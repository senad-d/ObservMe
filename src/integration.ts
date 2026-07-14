export const OBSERVME_INTEGRATION_CHANNEL = "observme:integration:request";
export const OBSERVME_INTEGRATION_VERSION = 1 as const;

export type ObservMeIntegrationVersion = typeof OBSERVME_INTEGRATION_VERSION;
export type ObservMeProcessEnvironment = Record<string, string | undefined>;
export type ObservMeSpawnType = "command" | "tool" | "extension" | "unknown";
export type ObservMeSpawnReason = "delegated_task" | "parallel_search" | "review" | "tool_wrapper" | "unknown";
export type ObservMeAgentWaitReason = "dependency" | "rate_limit" | "child_running" | "unknown";
export type ObservMeChildStatus = "starting" | "active" | "completed" | "failed" | "cancelled" | "orphaned";
export type ObservMeTerminalChildStatus = Extract<ObservMeChildStatus, "completed" | "failed" | "cancelled">;
export type ObservMeJoinStatus = "completed" | "failed" | "cancelled" | "timeout" | "unknown" | "waiting";
export type ObservMeIntegrationFailureReason =
  | "session_unavailable"
  | "invalid_request"
  | "spawn_already_exists"
  | "wait_already_exists"
  | "join_already_exists"
  | "spawn_not_found"
  | "child_agent_mismatch"
  | "invalid_terminal_transition"
  | "wait_not_found"
  | "join_not_found"
  | "operation_failed";

export interface ObservMeIntegrationFailure {
  readonly ok: false;
  readonly reason: ObservMeIntegrationFailureReason;
}

export interface ObservMeIntegrationContext {
  readonly workflowId: string;
  readonly workflowRootAgentId: string;
  readonly agentId: string;
  readonly parentAgentId?: string;
  readonly rootAgentId: string;
  readonly depth: number;
  readonly role: "root" | "subagent" | "orchestrator" | "worker" | "reviewer" | "unknown";
  readonly capability?: string;
  readonly sessionId?: string;
  readonly traceId?: string;
}

export interface ObservMeIntegrationContextSuccess {
  readonly ok: true;
  readonly context: ObservMeIntegrationContext;
}

export interface ObservMeStartSubagentOptions {
  readonly spawnId?: string;
  readonly childAgentId?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly spawnType?: ObservMeSpawnType;
  readonly spawnReason?: ObservMeSpawnReason;
  readonly toolCallId?: string;
  readonly env?: ObservMeProcessEnvironment;
}

export interface ObservMeStartedSubagent {
  readonly ok: true;
  readonly spawnId: string;
  readonly childAgentId: string;
  readonly env: ObservMeProcessEnvironment;
  readonly traceContextPropagated: boolean;
}

export interface ObservMeCompleteSubagentOptions {
  readonly childAgentId?: string;
  readonly childStatus?: ObservMeTerminalChildStatus;
  readonly outcome?: ObservMeTerminalChildStatus;
}

export interface ObservMeFailSubagentOptions {
  readonly childAgentId?: string;
  readonly errorClass?: string;
}

export interface ObservMeWaitJoinOptions {
  readonly id?: string;
  readonly spawnId?: string;
  readonly childAgentId?: string;
  readonly childStatus?: ObservMeChildStatus;
  readonly joinStatus?: ObservMeJoinStatus;
  readonly reason?: ObservMeAgentWaitReason;
  readonly failurePropagated?: boolean;
  readonly durationMs?: number;
}

export interface ObservMeStartedWaitJoin {
  readonly ok: true;
  readonly id: string;
}

export interface ObservMeIntegrationSuccess {
  readonly ok: true;
}

export interface ObservMeIntegrationApi {
  readonly version: ObservMeIntegrationVersion;
  getContext(): ObservMeIntegrationContextSuccess | ObservMeIntegrationFailure;
  startSubagent(options?: ObservMeStartSubagentOptions): ObservMeStartedSubagent | ObservMeIntegrationFailure;
  completeSubagent(spawnId: string, options?: ObservMeCompleteSubagentOptions): ObservMeIntegrationSuccess | ObservMeIntegrationFailure;
  failSubagent(spawnId: string, options?: ObservMeFailSubagentOptions): ObservMeIntegrationSuccess | ObservMeIntegrationFailure;
  startWait(options?: ObservMeWaitJoinOptions): ObservMeStartedWaitJoin | ObservMeIntegrationFailure;
  endWait(waitId: string, options?: ObservMeWaitJoinOptions): ObservMeIntegrationSuccess | ObservMeIntegrationFailure;
  startJoin(options?: ObservMeWaitJoinOptions): ObservMeStartedWaitJoin | ObservMeIntegrationFailure;
  endJoin(joinId: string, options?: ObservMeWaitJoinOptions): ObservMeIntegrationSuccess | ObservMeIntegrationFailure;
}

export interface ObservMeIntegrationRequest {
  readonly supportedVersions: readonly ObservMeIntegrationVersion[];
  readonly respond: (api: ObservMeIntegrationApi) => void;
}

export interface ObservMeIntegrationEventBus {
  emit(channel: string, data: unknown): void;
}

export interface ObservMeIntegrationHost {
  readonly events: ObservMeIntegrationEventBus;
}

interface IntegrationResponseHolder {
  api?: ObservMeIntegrationApi;
}

export function requestObservMeIntegration(host: ObservMeIntegrationHost): ObservMeIntegrationApi | undefined {
  const events = resolveIntegrationEventBus(host);
  if (!events) return undefined;

  const holder: IntegrationResponseHolder = {};
  const request: ObservMeIntegrationRequest = {
    supportedVersions: [OBSERVME_INTEGRATION_VERSION],
    respond: receiveObservMeIntegration.bind(undefined, holder),
  };

  try {
    events.emit(OBSERVME_INTEGRATION_CHANNEL, request);
  } catch {
    return undefined;
  }
  return holder.api;
}

function resolveIntegrationEventBus(host: unknown): ObservMeIntegrationEventBus | undefined {
  if (!host || typeof host !== "object") return undefined;
  try {
    const events = (host as Partial<ObservMeIntegrationHost>).events;
    return events && typeof events.emit === "function" ? events : undefined;
  } catch {
    return undefined;
  }
}

function receiveObservMeIntegration(holder: IntegrationResponseHolder, value: unknown): void {
  if (holder.api || !isObservMeIntegrationApi(value)) return;
  holder.api = value;
}

function isObservMeIntegrationApi(value: unknown): value is ObservMeIntegrationApi {
  if (!value || typeof value !== "object") return false;

  try {
    const api = value as Partial<ObservMeIntegrationApi>;
    return (
      api.version === OBSERVME_INTEGRATION_VERSION &&
      typeof api.getContext === "function" &&
      typeof api.startSubagent === "function" &&
      typeof api.completeSubagent === "function" &&
      typeof api.failSubagent === "function" &&
      typeof api.startWait === "function" &&
      typeof api.endWait === "function" &&
      typeof api.startJoin === "function" &&
      typeof api.endJoin === "function"
    );
  } catch {
    return false;
  }
}
