import type { ObservMeConfig } from "../config/schema.ts";
import type { AgentLineageContext } from "../pi/agent-lineage.ts";
import type { BoundedOtelOperationResult, OtelShutdownLogSink, ShutdownableOtelSdk } from "./shutdown.ts";
import { flushOtelSdk, shutdownOtelSdk } from "./shutdown.ts";

export type OtelSdkLifecycleState = "idle" | "starting" | "started" | "shutting_down" | "shutdown";

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
    if (this.#state === "shutdown") throw new Error("ObservMe OTEL SDK controller cannot be restarted after shutdown.");

    this.#state = "starting";
    this.#sdk = this.#sdkFactory({ config: this.#config, agent: this.#agent });
    await this.#sdk.start?.();
    this.#state = "started";
    return this.#sdk;
  }

  async flush(timeoutMs: number = this.#config.shutdown.flushTimeoutMs): Promise<BoundedOtelOperationResult> {
    return flushOtelSdk(this.#sdk, timeoutMs, this.#logger);
  }

  async shutdown(timeoutMs: number = this.#config.shutdown.flushTimeoutMs): Promise<BoundedOtelOperationResult> {
    if (this.#state === "shutdown") return { operation: "shutdown", completed: true, timedOut: false };

    this.#state = "shutting_down";
    const result = await shutdownOtelSdk(this.#sdk, timeoutMs, this.#logger);
    this.#state = "shutdown";
    return result;
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
