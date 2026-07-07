import type { ExtensionAPI, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import { loadSessionConfig } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import { ObservMeLogSdk } from "../otel/logs.ts";
import type { ContentLimitKind } from "../privacy/truncate.ts";
import { truncateContent } from "../privacy/truncate.ts";
import { redactValue } from "../privacy/redact.ts";
import {
  BASH_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  COMPACTION_ATTRIBUTES,
  LLM_ATTRIBUTES,
  LOG_ATTRIBUTES,
  TOOL_ATTRIBUTES,
} from "../semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../semconv/metrics.ts";
import {
  completeObsSubcommand,
  missingObsOptionValueMessage,
  parseObsSubcommandArgs,
  unknownObsOptionMessage,
} from "./obs-args.ts";

export type ObsBackfillAttributeValue = boolean | number | string | string[];
export type ObsBackfillAttributes = Record<string, ObsBackfillAttributeValue>;

export interface ObsBackfillCommandContext {
  readonly cwd?: string;
  readonly hasUI?: boolean;
  readonly signal?: AbortSignal;
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
    confirm?: (title: string, message: string, options?: { timeout?: number; signal?: AbortSignal }) => Promise<boolean> | boolean;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
  readonly waitForIdle?: (options?: ObsBackfillOperationOptions) => Promise<void> | void;
  readonly sessionManager?: ObsBackfillSessionManager;
}

export interface ObsBackfillOperationOptions {
  readonly signal?: AbortSignal;
}

export interface ObsBackfillSessionManager {
  readonly getBranch?: () => readonly SessionEntry[];
  readonly getEntries?: () => readonly SessionEntry[];
  readonly getHeader?: () => SessionHeader | null;
  readonly getSessionId?: () => string;
  readonly getSessionFile?: () => string | undefined;
}

export interface ObsBackfillTelemetryRecord {
  readonly eventName: string;
  readonly body: string;
  readonly attributes: ObsBackfillAttributes;
  readonly timestamp?: Date;
}

export interface ObsBackfillExporter {
  emit: (record: ObsBackfillTelemetryRecord, options?: ObsBackfillOperationOptions) => Promise<void> | void;
  flush?: (options?: ObsBackfillOperationOptions) => Promise<void> | void;
  shutdown?: (options?: ObsBackfillOperationOptions) => Promise<void> | void;
}

export interface ObsBackfillSummary {
  readonly status: "completed" | "cancelled" | "skipped";
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly since?: string;
  readonly entriesScanned: number;
  readonly entriesEligible: number;
  readonly recordsExported: number;
  readonly recordsSkipped: number;
  readonly rateLimited: boolean;
  readonly contentCaptured: boolean;
  readonly redactionFailures: number;
  readonly reason?: string;
}

export type ObsBackfillConfigLoader = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type ObsBackfillExporterFactory = (
  config: ObservMeConfig,
  ctx: ObsBackfillCommandContext,
) => ObsBackfillExporter | Promise<ObsBackfillExporter>;
export type ObsBackfillRunner = (
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
) => Promise<ObsBackfillSummary> | ObsBackfillSummary;

export interface ObsBackfillOptions {
  readonly loadConfig?: ObsBackfillConfigLoader;
  readonly createExporter?: ObsBackfillExporterFactory;
  readonly runBackfill?: ObsBackfillRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
  readonly now?: () => Date;
  readonly maxRecords?: number;
  readonly confirmTimeoutMs?: number;
  readonly exportOperationTimeoutMs?: number;
}

export type RegisterObsBackfillCommandOptions = ObsBackfillOptions;

export interface ObsBackfillRequest {
  readonly currentSession: boolean;
  readonly since?: string;
  readonly sinceMs?: number;
}

interface ParsedObsBackfillArgs {
  readonly request?: ObsBackfillRequest;
  readonly error?: string;
}

interface ObsBackfillBuildResult {
  readonly records: readonly ObsBackfillTelemetryRecord[];
  readonly entriesScanned: number;
  readonly entriesEligible: number;
  readonly recordsSkipped: number;
  readonly rateLimited: boolean;
  readonly contentCaptured: boolean;
  readonly redactionFailures: number;
}

interface ObsBackfillContentResult {
  readonly captured: boolean;
  readonly redactionFailures: number;
}

interface ToolCallContent {
  readonly name?: string;
  readonly arguments?: unknown;
}

const OBS_COMMAND_NAME = "obs";
const OBS_BACKFILL_SUBCOMMAND = "backfill";
const OBS_BACKFILL_USAGE = "Usage: /obs backfill --current-session --since 1h";
const OBS_BACKFILL_DEFAULT_MAX_RECORDS = 100;
const OBS_BACKFILL_DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const OBS_BACKFILL_CATEGORY = "backfill";
const OBS_BACKFILL_UNKNOWN_SESSION = "unknown";
const millisecondsPerSecond = 1000;
const millisecondsPerMinute = 60 * millisecondsPerSecond;
const millisecondsPerHour = 60 * millisecondsPerMinute;
const millisecondsPerDay = 24 * millisecondsPerHour;
const sincePattern = /^(\d+)(ms|s|m|h|d)$/iu;
const abortErrorNames = new Set(["AbortError", "TimeoutError"]);

export function registerObsBackfillCommand(
  pi: ExtensionAPI,
  options: RegisterObsBackfillCommandOptions = {},
): void {
  const command = new ObsBackfillCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Replay current-session ObservMe telemetry on demand. Usage: /obs backfill --current-session --since 1h",
    getArgumentCompletions: getObsBackfillCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsBackfillCommand(
  args: string,
  ctx: ObsBackfillCommandContext,
  options: RegisterObsBackfillCommandOptions = {},
): Promise<void> {
  const parsed = parseObsBackfillArgs(args);
  if (!parsed.request) {
    await notifyBackfill(ctx, parsed.error ? `${OBS_BACKFILL_USAGE}\n${parsed.error}` : OBS_BACKFILL_USAGE, "warning");
    return;
  }

  try {
    const summary = await resolveObsBackfillSummary(ctx, parsed.request, options);
    await notifyBackfill(ctx, renderObsBackfillSummary(summary), notificationTypeForSummary(summary));
  } catch (error) {
    await notifyBackfill(ctx, `ObservMe backfill unavailable: ${formatBackfillError(error)}`, "error");
  }
}

export function getObsBackfillCommandArgumentCompletions(
  prefix: string,
): Array<{ value: string; label: string }> | null {
  return completeObsSubcommand(prefix, OBS_BACKFILL_SUBCOMMAND);
}

export async function runObsBackfill(
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  options: ObsBackfillOptions = {},
): Promise<ObsBackfillSummary> {
  if (isAbortSignalAborted(ctx.signal)) return cancelledBackfillSummary(ctx, request, "operation cancelled");

  const config = await loadObsBackfillConfig(ctx, options);
  const skippedSummary = resolveSkippedBackfillSummary(config, ctx, request);
  if (skippedSummary) return skippedSummary;

  const confirmed = await confirmBackfillOrCancel(ctx, request, config, options);
  if (!confirmed) return cancelledBackfillSummary(ctx, request, isAbortSignalAborted(ctx.signal) ? "operation cancelled" : undefined);
  if (isAbortSignalAborted(ctx.signal)) return cancelledBackfillSummary(ctx, request, "operation cancelled");

  const operationTimeoutMs = normalizeBackfillOperationTimeoutMs(options.exportOperationTimeoutMs);
  try {
    await waitForObsBackfillIdle(ctx, operationTimeoutMs);
  } catch (error) {
    if (error instanceof ObsBackfillInterruptedError) return cancelledBackfillSummary(ctx, request, error.reason);
    throw error;
  }

  const entries = readCurrentSessionEntries(ctx);
  const sessionId = resolveCurrentSessionId(ctx);
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  const buildResult = buildObsBackfillRecords(entries, config, request, sessionId, options);

  try {
    const recordsExported = buildResult.records.length > 0 ? await exportObsBackfillRecords(buildResult.records, config, ctx, operationTimeoutMs, options) : 0;
    return completedBackfillSummary(ctx, request, buildResult, recordsExported, sessionId, sessionFile);
  } catch (error) {
    if (error instanceof ObsBackfillInterruptedError) {
      return interruptedBackfillSummary(ctx, request, buildResult, error.recordsExported, error.reason, sessionId, sessionFile);
    }

    throw error;
  }
}

export function renderObsBackfillSummary(summary: ObsBackfillSummary): string {
  if (summary.status === "cancelled") return renderCancelledObsBackfillSummary(summary);
  if (summary.status === "skipped") return `ObservMe backfill skipped: ${summary.reason ?? "not available"}.`;

  const lines = [
    `Backfilled session: ${summary.sessionId ?? OBS_BACKFILL_UNKNOWN_SESSION}`,
    `Window: ${summary.since ?? "all current-session entries"}`,
    `Entries scanned: ${summary.entriesScanned}`,
    `Entries eligible: ${summary.entriesEligible}`,
    `Records exported: ${summary.recordsExported}`,
    `Content captured: ${formatBoolean(summary.contentCaptured)}`,
  ];

  if (summary.rateLimited) lines.push(`Rate limit: applied; skipped ${summary.recordsSkipped} eligible record(s)`);
  if (summary.redactionFailures > 0) lines.push(`Redaction failures: ${summary.redactionFailures}`);
  return lines.join("\n");
}

export function buildObsBackfillRecords(
  entries: readonly SessionEntry[],
  config: ObservMeConfig,
  request: ObsBackfillRequest,
  sessionId: string | undefined,
  options: Pick<ObsBackfillOptions, "maxRecords" | "now"> = {},
): ObsBackfillBuildResult {
  const cutoffMs = resolveSinceCutoffMs(request, options);
  const maxRecords = normalizeMaxRecords(options.maxRecords);
  const records: ObsBackfillTelemetryRecord[] = [];
  let entriesEligible = 0;
  let recordsSkipped = 0;
  let rateLimited = false;
  let contentCaptured = false;
  let redactionFailures = 0;

  for (const entry of entries) {
    if (!entryIsWithinSince(entry, cutoffMs)) continue;
    entriesEligible += 1;

    if (records.length >= maxRecords) {
      recordsSkipped += 1;
      rateLimited = true;
      continue;
    }

    const conversion = sessionEntryToBackfillRecord(entry, config, sessionId);
    if (!conversion.record) continue;

    records.push(conversion.record);
    contentCaptured = contentCaptured || conversion.contentCaptured;
    redactionFailures += conversion.redactionFailures;
  }

  return {
    records,
    entriesScanned: entries.length,
    entriesEligible,
    recordsSkipped,
    rateLimited,
    contentCaptured,
    redactionFailures,
  };
}

export function createObsBackfillLogExporter(config: ObservMeConfig): ObsBackfillExporter {
  const sdk = new ObservMeLogSdk({ config });
  sdk.start();
  return new ObsBackfillLogExporter(sdk);
}

class ObsBackfillInterruptedError extends Error {
  readonly reason: string;
  readonly recordsExported: number;

  constructor(reason: string, recordsExported = 0) {
    super(reason);
    this.name = "ObsBackfillInterruptedError";
    this.reason = reason;
    this.recordsExported = recordsExported;
  }
}

class ObsBackfillCommand {
  readonly #options: RegisterObsBackfillCommandOptions;

  constructor(options: RegisterObsBackfillCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsBackfillCommandContext): Promise<void> {
    await handleObsBackfillCommand(args, ctx, this.#options);
  }
}

class ObsBackfillLogExporter implements ObsBackfillExporter {
  readonly #sdk: ObservMeLogSdk;

  constructor(sdk: ObservMeLogSdk) {
    this.#sdk = sdk;
  }

  emit(record: ObsBackfillTelemetryRecord, _options?: ObsBackfillOperationOptions): void {
    this.#sdk.logger.emit({
      severityText: "INFO",
      body: record.body,
      attributes: {
        [LOG_ATTRIBUTES.EVENT_NAME]: record.eventName,
        [LOG_ATTRIBUTES.EVENT_CATEGORY]: OBS_BACKFILL_CATEGORY,
        ...record.attributes,
      },
    });
  }

  async flush(_options?: ObsBackfillOperationOptions): Promise<void> {
    await this.#sdk.forceFlush();
  }

  async shutdown(_options?: ObsBackfillOperationOptions): Promise<void> {
    await this.#sdk.shutdown();
  }
}

async function resolveObsBackfillSummary(
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  options: RegisterObsBackfillCommandOptions,
): Promise<ObsBackfillSummary> {
  if (options.runBackfill) return options.runBackfill(ctx, request);
  return runObsBackfill(ctx, request, options);
}

async function loadObsBackfillConfig(
  ctx: ObsBackfillCommandContext,
  options: ObsBackfillOptions,
): Promise<ObservMeConfig> {
  const loadConfig = options.loadConfig ?? loadSessionConfig;
  return loadConfig({ ctx, cwd: ctx.cwd, configDirName: options.configDirName, env: options.env });
}

function resolveSkippedBackfillSummary(
  config: ObservMeConfig,
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
): ObsBackfillSummary | undefined {
  if (!request.currentSession) return skippedBackfillSummary(ctx, request, "only --current-session backfill is supported");
  if (!config.enabled) return skippedBackfillSummary(ctx, request, "ObservMe is disabled");
  if (!config.logs.enabled) return skippedBackfillSummary(ctx, request, "ObservMe log export is disabled");
  if (!ctx.sessionManager) return skippedBackfillSummary(ctx, request, "current session state is unavailable");
  return undefined;
}

async function confirmBackfillOrCancel(
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  config: ObservMeConfig,
  options: ObsBackfillOptions,
): Promise<boolean> {
  try {
    return await confirmObsBackfill(ctx, request, config, options);
  } catch (error) {
    if (isAbortLikeError(error) || isAbortSignalAborted(ctx.signal)) return false;
    throw error;
  }
}

async function confirmObsBackfill(
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  config: ObservMeConfig,
  options: ObsBackfillOptions,
): Promise<boolean> {
  if (!canConfirmBackfill(ctx)) return false;

  return ctx.ui.confirm("Confirm ObservMe backfill", buildBackfillConfirmationMessage(request, config, options), {
    signal: ctx.signal,
    timeout: options.confirmTimeoutMs,
  });
}

function canConfirmBackfill(ctx: ObsBackfillCommandContext): ctx is ObsBackfillCommandContext & {
  readonly ui: ObsBackfillCommandContext["ui"] & { readonly confirm: NonNullable<ObsBackfillCommandContext["ui"]["confirm"]> };
} {
  return ctx.hasUI !== false && typeof ctx.ui.confirm === "function";
}

function buildBackfillConfirmationMessage(
  request: ObsBackfillRequest,
  config: ObservMeConfig,
  options: ObsBackfillOptions,
): string {
  const contentMode = anyBackfillContentCaptureEnabled(config) ? "enabled capture flags will be redacted before export" : "content capture is disabled";
  return [
    "Send historical ObservMe telemetry for the current Pi session?",
    `Window: ${request.since ?? "all current-session entries"}`,
    `Rate limit: ${normalizeMaxRecords(options.maxRecords)} record(s)` ,
    `Content mode: ${contentMode}`,
    "Replayed telemetry will be marked observme.replayed=true.",
  ].join("\n");
}

function cancelledBackfillSummary(
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  explicitReason?: string,
): ObsBackfillSummary {
  const reason = explicitReason ?? (canConfirmBackfill(ctx) ? "user did not confirm" : "interactive confirmation is required");
  return {
    status: "cancelled",
    sessionId: resolveCurrentSessionId(ctx),
    sessionFile: ctx.sessionManager?.getSessionFile?.(),
    since: request.since,
    entriesScanned: 0,
    entriesEligible: 0,
    recordsExported: 0,
    recordsSkipped: 0,
    rateLimited: false,
    contentCaptured: false,
    redactionFailures: 0,
    reason,
  };
}

function skippedBackfillSummary(
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  reason: string,
): ObsBackfillSummary {
  return {
    status: "skipped",
    sessionId: resolveCurrentSessionId(ctx),
    sessionFile: ctx.sessionManager?.getSessionFile?.(),
    since: request.since,
    entriesScanned: 0,
    entriesEligible: 0,
    recordsExported: 0,
    recordsSkipped: 0,
    rateLimited: false,
    contentCaptured: false,
    redactionFailures: 0,
    reason,
  };
}

function completedBackfillSummary(
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  buildResult: ObsBackfillBuildResult,
  recordsExported: number,
  sessionId = resolveCurrentSessionId(ctx),
  sessionFile = ctx.sessionManager?.getSessionFile?.(),
): ObsBackfillSummary {
  return backfillSummary("completed", ctx, request, buildResult, recordsExported, undefined, sessionId, sessionFile);
}

function interruptedBackfillSummary(
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  buildResult: ObsBackfillBuildResult,
  recordsExported: number,
  reason: string,
  sessionId = resolveCurrentSessionId(ctx),
  sessionFile = ctx.sessionManager?.getSessionFile?.(),
): ObsBackfillSummary {
  return backfillSummary("cancelled", ctx, request, buildResult, recordsExported, reason, sessionId, sessionFile);
}

function backfillSummary(
  status: ObsBackfillSummary["status"],
  _ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  buildResult: ObsBackfillBuildResult,
  recordsExported: number,
  reason: string | undefined,
  sessionId: string | undefined,
  sessionFile: string | undefined,
): ObsBackfillSummary {
  return {
    status,
    sessionId,
    sessionFile,
    since: request.since,
    entriesScanned: buildResult.entriesScanned,
    entriesEligible: buildResult.entriesEligible,
    recordsExported,
    recordsSkipped: buildResult.recordsSkipped + (buildResult.records.length - recordsExported),
    rateLimited: buildResult.rateLimited,
    contentCaptured: buildResult.contentCaptured,
    redactionFailures: buildResult.redactionFailures,
    reason,
  };
}

async function waitForObsBackfillIdle(ctx: ObsBackfillCommandContext, operationTimeoutMs: number): Promise<void> {
  if (!ctx.waitForIdle) return;
  await runBackfillOperation(ctx.waitForIdle({ signal: ctx.signal }), ctx.signal, operationTimeoutMs, "wait for idle");
}

async function exportObsBackfillRecords(
  records: readonly ObsBackfillTelemetryRecord[],
  config: ObservMeConfig,
  ctx: ObsBackfillCommandContext,
  operationTimeoutMs: number,
  options: ObsBackfillOptions,
): Promise<number> {
  const exporter = await createObsBackfillExporter(config, ctx, operationTimeoutMs, options);
  let recordsExported = 0;
  let pendingError: unknown;

  try {
    for (const record of records) {
      throwIfBackfillAborted(ctx.signal);
      await runBackfillOperation(exporter.emit(record, { signal: ctx.signal }), ctx.signal, operationTimeoutMs, "export emit");
      recordsExported += 1;
    }

    throwIfBackfillAborted(ctx.signal);
    await runBackfillOperation(exporter.flush?.({ signal: ctx.signal }), ctx.signal, operationTimeoutMs, "export flush");
  } catch (error) {
    pendingError = addExportCountToBackfillInterruption(error, recordsExported);
  } finally {
    pendingError = await shutdownObsBackfillExporter(exporter, ctx.signal, operationTimeoutMs, pendingError);
  }

  if (pendingError !== undefined) throw pendingError;
  return recordsExported;
}

async function createObsBackfillExporter(
  config: ObservMeConfig,
  ctx: ObsBackfillCommandContext,
  operationTimeoutMs: number,
  options: ObsBackfillOptions,
): Promise<ObsBackfillExporter> {
  throwIfBackfillAborted(ctx.signal);
  const exporter = options.createExporter ? options.createExporter(config, ctx) : createObsBackfillLogExporter(config);
  return runBackfillOperation(exporter, ctx.signal, operationTimeoutMs, "exporter setup");
}

async function shutdownObsBackfillExporter(
  exporter: ObsBackfillExporter,
  signal: AbortSignal | undefined,
  operationTimeoutMs: number,
  pendingError: unknown,
): Promise<unknown> {
  try {
    await runBackfillOperation(exporter.shutdown?.({ signal }), undefined, operationTimeoutMs, "export shutdown");
    return pendingError;
  } catch (shutdownError) {
    return pendingError ?? shutdownError;
  }
}

async function runBackfillOperation<T>(
  operation: Promise<T> | T,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  throwIfBackfillAborted(signal);

  const abortPromise = createBackfillAbortPromise<T>(signal);
  const timeoutPromise = createBackfillTimeoutPromise<T>(timeoutMs, label);

  try {
    return await Promise.race([Promise.resolve(operation), abortPromise.promise, timeoutPromise.promise]);
  } finally {
    abortPromise.cleanup();
    timeoutPromise.cleanup();
  }
}

function createBackfillAbortPromise<T>(signal: AbortSignal | undefined): { readonly promise: Promise<T>; readonly cleanup: () => void } {
  if (!signal) return { promise: new Promise<T>(() => { /* never resolves */ }), cleanup: noop };

  let cleanup = noop;
  const promise = new Promise<T>((_resolve, reject) => {
    const abortOperation = (): void => reject(new ObsBackfillInterruptedError("operation cancelled"));
    signal.addEventListener("abort", abortOperation, { once: true });
    cleanup = () => signal.removeEventListener("abort", abortOperation);
  });
  return { promise, cleanup };
}

function createBackfillTimeoutPromise<T>(timeoutMs: number, label: string): { readonly promise: Promise<T>; readonly cleanup: () => void } {
  let timeout: NodeJS.Timeout | undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new ObsBackfillInterruptedError(`${label} timed out`)), timeoutMs);
  });
  return { promise, cleanup: () => clearTimeout(timeout) };
}

function addExportCountToBackfillInterruption(error: unknown, recordsExported: number): unknown {
  if (error instanceof ObsBackfillInterruptedError) return new ObsBackfillInterruptedError(error.reason, recordsExported);
  return error;
}

function readCurrentSessionEntries(ctx: ObsBackfillCommandContext): readonly SessionEntry[] {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.();
  if (!entries) throw new Error("current session entries are unavailable");
  return entries;
}

function resolveCurrentSessionId(ctx: ObsBackfillCommandContext): string | undefined {
  return normalizeOptionalString(ctx.sessionManager?.getSessionId?.()) ?? normalizeOptionalString(ctx.sessionManager?.getHeader?.()?.id);
}

function parseObsBackfillArgs(args: string): ParsedObsBackfillArgs {
  const parsed = parseObsSubcommandArgs(args, OBS_BACKFILL_SUBCOMMAND);
  if (!parsed.matched) return { error: undefined };
  return parseObsBackfillFlags(parsed.values);
}

function parseObsBackfillFlags(tokens: readonly string[]): ParsedObsBackfillArgs {
  let currentSession = false;
  let since: string | undefined;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--current-session") {
      if (currentSession) return { error: "Repeated option: --current-session." };
      currentSession = true;
      index += 1;
      continue;
    }

    if (token === "--since") {
      if (since !== undefined) return { error: "Repeated option: --since." };
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return { error: missingObsOptionValueMessage("--since") };
      since = value;
      index += 2;
      continue;
    }

    if (token.startsWith("--since=")) {
      if (since !== undefined) return { error: "Repeated option: --since." };
      since = token.slice("--since=".length);
      if (!since) return { error: missingObsOptionValueMessage("--since") };
      index += 1;
      continue;
    }

    return { error: unknownObsOptionMessage(token) };
  }

  if (!currentSession) return { error: "Backfill requires --current-session so historical replay is always explicit." };
  return parsedObsBackfillRequest(currentSession, since);
}

function parsedObsBackfillRequest(currentSession: boolean, since: string | undefined): ParsedObsBackfillArgs {
  if (since === undefined) return { request: { currentSession } };

  const sinceMs = parseSinceDurationMs(since);
  if (sinceMs === undefined) return { error: `Invalid --since duration: ${since}. Use values like 30m, 1h, or 2d.` };
  return { request: { currentSession, since, sinceMs } };
}

function parseSinceDurationMs(value: string): number | undefined {
  const match = sincePattern.exec(value.trim());
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  return amount * millisecondsForSinceUnit(match[2].toLowerCase());
}

function millisecondsForSinceUnit(unit: string): number {
  if (unit === "ms") return 1;
  if (unit === "s") return millisecondsPerSecond;
  if (unit === "m") return millisecondsPerMinute;
  if (unit === "h") return millisecondsPerHour;
  return millisecondsPerDay;
}

function resolveSinceCutoffMs(
  request: ObsBackfillRequest,
  options: Pick<ObsBackfillOptions, "now">,
): number | undefined {
  if (request.sinceMs === undefined) return undefined;
  const now = options.now?.() ?? new Date();
  return now.getTime() - request.sinceMs;
}

function entryIsWithinSince(entry: SessionEntry, cutoffMs: number | undefined): boolean {
  if (cutoffMs === undefined) return true;

  const timestampMs = Date.parse(entry.timestamp);
  return Number.isFinite(timestampMs) && timestampMs >= cutoffMs;
}

function sessionEntryToBackfillRecord(
  entry: SessionEntry,
  config: ObservMeConfig,
  sessionId: string | undefined,
): { readonly record?: ObsBackfillTelemetryRecord; readonly contentCaptured: boolean; readonly redactionFailures: number } {
  const baseAttributes = buildBaseEntryAttributes(entry, config, sessionId);

  if (entry.type === "message") return messageEntryToBackfillRecord(entry, config, baseAttributes);
  if (entry.type === "model_change") return modelChangeEntryToBackfillRecord(entry, baseAttributes);
  if (entry.type === "thinking_level_change") return thinkingChangeEntryToBackfillRecord(entry, baseAttributes);
  if (entry.type === "compaction") return compactionEntryToBackfillRecord(entry, baseAttributes);
  if (entry.type === "branch_summary") return branchSummaryEntryToBackfillRecord(entry, baseAttributes);
  return { contentCaptured: false, redactionFailures: 0 };
}

function buildBaseEntryAttributes(entry: SessionEntry, config: ObservMeConfig, sessionId: string | undefined): ObsBackfillAttributes {
  return withoutUndefinedAttributes({
    [COMMON_SPAN_ATTRIBUTES.PI_SESSION_ID]: sessionId,
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_ID]: entry.id,
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_PARENT_ID]: entry.parentId ?? undefined,
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_TYPE]: entry.type,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_REPLAYED]: true,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_CAPTURE_PROMPTS]: config.capture.prompts,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_CAPTURE_RESPONSES]: config.capture.responses,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_CAPTURE_TOOL_ARGUMENTS]: config.capture.toolArguments,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_REDACTION_ENABLED]: config.privacy.redactionEnabled,
  });
}

function messageEntryToBackfillRecord(
  entry: Extract<SessionEntry, { type: "message" }>,
  config: ObservMeConfig,
  baseAttributes: ObsBackfillAttributes,
): { readonly record?: ObsBackfillTelemetryRecord; readonly contentCaptured: boolean; readonly redactionFailures: number } {
  const message = entry.message as unknown as Record<string, unknown>;
  const role = readString(message, "role");

  if (role === "user") return userMessageToBackfillRecord(entry, message, config, baseAttributes);
  if (role === "assistant") return assistantMessageToBackfillRecord(entry, message, config, baseAttributes);
  if (role === "toolResult") return toolResultMessageToBackfillRecord(entry, message, config, baseAttributes);
  if (role === "bashExecution") return bashExecutionMessageToBackfillRecord(entry, message, config, baseAttributes);
  return unknownMessageToBackfillRecord(entry, role, baseAttributes);
}

function userMessageToBackfillRecord(
  entry: SessionEntry,
  message: Record<string, unknown>,
  config: ObservMeConfig,
  baseAttributes: ObsBackfillAttributes,
): { readonly record: ObsBackfillTelemetryRecord; readonly contentCaptured: boolean; readonly redactionFailures: number } {
  const attributes: ObsBackfillAttributes = { ...baseAttributes, "pi.message.role": "user" };
  const content = extractTextContent(readUnknown(message, "content"));
  attributes["pi.message.content_length"] = content?.length ?? 0;
  const contentResult = maybeAttachCapturedContent(attributes, LLM_ATTRIBUTES.PI_LLM_PROMPT_REDACTED, content, "prompt", config, config.capture.prompts);

  return {
    record: createBackfillRecord(LOG_EVENT_NAMES.LLM_PROMPT_CAPTURED, entry, attributes),
    contentCaptured: contentResult.captured,
    redactionFailures: contentResult.redactionFailures,
  };
}

function assistantMessageToBackfillRecord(
  entry: SessionEntry,
  message: Record<string, unknown>,
  config: ObservMeConfig,
  baseAttributes: ObsBackfillAttributes,
): { readonly record: ObsBackfillTelemetryRecord; readonly contentCaptured: boolean; readonly redactionFailures: number } {
  const attributes = assistantMessageAttributes(message, baseAttributes);
  const content = readUnknown(message, "content");
  const responseResult = maybeAttachCapturedContent(
    attributes,
    LLM_ATTRIBUTES.PI_LLM_RESPONSE_REDACTED,
    extractTextContent(content),
    "response",
    config,
    config.capture.responses,
  );
  const thinkingResult = maybeAttachCapturedContent(
    attributes,
    LLM_ATTRIBUTES.PI_LLM_THINKING_REDACTED,
    extractThinkingContent(content),
    "response",
    config,
    config.capture.thinking,
  );
  const toolArgsResult = maybeAttachCapturedContent(
    attributes,
    TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_REDACTED,
    extractToolCallArgumentsContent(content),
    "toolArgument",
    config,
    config.capture.toolArguments,
  );

  return {
    record: createBackfillRecord(LOG_EVENT_NAMES.LLM_REQUEST_COMPLETED, entry, attributes),
    contentCaptured: responseResult.captured || thinkingResult.captured || toolArgsResult.captured,
    redactionFailures: responseResult.redactionFailures + thinkingResult.redactionFailures + toolArgsResult.redactionFailures,
  };
}

function assistantMessageAttributes(message: Record<string, unknown>, baseAttributes: ObsBackfillAttributes): ObsBackfillAttributes {
  const content = readUnknown(message, "content");
  const usage = readRecord(message, "usage");
  const cost = readRecord(usage, "cost");

  return withoutUndefinedAttributes({
    ...baseAttributes,
    "pi.message.role": "assistant",
    [LLM_ATTRIBUTES.GEN_AI_PROVIDER_NAME]: readString(message, "provider"),
    [LLM_ATTRIBUTES.GEN_AI_REQUEST_MODEL]: readString(message, "model"),
    [LLM_ATTRIBUTES.GEN_AI_RESPONSE_MODEL]: readString(message, "responseModel"),
    [LLM_ATTRIBUTES.GEN_AI_RESPONSE_ID]: readString(message, "responseId"),
    [LLM_ATTRIBUTES.PI_LLM_API]: readString(message, "api"),
    [LLM_ATTRIBUTES.PI_LLM_STOP_REASON]: readString(message, "stopReason"),
    [LLM_ATTRIBUTES.GEN_AI_USAGE_INPUT_TOKENS]: readNumber(usage, "input"),
    [LLM_ATTRIBUTES.GEN_AI_USAGE_OUTPUT_TOKENS]: readNumber(usage, "output"),
    [LLM_ATTRIBUTES.GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: readNumber(usage, "cacheRead"),
    [LLM_ATTRIBUTES.GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: readNumber(usage, "cacheWrite"),
    [LLM_ATTRIBUTES.GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: readNumber(usage, "reasoning"),
    [LLM_ATTRIBUTES.PI_LLM_USAGE_TOTAL_TOKENS]: readNumber(usage, "totalTokens"),
    [LLM_ATTRIBUTES.PI_LLM_COST_TOTAL_USD]: readNumber(cost, "total"),
    "pi.llm.tool_call_count": extractToolCalls(content).length,
    "pi.message.content_length": extractTextContent(content)?.length ?? 0,
  });
}

function toolResultMessageToBackfillRecord(
  entry: SessionEntry,
  message: Record<string, unknown>,
  config: ObservMeConfig,
  baseAttributes: ObsBackfillAttributes,
): { readonly record: ObsBackfillTelemetryRecord; readonly contentCaptured: boolean; readonly redactionFailures: number } {
  const attributes = withoutUndefinedAttributes({
    ...baseAttributes,
    "pi.message.role": "toolResult",
    [TOOL_ATTRIBUTES.PI_TOOL_CALL_ID]: readString(message, "toolCallId"),
    [TOOL_ATTRIBUTES.PI_TOOL_NAME]: readString(message, "toolName"),
    [TOOL_ATTRIBUTES.PI_TOOL_SUCCESS]: readBoolean(message, "isError") === true ? false : true,
  });
  const content = extractTextContent(readUnknown(message, "content"));
  attributes[TOOL_ATTRIBUTES.PI_TOOL_RESULT_SIZE] = content?.length ?? 0;
  const contentResult = maybeAttachCapturedContent(attributes, TOOL_ATTRIBUTES.PI_TOOL_RESULT_REDACTED, content, "toolResult", config, config.capture.toolResults);

  return {
    record: createBackfillRecord(readBoolean(message, "isError") === true ? LOG_EVENT_NAMES.TOOL_CALL_FAILED : LOG_EVENT_NAMES.TOOL_CALL_COMPLETED, entry, attributes),
    contentCaptured: contentResult.captured,
    redactionFailures: contentResult.redactionFailures,
  };
}

function bashExecutionMessageToBackfillRecord(
  entry: SessionEntry,
  message: Record<string, unknown>,
  config: ObservMeConfig,
  baseAttributes: ObsBackfillAttributes,
): { readonly record: ObsBackfillTelemetryRecord; readonly contentCaptured: boolean; readonly redactionFailures: number } {
  const command = readString(message, "command");
  const output = readString(message, "output");
  const attributes = withoutUndefinedAttributes({
    ...baseAttributes,
    "pi.message.role": "bashExecution",
    [BASH_ATTRIBUTES.PI_BASH_EXIT_CODE]: readNumber(message, "exitCode"),
    [BASH_ATTRIBUTES.PI_BASH_CANCELLED]: readBoolean(message, "cancelled"),
    [BASH_ATTRIBUTES.PI_BASH_TRUNCATED]: readBoolean(message, "truncated"),
    [BASH_ATTRIBUTES.PI_BASH_OUTPUT_SIZE]: output?.length ?? 0,
    [BASH_ATTRIBUTES.PI_BASH_FULL_OUTPUT_PATH_PRESENT]: Boolean(readString(message, "fullOutputPath")),
    [BASH_ATTRIBUTES.PI_BASH_EXCLUDE_FROM_CONTEXT]: readBoolean(message, "excludeFromContext"),
  });
  const commandResult = maybeAttachCapturedContent(attributes, BASH_ATTRIBUTES.PI_BASH_COMMAND_REDACTED, command, "logBody", config, config.capture.bashCommands);
  const outputResult = maybeAttachCapturedContent(attributes, BASH_ATTRIBUTES.PI_BASH_OUTPUT_REDACTED, output, "bashOutput", config, config.capture.bashOutput);

  return {
    record: createBackfillRecord(LOG_EVENT_NAMES.BASH_COMPLETED, entry, attributes),
    contentCaptured: commandResult.captured || outputResult.captured,
    redactionFailures: commandResult.redactionFailures + outputResult.redactionFailures,
  };
}

function unknownMessageToBackfillRecord(
  entry: SessionEntry,
  role: string | undefined,
  baseAttributes: ObsBackfillAttributes,
): { readonly record: ObsBackfillTelemetryRecord; readonly contentCaptured: false; readonly redactionFailures: 0 } {
  const attributes = withoutUndefinedAttributes({ ...baseAttributes, "pi.message.role": role ?? "unknown" });
  return {
    record: createBackfillRecord("message.replayed", entry, attributes),
    contentCaptured: false,
    redactionFailures: 0,
  };
}

function modelChangeEntryToBackfillRecord(
  entry: Extract<SessionEntry, { type: "model_change" }>,
  baseAttributes: ObsBackfillAttributes,
): { readonly record: ObsBackfillTelemetryRecord; readonly contentCaptured: false; readonly redactionFailures: 0 } {
  const attributes = withoutUndefinedAttributes({
    ...baseAttributes,
    [LLM_ATTRIBUTES.GEN_AI_PROVIDER_NAME]: entry.provider,
    [LLM_ATTRIBUTES.GEN_AI_REQUEST_MODEL]: entry.modelId,
  });
  return {
    record: createBackfillRecord(LOG_EVENT_NAMES.MODEL_CHANGED, entry, attributes),
    contentCaptured: false,
    redactionFailures: 0,
  };
}

function thinkingChangeEntryToBackfillRecord(
  entry: Extract<SessionEntry, { type: "thinking_level_change" }>,
  baseAttributes: ObsBackfillAttributes,
): { readonly record: ObsBackfillTelemetryRecord; readonly contentCaptured: false; readonly redactionFailures: 0 } {
  const attributes = withoutUndefinedAttributes({ ...baseAttributes, [LLM_ATTRIBUTES.PI_LLM_REQUEST_THINKING_LEVEL]: entry.thinkingLevel });
  return {
    record: createBackfillRecord(LOG_EVENT_NAMES.THINKING_CHANGED, entry, attributes),
    contentCaptured: false,
    redactionFailures: 0,
  };
}

function compactionEntryToBackfillRecord(
  entry: Extract<SessionEntry, { type: "compaction" }>,
  baseAttributes: ObsBackfillAttributes,
): { readonly record: ObsBackfillTelemetryRecord; readonly contentCaptured: false; readonly redactionFailures: 0 } {
  const attributes = withoutUndefinedAttributes({
    ...baseAttributes,
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_FIRST_KEPT_ENTRY_ID]: entry.firstKeptEntryId,
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_TOKENS_BEFORE]: entry.tokensBefore,
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_SUMMARY_LENGTH]: entry.summary.length,
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_FROM_HOOK]: entry.fromHook === true,
  });
  return {
    record: createBackfillRecord(LOG_EVENT_NAMES.COMPACTION_CREATED, entry, attributes),
    contentCaptured: false,
    redactionFailures: 0,
  };
}

function branchSummaryEntryToBackfillRecord(
  entry: Extract<SessionEntry, { type: "branch_summary" }>,
  baseAttributes: ObsBackfillAttributes,
): { readonly record: ObsBackfillTelemetryRecord; readonly contentCaptured: false; readonly redactionFailures: 0 } {
  const attributes = withoutUndefinedAttributes({
    ...baseAttributes,
    "pi.branch.from_id": entry.fromId,
    "pi.branch.summary.length": entry.summary.length,
    "pi.branch.from_hook": entry.fromHook === true,
  });
  return {
    record: createBackfillRecord(LOG_EVENT_NAMES.BRANCH_CREATED, entry, attributes),
    contentCaptured: false,
    redactionFailures: 0,
  };
}

function createBackfillRecord(
  eventName: string,
  entry: SessionEntry,
  attributes: ObsBackfillAttributes,
): ObsBackfillTelemetryRecord {
  return {
    eventName,
    body: eventName,
    attributes,
    timestamp: parseEntryTimestamp(entry),
  };
}

function maybeAttachCapturedContent(
  attributes: ObsBackfillAttributes,
  attributeKey: string,
  value: string | undefined,
  kind: ContentLimitKind,
  config: ObservMeConfig,
  captureEnabled: boolean,
): ObsBackfillContentResult {
  if (!captureEnabled || value === undefined || value.length === 0) return { captured: false, redactionFailures: 0 };
  if (!config.privacy.redactionEnabled && config.privacy.allowUnsafeCapture) return attachUnsafeCapturedContent(attributes, attributeKey, value, kind, config);
  return attachRedactedCapturedContent(attributes, attributeKey, value, kind, config);
}

function attachUnsafeCapturedContent(
  attributes: ObsBackfillAttributes,
  attributeKey: string,
  value: string,
  kind: ContentLimitKind,
  config: ObservMeConfig,
): ObsBackfillContentResult {
  const result = truncateContent(value, kind, config.limits);
  attributes[attributeKey] = result.value;
  Object.assign(attributes, result.attributes);
  return { captured: true, redactionFailures: 0 };
}

function attachRedactedCapturedContent(
  attributes: ObsBackfillAttributes,
  attributeKey: string,
  value: string,
  kind: ContentLimitKind,
  config: ObservMeConfig,
): ObsBackfillContentResult {
  const result = redactValue(value, {
    pathMode: config.privacy.pathMode,
    customRedactionPatterns: config.privacy.customRedactionPatterns,
    maxOutputChars: limitForBackfillContent(kind, config),
  });

  if (result.dropped || result.value === undefined) return { captured: false, redactionFailures: result.failureMetrics.redactionFailures || 1 };

  attributes[attributeKey] = result.value;
  if (result.truncated) attributes[COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED] = true;
  if (result.originalLength !== undefined) attributes[COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH] = result.originalLength;
  return { captured: true, redactionFailures: 0 };
}

function limitForBackfillContent(kind: ContentLimitKind, config: ObservMeConfig): number {
  if (kind === "prompt") return config.limits.maxPromptChars;
  if (kind === "response") return config.limits.maxResponseChars;
  if (kind === "toolArgument") return config.limits.maxToolArgumentChars;
  if (kind === "toolResult") return config.limits.maxToolResultChars;
  if (kind === "bashOutput") return config.limits.maxBashOutputChars;
  return config.limits.maxLogBodyChars;
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;

  const parts = value.map(extractTextBlockContent).filter(isNonEmptyString);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractTextBlockContent(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (readString(value, "type") !== "text") return undefined;
  return readString(value, "text");
}

function extractThinkingContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;

  const parts = value.map(extractThinkingBlockContent).filter(isNonEmptyString);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractThinkingBlockContent(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (readString(value, "type") !== "thinking") return undefined;
  return readString(value, "thinking");
}

function extractToolCallArgumentsContent(value: unknown): string | undefined {
  const toolCalls = extractToolCalls(value);
  if (toolCalls.length === 0) return undefined;
  return safeJsonStringify(toolCalls);
}

function extractToolCalls(value: unknown): ToolCallContent[] {
  if (!Array.isArray(value)) return [];
  return value.map(extractToolCall).filter(isToolCallContent);
}

function extractToolCall(value: unknown): ToolCallContent | undefined {
  if (!isRecord(value)) return undefined;
  if (readString(value, "type") !== "toolCall") return undefined;
  return {
    name: readString(value, "name"),
    arguments: readUnknown(value, "arguments"),
  };
}

function isToolCallContent(value: ToolCallContent | undefined): value is ToolCallContent {
  return value !== undefined;
}

function parseEntryTimestamp(entry: SessionEntry): Date | undefined {
  const timestampMs = Date.parse(entry.timestamp);
  return Number.isFinite(timestampMs) ? new Date(timestampMs) : undefined;
}

function normalizeMaxRecords(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return OBS_BACKFILL_DEFAULT_MAX_RECORDS;
  return Math.trunc(value);
}

function normalizeBackfillOperationTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return OBS_BACKFILL_DEFAULT_OPERATION_TIMEOUT_MS;
  return Math.trunc(value);
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function throwIfBackfillAborted(signal: AbortSignal | undefined): void {
  if (isAbortSignalAborted(signal)) throw new ObsBackfillInterruptedError("operation cancelled");
}

function isAbortLikeError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const name = error["name"];
  return typeof name === "string" && abortErrorNames.has(name);
}

function anyBackfillContentCaptureEnabled(config: ObservMeConfig): boolean {
  return (
    config.capture.prompts ||
    config.capture.responses ||
    config.capture.thinking ||
    config.capture.toolArguments ||
    config.capture.toolResults ||
    config.capture.bashCommands ||
    config.capture.bashOutput
  );
}

function notificationTypeForSummary(summary: ObsBackfillSummary): "info" | "warning" {
  if (summary.status === "completed" && !summary.rateLimited && summary.redactionFailures === 0) return "info";
  return "warning";
}

function renderCancelledObsBackfillSummary(summary: ObsBackfillSummary): string {
  const lines = [`ObservMe backfill cancelled: ${summary.reason ?? "user did not confirm"}.`];
  if (summary.entriesScanned > 0) lines.push(`Entries scanned: ${summary.entriesScanned}`);
  if (summary.entriesEligible > 0) lines.push(`Entries eligible: ${summary.entriesEligible}`);
  if (summary.recordsExported > 0) lines.push(`Records exported before cancellation: ${summary.recordsExported}`);
  if (summary.recordsSkipped > 0) lines.push(`Records not exported: ${summary.recordsSkipped}`);
  return lines.join("\n");
}

async function notifyBackfill(
  ctx: ObsBackfillCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): Promise<void> {
  await ctx.ui.notify(message, type);
}

function withoutUndefinedAttributes(values: Record<string, ObsBackfillAttributeValue | undefined>): ObsBackfillAttributes {
  const attributes: ObsBackfillAttributes = {};

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) attributes[key] = value;
  }

  return attributes;
}

function readUnknown(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const nested = readUnknown(value, key);
  return isRecord(nested) ? nested : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const raw = readUnknown(value, key);
  return typeof raw === "string" ? raw : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const raw = readUnknown(value, key);
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  const raw = readUnknown(value, key);
  return typeof raw === "boolean" ? raw : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : undefined;
  } catch (_error) {
    return undefined;
  }
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function formatBackfillError(error: unknown): string {
  if (error instanceof ObsBackfillInterruptedError) return error.reason;
  if (isAbortLikeError(error)) return "operation cancelled";
  return "operation failed";
}

function noop(): void {
  // Intentionally empty.
}
