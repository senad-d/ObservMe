import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AnchoredCreateCommand } from "./anchored-exclusive-create-helper.ts";
import { readBoundedOpenSourceFileText } from "./read-source-file.ts";
import { normalizeNodeTimerMilliseconds } from "./timer-limits.ts";

export interface ProjectLocalFilePathOptions {
  readonly cwd?: string;
  readonly configDirName?: string;
  readonly defaultConfigDirName?: string;
  readonly fileName: string;
  readonly overridePath?: string;
  readonly inputLabel: string;
}

export interface AnchoredCreateHelperProcessOptions {
  readonly modulePath?: string;
  readonly arguments?: readonly string[];
  readonly phaseTimeoutMillis?: number;
  readonly shutdownStepTimeoutMillis?: number;
}

export interface ProjectLocalFileOperationHooks {
  readonly beforeOpen?: () => Promise<void> | void;
  readonly afterOpen?: () => Promise<void> | void;
  readonly anchoredCreateHelper?: AnchoredCreateHelperProcessOptions;
}

export type ExclusiveProjectLocalFileCreateStatus = "created" | "exists";

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface CanonicalProjectPathSnapshot {
  readonly rootPath: string;
  readonly canonicalRootPath: string;
  readonly canonicalCandidatePath: string;
  readonly rootIdentity: FileIdentity;
  readonly inputLabel: string;
}

interface AnchoredCreateHelperOwner {
  readonly process: ChildProcess;
  readonly phaseTimeoutMillis: number;
  readonly shutdownStepTimeoutMillis: number;
  directoryIdentity?: FileIdentity;
  processError?: unknown;
  shutdownPromise?: Promise<boolean>;
}

const parentSegment = "..";
const unsafeProjectPathErrorCode = "OBSERVME_UNSAFE_PROJECT_PATH";
const unsafeProjectPathCleanupErrorCode = "OBSERVME_UNSAFE_PROJECT_PATH_CLEANUP_FAILED";
const anchoredCreateHelperPath = fileURLToPath(new URL("./anchored-exclusive-create-helper.mjs", import.meta.url));

/** Maximum wait for each ready/open/write/commit/abort/cancel helper protocol response. */
export const ANCHORED_CREATE_HELPER_PHASE_TIMEOUT_MILLIS = 2_000;
/** Maximum wait after disconnect and after each TERM/KILL reaping step. */
export const ANCHORED_CREATE_HELPER_SHUTDOWN_STEP_TIMEOUT_MILLIS = 250;

export function resolveProjectLocalFilePath(options: ProjectLocalFilePathOptions): string {
  const root = resolve(options.cwd ?? process.cwd());
  const candidatePath = resolveProjectLocalCandidatePath(root, options);

  assertProjectContainment(root, candidatePath, options.inputLabel);
  if (shouldPreserveRelativeOverride(options)) return options.overridePath!;
  return candidatePath;
}

/**
 * Project-local I/O policy: lexical paths and their canonical targets must remain
 * inside one stable canonical root. Safe in-root symlinks are pinned to their
 * canonical target, missing final paths are supported, and an opened file's
 * device/inode identity is verified before bytes are read or written.
 */
export async function resolveCanonicalProjectLocalFilePath(
  options: ProjectLocalFilePathOptions,
): Promise<string> {
  return (await createCanonicalProjectPathSnapshot(options)).canonicalCandidatePath;
}

export async function readCanonicalProjectLocalFileText(
  options: ProjectLocalFilePathOptions,
  maximumBytes: number,
  hooks: ProjectLocalFileOperationHooks = {},
): Promise<string | undefined> {
  const snapshot = await createCanonicalProjectPathSnapshot(options);
  await hooks.beforeOpen?.();

  let fileHandle: FileHandle | undefined;

  try {
    fileHandle = await openProjectFileForRead(snapshot);
    if (!fileHandle) return undefined;
    await assertOpenedProjectFileIsStable(snapshot, fileHandle);
    const text = await readBoundedOpenSourceFileText(fileHandle, maximumBytes);
    await assertOpenedProjectFileIsStable(snapshot, fileHandle);
    return text;
  } finally {
    await closeFileHandle(fileHandle);
  }
}

export async function createCanonicalProjectLocalFileExclusively(
  options: ProjectLocalFilePathOptions,
  content: string,
  hooks: ProjectLocalFileOperationHooks = {},
): Promise<ExclusiveProjectLocalFileCreateStatus> {
  const initialSnapshot = await createCanonicalProjectPathSnapshot(options);
  await mkdir(dirname(initialSnapshot.canonicalCandidatePath), { recursive: true });
  const snapshot = await createCanonicalProjectPathSnapshot(options);
  if (await projectFileAlreadyExists(snapshot)) return "exists";
  const helper = await startAnchoredCreateHelper(snapshot, hooks.anchoredCreateHelper);
  let createRequested = false;
  let openedIdentity: FileIdentity | undefined;

  try {
    await assertMissingProjectPathIsSafe(snapshot);
    await hooks.beforeOpen?.();
    createRequested = true;
    const openResult = await receiveAnchoredOpenResult(helper, snapshot);
    if (openResult === "exists") {
      await assertExistingProjectFileIsSafe(options);
      await assertAnchoredCreateHelperReaped(helper, snapshot.inputLabel);
      return "exists";
    }

    openedIdentity = openResult;
    await hooks.afterOpen?.();
    await assertAnchoredProjectFileIsStable(snapshot, openedIdentity);
    await receiveAnchoredWriteResult(helper, snapshot, openedIdentity, content);
    await assertAnchoredProjectFileIsStable(snapshot, openedIdentity);
    await receiveAnchoredCommitResult(helper, snapshot);
    openedIdentity = undefined;
    await assertAnchoredCreateHelperReaped(helper, snapshot.inputLabel);
    return "created";
  } catch (error) {
    if (!await cleanupFailedAnchoredCreate(helper, snapshot, createRequested, openedIdentity, error)) {
      throw createUnsafeProjectPathCleanupError(snapshot.inputLabel);
    }
    throw error;
  }
}

async function assertAnchoredCreateHelperReaped(
  helper: AnchoredCreateHelperOwner,
  inputLabel: string,
): Promise<void> {
  if (!await terminateAndReapAnchoredCreateHelper(helper)) {
    throw createUnsafeProjectPathCleanupError(inputLabel);
  }
}

async function startAnchoredCreateHelper(
  snapshot: CanonicalProjectPathSnapshot,
  options: AnchoredCreateHelperProcessOptions | undefined,
): Promise<AnchoredCreateHelperOwner> {
  const canonicalParentPath = dirname(snapshot.canonicalCandidatePath);
  assertProjectContainment(snapshot.canonicalRootPath, canonicalParentPath, snapshot.inputLabel);
  const parentStats = await stat(canonicalParentPath, { bigint: true });
  if (!parentStats.isDirectory()) throw createUnsafeProjectPathError(snapshot.inputLabel);

  const helperProcess = fork(options?.modulePath ?? anchoredCreateHelperPath, [...(options?.arguments ?? [])], {
    cwd: canonicalParentPath,
    execArgv: [],
    serialization: "json",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const helper: AnchoredCreateHelperOwner = {
    process: helperProcess,
    phaseTimeoutMillis: normalizeHelperTimeout(
      options?.phaseTimeoutMillis,
      ANCHORED_CREATE_HELPER_PHASE_TIMEOUT_MILLIS,
    ),
    shutdownStepTimeoutMillis: normalizeHelperTimeout(
      options?.shutdownStepTimeoutMillis,
      ANCHORED_CREATE_HELPER_SHUTDOWN_STEP_TIMEOUT_MILLIS,
    ),
  };
  helperProcess.on("error", recordAnchoredCreateHelperError.bind(undefined, helper));

  try {
    const message = await exchangeHelperMessage(helper);
    if (readHelperMessageType(message) !== "ready") throwHelperFailure(message, snapshot.inputLabel);
    const directoryIdentity = readSerializedFileIdentity(message);
    if (!directoryIdentity || !hasSameIdentity(toFileIdentity(parentStats), directoryIdentity)) {
      throw createUnsafeProjectPathError(snapshot.inputLabel);
    }
    helper.directoryIdentity = directoryIdentity;
    return helper;
  } catch (error) {
    if (!await terminateAndReapAnchoredCreateHelper(helper)) {
      throw createUnsafeProjectPathCleanupError(snapshot.inputLabel);
    }
    throw error;
  }
}

async function receiveAnchoredOpenResult(
  helper: AnchoredCreateHelperOwner,
  snapshot: CanonicalProjectPathSnapshot,
): Promise<"exists" | FileIdentity> {
  const message = await exchangeHelperMessage(helper, {
    type: "create",
    fileName: basename(snapshot.canonicalCandidatePath),
  });
  if (readHelperMessageType(message) === "exists") return "exists";
  if (readHelperMessageType(message) !== "opened") throwHelperFailure(message, snapshot.inputLabel);

  const identity = readSerializedFileIdentity(message);
  if (!identity) throw createUnsafeProjectPathError(snapshot.inputLabel);
  return identity;
}

async function receiveAnchoredWriteResult(
  helper: AnchoredCreateHelperOwner,
  snapshot: CanonicalProjectPathSnapshot,
  openedIdentity: FileIdentity,
  content: string,
): Promise<void> {
  const message = await exchangeHelperMessage(helper, { type: "write", content });
  if (readHelperMessageType(message) !== "written") throwHelperFailure(message, snapshot.inputLabel);

  const writtenIdentity = readSerializedFileIdentity(message);
  if (!writtenIdentity || !hasSameIdentity(openedIdentity, writtenIdentity)) {
    throw createUnsafeProjectPathError(snapshot.inputLabel);
  }
}

async function receiveAnchoredCommitResult(
  helper: AnchoredCreateHelperOwner,
  snapshot: CanonicalProjectPathSnapshot,
): Promise<void> {
  const message = await exchangeHelperMessage(helper, { type: "commit" });
  if (readHelperMessageType(message) !== "committed") throwHelperFailure(message, snapshot.inputLabel);
}

async function cleanupFailedAnchoredCreate(
  helper: AnchoredCreateHelperOwner,
  snapshot: CanonicalProjectPathSnapshot,
  createRequested: boolean,
  openedIdentity: FileIdentity | undefined,
  error: unknown,
): Promise<boolean> {
  let protocolCleanupConfirmed = false;
  if (!isAnchoredCreateTimeout(error)) {
    protocolCleanupConfirmed = openedIdentity
      ? await abortAnchoredCreate(helper)
      : !createRequested && await cancelAnchoredCreate(helper);
  }

  const reaped = await terminateAndReapAnchoredCreateHelper(helper);
  if (!reaped) return false;
  if (protocolCleanupConfirmed || !createRequested) return true;
  return isAnchoredTargetVerifiedMissing(snapshot, helper.directoryIdentity);
}

async function abortAnchoredCreate(helper: AnchoredCreateHelperOwner): Promise<boolean> {
  if (!helper.process.connected) return false;

  try {
    const message = await exchangeHelperMessage(helper, { type: "abort" });
    return readHelperMessageType(message) === "aborted";
  } catch {
    return false;
  }
}

async function cancelAnchoredCreate(helper: AnchoredCreateHelperOwner): Promise<boolean> {
  if (!helper.process.connected) return false;

  try {
    const message = await exchangeHelperMessage(helper, { type: "cancel" });
    return readHelperMessageType(message) === "cancelled";
  } catch {
    return false;
  }
}

async function exchangeHelperMessage(
  helper: AnchoredCreateHelperOwner,
  command?: AnchoredCreateCommand,
): Promise<unknown> {
  if (helper.processError) throw createAnchoredCreateFailure("EPIPE");
  const controller = new AbortController();

  try {
    const messageEvent = once(helper.process, "message", { signal: controller.signal });
    const exitEvent = once(helper.process, "exit", { signal: controller.signal }).then(rejectUnexpectedHelperExit);
    const timeoutEvent = wait(helper.phaseTimeoutMillis, undefined, {
      ref: false,
      signal: controller.signal,
    }).then(rejectAnchoredCreateTimeout);
    if (command) sendHelperMessage(helper.process, command);
    const [message] = await Promise.race([messageEvent, exitEvent, timeoutEvent]);
    return message;
  } finally {
    controller.abort();
  }
}

async function terminateAndReapAnchoredCreateHelper(helper: AnchoredCreateHelperOwner): Promise<boolean> {
  helper.shutdownPromise ??= disconnectTerminateAndReapAnchoredCreateHelper(helper);
  return helper.shutdownPromise;
}

async function disconnectTerminateAndReapAnchoredCreateHelper(
  helper: AnchoredCreateHelperOwner,
): Promise<boolean> {
  disconnectAnchoredCreateHelper(helper.process);
  if (await waitForAnchoredCreateHelperExit(helper)) return true;

  signalAnchoredCreateHelper(helper.process, "SIGTERM");
  if (await waitForAnchoredCreateHelperExit(helper)) return true;

  signalAnchoredCreateHelper(helper.process, "SIGKILL");
  return waitForAnchoredCreateHelperExit(helper);
}

async function waitForAnchoredCreateHelperExit(helper: AnchoredCreateHelperOwner): Promise<boolean> {
  if (hasAnchoredCreateHelperExited(helper.process)) return true;
  const controller = new AbortController();

  try {
    const exitEvent = once(helper.process, "exit", { signal: controller.signal });
    const timeoutEvent = wait(helper.shutdownStepTimeoutMillis, false, {
      ref: false,
      signal: controller.signal,
    });
    const result = await Promise.race([exitEvent, timeoutEvent]);
    return result !== false || hasAnchoredCreateHelperExited(helper.process);
  } finally {
    controller.abort();
  }
}

async function isAnchoredTargetVerifiedMissing(
  snapshot: CanonicalProjectPathSnapshot,
  directoryIdentity: FileIdentity | undefined,
): Promise<boolean> {
  if (!directoryIdentity) return false;

  try {
    await assertCanonicalRootIsStable(snapshot);
    const currentParentStats = await stat(dirname(snapshot.canonicalCandidatePath), { bigint: true });
    if (!currentParentStats.isDirectory()) return false;
    if (!hasSameIdentity(directoryIdentity, toFileIdentity(currentParentStats))) return false;
  } catch {
    return false;
  }

  try {
    await lstat(snapshot.canonicalCandidatePath);
    return false;
  } catch (error) {
    return isMissingPathError(error);
  }
}

function rejectUnexpectedHelperExit(): never {
  throw createAnchoredCreateFailure("EPIPE");
}

function rejectAnchoredCreateTimeout(): never {
  throw createAnchoredCreateFailure("ETIMEDOUT");
}

function sendHelperMessage(helper: ChildProcess, message: AnchoredCreateCommand): void {
  if (!helper.connected) throw createAnchoredCreateFailure("EPIPE");
  helper.send(message);
}

function disconnectAnchoredCreateHelper(helper: ChildProcess): void {
  if (!helper.connected) return;

  try {
    helper.disconnect();
  } catch {
    return;
  }
}

function signalAnchoredCreateHelper(helper: ChildProcess, signal: NodeJS.Signals): void {
  try {
    helper.kill(signal);
  } catch {
    return;
  }
}

function hasAnchoredCreateHelperExited(helper: ChildProcess): boolean {
  return helper.exitCode !== null || helper.signalCode !== null;
}

function recordAnchoredCreateHelperError(helper: AnchoredCreateHelperOwner, error: unknown): void {
  helper.processError ??= error;
}

function normalizeHelperTimeout(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return normalizeNodeTimerMilliseconds(value);
}

function isAnchoredCreateTimeout(error: unknown): boolean {
  return isErrorWithCode(error) && error.code === "ETIMEDOUT";
}

function readHelperMessageType(message: unknown): string | undefined {
  if (!isMessageRecord(message) || typeof message.type !== "string") return undefined;
  return message.type;
}

function readSerializedFileIdentity(message: unknown): FileIdentity | undefined {
  if (!isMessageRecord(message) || !isMessageRecord(message.identity) && !isMessageRecord(message.directoryIdentity)) {
    return undefined;
  }

  const serializedIdentity = isMessageRecord(message.identity) ? message.identity : message.directoryIdentity;
  if (!isMessageRecord(serializedIdentity)) return undefined;
  if (typeof serializedIdentity.device !== "string" || typeof serializedIdentity.inode !== "string") return undefined;

  try {
    return { device: BigInt(serializedIdentity.device), inode: BigInt(serializedIdentity.inode) };
  } catch {
    return undefined;
  }
}

function throwHelperFailure(message: unknown, inputLabel: string): never {
  const messageType = readHelperMessageType(message);
  if (messageType === "cleanup_failed") throw createUnsafeProjectPathCleanupError(inputLabel);
  if (messageType !== "error" || !isMessageRecord(message) || typeof message.code !== "string") {
    throw createUnsafeProjectPathError(inputLabel);
  }
  if (message.code === "ELOOP" || message.code === "EINVAL") throw createUnsafeProjectPathError(inputLabel);
  throw createAnchoredCreateFailure(message.code);
}

function createAnchoredCreateFailure(code: string): NodeJS.ErrnoException {
  const message = code === "ETIMEDOUT"
    ? "Anchored ObservMe project file helper protocol timed out."
    : "Anchored ObservMe project file creation failed.";
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function isMessageRecord(message: unknown): message is Record<string, unknown> {
  return typeof message === "object" && message !== null;
}

export function isUnsafeProjectPathError(error: unknown): boolean {
  if (!isErrorWithCode(error)) return false;
  return error.code === unsafeProjectPathErrorCode || error.code === unsafeProjectPathCleanupErrorCode;
}

function resolveProjectLocalCandidatePath(root: string, options: ProjectLocalFilePathOptions): string {
  if (options.overridePath !== undefined) return resolveOverridePath(root, options.overridePath, options.inputLabel);
  return resolveConfigDirPath(root, options);
}

function shouldPreserveRelativeOverride(options: ProjectLocalFilePathOptions): boolean {
  return options.cwd === undefined && options.overridePath !== undefined && !isAbsolute(options.overridePath);
}

function resolveOverridePath(root: string, overridePath: string, inputLabel: string): string {
  if (isRelativeTraversalPath(overridePath)) throw createUnsafeProjectPathError(inputLabel);
  return isAbsolute(overridePath) ? resolve(overridePath) : resolve(root, overridePath);
}

function resolveConfigDirPath(root: string, options: ProjectLocalFilePathOptions): string {
  const configDirName = options.configDirName ?? options.defaultConfigDirName;

  if (!configDirName) throw createUnsafeProjectPathError(options.inputLabel);
  if (isAbsolute(configDirName)) throw createUnsafeProjectPathError(options.inputLabel);
  if (hasParentSegment(configDirName)) throw createUnsafeProjectPathError(options.inputLabel);
  return resolve(root, join(configDirName, options.fileName));
}

function isRelativeTraversalPath(pathInput: string): boolean {
  return !isAbsolute(pathInput) && hasParentSegment(pathInput);
}

function hasParentSegment(pathInput: string): boolean {
  return pathInput.split(/[\\/]+/u).includes(parentSegment);
}

function assertProjectContainment(root: string, candidatePath: string, inputLabel: string): void {
  if (!isPathInsideOrSame(root, candidatePath)) throw createUnsafeProjectPathError(inputLabel);
}

async function createCanonicalProjectPathSnapshot(
  options: ProjectLocalFilePathOptions,
): Promise<CanonicalProjectPathSnapshot> {
  try {
    const rootPath = resolve(options.cwd ?? process.cwd());
    const candidatePath = resolveProjectLocalCandidatePath(rootPath, options);
    assertProjectContainment(rootPath, candidatePath, options.inputLabel);

    const canonicalRootPath = await realpath(rootPath);
    const rootStats = await stat(canonicalRootPath, { bigint: true });
    if (!rootStats.isDirectory()) throw createUnsafeProjectPathError(options.inputLabel);

    const canonicalCandidatePath = await resolveCanonicalPathWithMissingComponents(candidatePath);
    assertProjectContainment(canonicalRootPath, canonicalCandidatePath, options.inputLabel);

    return {
      rootPath,
      canonicalRootPath,
      canonicalCandidatePath,
      rootIdentity: toFileIdentity(rootStats),
      inputLabel: options.inputLabel,
    };
  } catch (error) {
    if (isUnsafeProjectPathError(error)) throw error;
    throw createUnsafeProjectPathError(options.inputLabel);
  }
}

async function openProjectFileForRead(snapshot: CanonicalProjectPathSnapshot): Promise<FileHandle | undefined> {
  try {
    return await open(snapshot.canonicalCandidatePath, createReadOpenFlags());
  } catch (error) {
    if (!isMissingPathError(error) && !isNotDirectoryError(error)) {
      if (isSymlinkLoopError(error)) throw createUnsafeProjectPathError(snapshot.inputLabel);
      throw error;
    }

    await assertMissingProjectPathIsSafe(snapshot);
    return undefined;
  }
}

function createReadOpenFlags(): number {
  return constants.O_RDONLY | optionalOpenFlag(constants.O_NOFOLLOW) | optionalOpenFlag(constants.O_NONBLOCK);
}

function optionalOpenFlag(flag: number | undefined): number {
  return typeof flag === "number" ? flag : 0;
}

async function assertOpenedProjectFileIsStable(
  snapshot: CanonicalProjectPathSnapshot,
  fileHandle: FileHandle,
): Promise<void> {
  try {
    await assertCanonicalRootIsStable(snapshot);
    const currentCanonicalPath = await realpath(snapshot.canonicalCandidatePath);
    assertProjectContainment(snapshot.canonicalRootPath, currentCanonicalPath, snapshot.inputLabel);

    const openedStats = await fileHandle.stat({ bigint: true });
    const currentPathStats = await stat(currentCanonicalPath, { bigint: true });
    if (!openedStats.isFile() || !currentPathStats.isFile()) {
      throw createUnsafeProjectPathError(snapshot.inputLabel);
    }
    if (!hasSameFileIdentity(openedStats, currentPathStats)) {
      throw createUnsafeProjectPathError(snapshot.inputLabel);
    }
  } catch (error) {
    if (isUnsafeProjectPathError(error)) throw error;
    throw createUnsafeProjectPathError(snapshot.inputLabel);
  }
}

async function assertMissingProjectPathIsSafe(snapshot: CanonicalProjectPathSnapshot): Promise<void> {
  try {
    await assertCanonicalRootIsStable(snapshot);
    const currentCanonicalPath = await resolveCanonicalPathWithMissingComponents(
      snapshot.canonicalCandidatePath,
    );
    assertProjectContainment(snapshot.canonicalRootPath, currentCanonicalPath, snapshot.inputLabel);
  } catch (error) {
    if (isUnsafeProjectPathError(error)) throw error;
    throw createUnsafeProjectPathError(snapshot.inputLabel);
  }
}

async function projectFileAlreadyExists(snapshot: CanonicalProjectPathSnapshot): Promise<boolean> {
  try {
    await assertCanonicalRootIsStable(snapshot);
    const currentCanonicalPath = await realpath(snapshot.canonicalCandidatePath);
    assertProjectContainment(snapshot.canonicalRootPath, currentCanonicalPath, snapshot.inputLabel);
    const existingStats = await stat(currentCanonicalPath, { bigint: true });
    if (!existingStats.isFile()) throw createUnsafeProjectPathError(snapshot.inputLabel);
    return true;
  } catch (error) {
    if (!isMissingPathError(error) && !isNotDirectoryError(error)) {
      if (isUnsafeProjectPathError(error)) throw error;
      throw createUnsafeProjectPathError(snapshot.inputLabel);
    }
    await assertMissingProjectPathIsSafe(snapshot);
    return false;
  }
}

async function assertAnchoredProjectFileIsStable(
  snapshot: CanonicalProjectPathSnapshot,
  openedIdentity: FileIdentity,
): Promise<void> {
  try {
    await assertCanonicalRootIsStable(snapshot);
    const currentCanonicalPath = await realpath(snapshot.canonicalCandidatePath);
    assertProjectContainment(snapshot.canonicalRootPath, currentCanonicalPath, snapshot.inputLabel);

    const currentPathStats = await stat(currentCanonicalPath, { bigint: true });
    if (!currentPathStats.isFile() || !hasSameIdentity(openedIdentity, toFileIdentity(currentPathStats))) {
      throw createUnsafeProjectPathError(snapshot.inputLabel);
    }
  } catch (error) {
    if (isUnsafeProjectPathError(error)) throw error;
    throw createUnsafeProjectPathError(snapshot.inputLabel);
  }
}

async function assertExistingProjectFileIsSafe(options: ProjectLocalFilePathOptions): Promise<void> {
  const snapshot = await createCanonicalProjectPathSnapshot(options);

  try {
    await assertCanonicalRootIsStable(snapshot);
    const existingStats = await stat(snapshot.canonicalCandidatePath, { bigint: true });
    if (!existingStats.isFile()) throw createUnsafeProjectPathError(snapshot.inputLabel);
  } catch (error) {
    if (isUnsafeProjectPathError(error)) throw error;
    throw createUnsafeProjectPathError(snapshot.inputLabel);
  }
}

async function assertCanonicalRootIsStable(snapshot: CanonicalProjectPathSnapshot): Promise<void> {
  const currentCanonicalRoot = await realpath(snapshot.rootPath);
  const currentRootStats = await stat(currentCanonicalRoot, { bigint: true });
  if (!currentRootStats.isDirectory()) throw createUnsafeProjectPathError(snapshot.inputLabel);
  if (!hasSameIdentity(snapshot.rootIdentity, toFileIdentity(currentRootStats))) {
    throw createUnsafeProjectPathError(snapshot.inputLabel);
  }
}

async function closeFileHandle(fileHandle: FileHandle | undefined): Promise<void> {
  if (!fileHandle) return;

  try {
    await fileHandle.close();
  } catch {
    return;
  }
}

function toFileIdentity(stats: BigIntStats): FileIdentity {
  return { device: stats.dev, inode: stats.ino };
}

function hasSameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return hasSameIdentity(toFileIdentity(left), toFileIdentity(right));
}

function hasSameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function resolveCanonicalPathWithMissingComponents(candidatePath: string): Promise<string> {
  const missingComponents: string[] = [];
  let currentPath = candidatePath;

  while (true) {
    try {
      const canonicalExistingPath = await realpath(currentPath);
      missingComponents.reverse();
      return resolve(canonicalExistingPath, ...missingComponents);
    } catch (error) {
      if (!isMissingPathError(error) || await pathEntryExists(currentPath)) throw error;
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) throw error;
      missingComponents.push(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return isErrorWithCode(error) && error.code === "ENOENT";
}

function isNotDirectoryError(error: unknown): error is NodeJS.ErrnoException {
  return isErrorWithCode(error) && error.code === "ENOTDIR";
}

function isSymlinkLoopError(error: unknown): error is NodeJS.ErrnoException {
  return isErrorWithCode(error) && error.code === "ELOOP";
}

function isErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function isPathInsideOrSame(root: string, candidatePath: string): boolean {
  const pathFromRoot = relative(root, candidatePath);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(parentSegment) && !isAbsolute(pathFromRoot));
}

function createUnsafeProjectPathError(inputLabel: string): NodeJS.ErrnoException {
  const error = new Error(createUnsafeProjectPathMessage(inputLabel)) as NodeJS.ErrnoException;
  error.code = unsafeProjectPathErrorCode;
  return error;
}

function createUnsafeProjectPathMessage(inputLabel: string): string {
  return `Unsafe ObservMe ${inputLabel}: path input must stay inside the active project root.`;
}

function createUnsafeProjectPathCleanupError(inputLabel: string): NodeJS.ErrnoException {
  const error = new Error(
    `Unsafe ObservMe ${inputLabel}: anchored file cleanup failed; inspect the trusted project directory.`,
  ) as NodeJS.ErrnoException;
  error.code = unsafeProjectPathCleanupErrorCode;
  return error;
}
