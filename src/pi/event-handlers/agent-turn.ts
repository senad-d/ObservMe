import { SpanStatusCode } from "@opentelemetry/api";
import { recordObsSessionTurn } from "../../commands/obs-session.ts";
import { AGENT_RUN_ATTRIBUTES, TURN_ATTRIBUTES } from "../../semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../../semconv/metrics.ts";
import { SPAN_NAMES } from "../../semconv/spans.ts";
import {
  buildAgentRunAttributes,
  buildLineageMetricSafeLogAttributes,
  buildTurnAttributes,
  deriveTurnId,
  emitLifecycleLog,
  endActiveSpan,
  metricLabels,
  nextAgentRunId,
  nextTurnIndex,
  readInteger,
  readString,
  recordSpanDurationMs,
  recordTelemetryDrop,
  startActiveChildSpan,
} from "../handler-internals.ts";
import { workflowFailed } from "../handler-runtime.ts";
import type { HandlerRegistrar } from "../handler-runtime.ts";
import type { Handler, HandlerSessionState, ObservMeHandlerContext } from "../handler-types.ts";

export function registerAgentTurnHandlers(registrar: HandlerRegistrar, state: HandlerSessionState): void {
  registrar.add("agent_start", createAgentStartHandler(state));
  registrar.add("turn_start", createTurnStartHandler(state));
  registrar.add("turn_end", createTurnEndHandler(state));
  registrar.add("agent_end", createAgentEndHandler(state));
}

function createAgentStartHandler(state: HandlerSessionState): Handler {
  return handleAgentStart.bind(undefined, state);
}

function handleAgentStart(state: HandlerSessionState, event: unknown, _ctx: ObservMeHandlerContext): void {
  const session = state.session;
  if (!session) return;

  const runId = nextAgentRunId(session, event);
  const attributes = buildAgentRunAttributes(event, session, runId);
  const span = startActiveChildSpan(session, SPAN_NAMES.PI_AGENT_RUN, session.sessionSpan, attributes, "agent_run");

  session.currentAgentRunId = runId;
  session.spans.activeAgentRuns.set(runId, span);
  session.metrics.agentRuns.add(1, metricLabels(session.config, session.lineage));
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.AGENT_RUN_STARTED, attributes);
}

function createAgentEndHandler(state: HandlerSessionState): Handler {
  return handleAgentEnd.bind(undefined, state);
}

function handleAgentEnd(state: HandlerSessionState, event: unknown, _ctx: ObservMeHandlerContext): void {
  const session = state.session;
  if (!session) return;

  const runId = readString(event, "agentRunId") ?? readString(event, "runId") ?? session.currentAgentRunId;
  if (!runId) return;

  const span = session.spans.activeAgentRuns.get(runId);
  const failed = workflowFailed(event);
  const labels = metricLabels(session.config, session.lineage);
  if (failed) span?.setStatus({ code: SpanStatusCode.ERROR });
  if (span && failed) session.metrics.agentRunErrors.add(1, labels);
  recordSpanDurationMs(span, session.metrics.agentRunDurationMs, labels);
  endActiveSpan(session, span);
  session.spans.activeAgentRuns.delete(runId);
  session.turnSequences.delete(runId);
  if (session.currentAgentRunId === runId) session.currentAgentRunId = undefined;
  emitLifecycleLog(session.logger, failed ? LOG_EVENT_NAMES.AGENT_RUN_FAILED : LOG_EVENT_NAMES.AGENT_RUN_COMPLETED, {
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_ID]: runId,
    ...buildLineageMetricSafeLogAttributes(session),
  });
}

function createTurnStartHandler(state: HandlerSessionState): Handler {
  return handleTurnStart.bind(undefined, state);
}

function handleTurnStart(state: HandlerSessionState, event: unknown, _ctx: ObservMeHandlerContext): void {
  const session = state.session;
  if (!session) return;

  const hadCurrentAgentRun = session.currentAgentRunId !== undefined;
  const runId = session.currentAgentRunId ?? nextAgentRunId(session, event);
  if (!hadCurrentAgentRun) recordTelemetryDrop(session, "agent_run_id_missing_turn_start", { operation: "turn_start" });
  const runSpan = session.spans.activeAgentRuns.get(runId) ?? session.sessionSpan;
  const turnIndex = nextTurnIndex(session, runId, event);
  const turnId = deriveTurnId(runId, turnIndex);
  const attributes = buildTurnAttributes(event, session, runId, turnId, turnIndex);
  const span = startActiveChildSpan(session, SPAN_NAMES.PI_TURN, runSpan, attributes, "turn");

  session.currentTurnId = turnId;
  session.spans.activeTurns.set(turnId, span);
  session.metrics.turnsStarted.add(1, metricLabels(session.config, session.lineage));
  recordObsSessionTurn();
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TURN_STARTED, attributes);
}

function createTurnEndHandler(state: HandlerSessionState): Handler {
  return handleTurnEnd.bind(undefined, state);
}

function handleTurnEnd(state: HandlerSessionState, event: unknown, _ctx: ObservMeHandlerContext): void {
  const session = state.session;
  if (!session) return;

  const explicitTurnId = readString(event, "turnId") ?? readString(event, "turn_id");
  let turnId = explicitTurnId;
  let runId = readString(event, "agentRunId") ?? readString(event, "runId") ?? session.currentAgentRunId;
  if (!runId && !turnId && session.currentTurnId) {
    turnId = session.currentTurnId;
    runId = readRunIdFromTurnId(turnId);
  }
  if (!runId) {
    recordTelemetryDrop(session, "turn_run_id_missing", { operation: "turn_end" });
    return;
  }

  const turnIndex = readInteger(event, "turnIndex") ?? readInteger(event, "turn_index") ?? session.turnSequences.get(runId);
  if (!turnId) {
    if (!turnIndex) {
      recordTelemetryDrop(session, "turn_index_missing", { operation: "turn_end" });
      return;
    }
    turnId = deriveTurnId(runId, turnIndex);
  }

  const span = session.spans.activeTurns.get(turnId);
  if (!span) {
    recordTelemetryDrop(session, "turn_span_missing", { operation: "turn_end" });
    return;
  }

  if (workflowFailed(event)) span.setStatus({ code: SpanStatusCode.ERROR });
  recordSpanDurationMs(span, session.metrics.turnDurationMs, metricLabels(session.config, session.lineage));
  endActiveSpan(session, span);
  session.spans.activeTurns.delete(turnId);
  if (session.currentTurnId === turnId) session.currentTurnId = undefined;
  session.metrics.turnsCompleted.add(1, metricLabels(session.config, session.lineage));
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TURN_COMPLETED, {
    [TURN_ATTRIBUTES.PI_TURN_ID]: turnId,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_ID]: runId,
    ...buildLineageMetricSafeLogAttributes(session),
  });
}

function readRunIdFromTurnId(turnId: string): string | undefined {
  const separator = "-turn-";
  const separatorIndex = turnId.lastIndexOf(separator);
  if (separatorIndex <= 0) return undefined;
  return turnId.slice(0, separatorIndex);
}
