import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ProjectLocalFilePathOptions {
  readonly cwd?: string;
  readonly configDirName?: string;
  readonly defaultConfigDirName?: string;
  readonly fileName: string;
  readonly overridePath?: string;
  readonly inputLabel: string;
}

export interface ProjectLocalFileOperationHooks {
  readonly beforeOpen?: () => Promise<void> | void;
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

const parentSegment = "..";
const unsafeProjectPathErrorCode = "OBSERVME_UNSAFE_PROJECT_PATH";

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
  hooks: ProjectLocalFileOperationHooks = {},
): Promise<string | undefined> {
  const snapshot = await createCanonicalProjectPathSnapshot(options);
  await hooks.beforeOpen?.();

  let fileHandle: FileHandle | undefined;

  try {
    fileHandle = await openProjectFileForRead(snapshot);
    if (!fileHandle) return undefined;
    await assertOpenedProjectFileIsStable(snapshot, fileHandle);
    return await fileHandle.readFile({ encoding: "utf8" });
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
  await hooks.beforeOpen?.();

  let fileHandle: FileHandle | undefined;
  let openedIdentity: FileIdentity | undefined;

  try {
    fileHandle = await openProjectFileForExclusiveCreate(snapshot);
    if (!fileHandle) {
      await assertExistingProjectFileIsSafe(options);
      return "exists";
    }

    openedIdentity = toFileIdentity(await fileHandle.stat({ bigint: true }));
    await assertOpenedProjectFileIsStable(snapshot, fileHandle);
    await fileHandle.writeFile(content, { encoding: "utf8" });
    await assertOpenedProjectFileIsStable(snapshot, fileHandle);
    return "created";
  } catch (error) {
    await closeFileHandle(fileHandle);
    fileHandle = undefined;
    if (openedIdentity) await removeCreatedFileIfIdentityMatches(snapshot, openedIdentity);
    throw error;
  } finally {
    await closeFileHandle(fileHandle);
  }
}

export function isUnsafeProjectPathError(error: unknown): boolean {
  return isErrorWithCode(error) && error.code === unsafeProjectPathErrorCode;
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

async function openProjectFileForExclusiveCreate(
  snapshot: CanonicalProjectPathSnapshot,
): Promise<FileHandle | undefined> {
  try {
    return await open(snapshot.canonicalCandidatePath, createExclusiveWriteOpenFlags(), 0o600);
  } catch (error) {
    if (isFileAlreadyExistsError(error)) return undefined;
    if (isSymlinkLoopError(error)) throw createUnsafeProjectPathError(snapshot.inputLabel);
    throw error;
  }
}

function createReadOpenFlags(): number {
  return constants.O_RDONLY | optionalOpenFlag(constants.O_NOFOLLOW) | optionalOpenFlag(constants.O_NONBLOCK);
}

function createExclusiveWriteOpenFlags(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | optionalOpenFlag(constants.O_NOFOLLOW);
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

async function removeCreatedFileIfIdentityMatches(
  snapshot: CanonicalProjectPathSnapshot,
  openedIdentity: FileIdentity,
): Promise<void> {
  try {
    const currentStats = await lstat(snapshot.canonicalCandidatePath, { bigint: true });
    if (!hasSameIdentity(openedIdentity, toFileIdentity(currentStats))) return;
    await unlink(snapshot.canonicalCandidatePath);
  } catch {
    return;
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
      return resolve(canonicalExistingPath, ...missingComponents.reverse());
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

function isFileAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return isErrorWithCode(error) && error.code === "EEXIST";
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
