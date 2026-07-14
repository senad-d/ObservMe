import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  requestObservMeIntegration,
  type ObservMeIntegrationApi,
  type ObservMeJoinStatus,
  type ObservMeProcessEnvironment,
  type ObservMeSpawnReason,
  type ObservMeSpawnType,
  type ObservMeStartedSubagent,
  type ObservMeTerminalChildStatus,
} from "@senad-d/observme/integration";

/**
 * Transport-neutral context supplied to a child launcher.
 *
 * Implement ChildTransport with child_process, Pi RPC, tmux, SSH, a container,
 * a queue, or another process manager. Always pass environment unchanged to
 * the child Pi process and never log it.
 */
export interface ChildLaunchContext {
  readonly environment: ObservMeProcessEnvironment;
  readonly spawnId?: string;
  readonly childAgentId?: string;
  readonly traceContextPropagated: boolean;
}

export interface ChildRunResult<Value> {
  readonly status: "completed" | "failed" | "cancelled" | "timeout";
  readonly value?: Value;
  readonly failurePropagated?: boolean;
}

export interface ChildTransport<Request, Handle, Value> {
  launch(request: Request, context: ChildLaunchContext, signal?: AbortSignal): Promise<Handle>;
  wait(handle: Handle, signal?: AbortSignal): Promise<ChildRunResult<Value>>;
}

export interface ObservableSubagentRunOptions<Request> {
  readonly request: Request;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly spawnType?: ObservMeSpawnType;
  readonly spawnReason?: ObservMeSpawnReason;
  readonly toolCallId?: string;
  readonly environment?: ObservMeProcessEnvironment;
  readonly signal?: AbortSignal;
}

/**
 * Generic adapter that adds ObservMe lifecycle reporting to any child transport.
 *
 * The transport owns process control and result delivery. ObservMe owns only
 * spawn/wait/join telemetry and propagation context. When ObservMe is absent or
 * inactive, the transport still runs with the supplied base environment.
 */
export class ObservableSubagentRunner<Request, Handle, Value> {
  readonly #pi: ExtensionAPI;
  readonly #transport: ChildTransport<Request, Handle, Value>;

  constructor(pi: ExtensionAPI, transport: ChildTransport<Request, Handle, Value>) {
    this.#pi = pi;
    this.#transport = transport;
  }

  async run(options: ObservableSubagentRunOptions<Request>): Promise<ChildRunResult<Value>> {
    const observme = requestObservMeIntegration(this.#pi);
    const started = startObservMeSubagent(observme, options);
    const context = createLaunchContext(started, options.environment);
    let handle: Handle;

    try {
      handle = await this.#transport.launch(options.request, context, options.signal);
    } catch (error) {
      failObservMeLaunch(observme, started, error);
      throw error;
    }

    return this.waitForResult(observme, started, handle, options.signal);
  }

  private async waitForResult(
    observme: ObservMeIntegrationApi | undefined,
    started: ObservMeStartedSubagent | undefined,
    handle: Handle,
    signal: AbortSignal | undefined,
  ): Promise<ChildRunResult<Value>> {
    const wait = startObservMeWait(observme, started);

    try {
      const result = await this.#transport.wait(handle, signal);
      endObservMeWait(observme, started, wait, result);
      completeObservMeChild(observme, started, childStatus(result.status));
      recordObservMeJoin(observme, started, result);
      return result;
    } catch (error) {
      endObservMeWaitFailure(observme, started, wait);
      completeObservMeChild(observme, started, "failed");
      recordObservMeJoinFailure(observme, started);
      throw error;
    }
  }
}

function startObservMeSubagent<Request>(
  observme: ObservMeIntegrationApi | undefined,
  options: ObservableSubagentRunOptions<Request>,
): ObservMeStartedSubagent | undefined {
  const result = observme?.startSubagent({
    command: options.command,
    args: options.args,
    spawnType: options.spawnType ?? "extension",
    spawnReason: options.spawnReason ?? "delegated_task",
    toolCallId: options.toolCallId,
    env: options.environment ?? process.env,
  });
  return result?.ok ? result : undefined;
}

function createLaunchContext(
  started: ObservMeStartedSubagent | undefined,
  environment: ObservMeProcessEnvironment | undefined,
): ChildLaunchContext {
  return {
    environment: started?.env ?? environment ?? process.env,
    spawnId: started?.spawnId,
    childAgentId: started?.childAgentId,
    traceContextPropagated: started?.traceContextPropagated ?? false,
  };
}

function completeObservMeChild(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
  status: ObservMeTerminalChildStatus,
): void {
  if (!observme || !started) return;
  observme.completeSubagent(started.spawnId, {
    childAgentId: started.childAgentId,
    childStatus: status,
    outcome: status,
  });
}

function failObservMeLaunch(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
  error: unknown,
): void {
  if (!observme || !started) return;
  observme.failSubagent(started.spawnId, {
    childAgentId: started.childAgentId,
    errorClass: safeErrorClass(error),
  });
}

function startObservMeWait(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
) {
  if (!observme || !started) return undefined;
  const wait = observme.startWait({
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "active",
    reason: "child_running",
  });
  return wait.ok ? wait : undefined;
}

function endObservMeWait<Value>(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
  wait: { readonly id: string } | undefined,
  result: ChildRunResult<Value>,
): void {
  if (!observme || !started || !wait) return;
  observme.endWait(wait.id, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: childStatus(result.status),
    joinStatus: joinStatus(result.status),
    reason: "child_running",
  });
}

function endObservMeWaitFailure(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
  wait: { readonly id: string } | undefined,
): void {
  if (!observme || !started || !wait) return;
  observme.endWait(wait.id, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "failed",
    joinStatus: "failed",
    reason: "child_running",
    failurePropagated: true,
  });
}

function recordObservMeJoin<Value>(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
  result: ChildRunResult<Value>,
): void {
  if (!observme || !started) return;
  const status = joinStatus(result.status);
  const child = childStatus(result.status);
  const join = observme.startJoin({
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: child,
    joinStatus: status,
    reason: "dependency",
  });
  if (!join.ok) return;
  observme.endJoin(join.id, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: child,
    joinStatus: status,
    reason: "dependency",
    failurePropagated: result.failurePropagated ?? result.status === "failed",
  });
}

function recordObservMeJoinFailure(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
): void {
  if (!observme || !started) return;
  const join = observme.startJoin({
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "failed",
    joinStatus: "failed",
    reason: "dependency",
  });
  if (!join.ok) return;
  observme.endJoin(join.id, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "failed",
    joinStatus: "failed",
    reason: "dependency",
    failurePropagated: true,
  });
}

function childStatus(status: ChildRunResult<unknown>["status"]): ObservMeTerminalChildStatus {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function joinStatus(status: ChildRunResult<unknown>["status"]): ObservMeJoinStatus {
  return status;
}

function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "launcher_error";
  const normalized = error.name.trim().toLowerCase().replaceAll(/[^a-z0-9_.:-]/gu, "_");
  return /^[a-z][a-z0-9_.:-]{0,63}$/u.test(normalized) ? normalized : "launcher_error";
}
