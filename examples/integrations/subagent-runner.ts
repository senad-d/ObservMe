import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  classifyObservMeRunnerOutcome,
  requestObservMeIntegration,
  type ObservMeIntegrationApi,
  type ObservMeProcessEnvironment,
  type ObservMeRunnerOutcome,
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

  async start(options: ObservableSubagentRunOptions<Request>): Promise<ObservableSubagentExecution<Handle, Value>> {
    const observme = requestObservMeIntegration(this.#pi);
    const started = startObservMeSubagent(observme, options);
    const context = createLaunchContext(started, options.environment);

    try {
      const handle = await this.#transport.launch(options.request, context, options.signal);
      return new ObservableSubagentExecution(this.#transport, handle, observme, started);
    } catch (error) {
      const outcome = classifyObservMeRunnerOutcome({ type: "error", phase: "launch", error, signal: options.signal });
      recordObservMeLaunchError(observme, started, outcome, error);
      throw error;
    }
  }

  async run(options: ObservableSubagentRunOptions<Request>): Promise<ChildRunResult<Value>> {
    const execution = await this.start(options);
    return execution.wait(options.signal);
  }
}

/**
 * Retains transport and ObservMe ownership after a non-terminal wait outcome.
 * Call wait() again after a timeout or interrupted/failed result read.
 */
export class ObservableSubagentExecution<Handle, Value> {
  readonly #transport: ChildWaitTransport<Handle, Value>;
  readonly #handle: Handle;
  readonly #observme: ObservMeIntegrationApi | undefined;
  readonly #started: ObservMeStartedSubagent | undefined;
  #terminalResult?: ChildRunResult<Value>;

  constructor(
    transport: ChildWaitTransport<Handle, Value>,
    handle: Handle,
    observme: ObservMeIntegrationApi | undefined,
    started: ObservMeStartedSubagent | undefined,
  ) {
    this.#transport = transport;
    this.#handle = handle;
    this.#observme = observme;
    this.#started = started;
  }

  async wait(signal?: AbortSignal): Promise<ChildRunResult<Value>> {
    if (this.#terminalResult) return this.#terminalResult;
    const wait = startObservMeWait(this.#observme, this.#started);

    try {
      const result = await this.#transport.wait(this.#handle, signal);
      const outcome = classifyObservMeRunnerOutcome({ type: "result", status: result.status });
      recordObservMeWaitOutcome(this.#observme, this.#started, wait, outcome, result.failurePropagated);
      if (outcome.terminalChildStatus) this.#terminalResult = result;
      return result;
    } catch (error) {
      const outcome = classifyObservMeRunnerOutcome({ type: "error", phase: "wait", error, signal });
      recordObservMeWaitOutcome(this.#observme, this.#started, wait, outcome);
      throw error;
    }
  }
}

interface ChildWaitTransport<Handle, Value> {
  wait(handle: Handle, signal?: AbortSignal): Promise<ChildRunResult<Value>>;
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

function recordObservMeLaunchError(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
  outcome: ObservMeRunnerOutcome,
  error: unknown,
): void {
  if (!observme || !started) return;
  if (outcome.terminalChildStatus) {
    completeObservMeChild(observme, started, outcome.terminalChildStatus);
    return;
  }
  if (outcome.kind !== "launcher_failure") return;
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

function recordObservMeWaitOutcome(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
  wait: { readonly id: string } | undefined,
  outcome: ObservMeRunnerOutcome,
  failurePropagated?: boolean,
): void {
  endObservMeWait(observme, started, wait, outcome, failurePropagated);
  if (outcome.terminalChildStatus) completeObservMeChild(observme, started, outcome.terminalChildStatus);
  recordObservMeJoin(observme, started, outcome, failurePropagated);
}

function endObservMeWait(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
  wait: { readonly id: string } | undefined,
  outcome: ObservMeRunnerOutcome,
  failurePropagated?: boolean,
): void {
  if (!observme || !started || !wait) return;
  observme.endWait(wait.id, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: outcome.childStatus,
    joinStatus: outcome.joinStatus,
    reason: "child_running",
    failurePropagated: resolveFailurePropagation(outcome, failurePropagated),
  });
}

function recordObservMeJoin(
  observme: ObservMeIntegrationApi | undefined,
  started: ObservMeStartedSubagent | undefined,
  outcome: ObservMeRunnerOutcome,
  failurePropagated?: boolean,
): void {
  if (!observme || !started) return;
  const join = observme.startJoin({
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: outcome.childStatus,
    joinStatus: outcome.joinStatus,
    reason: "dependency",
  });
  if (!join.ok) return;
  observme.endJoin(join.id, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: outcome.childStatus,
    joinStatus: outcome.joinStatus,
    reason: "dependency",
    failurePropagated: resolveFailurePropagation(outcome, failurePropagated),
  });
}

function resolveFailurePropagation(outcome: ObservMeRunnerOutcome, failurePropagated?: boolean): boolean | undefined {
  return failurePropagated ?? (outcome.kind === "child_failed" ? true : undefined);
}

function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "launcher_error";
  const normalized = error.name.trim().toLowerCase().replaceAll(/[^a-z0-9_.:-]/gu, "_");
  return /^[a-z][a-z0-9_.:-]{0,63}$/u.test(normalized) ? normalized : "launcher_error";
}
