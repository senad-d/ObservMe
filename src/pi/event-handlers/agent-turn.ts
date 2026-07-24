import type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  ExtensionContext,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
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
import type { HandlerRegistrar } from "../handler-runtime.ts";
import type { HandlerSessionState, PiHandler, TerminalOutcome } from "../handler-types.ts";
import {
  deriveAgentOutcome,
  deriveTurnOutcome,
  mergeTerminalOutcome,
  setTerminalSpanStatus,
} from "../terminal-outcome.ts";

export function registerAgentTurnHandlers(registrar: HandlerRegistrar, state: HandlerSessionState): void {
  registrar.add("before_agent_start", createBeforeAgentStartHandler(state));
  registrar.add("agent_start", createAgentStartHandler(state));
  registrar.add("turn_start", createTurnStartHandler(state));
  registrar.add("turn_end", createTurnEndHandler(state));
  registrar.add("agent_end", createAgentEndHandler(state));
}

function createBeforeAgentStartHandler(state: HandlerSessionState): PiHandler<"before_agent_start"> {
  return handleBeforeAgentStart.bind(undefined, state);
}

function handleBeforeAgentStart(
  state: HandlerSessionState,
  event: BeforeAgentStartEvent,
  _ctx: ExtensionContext,
): void {
  const session = state.session;
  if (!session) return;

  session.pendingUserPromptImageCount = event.images?.length ?? 0;
}

function createAgentStartHandler(state: HandlerSessionState): PiHandler<"agent_start"> {
  return handleAgentStart.bind(undefined, state);
}

function handleAgentStart(state: HandlerSessionState, event: AgentStartEvent, _ctx: ExtensionContext): void {
  const session = state.session;
  if (!session) return;

  session.nextTurnImageCount = session.pendingUserPromptImageCount;
  session.pendingUserPromptImageCount = undefined;
  const runId = nextAgentRunId(session, event);
  const attributes = buildAgentRunAttributes(event, session, runId);
  const span = startActiveChildSpan(session, SPAN_NAMES.PI_AGENT_RUN, session.sessionSpan, attributes, "agent_run");

  session.currentAgentRunId = runId;
  session.spans.activeAgentRuns.set(runId, span);
  session.metrics.agentRuns.add(1, metricLabels(session.config, session.lineage));
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.AGENT_RUN_STARTED, attributes);
}

function createAgentEndHandler(state: HandlerSessionState): PiHandler<"agent_end"> {
  return handleAgentEnd.bind(undefined, state);
}

function handleAgentEnd(state: HandlerSessionState, event: AgentEndEvent, _ctx: ExtensionContext): void {
  const session = state.session;
  if (!session) return;

  const runId = readString(event, "agentRunId") ?? readString(event, "runId") ?? session.currentAgentRunId;
  if (!runId) return;

  const span = session.spans.activeAgentRuns.get(runId);
  if (!span) {
    recordTelemetryDrop(session, "agent_run_span_missing", { operation: "agent_end" });
    return;
  }

  const outcome = deriveAgentOutcome(event);
  const labels = metricLabels(session.config, session.lineage);
  span.setAttribute(AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_OUTCOME, outcome);
  setTerminalSpanStatus(span, outcome);
  session.workflowOutcome = mergeTerminalOutcome(session.workflowOutcome, outcome);
  if (outcome === "error") session.metrics.agentRunErrors.add(1, labels);
  recordSpanDurationMs(span, session.metrics.agentRunDurationMs, labels);
  endActiveSpan(session, span);
  session.spans.activeAgentRuns.delete(runId);
  session.turnSequences.delete(runId);
  if (session.currentAgentRunId === runId) {
    session.currentAgentRunId = undefined;
    session.nextTurnImageCount = undefined;
  }
  emitLifecycleLog(session.logger, agentRunTerminalEventName(outcome), {
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_ID]: runId,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_OUTCOME]: outcome,
    ...buildLineageMetricSafeLogAttributes(session),
  }, terminalSeverity(outcome));
}

function createTurnStartHandler(state: HandlerSessionState): PiHandler<"turn_start"> {
  return handleTurnStart.bind(undefined, state);
}

function handleTurnStart(state: HandlerSessionState, event: TurnStartEvent, _ctx: ExtensionContext): void {
  const session = state.session;
  if (!session) return;

  const hadCurrentAgentRun = session.currentAgentRunId !== undefined;
  const runId = session.currentAgentRunId ?? nextAgentRunId(session, event);
  if (!hadCurrentAgentRun) recordTelemetryDrop(session, "agent_run_id_missing_turn_start", { operation: "turn_start" });
  const runSpan = session.spans.activeAgentRuns.get(runId) ?? session.sessionSpan;
  const turnIndex = nextTurnIndex(session, runId, event);
  const turnId = deriveTurnId(runId, turnIndex);
  const imageCount = session.nextTurnImageCount;
  session.nextTurnImageCount = undefined;
  const attributes = buildTurnAttributes(event, session, runId, turnId, turnIndex, imageCount);
  const span = startActiveChildSpan(session, SPAN_NAMES.PI_TURN, runSpan, attributes, "turn");

  session.currentTurnId = turnId;
  session.spans.activeTurns.set(turnId, span);
  session.metrics.turnsStarted.add(1, metricLabels(session.config, session.lineage));
  recordObsSessionTurn();
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TURN_STARTED, attributes);
}

function createTurnEndHandler(state: HandlerSessionState): PiHandler<"turn_end"> {
  return handleTurnEnd.bind(undefined, state);
}

function handleTurnEnd(state: HandlerSessionState, event: TurnEndEvent, _ctx: ExtensionContext): void {
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
    if (turnIndex === undefined) {
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

  const outcome = deriveTurnOutcome(event);
  const labels = metricLabels(session.config, session.lineage);
  span.setAttribute(TURN_ATTRIBUTES.PI_TURN_OUTCOME, outcome);
  setTerminalSpanStatus(span, outcome);
  session.workflowOutcome = mergeTerminalOutcome(session.workflowOutcome, outcome);
  recordSpanDurationMs(span, session.metrics.turnDurationMs, labels);
  endActiveSpan(session, span);
  session.spans.activeTurns.delete(turnId);
  if (session.currentTurnId === turnId) session.currentTurnId = undefined;
  session.metrics.turnsCompleted.add(1, labels);
  emitLifecycleLog(session.logger, turnTerminalEventName(outcome), {
    [TURN_ATTRIBUTES.PI_TURN_ID]: turnId,
    [TURN_ATTRIBUTES.PI_TURN_OUTCOME]: outcome,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_ID]: runId,
    ...buildLineageMetricSafeLogAttributes(session),
  }, terminalSeverity(outcome));
}

function agentRunTerminalEventName(outcome: TerminalOutcome): string {
  if (outcome === "error") return LOG_EVENT_NAMES.AGENT_RUN_FAILED;
  if (outcome === "cancelled") return LOG_EVENT_NAMES.AGENT_RUN_CANCELLED;
  if (outcome === "unknown") return LOG_EVENT_NAMES.AGENT_RUN_UNKNOWN;
  return LOG_EVENT_NAMES.AGENT_RUN_COMPLETED;
}

function turnTerminalEventName(outcome: TerminalOutcome): string {
  if (outcome === "error") return LOG_EVENT_NAMES.TURN_FAILED;
  if (outcome === "cancelled") return LOG_EVENT_NAMES.TURN_CANCELLED;
  if (outcome === "unknown") return LOG_EVENT_NAMES.TURN_UNKNOWN;
  return LOG_EVENT_NAMES.TURN_COMPLETED;
}

function terminalSeverity(outcome: TerminalOutcome): "ERROR" | "INFO" {
  return outcome === "error" ? "ERROR" : "INFO";
}

function readRunIdFromTurnId(turnId: string): string | undefined {
  const separator = "-turn-";
  const separatorIndex = turnId.lastIndexOf(separator);
  if (separatorIndex <= 0) return undefined;
  return turnId.slice(0, separatorIndex);
}
