import {
  OBSERVME_INTEGRATION_CHANNEL,
  OBSERVME_INTEGRATION_VERSION,
  type ObservMeCompleteSubagentOptions,
  type ObservMeFailSubagentOptions,
  type ObservMeIntegrationApi,
  type ObservMeIntegrationContextSuccess,
  type ObservMeIntegrationFailure,
  type ObservMeIntegrationRequest,
  type ObservMeIntegrationSuccess,
  type ObservMeStartedSubagent,
  type ObservMeStartedWaitJoin,
  type ObservMeStartSubagentOptions,
  type ObservMeWaitJoinOptions,
} from "../integration.ts";
import { SESSION_ATTRIBUTES } from "../semconv/attributes.ts";
import {
  completeSubagentSpawn,
  endAgentJoin,
  endAgentWait,
  failSubagentSpawn,
  startAgentJoin,
  startAgentWait,
  startSubagentSpawn,
} from "./subagent-spawn.ts";
import type { HandlerSessionState, ObservMeTelemetrySession } from "./handler-types.ts";

interface IntegrationEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface IntegrationPiApi {
  readonly events?: IntegrationEventBus;
}

const integrationIdentifierPattern = /^[A-Za-z0-9._:-]{1,128}$/u;
const maximumIntegrationCommandLength = 4096;
const maximumIntegrationArgumentCount = 256;
const maximumIntegrationArgumentLength = 4096;
const maximumIntegrationEnvironmentEntries = 4096;

export function registerObservMeIntegration(pi: unknown, state: HandlerSessionState): (() => void) | undefined {
  const events = resolveIntegrationEventBus(pi);
  if (!events) return undefined;

  const api = new SessionBackedObservMeIntegrationApi(state);
  try {
    return events.on(OBSERVME_INTEGRATION_CHANNEL, api.handleRequest.bind(api));
  } catch {
    return undefined;
  }
}

export class SessionBackedObservMeIntegrationApi implements ObservMeIntegrationApi {
  readonly version = OBSERVME_INTEGRATION_VERSION;
  readonly #state: HandlerSessionState;

  constructor(state: HandlerSessionState) {
    this.#state = state;
  }

  handleRequest(value: unknown): void {
    try {
      if (!isCompatibleIntegrationRequest(value)) return;
      value.respond(this);
    } catch {
      return;
    }
  }

  getContext(): ObservMeIntegrationContextSuccess | ObservMeIntegrationFailure {
    const session = this.#state.session;
    if (!session) return integrationFailure("session_unavailable");

    return {
      ok: true,
      context: {
        workflowId: session.lineage.workflowId,
        workflowRootAgentId: session.lineage.workflowRootAgentId,
        agentId: session.lineage.agentId,
        parentAgentId: session.lineage.parentAgentId,
        rootAgentId: session.lineage.rootAgentId,
        depth: session.lineage.depth,
        role: session.lineage.role,
        capability: session.lineage.capability,
        sessionId: readSessionId(session),
        traceId: readSessionTraceId(session),
      },
    };
  }

  startSubagent(options: ObservMeStartSubagentOptions = {}): ObservMeStartedSubagent | ObservMeIntegrationFailure {
    const session = this.#state.session;
    if (!session) return integrationFailure("session_unavailable");
    try {
      if (!isValidStartSubagentOptions(options)) return integrationFailure("invalid_request");
      if (options.spawnId && session.spans.activeSubagentSpawns.has(options.spawnId)) {
        return integrationFailure("spawn_already_exists");
      }

      const started = startSubagentSpawn(session, options);
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

  completeSubagent(
    spawnId: string,
    options: ObservMeCompleteSubagentOptions = {},
  ): ObservMeIntegrationSuccess | ObservMeIntegrationFailure {
    const session = this.#state.session;
    if (!session) return integrationFailure("session_unavailable");
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
    const session = this.#state.session;
    if (!session) return integrationFailure("session_unavailable");
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
    const session = this.#state.session;
    if (!session) return integrationFailure("session_unavailable");
    try {
      if (!isValidWaitJoinOptions(options)) return integrationFailure("invalid_request");

      const requestedId = resolveRequestedWaitJoinId(options, kind);
      const registry = kind === "wait" ? session.spans.activeAgentWaits : session.spans.activeAgentJoins;
      if (requestedId && registry.has(requestedId)) {
        return integrationFailure(kind === "wait" ? "wait_already_exists" : "join_already_exists");
      }

      const started = kind === "wait" ? startAgentWait(session, options) : startAgentJoin(session, options);
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
    const session = this.#state.session;
    if (!session) return integrationFailure("session_unavailable");
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

function resolveIntegrationEventBus(pi: unknown): IntegrationEventBus | undefined {
  if (!pi || typeof pi !== "object") return undefined;
  try {
    const events = (pi as IntegrationPiApi).events;
    return events && typeof events.on === "function" ? events : undefined;
  } catch {
    return undefined;
  }
}

function isCompatibleIntegrationRequest(value: unknown): value is ObservMeIntegrationRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ObservMeIntegrationRequest>;
  return (
    Array.isArray(request.supportedVersions) &&
    request.supportedVersions.includes(OBSERVME_INTEGRATION_VERSION) &&
    typeof request.respond === "function"
  );
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

function isValidCompleteSubagentOptions(value: unknown): value is ObservMeCompleteSubagentOptions {
  if (!isIntegrationRecord(value)) return false;
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
  return typeof value === "string" && integrationIdentifierPattern.test(value);
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
  return entry[0].length > 0 && (typeof entry[1] === "string" || entry[1] === undefined);
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

function resolveRequestedWaitJoinId(options: ObservMeWaitJoinOptions, kind: "wait" | "join"): string | undefined {
  return options.id ?? (options.spawnId ? `${kind}-${options.spawnId}` : undefined);
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
