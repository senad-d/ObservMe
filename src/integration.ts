export const OBSERVME_INTEGRATION_CHANNEL = "observme:integration:request";
export const OBSERVME_INTEGRATION_VERSION = 1 as const;
export const OBSERVME_INTEGRATION_VERSION_V2 = 2 as const;
export const OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION = 1 as const;
export const OBSERVME_CHILD_ROLES = Object.freeze(["lead", "helper", "worker", "validator"] as const);

export type ObservMeIntegrationVersion = typeof OBSERVME_INTEGRATION_VERSION;
export type ObservMeIntegrationVersionV2 = typeof OBSERVME_INTEGRATION_VERSION_V2;
export type ObservMeChildIdentityEnvelopeVersion = typeof OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION;
export type ObservMeChildRole = (typeof OBSERVME_CHILD_ROLES)[number];

export interface ObservMeChildDescriptor {
  readonly displayName: string;
  readonly role: ObservMeChildRole;
  readonly capability: string;
}
export type ObservMeProcessEnvironment = Record<string, string | undefined>;
export type ObservMeSpawnType = "command" | "tool" | "extension" | "unknown";
export type ObservMeSpawnReason = "delegated_task" | "parallel_search" | "review" | "tool_wrapper" | "unknown";
export type ObservMeAgentWaitReason = "dependency" | "rate_limit" | "child_running" | "unknown";
export type ObservMeChildStatus = "starting" | "active" | "completed" | "failed" | "cancelled" | "orphaned";
export type ObservMeTerminalChildStatus = Extract<ObservMeChildStatus, "completed" | "failed" | "cancelled">;
export type ObservMeJoinStatus = "completed" | "failed" | "cancelled" | "timeout" | "unknown" | "waiting";
export type ObservMeRunnerResultStatus = Extract<ObservMeJoinStatus, "completed" | "failed" | "cancelled" | "timeout">;
export type ObservMeRunnerPhase = "launch" | "wait";
export type ObservMeRunnerOutcomeKind =
  | "child_completed"
  | "child_failed"
  | "child_cancelled"
  | "wait_timeout"
  | "caller_cancelled"
  | "launcher_failure"
  | "transport_failure";

export type ObservMeRunnerSettlement =
  | { readonly type: "result"; readonly status?: ObservMeRunnerResultStatus }
  | { readonly type: "error"; readonly phase: ObservMeRunnerPhase; readonly error: unknown; readonly signal?: AbortSignal };

export interface ObservMeRunnerOutcome {
  readonly kind: ObservMeRunnerOutcomeKind;
  readonly childStatus: ObservMeChildStatus;
  readonly terminalChildStatus?: ObservMeTerminalChildStatus;
  readonly joinStatus: ObservMeJoinStatus;
}

export type ObservMeIntegrationFailureReason =
  | "session_unavailable"
  | "session_closing"
  | "invalid_request"
  | "spawn_already_exists"
  | "child_agent_already_exists"
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

export type ObservMeIntegrationContextRole =
  | "root"
  | "subagent"
  | "orchestrator"
  | "worker"
  | "reviewer"
  | "unknown";
export type ObservMeIntegrationContextRoleV2 = ObservMeIntegrationContextRole | ObservMeChildRole;

export interface ObservMeIntegrationContext {
  readonly workflowId: string;
  readonly workflowRootAgentId: string;
  readonly agentId: string;
  readonly parentAgentId?: string;
  readonly rootAgentId: string;
  readonly depth: number;
  readonly role: ObservMeIntegrationContextRole;
  readonly capability?: string;
  readonly sessionId?: string;
  readonly traceId?: string;
}

export interface ObservMeIntegrationContextV2 extends Omit<ObservMeIntegrationContext, "role"> {
  readonly role: ObservMeIntegrationContextRoleV2;
}

export interface ObservMeIntegrationContextSuccess {
  readonly ok: true;
  readonly context: ObservMeIntegrationContext;
}

export interface ObservMeIntegrationContextSuccessV2 {
  readonly ok: true;
  readonly context: ObservMeIntegrationContextV2;
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

export interface ObservMeStartSubagentOptionsV2 extends ObservMeStartSubagentOptions {
  readonly child: ObservMeChildDescriptor;
}

export interface ObservMeStartedSubagent {
  readonly ok: true;
  readonly spawnId: string;
  readonly childAgentId: string;
  readonly env: ObservMeProcessEnvironment;
  readonly traceContextPropagated: boolean;
}

export interface ObservMeCompleteSubagentLaunchOptions {
  readonly childAgentId?: string;
}

export interface ObservMeCompleteSubagentOptions extends ObservMeCompleteSubagentLaunchOptions {
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
  /** Optional additive capability: call once immediately after obtaining a usable launcher handle. */
  completeSubagentLaunch?(
    spawnId: string,
    options?: ObservMeCompleteSubagentLaunchOptions,
  ): ObservMeIntegrationSuccess | ObservMeIntegrationFailure;
  completeSubagent(spawnId: string, options?: ObservMeCompleteSubagentOptions): ObservMeIntegrationSuccess | ObservMeIntegrationFailure;
  failSubagent(spawnId: string, options?: ObservMeFailSubagentOptions): ObservMeIntegrationSuccess | ObservMeIntegrationFailure;
  startWait(options?: ObservMeWaitJoinOptions): ObservMeStartedWaitJoin | ObservMeIntegrationFailure;
  endWait(waitId: string, options?: ObservMeWaitJoinOptions): ObservMeIntegrationSuccess | ObservMeIntegrationFailure;
  startJoin(options?: ObservMeWaitJoinOptions): ObservMeStartedWaitJoin | ObservMeIntegrationFailure;
  endJoin(joinId: string, options?: ObservMeWaitJoinOptions): ObservMeIntegrationSuccess | ObservMeIntegrationFailure;
}

export interface ObservMeIntegrationApiV2 extends Omit<ObservMeIntegrationApi, "version" | "getContext" | "startSubagent"> {
  readonly version: ObservMeIntegrationVersionV2;
  readonly childRoles: typeof OBSERVME_CHILD_ROLES;
  readonly childIdentityEnvelopeVersion: ObservMeChildIdentityEnvelopeVersion;
  getContext(): ObservMeIntegrationContextSuccessV2 | ObservMeIntegrationFailure;
  startSubagent(options: ObservMeStartSubagentOptionsV2): ObservMeStartedSubagent | ObservMeIntegrationFailure;
}

export interface ObservMeIntegrationRequest {
  readonly supportedVersions: readonly ObservMeIntegrationVersion[];
  readonly respond: (api: ObservMeIntegrationApi) => void;
}

export type ObservMeIntegrationResponseV2 = ObservMeIntegrationApiV2 | ObservMeIntegrationApi;

export interface ObservMeIntegrationRequestV2 {
  readonly supportedVersions: readonly (ObservMeIntegrationVersionV2 | ObservMeIntegrationVersion)[];
  readonly respond: (api: ObservMeIntegrationResponseV2) => void;
}

export interface ObservMeIntegrationEventBus {
  emit(channel: string, data: unknown): void;
}

export interface ObservMeIntegrationHost {
  readonly events: ObservMeIntegrationEventBus;
}

interface IntegrationResponseHolder<TApi> {
  accepting: boolean;
  api?: TApi;
  version?: ObservMeIntegrationVersion | ObservMeIntegrationVersionV2;
}

export function classifyObservMeRunnerOutcome(settlement: ObservMeRunnerSettlement): ObservMeRunnerOutcome {
  if (settlement.type === "result") return classifyObservMeRunnerResult(settlement.status ?? "completed");
  if (isAbortLikeRunnerError(settlement.error, settlement.signal)) {
    return settlement.phase === "launch"
      ? runnerOutcome("caller_cancelled", "cancelled", "cancelled", "cancelled")
      : runnerOutcome("caller_cancelled", "active", "cancelled");
  }
  if (settlement.phase === "launch") return runnerOutcome("launcher_failure", "failed", "failed");
  return runnerOutcome("transport_failure", "active", "unknown");
}

export function requestObservMeIntegration(host: ObservMeIntegrationHost): ObservMeIntegrationApi | undefined {
  const events = resolveIntegrationEventBus(host);
  if (!events) return undefined;

  const holder: IntegrationResponseHolder<ObservMeIntegrationApi> = { accepting: true };
  const request: ObservMeIntegrationRequest = {
    supportedVersions: [OBSERVME_INTEGRATION_VERSION],
    respond: receiveObservMeIntegrationV1.bind(undefined, holder),
  };

  if (!emitObservMeIntegrationRequest(events, request, holder)) return undefined;
  return holder.api;
}

export function requestObservMeIntegrationV2(host: ObservMeIntegrationHost): ObservMeIntegrationApiV2 | undefined {
  const events = resolveIntegrationEventBus(host);
  if (!events) return undefined;

  const holder: IntegrationResponseHolder<ObservMeIntegrationResponseV2> = { accepting: true };
  const request: ObservMeIntegrationRequestV2 = {
    supportedVersions: [OBSERVME_INTEGRATION_VERSION_V2, OBSERVME_INTEGRATION_VERSION],
    respond: receiveObservMeIntegrationV2.bind(undefined, holder),
  };

  if (!emitObservMeIntegrationRequest(events, request, holder)) return undefined;
  return isObservMeIntegrationApiV2(holder.api) ? holder.api : undefined;
}

function classifyObservMeRunnerResult(status: ObservMeRunnerResultStatus): ObservMeRunnerOutcome {
  if (status === "completed") return runnerOutcome("child_completed", "completed", "completed", "completed");
  if (status === "failed") return runnerOutcome("child_failed", "failed", "failed", "failed");
  if (status === "cancelled") return runnerOutcome("child_cancelled", "cancelled", "cancelled", "cancelled");
  return runnerOutcome("wait_timeout", "active", "timeout");
}

function runnerOutcome(
  kind: ObservMeRunnerOutcomeKind,
  childStatus: ObservMeChildStatus,
  joinStatus: ObservMeJoinStatus,
  terminalChildStatus?: ObservMeTerminalChildStatus,
): ObservMeRunnerOutcome {
  return { kind, childStatus, joinStatus, terminalChildStatus };
}

function isAbortLikeRunnerError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== "object") return false;
  try {
    return "name" in error && error.name === "AbortError";
  } catch {
    return false;
  }
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

function emitObservMeIntegrationRequest(
  events: ObservMeIntegrationEventBus,
  request: ObservMeIntegrationRequest | ObservMeIntegrationRequestV2,
  holder: { accepting: boolean },
): boolean {
  try {
    events.emit(OBSERVME_INTEGRATION_CHANNEL, request);
    return true;
  } catch {
    return false;
  } finally {
    holder.accepting = false;
  }
}

function receiveObservMeIntegrationV1(
  holder: IntegrationResponseHolder<ObservMeIntegrationApi>,
  value: unknown,
): void {
  if (!holder.accepting || holder.api || !isObservMeIntegrationApi(value)) return;
  holder.api = value;
  holder.version = OBSERVME_INTEGRATION_VERSION;
}

function receiveObservMeIntegrationV2(
  holder: IntegrationResponseHolder<ObservMeIntegrationResponseV2>,
  value: unknown,
): void {
  if (!holder.accepting) return;
  if (isObservMeIntegrationApiV2(value)) {
    if (holder.version !== OBSERVME_INTEGRATION_VERSION_V2) {
      holder.api = value;
      holder.version = OBSERVME_INTEGRATION_VERSION_V2;
    }
    return;
  }
  if (holder.version === undefined && isObservMeIntegrationApi(value)) {
    holder.api = value;
    holder.version = OBSERVME_INTEGRATION_VERSION;
  }
}

function isObservMeIntegrationApi(value: unknown): value is ObservMeIntegrationApi {
  if (!value || typeof value !== "object") return false;

  try {
    const api = value as Partial<ObservMeIntegrationApi>;
    return api.version === OBSERVME_INTEGRATION_VERSION && hasObservMeIntegrationMethods(api);
  } catch {
    return false;
  }
}

function isObservMeIntegrationApiV2(value: unknown): value is ObservMeIntegrationApiV2 {
  if (!value || typeof value !== "object") return false;

  try {
    const api = value as Partial<ObservMeIntegrationApiV2>;
    return (
      api.version === OBSERVME_INTEGRATION_VERSION_V2 &&
      api.childIdentityEnvelopeVersion === OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION &&
      isExactFrozenChildRoleCatalog(api.childRoles) &&
      hasObservMeIntegrationMethods(api)
    );
  } catch {
    return false;
  }
}

function hasObservMeIntegrationMethods(api: object): boolean {
  const candidate = api as Partial<ObservMeIntegrationApi>;
  return (
    typeof candidate.getContext === "function" &&
    typeof candidate.startSubagent === "function" &&
    typeof candidate.completeSubagent === "function" &&
    typeof candidate.failSubagent === "function" &&
    typeof candidate.startWait === "function" &&
    typeof candidate.endWait === "function" &&
    typeof candidate.startJoin === "function" &&
    typeof candidate.endJoin === "function"
  );
}

function isExactFrozenChildRoleCatalog(value: unknown): value is typeof OBSERVME_CHILD_ROLES {
  if (!Array.isArray(value) || !Object.isFrozen(value) || value.length !== OBSERVME_CHILD_ROLES.length) return false;
  for (let index = 0; index < OBSERVME_CHILD_ROLES.length; index += 1) {
    if (value[index] !== OBSERVME_CHILD_ROLES[index]) return false;
  }
  return true;
}
