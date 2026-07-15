import { setTimeout as delay } from "node:timers/promises";
import { readDiagnosticMessage, sanitizeDiagnosticText } from "../diagnostics/sanitize.ts";

export interface FlushableOtelSdk {
  forceFlush?: () => Promise<void> | void;
}

export interface ShutdownableOtelSdk extends FlushableOtelSdk {
  shutdown?: () => Promise<void> | void;
}

export interface OtelOperationSettlement {
  readonly operation: "flush" | "shutdown";
  readonly completed: boolean;
  readonly timedOut: false;
  readonly error?: unknown;
}

export interface BoundedOtelOperationResult {
  readonly operation: "flush" | "shutdown";
  readonly completed: boolean;
  readonly timedOut: boolean;
  readonly error?: unknown;
  readonly settlement?: Promise<OtelOperationSettlement>;
}

export interface OtelShutdownLogSink {
  warn?: (message: string) => void;
}

export async function flushOtelSdk(
  sdk: FlushableOtelSdk | undefined,
  timeoutMs: number,
  logger?: OtelShutdownLogSink,
): Promise<BoundedOtelOperationResult> {
  if (!sdk?.forceFlush) return completedOperation("flush");

  const result = await runBoundedOtelOperation("flush", sdk.forceFlush.bind(sdk), timeoutMs);
  logBoundedOperationIssue(result, logger);
  return result;
}

export async function shutdownOtelSdk(
  sdk: ShutdownableOtelSdk | undefined,
  timeoutMs: number,
  logger?: OtelShutdownLogSink,
): Promise<BoundedOtelOperationResult> {
  if (!sdk?.shutdown) return completedOperation("shutdown");

  const result = await runBoundedOtelOperation("shutdown", sdk.shutdown.bind(sdk), timeoutMs);
  logBoundedOperationIssue(result, logger);
  return result;
}

export async function runBoundedOtelOperation(
  operation: "flush" | "shutdown",
  action: () => Promise<void> | void,
  timeoutMs: number,
): Promise<BoundedOtelOperationResult> {
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const timeoutController = new AbortController();
  const timeoutResult = timeoutOperation(operation, normalizedTimeoutMs, timeoutController.signal);

  try {
    const settlement = settleOperation(operation, action);
    const result = await Promise.race([settlement, timeoutResult]);
    if (!result.timedOut) return result;
    return { ...result, settlement };
  } finally {
    timeoutController.abort();
  }
}

function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return 0;
  return timeoutMs;
}

async function settleOperation(
  operation: "flush" | "shutdown",
  action: () => Promise<void> | void,
): Promise<OtelOperationSettlement> {
  try {
    await action();
    return completedOperation(operation);
  } catch (error) {
    return { operation, completed: false, timedOut: false, error };
  }
}

async function timeoutOperation(
  operation: "flush" | "shutdown",
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BoundedOtelOperationResult> {
  return delay(timeoutMs, { operation, completed: false, timedOut: true } as const, { signal });
}

function completedOperation(operation: "flush" | "shutdown"): OtelOperationSettlement {
  return { operation, completed: true, timedOut: false };
}

function logBoundedOperationIssue(result: BoundedOtelOperationResult, logger: OtelShutdownLogSink | undefined): void {
  if (result.timedOut) {
    warnOtelOperation(logger, `ObservMe OTEL ${result.operation} exceeded timeout and remains pending.`);
    void result.settlement?.then(logLateOperationIssue.bind(undefined, logger));
    return;
  }

  logLateOperationIssue(logger, result);
}

function logLateOperationIssue(
  logger: OtelShutdownLogSink | undefined,
  result: Pick<BoundedOtelOperationResult, "operation" | "error">,
): void {
  if (result.error) warnOtelOperation(logger, `ObservMe OTEL ${result.operation} failed: ${formatError(result.error)}`);
}

function warnOtelOperation(logger: OtelShutdownLogSink | undefined, message: string): void {
  try {
    logger?.warn?.(message);
  } catch {
    return;
  }
}

function formatError(error: unknown): string {
  return sanitizeDiagnosticText(readDiagnosticMessage(error));
}
