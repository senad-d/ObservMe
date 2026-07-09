import { setTimeout as delay } from "node:timers/promises";
import { readDiagnosticMessage, sanitizeDiagnosticText } from "../diagnostics/sanitize.ts";

export interface FlushableOtelSdk {
  forceFlush?: () => Promise<void> | void;
}

export interface ShutdownableOtelSdk extends FlushableOtelSdk {
  shutdown?: () => Promise<void> | void;
}

export interface BoundedOtelOperationResult {
  readonly operation: "flush" | "shutdown";
  readonly completed: boolean;
  readonly timedOut: boolean;
  readonly error?: unknown;
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
    const completed = completeOperation(operation, action);
    return await Promise.race([completed, timeoutResult]);
  } catch (error) {
    return { operation, completed: false, timedOut: false, error };
  } finally {
    timeoutController.abort();
  }
}

function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return 0;
  return timeoutMs;
}

async function completeOperation(
  operation: "flush" | "shutdown",
  action: () => Promise<void> | void,
): Promise<BoundedOtelOperationResult> {
  await action();
  return completedOperation(operation);
}

async function timeoutOperation(
  operation: "flush" | "shutdown",
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BoundedOtelOperationResult> {
  return delay(timeoutMs, { operation, completed: false, timedOut: true } as const, { signal });
}

function completedOperation(operation: "flush" | "shutdown"): BoundedOtelOperationResult {
  return { operation, completed: true, timedOut: false };
}

function logBoundedOperationIssue(result: BoundedOtelOperationResult, logger: OtelShutdownLogSink | undefined): void {
  if (result.timedOut) {
    logger?.warn?.(`ObservMe OTEL ${result.operation} exceeded timeout and was abandoned.`);
    return;
  }

  if (result.error) logger?.warn?.(`ObservMe OTEL ${result.operation} failed: ${formatError(result.error)}`);
}

function formatError(error: unknown): string {
  return sanitizeDiagnosticText(readDiagnosticMessage(error));
}
