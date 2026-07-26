import {
  OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION,
  OBSERVME_CHILD_ROLES,
  OBSERVME_INTEGRATION_CHANNEL,
  OBSERVME_INTEGRATION_VERSION,
  OBSERVME_INTEGRATION_VERSION_V2,
  type ObservMeCompleteSubagentLaunchOptions,
  type ObservMeCompleteSubagentOptions,
  type ObservMeFailSubagentOptions,
  type ObservMeIntegrationApi,
  type ObservMeIntegrationApiV2,
  type ObservMeIntegrationContext,
  type ObservMeIntegrationContextSuccess,
  type ObservMeIntegrationContextSuccessV2,
  type ObservMeIntegrationFailure,
  type ObservMeIntegrationResponseV2,
  type ObservMeIntegrationSuccess,
  type ObservMeStartedSubagent,
  type ObservMeStartedWaitJoin,
  type ObservMeStartSubagentOptions,
  type ObservMeStartSubagentOptionsV2,
  type ObservMeWaitJoinOptions,
} from "../integration.ts";
import { SESSION_ATTRIBUTES } from "../semconv/attributes.ts";
import { validateObservMeChildDescriptor } from "./child-identity.ts";
import {
  completeSubagentLaunch,
  completeSubagentSpawn,
  endAgentJoin,
  endAgentWait,
  failSubagentSpawn,
  OBSERVME_LIFECYCLE_IDENTIFIER_MAX_CHARACTERS,
  resolveAgentWaitJoinId,
  resolveSubagentSpawnIdentity,
  startAgentJoin,
  startAgentWait,
  startSubagentSpawn,
} from "./subagent-spawn.ts";
import type { AgentRole, ChildIdentityPropagation } from "./agent-lineage.ts";
import type { HandlerSessionState, ObservMeTelemetrySession } from "./handler-types.ts";

interface IntegrationEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface IntegrationPiApi {
  readonly events?: IntegrationEventBus;
}

type IntegrationSessionAvailability =
  | { readonly ok: true; readonly session: ObservMeTelemetrySession }
  | ObservMeIntegrationFailure;

type IntegrationIdentityMode = ChildIdentityPropagation["mode"];

interface IntegrationProviderRequest {
  readonly supportedVersions: readonly number[];
  readonly respond: (api: ObservMeIntegrationResponseV2) => void;
}

interface ValidatedStartSubagentRequest {
  readonly options: ObservMeStartSubagentOptions;
  readonly childIdentity: ChildIdentityPropagation;
}

const integrationIdentifierPattern = /^[A-Za-z0-9._:-]+$/u;
const maximumIntegrationCommandLength = 4096;
const maximumIntegrationArgumentCount = 256;
const maximumIntegrationArgumentLength = 4096;
const maximumIntegrationEnvironmentEntries = 4096;
const maximumIntegrationEnvironmentKeyLength = 128;

export function registerObservMeIntegration(pi: unknown, state: HandlerSessionState): (() => void) | undefined {
  const events = resolveIntegrationEventBus(pi);
  if (!events) return undefined;

  const provider = new SessionBackedObservMeIntegrationProvider(state);
  try {
    return events.on(OBSERVME_INTEGRATION_CHANNEL, provider.handleRequest.bind(provider));
  } catch {
    return undefined;
  }
}

class SessionBackedObservMeIntegrationOperations {
  readonly #state: HandlerSessionState;

  constructor(state: HandlerSessionState) {
    this.#state = state;
  }

  getContextV1(): ObservMeIntegrationContextSuccess | ObservMeIntegrationFailure {
    const availability = resolveIntegrationSession(this.#state);
    if (!availability.ok) return availability;
    return createV1IntegrationContextSuccess(availability.session);
  }

  getContextV2(): ObservMeIntegrationContextSuccessV2 | ObservMeIntegrationFailure {
    const availability = resolveIntegrationSession(this.#state);
    if (!availability.ok) return availability;
    return createV2IntegrationContextSuccess(availability.session);
  }

  startSubagentV1(options: unknown = {}): ObservMeStartedSubagent | ObservMeIntegrationFailure {
    return this.startSubagent(options, "v1");
  }

  startSubagentV2(options: unknown): ObservMeStartedSubagent | ObservMeIntegrationFailure {
    return this.startSubagent(options, "v2");
  }

  private startSubagent(
    options: unknown,
    identityMode: IntegrationIdentityMode,
  ): ObservMeStartedSubagent | ObservMeIntegrationFailure {
    const availability = resolveIntegrationSession(this.#state);
    if (!availability.ok) return availability;
    const { session } = availability;
    try {
      const request = validateStartSubagentRequest(options, identityMode);
      if (!request) return integrationFailure("invalid_request");

      const identity = resolveSubagentSpawnIdentity(request.options);
      if (session.spans.activeSubagentSpawns.has(identity.spawnId)) {
        return integrationFailure("spawn_already_exists");
      }
      if (isChildAgentIdentifierRetained(session, identity.childAgentId)) {
        return integrationFailure("child_agent_already_exists");
      }

      const started = startSubagentSpawn(session, {
        ...request.options,
        ...identity,
        childIdentity: request.childIdentity,
      });
      return {
        ok: true,
        spawnId: started.spawnId,
        childAgentId: started.childAgentId,
        env: started.env,
        traceContextPropagated: started.traceContextPropagated,
      };
    } catch {
      return integrationFailure("operation_failed");
    }
  }

  completeSubagentLaunch(
    spawnId: string,
    options: ObservMeCompleteSubagentLaunchOptions = {},
  ): ObservMeIntegrationSuccess | ObservMeIntegrationFailure {
    const availability = resolveIntegrationSession(this.#state);
    if (!availability.ok) return availability;
    const { session } = availability;
    try {
      if (!isValidIntegrationIdentifier(spawnId) || !isValidCompleteSubagentLaunchOptions(options)) {
        return integrationFailure("invalid_request");
      }
      const result = completeSubagentLaunch(session, spawnId, options);
      return result.ok ? integrationSuccess() : integrationFailure(result.reason);
    } catch {
      return integrationFailure("operation_failed");
    }
  }

  completeSubagent(
    spawnId: string,
    options: ObservMeCompleteSubagentOptions = {},
  ): ObservMeIntegrationSuccess | ObservMeIntegrationFailure {
    const availability = resolveIntegrationSession(this.#state);
    if (!availability.ok) return availability;
    const { session } = availability;
    try {
      if (!isValidIntegrationIdentifier(spawnId) || !isValidCompleteSubagentOptions(options)) {
        return integrationFailure("invalid_request");
      }
      const result = completeSubagentSpawn(session, spawnId, options);
      return result.ok ? integrationSuccess() : integrationFailure(result.reason);
    } catch {
      return integrationFailure("operation_failed");
    }
  }

  failSubagent(
    spawnId: string,
    options: ObservMeFailSubagentOptions = {},
  ): ObservMeIntegrationSuccess | ObservMeIntegrationFailure {
    const availability = resolveIntegrationSession(this.#state);
    if (!availability.ok) return availability;
    const { session } = availability;
    try {
      if (!isValidIntegrationIdentifier(spawnId) || !isValidFailSubagentOptions(options)) {
        return integrationFailure("invalid_request");
      }
      const result = failSubagentSpawn(session, spawnId, options);
      return result.ok ? integrationSuccess() : integrationFailure(result.reason);
    } catch {
      return integrationFailure("operation_failed");
    }
  }

  startWait(options: ObservMeWaitJoinOptions = {}): ObservMeStartedWaitJoin | ObservMeIntegrationFailure {
    return this.startWaitJoin(options, "wait");
  }

  endWait(
    waitId: string,
    options: ObservMeWaitJoinOptions = {},
  ): ObservMeIntegrationSuccess | ObservMeIntegrationFailure {
    return this.endWaitJoin(waitId, options, "wait");
  }

  startJoin(options: ObservMeWaitJoinOptions = {}): ObservMeStartedWaitJoin | ObservMeIntegrationFailure {
    return this.startWaitJoin(options, "join");
  }

  endJoin(
    joinId: string,
    options: ObservMeWaitJoinOptions = {},
  ): ObservMeIntegrationSuccess | ObservMeIntegrationFailure {
    return this.endWaitJoin(joinId, options, "join");
  }

  private startWaitJoin(
    options: ObservMeWaitJoinOptions,
    kind: "wait" | "join",
  ): ObservMeStartedWaitJoin | ObservMeIntegrationFailure {
    const availability = resolveIntegrationSession(this.#state);
    if (!availability.ok) return availability;
    const { session } = availability;
    try {
      if (!isValidWaitJoinOptions(options)) return integrationFailure("invalid_request");

      const requestedId = resolveAgentWaitJoinId(options, kind);
      const registry = kind === "wait" ? session.spans.activeAgentWaits : session.spans.activeAgentJoins;
      if (registry.has(requestedId)) {
        return integrationFailure(kind === "wait" ? "wait_already_exists" : "join_already_exists");
      }

      const startOptions = { ...options, id: requestedId };
      const started = kind === "wait" ? startAgentWait(session, startOptions) : startAgentJoin(session, startOptions);
      return { ok: true, id: started.id };
    } catch {
      return integrationFailure("operation_failed");
    }
  }

  private endWaitJoin(
    id: string,
    options: ObservMeWaitJoinOptions,
    kind: "wait" | "join",
  ): ObservMeIntegrationSuccess | ObservMeIntegrationFailure {
    const availability = resolveIntegrationSession(this.#state);
    if (!availability.ok) return availability;
    const { session } = availability;
    try {
      if (!isValidIntegrationIdentifier(id) || !isValidWaitJoinOptions(options)) {
        return integrationFailure("invalid_request");
      }
      const registry = kind === "wait" ? session.spans.activeAgentWaits : session.spans.activeAgentJoins;
      if (!registry.has(id)) return integrationFailure(kind === "wait" ? "wait_not_found" : "join_not_found");

      const result = kind === "wait" ? endAgentWait(session, id, options) : endAgentJoin(session, id, options);
      return result.ok ? integrationSuccess() : integrationFailure(result.reason);
    } catch {
      return integrationFailure("operation_failed");
    }
  }
}

export class SessionBackedObservMeIntegrationProvider {
  readonly #apiV1: ObservMeIntegrationApi;
  readonly #apiV2: ObservMeIntegrationApiV2;

  constructor(state: HandlerSessionState) {
    const operations = new SessionBackedObservMeIntegrationOperations(state);
    this.#apiV1 = createIntegrationApiV1(operations);
    this.#apiV2 = createIntegrationApiV2(operations);
  }

  handleRequest(value: unknown): void {
    try {
      const request = readIntegrationProviderRequest(value);
      if (!request) return;

      const api = selectHighestMutuallySupportedApi(request.supportedVersions, this.#apiV1, this.#apiV2);
      if (api) request.respond(api);
    } catch {
      return;
    }
  }
}

function createIntegrationApiV1(operations: SessionBackedObservMeIntegrationOperations): ObservMeIntegrationApi {
  return Object.freeze({
    version: OBSERVME_INTEGRATION_VERSION,
    getContext: operations.getContextV1.bind(operations),
    startSubagent: operations.startSubagentV1.bind(operations),
    completeSubagentLaunch: operations.completeSubagentLaunch.bind(operations),
    completeSubagent: operations.completeSubagent.bind(operations),
    failSubagent: operations.failSubagent.bind(operations),
    startWait: operations.startWait.bind(operations),
    endWait: operations.endWait.bind(operations),
    startJoin: operations.startJoin.bind(operations),
    endJoin: operations.endJoin.bind(operations),
  });
}

function createIntegrationApiV2(operations: SessionBackedObservMeIntegrationOperations): ObservMeIntegrationApiV2 {
  return Object.freeze({
    version: OBSERVME_INTEGRATION_VERSION_V2,
    childRoles: OBSERVME_CHILD_ROLES,
    childIdentityEnvelopeVersion: OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION,
    getContext: operations.getContextV2.bind(operations),
    startSubagent: operations.startSubagentV2.bind(operations),
    completeSubagentLaunch: operations.completeSubagentLaunch.bind(operations),
    completeSubagent: operations.completeSubagent.bind(operations),
    failSubagent: operations.failSubagent.bind(operations),
    startWait: operations.startWait.bind(operations),
    endWait: operations.endWait.bind(operations),
    startJoin: operations.startJoin.bind(operations),
    endJoin: operations.endJoin.bind(operations),
  });
}

function selectHighestMutuallySupportedApi(
  supportedVersions: readonly number[],
  apiV1: ObservMeIntegrationApi,
  apiV2: ObservMeIntegrationApiV2,
): ObservMeIntegrationResponseV2 | undefined {
  if (supportedVersions.includes(OBSERVME_INTEGRATION_VERSION_V2)) return apiV2;
  if (supportedVersions.includes(OBSERVME_INTEGRATION_VERSION)) return apiV1;
  return undefined;
}

function resolveIntegrationSession(state: HandlerSessionState): IntegrationSessionAvailability {
  if (state.integrationSessionPhase === "closing") return integrationFailure("session_closing");
  return state.session ? { ok: true, session: state.session } : integrationFailure("session_unavailable");
}

function isChildAgentIdentifierRetained(session: ObservMeTelemetrySession, childAgentId: string): boolean {
  if (session.agentTree.getAgent(childAgentId)) return true;
  for (const activeSpawn of session.spans.activeSubagentSpawns.values()) {
    if (activeSpawn.childAgentId === childAgentId) return true;
  }
  return false;
}

function resolveIntegrationEventBus(pi: unknown): IntegrationEventBus | undefined {
  if (!pi || typeof pi !== "object") return undefined;
  try {
    const events = (pi as IntegrationPiApi).events;
    return events && typeof events.on === "function" ? events : undefined;
  } catch {
    return undefined;
  }
}

function readIntegrationProviderRequest(value: unknown): IntegrationProviderRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    const supportedVersions = Reflect.get(value, "supportedVersions");
    const respond = Reflect.get(value, "respond");
    if (!Array.isArray(supportedVersions) || !hasValidRequestedIntegrationVersions(supportedVersions)) {
      return undefined;
    }
    if (typeof respond !== "function") return undefined;
    return { supportedVersions, respond };
  } catch {
    return undefined;
  }
}

function hasValidRequestedIntegrationVersions(values: readonly unknown[]): values is readonly number[] {
  for (const value of values) {
    if (!isValidRequestedIntegrationVersion(value)) return false;
  }
  return true;
}

function isValidRequestedIntegrationVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateStartSubagentRequest(
  value: unknown,
  identityMode: IntegrationIdentityMode,
): ValidatedStartSubagentRequest | undefined {
  try {
    if (!isValidStartSubagentOptions(value)) return undefined;
    const options = copyStartSubagentOptions(value);
    if (identityMode === "v1") return { options, childIdentity: { mode: "v1" } };

    const descriptor = validateObservMeChildDescriptor(Reflect.get(value, "child"));
    if (!descriptor.ok) return undefined;
    return { options, childIdentity: { mode: "v2", descriptor: descriptor.descriptor } };
  } catch {
    return undefined;
  }
}

function copyStartSubagentOptions(value: ObservMeStartSubagentOptionsV2 | ObservMeStartSubagentOptions): ObservMeStartSubagentOptions {
  return {
    spawnId: value.spawnId,
    childAgentId: value.childAgentId,
    command: value.command,
    args: value.args,
    spawnType: value.spawnType,
    spawnReason: value.spawnReason,
    toolCallId: value.toolCallId,
    env: value.env,
  };
}

function isValidStartSubagentOptions(value: unknown): value is ObservMeStartSubagentOptions {
  if (!isIntegrationRecord(value)) return false;
  const options = value as Partial<ObservMeStartSubagentOptions>;
  return (
    isOptionalIntegrationIdentifier(options.spawnId) &&
    isOptionalIntegrationIdentifier(options.childAgentId) &&
    isOptionalBoundedString(options.command, maximumIntegrationCommandLength) &&
    isValidIntegrationArguments(options.args) &&
    isOptionalSpawnType(options.spawnType) &&
    isOptionalSpawnReason(options.spawnReason) &&
    isOptionalIntegrationIdentifier(options.toolCallId) &&
    isValidIntegrationEnvironment(options.env)
  );
}

function isValidCompleteSubagentLaunchOptions(value: unknown): value is ObservMeCompleteSubagentLaunchOptions {
  if (!isIntegrationRecord(value)) return false;
  const options = value as Partial<ObservMeCompleteSubagentLaunchOptions>;
  return isOptionalIntegrationIdentifier(options.childAgentId);
}

function isValidCompleteSubagentOptions(value: unknown): value is ObservMeCompleteSubagentOptions {
  if (!isValidCompleteSubagentLaunchOptions(value)) return false;
  const options = value as Partial<ObservMeCompleteSubagentOptions>;
  return (
    isOptionalIntegrationIdentifier(options.childAgentId) &&
    isOptionalTerminalChildStatus(options.childStatus) &&
    isOptionalTerminalChildStatus(options.outcome)
  );
}

function isValidFailSubagentOptions(value: unknown): value is ObservMeFailSubagentOptions {
  if (!isIntegrationRecord(value)) return false;
  const options = value as Partial<ObservMeFailSubagentOptions>;
  return isOptionalIntegrationIdentifier(options.childAgentId) && isOptionalBoundedString(options.errorClass, 256);
}

function isValidWaitJoinOptions(value: unknown): value is ObservMeWaitJoinOptions {
  if (!isIntegrationRecord(value)) return false;
  const options = value as Partial<ObservMeWaitJoinOptions>;
  return (
    isOptionalIntegrationIdentifier(options.id) &&
    isOptionalIntegrationIdentifier(options.spawnId) &&
    isOptionalIntegrationIdentifier(options.childAgentId) &&
    isOptionalChildStatus(options.childStatus) &&
    isOptionalJoinStatus(options.joinStatus) &&
    isOptionalWaitReason(options.reason) &&
    (options.failurePropagated === undefined || typeof options.failurePropagated === "boolean") &&
    (options.durationMs === undefined || isValidDuration(options.durationMs))
  );
}

function isIntegrationRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidIntegrationIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= OBSERVME_LIFECYCLE_IDENTIFIER_MAX_CHARACTERS &&
    integrationIdentifierPattern.test(value)
  );
}

function isOptionalIntegrationIdentifier(value: unknown): value is string | undefined {
  return value === undefined || isValidIntegrationIdentifier(value);
}

function isOptionalBoundedString(value: unknown, maximumLength: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= maximumLength);
}

function isValidIntegrationArguments(value: unknown): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= maximumIntegrationArgumentCount &&
      value.every(isValidIntegrationArgument))
  );
}

function isValidIntegrationArgument(value: unknown): value is string {
  return typeof value === "string" && value.length <= maximumIntegrationArgumentLength;
}

function isValidIntegrationEnvironment(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isIntegrationRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= maximumIntegrationEnvironmentEntries && entries.every(isValidIntegrationEnvironmentEntry);
}

function isValidIntegrationEnvironmentEntry(entry: [string, unknown]): boolean {
  const [key, value] = entry;
  return isValidIntegrationEnvironmentKey(key) && isValidIntegrationEnvironmentValue(value);
}

function isValidIntegrationEnvironmentKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumIntegrationEnvironmentKeyLength &&
    !value.includes("=") &&
    !value.includes("\u0000")
  );
}

function isValidIntegrationEnvironmentValue(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && !value.includes("\u0000"));
}

function isOptionalSpawnType(value: unknown): boolean {
  return value === undefined || value === "command" || value === "tool" || value === "extension" || value === "unknown";
}

function isOptionalSpawnReason(value: unknown): boolean {
  return (
    value === undefined ||
    value === "delegated_task" ||
    value === "parallel_search" ||
    value === "review" ||
    value === "tool_wrapper" ||
    value === "unknown"
  );
}

function isOptionalChildStatus(value: unknown): boolean {
  return (
    value === undefined ||
    value === "starting" ||
    value === "active" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "orphaned"
  );
}

function isOptionalTerminalChildStatus(value: unknown): boolean {
  return value === undefined || value === "completed" || value === "failed" || value === "cancelled";
}

function isOptionalJoinStatus(value: unknown): boolean {
  return (
    value === undefined ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "timeout" ||
    value === "unknown" ||
    value === "waiting"
  );
}

function isOptionalWaitReason(value: unknown): boolean {
  return value === undefined || value === "dependency" || value === "rate_limit" || value === "child_running" || value === "unknown";
}

function isValidDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function createV1IntegrationContextSuccess(session: ObservMeTelemetrySession): ObservMeIntegrationContextSuccess {
  return {
    ok: true,
    context: {
      ...createIntegrationContextFields(session),
      role: resolveV1IntegrationContextRole(session.lineage.role),
    },
  };
}

function createV2IntegrationContextSuccess(session: ObservMeTelemetrySession): ObservMeIntegrationContextSuccessV2 {
  return {
    ok: true,
    context: {
      ...createIntegrationContextFields(session),
      role: session.lineage.role,
    },
  };
}

function createIntegrationContextFields(
  session: ObservMeTelemetrySession,
): Omit<ObservMeIntegrationContext, "role"> {
  return {
    workflowId: session.lineage.workflowId,
    workflowRootAgentId: session.lineage.workflowRootAgentId,
    agentId: session.lineage.agentId,
    parentAgentId: session.lineage.parentAgentId,
    rootAgentId: session.lineage.rootAgentId,
    depth: session.lineage.depth,
    capability: session.lineage.capability,
    sessionId: readSessionId(session),
    traceId: readSessionTraceId(session),
  };
}

function resolveV1IntegrationContextRole(role: AgentRole): ObservMeIntegrationContext["role"] {
  if (role === "lead" || role === "helper" || role === "validator") return "subagent";
  return role;
}

function readSessionId(session: ObservMeTelemetrySession): string | undefined {
  const value = session.sessionAttributes?.[SESSION_ATTRIBUTES.PI_SESSION_ID];
  return typeof value === "string" ? value : undefined;
}

function readSessionTraceId(session: ObservMeTelemetrySession): string | undefined {
  try {
    return session.sessionSpan?.spanContext().traceId;
  } catch {
    return undefined;
  }
}

function integrationSuccess(): ObservMeIntegrationSuccess {
  return { ok: true };
}

function integrationFailure(reason: ObservMeIntegrationFailure["reason"]): ObservMeIntegrationFailure {
  return { ok: false, reason };
}
