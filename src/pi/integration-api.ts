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

export function registerObservMeIntegration(pi: unknown, state: HandlerSessionState): (() => void) | undefined {
  const events = resolveIntegrationEventBus(pi);
  if (!events) return undefined;

  const api = new SessionBackedObservMeIntegrationApi(state);
  return events.on(OBSERVME_INTEGRATION_CHANNEL, api.handleRequest.bind(api));
}

export class SessionBackedObservMeIntegrationApi implements ObservMeIntegrationApi {
  readonly version = OBSERVME_INTEGRATION_VERSION;
  readonly #state: HandlerSessionState;

  constructor(state: HandlerSessionState) {
    this.#state = state;
  }

  handleRequest(value: unknown): void {
    if (!isCompatibleIntegrationRequest(value)) return;
    try {
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
    if (!session.spans.activeSubagentSpawns.get(spawnId)) return integrationFailure("spawn_not_found");

    try {
      completeSubagentSpawn(session, spawnId, options);
      return integrationSuccess();
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
    if (!session.spans.activeSubagentSpawns.get(spawnId)) return integrationFailure("spawn_not_found");

    try {
      failSubagentSpawn(session, spawnId, options);
      return integrationSuccess();
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
    const registry = kind === "wait" ? session.spans.activeAgentWaits : session.spans.activeAgentJoins;
    if (!registry.get(id)) return integrationFailure(kind === "wait" ? "wait_not_found" : "join_not_found");

    try {
      if (kind === "wait") endAgentWait(session, id, options);
      else endAgentJoin(session, id, options);
      return integrationSuccess();
    } catch {
      return integrationFailure("operation_failed");
    }
  }
}

function resolveIntegrationEventBus(pi: unknown): IntegrationEventBus | undefined {
  if (!pi || typeof pi !== "object") return undefined;
  const events = (pi as IntegrationPiApi).events;
  return events && typeof events.on === "function" ? events : undefined;
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
