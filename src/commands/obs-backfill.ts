import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import { type ObservMeLogSdk, createLogSessionScopedOtelSdk } from "../otel/logs.ts";
import type { BoundedOtelOperationResult } from "../otel/shutdown.ts";
import { flushOtelSdk, shutdownOtelSdk } from "../otel/shutdown.ts";
import { applyContentCapturePolicy } from "../privacy/content-capture.ts";
import type { ContentLimitKind } from "../privacy/truncate.ts";
import {
  BASH_ATTRIBUTES,
  BRANCH_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  COMPACTION_ATTRIBUTES,
  LLM_ATTRIBUTES,
  LOG_ATTRIBUTES,
  MESSAGE_ATTRIBUTES,
  TOOL_ATTRIBUTES,
} from "../semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../semconv/metrics.ts";
import {
  completeObsSubcommand,
  missingObsOptionValueMessage,
  parseObsSubcommandArgs,
  unknownObsOptionMessage,
} from "./obs-args.ts";
import { loadObsCommandConfig, normalizeObsCommandTimeoutMs, notifyObsCommand } from "./obs-command-support.ts";

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
  /**
   * Cooperative cancellation signal for this backfill run. Custom exporters should stop
   * pending work when this signal is aborted; non-cancellable work must be idempotent
   * and avoid emitting additional records after observing cancellation.
   */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
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
  /**
   * Validated source occurrence time. When absent or invalid, the production
   * exporter omits it so OpenTelemetry uses replay time instead of inventing a
   * historical timestamp.
   */
  readonly timestamp?: Date;
}

export interface ObsBackfillExporter {
  emit: (record: ObsBackfillTelemetryRecord, options?: ObsBackfillOperationOptions) => Promise<void> | void;
  flush?: (options?: ObsBackfillOperationOptions) => Promise<void> | void;
  shutdown?: (options?: ObsBackfillOperationOptions) => Promise<void> | void;
}

export interface ObsBackfillSummary {
  readonly status: "completed" | "partial" | "cancelled" | "skipped";
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly since?: string;
  readonly entriesScanned: number;
  readonly entriesEligible: number;
  readonly recordsAttempted: number;
  readonly recordsQueued: number;
  readonly recordsConfirmed: number;
  readonly recordsUnknown: number;
  readonly recordsNotAttempted: number;
  /** Records excluded by the configured backfill rate limit. */
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
  options?: ObsBackfillOperationOptions,
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

interface ObsBackfillDeliveryProgress {
  readonly recordsSelected: number;
  recordsAttempted: number;
  recordsQueued: number;
  flushSucceeded: boolean;
}

interface ObsBackfillDeliveryOutcome {
  readonly recordsAttempted: number;
  readonly recordsQueued: number;
  readonly recordsConfirmed: number;
  readonly recordsUnknown: number;
  readonly recordsNotAttempted: number;
}

interface BackfillSummaryInput {
  readonly status: ObsBackfillSummary["status"];
  readonly request: ObsBackfillRequest;
  readonly buildResult: ObsBackfillBuildResult;
  readonly delivery: ObsBackfillDeliveryOutcome;
  readonly reason?: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
}

interface ObsBackfillFlagState {
  currentSession: boolean;
  since?: string;
  index: number;
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
const OBS_BACKFILL_ABORT_CLEANUP_TIMEOUT_MS = 100;
const OBS_BACKFILL_CATEGORY = "backfill";
const OBS_BACKFILL_UNKNOWN_SESSION = "unknown";
const millisecondsPerSecond = 1000;
const millisecondsPerMinute = 60 * millisecondsPerSecond;
const millisecondsPerHour = 60 * millisecondsPerMinute;
const millisecondsPerDay = 24 * millisecondsPerHour;
const OBS_BACKFILL_MAX_SINCE_DAYS = 30;
const OBS_BACKFILL_MAX_SINCE_MS = OBS_BACKFILL_MAX_SINCE_DAYS * millisecondsPerDay;
const OBS_BACKFILL_SINCE_HELP = `Use a positive duration up to ${OBS_BACKFILL_MAX_SINCE_DAYS}d, such as 30m, 1h, or 2d.`;
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
    await notifyObsCommand(ctx, parsed.error ? `${OBS_BACKFILL_USAGE}\n${parsed.error}` : OBS_BACKFILL_USAGE, "warning");
    return;
  }

  try {
    const summary = await resolveObsBackfillSummary(ctx, parsed.request, options);
    await notifyObsCommand(ctx, renderObsBackfillSummary(summary), notificationTypeForSummary(summary));
  } catch (error) {
    await notifyObsCommand(ctx, `ObservMe backfill unavailable: ${formatBackfillError(error)}`, "error");
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
  const runScope = new ObsBackfillRunScope(ctx.signal);

  try {
    return await runObsBackfillWithScope(ctx, request, config, operationTimeoutMs, options, runScope);
  } finally {
    runScope.cleanup();
  }
}

export function renderObsBackfillSummary(summary: ObsBackfillSummary): string {
  if (summary.status === "cancelled") return renderCancelledObsBackfillSummary(summary);
  if (summary.status === "partial") return renderPartialObsBackfillSummary(summary);
  if (summary.status === "skipped") return `ObservMe backfill skipped: ${summary.reason ?? "not available"}.`;

  const lines = [
    `Backfilled session: ${summary.sessionId ?? OBS_BACKFILL_UNKNOWN_SESSION}`,
    `Window: ${summary.since ?? "all current-session entries"}`,
    `Entries scanned: ${summary.entriesScanned}`,
    `Entries eligible: ${summary.entriesEligible}`,
  ];
  appendBackfillDeliveryLines(lines, summary);
  appendBackfillQualityLines(lines, summary);
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

export function createObsBackfillLogExporter(
  config: ObservMeConfig,
  options: ObsBackfillOperationOptions = {},
): ObsBackfillExporter {
  const sdk = createLogSessionScopedOtelSdk({ config });
  sdk.start();
  return new ObsBackfillLogExporter(sdk, resolveBackfillOperationTimeoutMs(options, OBS_BACKFILL_DEFAULT_OPERATION_TIMEOUT_MS));
}

const EMPTY_BACKFILL_DELIVERY_OUTCOME: ObsBackfillDeliveryOutcome = {
  recordsAttempted: 0,
  recordsQueued: 0,
  recordsConfirmed: 0,
  recordsUnknown: 0,
  recordsNotAttempted: 0,
};

class ObsBackfillInterruptedError extends Error {
  readonly reason: string;
  readonly delivery: ObsBackfillDeliveryOutcome;
  readonly timedOut: boolean;
  readonly cancelled: boolean;

  constructor(
    reason: string,
    delivery: ObsBackfillDeliveryOutcome = EMPTY_BACKFILL_DELIVERY_OUTCOME,
    timedOut = false,
    cancelled = false,
  ) {
    super(reason);
    this.name = "ObsBackfillInterruptedError";
    this.reason = reason;
    this.delivery = delivery;
    this.timedOut = timedOut;
    this.cancelled = cancelled;
  }
}

class ObsBackfillRunScope {
  readonly #controller = new AbortController();
  readonly #parentSignal?: AbortSignal;
  readonly #abortFromParent = (): void => {
    this.abort("operation cancelled");
  };

  constructor(parentSignal: AbortSignal | undefined) {
    this.#parentSignal = parentSignal;
    if (parentSignal?.aborted) {
      this.abort("operation cancelled");
      return;
    }

    parentSignal?.addEventListener("abort", this.#abortFromParent, { once: true });
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  abort(reason: string): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
  }

  cleanup(): void {
    this.#parentSignal?.removeEventListener("abort", this.#abortFromParent);
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

export class ObsBackfillLogExporter implements ObsBackfillExporter {
  readonly #sdk: ObservMeLogSdk;
  readonly #operationTimeoutMs: number;

  constructor(sdk: ObservMeLogSdk, operationTimeoutMs: number) {
    this.#sdk = sdk;
    this.#operationTimeoutMs = operationTimeoutMs;
  }

  emit(record: ObsBackfillTelemetryRecord, options?: ObsBackfillOperationOptions): void {
    throwIfBackfillAborted(options?.signal);
    const timestamp = validBackfillLogTimestamp(record.timestamp);
    this.#sdk.logger.emit({
      ...(timestamp ? { timestamp } : {}),
      severityText: "INFO",
      body: record.body,
      attributes: {
        [LOG_ATTRIBUTES.EVENT_NAME]: record.eventName,
        [LOG_ATTRIBUTES.EVENT_CATEGORY]: OBS_BACKFILL_CATEGORY,
        ...record.attributes,
      },
    });
  }

  async flush(options?: ObsBackfillOperationOptions): Promise<void> {
    throwIfBackfillAborted(options?.signal);
    const result = await flushOtelSdk(this.#sdk, resolveBackfillOperationTimeoutMs(options, this.#operationTimeoutMs));
    throwIfBackfillOtelOperationFailed(result, "export flush");
    throwIfBackfillAborted(options?.signal);
  }

  async shutdown(options?: ObsBackfillOperationOptions): Promise<void> {
    const result = await shutdownOtelSdk(this.#sdk, resolveBackfillOperationTimeoutMs(options, this.#operationTimeoutMs));
    throwIfBackfillOtelOperationFailed(result, "export shutdown");
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

async function runObsBackfillWithScope(
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  config: ObservMeConfig,
  operationTimeoutMs: number,
  options: ObsBackfillOptions,
  runScope: ObsBackfillRunScope,
): Promise<ObsBackfillSummary> {
  try {
    await waitForObsBackfillIdle(ctx, operationTimeoutMs, runScope.signal, runScope);
  } catch (error) {
    if (error instanceof ObsBackfillInterruptedError) return cancelledBackfillSummary(ctx, request, error.reason);
    throw error;
  }

  const entries = readCurrentSessionEntries(ctx);
  const sessionId = resolveCurrentSessionId(ctx);
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  const buildResult = buildObsBackfillRecords(entries, config, request, sessionId, options);

  try {
    if (buildResult.records.length === 0) {
      throwIfBackfillAborted(runScope.signal);
      return completedBackfillSummary(ctx, request, buildResult, EMPTY_BACKFILL_DELIVERY_OUTCOME, sessionId, sessionFile);
    }

    const delivery = await exportObsBackfillRecords(buildResult.records, config, ctx, runScope.signal, operationTimeoutMs, options, runScope);
    return completedBackfillSummary(ctx, request, buildResult, delivery, sessionId, sessionFile);
  } catch (error) {
    if (error instanceof ObsBackfillInterruptedError) {
      return interruptedBackfillSummary(ctx, request, buildResult, error, sessionId, sessionFile);
    }

    throw error;
  }
}

async function loadObsBackfillConfig(
  ctx: ObsBackfillCommandContext,
  options: ObsBackfillOptions,
): Promise<ObservMeConfig> {
  return loadObsCommandConfig(ctx, options);
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
  return ctx.hasUI !== false && typeof ctx.ui?.confirm === "function";
}

function buildBackfillConfirmationMessage(
  request: ObsBackfillRequest,
  config: ObservMeConfig,
  options: ObsBackfillOptions,
): string {
  const contentMode = describeBackfillContentMode(config);
  return [
    "Send historical ObservMe telemetry for the current Pi session?",
    `Window: ${request.since ?? "all current-session entries"}`,
    `Rate limit: ${normalizeMaxRecords(options.maxRecords)} record(s)` ,
    `Content mode: ${contentMode}`,
    `Replayed telemetry will be marked ${COMMON_SPAN_ATTRIBUTES.OBSERVME_REPLAYED}=true.`,
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
    recordsAttempted: 0,
    recordsQueued: 0,
    recordsConfirmed: 0,
    recordsUnknown: 0,
    recordsNotAttempted: 0,
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
    recordsAttempted: 0,
    recordsQueued: 0,
    recordsConfirmed: 0,
    recordsUnknown: 0,
    recordsNotAttempted: 0,
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
  delivery: ObsBackfillDeliveryOutcome,
  sessionId = resolveCurrentSessionId(ctx),
  sessionFile = ctx.sessionManager?.getSessionFile?.(),
): ObsBackfillSummary {
  return backfillSummary({ status: "completed", request, buildResult, delivery, sessionId, sessionFile });
}

function interruptedBackfillSummary(
  ctx: ObsBackfillCommandContext,
  request: ObsBackfillRequest,
  buildResult: ObsBackfillBuildResult,
  error: ObsBackfillInterruptedError,
  sessionId = resolveCurrentSessionId(ctx),
  sessionFile = ctx.sessionManager?.getSessionFile?.(),
): ObsBackfillSummary {
  const status = error.cancelled ? "cancelled" : "partial";
  return backfillSummary({ status, request, buildResult, delivery: error.delivery, reason: error.reason, sessionId, sessionFile });
}

function backfillSummary(input: BackfillSummaryInput): ObsBackfillSummary {
  return {
    status: input.status,
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    since: input.request.since,
    entriesScanned: input.buildResult.entriesScanned,
    entriesEligible: input.buildResult.entriesEligible,
    recordsAttempted: input.delivery.recordsAttempted,
    recordsQueued: input.delivery.recordsQueued,
    recordsConfirmed: input.delivery.recordsConfirmed,
    recordsUnknown: input.delivery.recordsUnknown,
    recordsNotAttempted: input.delivery.recordsNotAttempted,
    recordsSkipped: input.buildResult.recordsSkipped,
    rateLimited: input.buildResult.rateLimited,
    contentCaptured: input.buildResult.contentCaptured,
    redactionFailures: input.buildResult.redactionFailures,
    reason: input.reason,
  };
}

async function waitForObsBackfillIdle(
  ctx: ObsBackfillCommandContext,
  operationTimeoutMs: number,
  signal: AbortSignal,
  runScope: ObsBackfillRunScope,
): Promise<void> {
  if (!ctx.waitForIdle) return;
  await runBackfillOperation(ctx.waitForIdle({ signal, timeoutMs: operationTimeoutMs }), signal, operationTimeoutMs, "wait for idle", runScope);
}

async function exportObsBackfillRecords(
  records: readonly ObsBackfillTelemetryRecord[],
  config: ObservMeConfig,
  ctx: ObsBackfillCommandContext,
  signal: AbortSignal,
  operationTimeoutMs: number,
  options: ObsBackfillOptions,
  runScope: ObsBackfillRunScope,
): Promise<ObsBackfillDeliveryOutcome> {
  const progress = createBackfillDeliveryProgress(records.length);
  const exporter = await createObsBackfillExporter(config, ctx, signal, operationTimeoutMs, options, runScope, progress);
  let operationLabel = "export emit";
  let pendingError: unknown;

  try {
    for (const record of records) {
      throwIfBackfillAborted(signal);
      progress.recordsAttempted += 1;
      await runBackfillOperation(exporter.emit(record, { signal, timeoutMs: operationTimeoutMs }), signal, operationTimeoutMs, operationLabel, runScope);
      progress.recordsQueued += 1;
    }

    operationLabel = "export flush";
    throwIfBackfillAborted(signal);
    await runBackfillOperation(exporter.flush?.({ signal, timeoutMs: operationTimeoutMs }), signal, operationTimeoutMs, operationLabel, runScope);
    progress.flushSucceeded = true;
    throwIfBackfillAborted(signal);
  } catch (error) {
    pendingError = backfillOperationError(error, progress, operationLabel);
  } finally {
    pendingError = await shutdownObsBackfillExporter(exporter, signal, operationTimeoutMs, pendingError, progress, runScope);
  }

  if (pendingError === undefined && isAbortSignalAborted(signal)) {
    pendingError = new ObsBackfillInterruptedError("operation cancelled", backfillDeliveryOutcome(progress), false, true);
  }
  if (pendingError !== undefined) throw pendingError;
  return backfillDeliveryOutcome(progress);
}

async function createObsBackfillExporter(
  config: ObservMeConfig,
  ctx: ObsBackfillCommandContext,
  signal: AbortSignal,
  operationTimeoutMs: number,
  options: ObsBackfillOptions,
  runScope: ObsBackfillRunScope,
  progress: ObsBackfillDeliveryProgress,
): Promise<ObsBackfillExporter> {
  try {
    throwIfBackfillAborted(signal);
    const setupOptions = { signal, timeoutMs: operationTimeoutMs };
    const exporter = options.createExporter ? options.createExporter(config, ctx, setupOptions) : createObsBackfillLogExporter(config, setupOptions);
    return await runBackfillOperation(exporter, signal, operationTimeoutMs, "exporter setup", runScope);
  } catch (error) {
    throw backfillOperationError(error, progress, "exporter setup");
  }
}

async function shutdownObsBackfillExporter(
  exporter: ObsBackfillExporter,
  signal: AbortSignal,
  operationTimeoutMs: number,
  pendingError: unknown,
  progress: ObsBackfillDeliveryProgress,
  runScope: ObsBackfillRunScope,
): Promise<unknown> {
  try {
    await runBackfillOperation(exporter.shutdown?.({ signal, timeoutMs: operationTimeoutMs }), undefined, operationTimeoutMs, "export shutdown", runScope);
    return pendingError;
  } catch (shutdownError) {
    return pendingError ?? backfillOperationError(shutdownError, progress, "export shutdown");
  }
}

async function runBackfillOperation<T>(
  operation: Promise<T> | T,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
  runScope?: ObsBackfillRunScope,
): Promise<T> {
  throwIfBackfillAborted(signal);

  const operationPromise = Promise.resolve(operation);
  const abortPromise = createBackfillAbortPromise<T>(signal);
  const timeoutPromise = createBackfillTimeoutPromise<T>(timeoutMs, label);

  try {
    return await Promise.race([operationPromise, abortPromise.promise, timeoutPromise.promise]);
  } catch (error) {
    if (isTimedOutBackfillInterruption(error)) runScope?.abort(error.reason);
    if (shouldWaitForBackfillOperationCleanup(error)) await waitForBackfillOperationCleanup(operationPromise, timeoutMs);

    throw error;
  } finally {
    abortPromise.cleanup();
    timeoutPromise.cleanup();
  }
}

function createBackfillAbortPromise<T>(signal: AbortSignal | undefined): { readonly promise: Promise<T>; readonly cleanup: () => void } {
  if (!signal) return { promise: new Promise<T>(() => { /* never resolves */ }), cleanup: noop };

  let cleanup = noop;
  const promise = new Promise<T>((_resolve, reject) => {
    const abortOperation = (): void => reject(new ObsBackfillInterruptedError("operation cancelled", EMPTY_BACKFILL_DELIVERY_OUTCOME, false, true));
    signal.addEventListener("abort", abortOperation, { once: true });
    cleanup = () => signal.removeEventListener("abort", abortOperation);
  });
  return { promise, cleanup };
}

function createBackfillTimeoutPromise<T>(timeoutMs: number, label: string): { readonly promise: Promise<T>; readonly cleanup: () => void } {
  let timeout: NodeJS.Timeout | undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new ObsBackfillInterruptedError(`${label} timed out`, EMPTY_BACKFILL_DELIVERY_OUTCOME, true)), timeoutMs);
  });
  return { promise, cleanup: () => clearTimeout(timeout) };
}

async function waitForBackfillOperationCleanup<T>(operationPromise: Promise<T>, timeoutMs: number): Promise<void> {
  const cleanupTimeoutMs = Math.min(normalizeBackfillOperationTimeoutMs(timeoutMs), OBS_BACKFILL_ABORT_CLEANUP_TIMEOUT_MS);
  await Promise.race([operationPromise.then(noop, noop), delay(cleanupTimeoutMs, undefined, { ref: false })]);
}

function createBackfillDeliveryProgress(recordsSelected: number): ObsBackfillDeliveryProgress {
  return { recordsSelected, recordsAttempted: 0, recordsQueued: 0, flushSucceeded: false };
}

function backfillDeliveryOutcome(progress: ObsBackfillDeliveryProgress): ObsBackfillDeliveryOutcome {
  return {
    recordsAttempted: progress.recordsAttempted,
    recordsQueued: progress.recordsQueued,
    recordsConfirmed: progress.flushSucceeded ? progress.recordsQueued : 0,
    recordsUnknown: progress.flushSucceeded ? 0 : progress.recordsAttempted,
    recordsNotAttempted: Math.max(0, progress.recordsSelected - progress.recordsAttempted),
  };
}

function backfillOperationError(
  error: unknown,
  progress: ObsBackfillDeliveryProgress,
  label: string,
): ObsBackfillInterruptedError {
  const delivery = backfillDeliveryOutcome(progress);
  if (error instanceof ObsBackfillInterruptedError) {
    return new ObsBackfillInterruptedError(error.reason, delivery, error.timedOut, error.cancelled);
  }
  if (isAbortLikeError(error)) return new ObsBackfillInterruptedError("operation cancelled", delivery, false, true);
  return new ObsBackfillInterruptedError(`${label} failed`, delivery);
}

function isTimedOutBackfillInterruption(error: unknown): error is ObsBackfillInterruptedError {
  return error instanceof ObsBackfillInterruptedError && error.timedOut;
}

function shouldWaitForBackfillOperationCleanup(error: unknown): boolean {
  return error instanceof ObsBackfillInterruptedError || isAbortLikeError(error);
}

function throwIfBackfillOtelOperationFailed(result: BoundedOtelOperationResult, label: string): void {
  if (result.timedOut) throw new ObsBackfillInterruptedError(`${label} timed out`, EMPTY_BACKFILL_DELIVERY_OUTCOME, true);
  if (result.error) throw result.error;
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
  const state: ObsBackfillFlagState = { currentSession: false, index: 0 };

  while (state.index < tokens.length) {
    const result = parseObsBackfillFlag(tokens, state);
    if (result.error) return result;
  }

  if (!state.currentSession) return { error: "Backfill requires --current-session so historical replay is always explicit." };
  return parsedObsBackfillRequest(state.currentSession, state.since);
}

function parseObsBackfillFlag(tokens: readonly string[], state: ObsBackfillFlagState): ParsedObsBackfillArgs {
  const token = tokens[state.index];
  if (token === "--current-session") return parseCurrentSessionBackfillFlag(state);
  if (token === "--since") return parseSeparateSinceBackfillFlag(tokens, state);
  if (token.startsWith("--since=")) return parseInlineSinceBackfillFlag(token, state);
  return { error: unknownObsOptionMessage(token) };
}

function parseCurrentSessionBackfillFlag(state: ObsBackfillFlagState): ParsedObsBackfillArgs {
  if (state.currentSession) return { error: "Repeated option: --current-session." };
  state.currentSession = true;
  state.index += 1;
  return {};
}

function parseSeparateSinceBackfillFlag(tokens: readonly string[], state: ObsBackfillFlagState): ParsedObsBackfillArgs {
  if (state.since !== undefined) return { error: "Repeated option: --since." };

  const value = tokens[state.index + 1];
  if (!value || value.startsWith("--")) return { error: missingObsOptionValueMessage("--since") };
  state.since = value;
  state.index += 2;
  return {};
}

function parseInlineSinceBackfillFlag(token: string, state: ObsBackfillFlagState): ParsedObsBackfillArgs {
  if (state.since !== undefined) return { error: "Repeated option: --since." };

  state.since = token.slice("--since=".length);
  if (!state.since) return { error: missingObsOptionValueMessage("--since") };
  state.index += 1;
  return {};
}

function parsedObsBackfillRequest(currentSession: boolean, since: string | undefined): ParsedObsBackfillArgs {
  if (since === undefined) return { request: { currentSession } };

  const sinceMs = parseSinceDurationMs(since);
  if (sinceMs === undefined) return { error: `Invalid --since duration: ${since}. ${OBS_BACKFILL_SINCE_HELP}` };
  return { request: { currentSession, since, sinceMs } };
}

function parseSinceDurationMs(value: string): number | undefined {
  const match = sincePattern.exec(value.trim());
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;

  const unitMs = millisecondsForSinceUnit(match[2].toLowerCase());
  if (amount > Math.floor(OBS_BACKFILL_MAX_SINCE_MS / unitMs)) return undefined;

  const durationMs = amount * unitMs;
  if (!Number.isSafeInteger(durationMs) || durationMs > OBS_BACKFILL_MAX_SINCE_MS) return undefined;
  return durationMs;
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

  const timestamp = parseEntryTimestamp(entry);
  return timestamp !== undefined && timestamp.getTime() >= cutoffMs;
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
  const attributes: ObsBackfillAttributes = { ...baseAttributes, [MESSAGE_ATTRIBUTES.PI_MESSAGE_ROLE]: "user" };
  const content = extractTextContent(readUnknown(message, "content"));
  attributes[MESSAGE_ATTRIBUTES.PI_MESSAGE_CONTENT_LENGTH] = content?.length ?? 0;
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
    [MESSAGE_ATTRIBUTES.PI_MESSAGE_ROLE]: "assistant",
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
    [LLM_ATTRIBUTES.PI_LLM_TOOL_CALL_COUNT]: extractToolCalls(content).length,
    [MESSAGE_ATTRIBUTES.PI_MESSAGE_CONTENT_LENGTH]: extractTextContent(content)?.length ?? 0,
  });
}

function toolResultMessageToBackfillRecord(
  entry: SessionEntry,
  message: Record<string, unknown>,
  config: ObservMeConfig,
  baseAttributes: ObsBackfillAttributes,
): { readonly record: ObsBackfillTelemetryRecord; readonly contentCaptured: boolean; readonly redactionFailures: number } {
  const failed = readBoolean(message, "isError") === true;
  const attributes = withoutUndefinedAttributes({
    ...baseAttributes,
    [MESSAGE_ATTRIBUTES.PI_MESSAGE_ROLE]: "toolResult",
    [TOOL_ATTRIBUTES.PI_TOOL_CALL_ID]: readString(message, "toolCallId"),
    [TOOL_ATTRIBUTES.PI_TOOL_NAME]: readString(message, "toolName"),
    [TOOL_ATTRIBUTES.PI_TOOL_SUCCESS]: !failed,
  });
  const content = extractTextContent(readUnknown(message, "content"));
  attributes[TOOL_ATTRIBUTES.PI_TOOL_RESULT_SIZE] = content?.length ?? 0;
  const contentResult = maybeAttachCapturedContent(attributes, TOOL_ATTRIBUTES.PI_TOOL_RESULT_REDACTED, content, "toolResult", config, config.capture.toolResults);
  const eventName = failed ? LOG_EVENT_NAMES.TOOL_CALL_FAILED : LOG_EVENT_NAMES.TOOL_CALL_COMPLETED;

  return {
    record: createBackfillRecord(eventName, entry, attributes),
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
    [MESSAGE_ATTRIBUTES.PI_MESSAGE_ROLE]: "bashExecution",
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
  const attributes = withoutUndefinedAttributes({ ...baseAttributes, [MESSAGE_ATTRIBUTES.PI_MESSAGE_ROLE]: role ?? "unknown" });
  return {
    record: createBackfillRecord(LOG_EVENT_NAMES.MESSAGE_REPLAYED, entry, attributes),
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
    [BRANCH_ATTRIBUTES.PI_BRANCH_FROM_ID]: entry.fromId,
    [BRANCH_ATTRIBUTES.PI_BRANCH_SUMMARY_LENGTH]: entry.summary.length,
    [BRANCH_ATTRIBUTES.PI_BRANCH_FROM_HOOK]: entry.fromHook === true,
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
  const result = applyContentCapturePolicy({ captureEnabled, value, kind, config });
  if (!result.captured || result.value === undefined) return { captured: false, redactionFailures: result.redactionFailures };

  attributes[attributeKey] = result.value;
  Object.assign(attributes, result.attributes);
  return { captured: true, redactionFailures: 0 };
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
  if (typeof entry.timestamp !== "string") return undefined;

  const timestampMs = Date.parse(entry.timestamp);
  return Number.isFinite(timestampMs) ? new Date(timestampMs) : undefined;
}

function validBackfillLogTimestamp(timestamp: Date | undefined): Date | undefined {
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) return undefined;
  return timestamp;
}

function normalizeMaxRecords(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return OBS_BACKFILL_DEFAULT_MAX_RECORDS;
  return Math.trunc(value);
}

function normalizeBackfillOperationTimeoutMs(value: number | undefined): number {
  return normalizeObsCommandTimeoutMs(value, OBS_BACKFILL_DEFAULT_OPERATION_TIMEOUT_MS);
}

function resolveBackfillOperationTimeoutMs(options: ObsBackfillOperationOptions | undefined, fallback: number): number {
  if (options?.timeoutMs === undefined) return normalizeBackfillOperationTimeoutMs(fallback);
  return normalizeBackfillOperationTimeoutMs(options.timeoutMs);
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function throwIfBackfillAborted(signal: AbortSignal | undefined): void {
  if (isAbortSignalAborted(signal)) {
    throw new ObsBackfillInterruptedError("operation cancelled", EMPTY_BACKFILL_DELIVERY_OUTCOME, false, true);
  }
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

function describeBackfillContentMode(config: ObservMeConfig): string {
  if (!anyBackfillContentCaptureEnabled(config)) return "content capture is disabled";
  if (!config.privacy.redactionEnabled && config.privacy.allowUnsafeCapture) return "enabled capture flags will export raw truncated content";
  return "enabled capture flags will be redacted before export";
}

function notificationTypeForSummary(summary: ObsBackfillSummary): "info" | "warning" {
  if (summary.status === "completed" && !summary.rateLimited && summary.redactionFailures === 0) return "info";
  return "warning";
}

function renderPartialObsBackfillSummary(summary: ObsBackfillSummary): string {
  const lines = [
    `ObservMe backfill incomplete: ${summary.reason ?? "delivery outcome is incomplete"}.`,
    `Backfill session: ${summary.sessionId ?? OBS_BACKFILL_UNKNOWN_SESSION}`,
    `Window: ${summary.since ?? "all current-session entries"}`,
    `Entries scanned: ${summary.entriesScanned}`,
    `Entries eligible: ${summary.entriesEligible}`,
  ];
  appendBackfillDeliveryLines(lines, summary);
  appendBackfillQualityLines(lines, summary);
  appendBackfillRetryGuidance(lines, summary);
  return lines.join("\n");
}

function renderCancelledObsBackfillSummary(summary: ObsBackfillSummary): string {
  const lines = [`ObservMe backfill cancelled: ${summary.reason ?? "user did not confirm"}.`];
  if (summary.entriesScanned === 0) return lines.join("\n");

  lines.push(`Entries scanned: ${summary.entriesScanned}`);
  lines.push(`Entries eligible: ${summary.entriesEligible}`);
  appendBackfillDeliveryLines(lines, summary);
  appendBackfillQualityLines(lines, summary);
  appendBackfillRetryGuidance(lines, summary);
  return lines.join("\n");
}

function appendBackfillDeliveryLines(lines: string[], summary: ObsBackfillSummary): void {
  lines.push(`Records attempted: ${summary.recordsAttempted}`);
  lines.push(`Records queued: ${summary.recordsQueued}`);
  lines.push(`Records confirmed exported: ${summary.recordsConfirmed}`);
  lines.push(`Records with unknown delivery: ${summary.recordsUnknown}`);
  lines.push(`Records not attempted: ${summary.recordsNotAttempted}`);
  const attemptedNotQueued = summary.recordsAttempted - summary.recordsQueued;
  if (attemptedNotQueued > 0) lines.push(`Records without queue acknowledgement: ${attemptedNotQueued}`);
}

function appendBackfillQualityLines(lines: string[], summary: ObsBackfillSummary): void {
  lines.push(`Content captured: ${formatBoolean(summary.contentCaptured)}`);
  if (summary.rateLimited) lines.push(`Rate limit: applied; skipped ${summary.recordsSkipped} eligible record(s)`);
  if (summary.redactionFailures > 0) lines.push(`Redaction failures: ${summary.redactionFailures}`);
}

function appendBackfillRetryGuidance(lines: string[], summary: ObsBackfillSummary): void {
  const attemptedNotQueued = summary.recordsAttempted - summary.recordsQueued;
  if (summary.recordsUnknown > 0) {
    lines.push(`Retry guidance: delivery is unknown for ${summary.recordsUnknown} attempted record(s); inspect the destination before retrying because replay may create duplicates.`);
    return;
  }
  if (summary.recordsNotAttempted > 0 || attemptedNotQueued > 0) {
    lines.push("Retry guidance: retry the same backfill after resolving the failure; queued records have no unknown delivery.");
    return;
  }
  if (summary.status === "partial" && summary.recordsConfirmed > 0) {
    lines.push("Retry guidance: all queued records were confirmed; do not replay them solely because exporter shutdown failed.");
  }
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
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return raw;
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
  return trimmed || undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : undefined;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
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
