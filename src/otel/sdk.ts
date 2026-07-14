import type { ObservMeConfig } from "../config/schema.ts";
import { readDiagnosticMessage, sanitizeDiagnosticText } from "../diagnostics/sanitize.ts";
import type { AgentLineageContext } from "../pi/agent-lineage.ts";
import type { BoundedOtelOperationResult, OtelShutdownLogSink, ShutdownableOtelSdk } from "./shutdown.ts";
import { flushOtelSdk, shutdownOtelSdk } from "./shutdown.ts";

// `failed` is terminal: startup cleanup clears the SDK reference and the controller cannot be retried.
export type OtelSdkLifecycleState = "idle" | "starting" | "started" | "failed" | "shutting_down" | "shutdown";

export interface StartOtelSdkFactoryOptions {
  readonly config: ObservMeConfig;
  readonly agent?: AgentLineageContext;
}

export interface SessionScopedOtelSdk extends ShutdownableOtelSdk {
  start?: () => Promise<void> | void;
}

export type SessionScopedOtelSdkFactory = (options: StartOtelSdkFactoryOptions) => SessionScopedOtelSdk;

export interface ObservMeOtelSdkControllerOptions {
  readonly config: ObservMeConfig;
  readonly agent?: AgentLineageContext;
  readonly sdkFactory?: SessionScopedOtelSdkFactory;
  readonly logger?: OtelShutdownLogSink;
}

export interface ObservMeOtelSdkControllerSnapshot {
  readonly state: OtelSdkLifecycleState;
  readonly started: boolean;
  readonly shutdown: boolean;
}

export class ObservMeOtelSdkController {
  readonly #config: ObservMeConfig;
  readonly #agent?: AgentLineageContext;
  readonly #sdkFactory: SessionScopedOtelSdkFactory;
  readonly #logger?: OtelShutdownLogSink;
  #sdk?: SessionScopedOtelSdk;
  #startPromise?: Promise<SessionScopedOtelSdk>;
  #startupCleanupResult?: BoundedOtelOperationResult;
  #state: OtelSdkLifecycleState = "idle";

  constructor(options: ObservMeOtelSdkControllerOptions) {
    this.#config = options.config;
    this.#agent = options.agent;
    this.#sdkFactory = options.sdkFactory ?? createNoopSessionScopedOtelSdk;
    this.#logger = options.logger;
  }

  get state(): OtelSdkLifecycleState {
    return this.#state;
  }

  get sdk(): SessionScopedOtelSdk | undefined {
    return this.#sdk;
  }

  snapshot(): ObservMeOtelSdkControllerSnapshot {
    return {
      state: this.#state,
      started: this.#state === "started",
      shutdown: this.#state === "shutdown",
    };
  }

  async start(): Promise<SessionScopedOtelSdk> {
    if (this.#state === "started" && this.#sdk) return this.#sdk;
    if (this.#state === "starting" && this.#startPromise) return this.#startPromise;
    if (this.#state === "failed") throw new Error("ObservMe OTEL SDK controller cannot be restarted after failed startup.");
    if (this.#state === "shutdown") throw new Error("ObservMe OTEL SDK controller cannot be restarted after shutdown.");

    this.#state = "starting";
    this.#startPromise = this.startOnce();
    return this.#startPromise;
  }

  private async startOnce(): Promise<SessionScopedOtelSdk> {
    try {
      this.#sdk = this.#sdkFactory({ config: this.#config, agent: this.#agent });
      await this.#sdk.start?.();
      this.#state = "started";
      return this.#sdk;
    } catch (error) {
      if (error instanceof ObservMeOtelStartupError) {
        this.#startupCleanupResult = error.cleanup ?? completedShutdown();
      } else {
        this.#startupCleanupResult = sanitizeStartupCleanupResult(
          await shutdownOtelSdk(
            this.#sdk,
            this.#config.shutdown.flushTimeoutMs,
            this.#logger,
          ),
        );
      }
      this.#sdk = undefined;
      this.#state = "failed";
      throw toOtelStartupError(error, this.#startupCleanupResult);
    } finally {
      this.#startPromise = undefined;
    }
  }

  async flush(timeoutMs: number = this.#config.shutdown.flushTimeoutMs): Promise<BoundedOtelOperationResult> {
    return flushOtelSdk(this.#sdk, timeoutMs, this.#logger);
  }

  async shutdown(timeoutMs: number = this.#config.shutdown.flushTimeoutMs): Promise<BoundedOtelOperationResult> {
    if (this.#state === "shutdown") return completedShutdown();
    if (this.#state === "failed") return this.#startupCleanupResult ?? completedShutdown();

    this.#state = "shutting_down";
    const result = await shutdownOtelSdk(this.#sdk, timeoutMs, this.#logger);
    this.#sdk = undefined;
    this.#state = "shutdown";
    return result;
  }
}

export function toOtelStartupError(
  error: unknown,
  cleanup?: BoundedOtelOperationResult,
): Error {
  if (error instanceof ObservMeOtelStartupError) return error;

  const detail = sanitizeDiagnosticText(readDiagnosticMessage(error));
  const safeCleanup = cleanup ? sanitizeStartupCleanupResult(cleanup) : undefined;
  return new ObservMeOtelStartupError(
    `ObservMe OTEL startup failed: ${detail}. ${startupCleanupGuidance(safeCleanup)}`,
    safeCleanup,
  );
}

export class ObservMeOtelStartupError extends Error {
  readonly cleanup?: BoundedOtelOperationResult;

  constructor(message: string, cleanup?: BoundedOtelOperationResult) {
    super(message);
    this.name = "ObservMeOtelStartupError";
    this.cleanup = cleanup;
  }
}

export function createOtelSdkController(options: ObservMeOtelSdkControllerOptions): ObservMeOtelSdkController {
  return new ObservMeOtelSdkController(options);
}

export async function startOtelSdk(options: ObservMeOtelSdkControllerOptions): Promise<ObservMeOtelSdkController> {
  const controller = createOtelSdkController(options);
  await controller.start();
  return controller;
}

export function createNoopSessionScopedOtelSdk(): SessionScopedOtelSdk {
  return new NoopSessionScopedOtelSdk();
}

function startupCleanupGuidance(cleanup: BoundedOtelOperationResult | undefined): string {
  if (!cleanup) return "Check OTLP settings and Collector availability before retrying.";
  if (cleanup.timedOut) return "Cleanup exceeded its timeout; restart Pi before retrying.";
  if (cleanup.error) return "Cleanup also failed; restart Pi before retrying.";
  return "Started providers were cleaned up; check OTLP settings and Collector availability before retrying.";
}

function completedShutdown(): BoundedOtelOperationResult {
  return { operation: "shutdown", completed: true, timedOut: false };
}

function sanitizeStartupCleanupResult(result: BoundedOtelOperationResult): BoundedOtelOperationResult {
  if (!result.error) return result;

  return {
    ...result,
    error: new Error(sanitizeDiagnosticText(readDiagnosticMessage(result.error))),
  };
}

class NoopSessionScopedOtelSdk implements SessionScopedOtelSdk {
  async start(): Promise<void> {
    await Promise.resolve();
  }

  async forceFlush(): Promise<void> {
    await Promise.resolve();
  }

  async shutdown(): Promise<void> {
    await Promise.resolve();
  }
}
