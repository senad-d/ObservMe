import { SpanStatusCode } from "@opentelemetry/api";
import type {
  ExtensionContext,
  SessionBeforeTreeEvent,
  SessionCompactEvent,
  SessionInfoChangedEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { COMPACTION_ATTRIBUTES, SESSION_ATTRIBUTES } from "../../semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../../semconv/metrics.ts";
import { SPAN_NAMES } from "../../semconv/spans.ts";
import {
  buildBranchAttributes,
  buildBranchPreparationState,
  buildCompactionAttributes,
  buildLineageMetricSafeLogAttributes,
  buildModelChangeAttributes,
  buildThinkingLevelChangeAttributes,
  emitStructuredLog,
  endActiveSpan,
  metricLabels,
  modelChangeMetricLabels,
  readString,
  resolveOperationParentSpan,
  startActiveChildSpan,
  thinkingLevelChangeMetricLabels,
  updateCurrentSessionAttributes,
} from "../handler-internals.ts";
import type { HandlerRegistrar } from "../handler-runtime.ts";
import type {
  AttributeMap,
  HandlerSessionState,
  ObservMeTelemetrySession,
  PiEvent,
  PiHandler,
} from "../handler-types.ts";

export function registerSessionEventHandlers(registrar: HandlerRegistrar, state: HandlerSessionState): void {
  registrar.add("session_info_changed", createSessionInfoChangedHandler(state));
  registrar.add("model_select", createModelChangeHandler(state));
  registrar.add("thinking_level_select", createThinkingLevelChangeHandler(state));
  registrar.add("session_before_tree", createSessionBeforeTreeHandler(state));
  registrar.add("session_tree", createBranchHandler(state));
  registrar.add("session_compact", createCompactionHandler(state));
}

function createSessionInfoChangedHandler(state: HandlerSessionState): PiHandler<"session_info_changed"> {
  return handleSessionInfoChanged.bind(undefined, state);
}

function handleSessionInfoChanged(
  state: HandlerSessionState,
  event: SessionInfoChangedEvent,
  ctx: ExtensionContext,
): void {
  const session = state.session;
  if (!session) return;

  const attributes = {
    ...buildLineageMetricSafeLogAttributes(session),
    [SESSION_ATTRIBUTES.PI_SESSION_NAME]: readString(event, "name") ?? ctx.sessionManager?.getSessionName() ?? "unknown",
  };

  updateCurrentSessionAttributes(session, attributes, [SESSION_ATTRIBUTES.PI_SESSION_NAME]);
  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.SESSION_NAMED, attributes);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.SESSION_NAMED, "session", attributes);
}

function createModelChangeHandler(state: HandlerSessionState): PiHandler<"model_select"> {
  return handleModelChange.bind(undefined, state);
}

function handleModelChange(
  state: HandlerSessionState,
  event: PiEvent<"model_select">,
  ctx: ExtensionContext,
): void {
  const session = state.session;
  if (!session) return;

  const attributes = buildModelChangeAttributes(event, ctx, session);

  updateCurrentSessionAttributes(session, attributes, [
    SESSION_ATTRIBUTES.PI_MODEL_PROVIDER_CURRENT,
    SESSION_ATTRIBUTES.PI_MODEL_ID_CURRENT,
  ]);
  session.metrics.modelChanges.add(1, modelChangeMetricLabels(session, attributes));
  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.MODEL_CHANGED, attributes);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.MODEL_CHANGED, "model", attributes);
}

function createThinkingLevelChangeHandler(state: HandlerSessionState): PiHandler<"thinking_level_select"> {
  return handleThinkingLevelChange.bind(undefined, state);
}

function handleThinkingLevelChange(
  state: HandlerSessionState,
  event: PiEvent<"thinking_level_select">,
  _ctx: ExtensionContext,
): void {
  const session = state.session;
  if (!session) return;

  const attributes = buildThinkingLevelChangeAttributes(event, session);

  updateCurrentSessionAttributes(session, attributes, [SESSION_ATTRIBUTES.PI_THINKING_LEVEL_CURRENT]);
  session.metrics.thinkingLevelChanges.add(1, thinkingLevelChangeMetricLabels(session));
  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.THINKING_CHANGED, attributes);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.THINKING_CHANGED, "thinking", attributes);
}

function createSessionBeforeTreeHandler(state: HandlerSessionState): PiHandler<"session_before_tree"> {
  return handleSessionBeforeTree.bind(undefined, state);
}

function handleSessionBeforeTree(
  state: HandlerSessionState,
  event: SessionBeforeTreeEvent,
  _ctx: ExtensionContext,
): void {
  const session = state.session;
  if (!session) return;

  session.currentBranchPreparation = buildBranchPreparationState(event, session.config);
}

function createBranchHandler(state: HandlerSessionState): PiHandler<"session_tree"> {
  return handleBranch.bind(undefined, state);
}

function handleBranch(state: HandlerSessionState, event: SessionTreeEvent, _ctx: ExtensionContext): void {
  const session = state.session;
  if (!session) return;

  try {
    recordBranch(session, event);
  } finally {
    session.currentBranchPreparation = undefined;
  }
}

function recordBranch(session: ObservMeTelemetrySession, event: SessionTreeEvent): void {
  const attributes = buildBranchAttributes(event, session);
  const labels = metricLabels(session.config, session.lineage);
  const span = startActiveChildSpan(session, SPAN_NAMES.PI_BRANCH, resolveOperationParentSpan(session), attributes, "branch");

  span.addEvent(LOG_EVENT_NAMES.BRANCH_CREATED, attributes);
  span.setStatus({ code: SpanStatusCode.OK });
  endActiveSpan(session, span);
  session.metrics.branches.add(1, labels);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.BRANCH_CREATED, "branch", attributes);
}

function createCompactionHandler(state: HandlerSessionState): PiHandler<"session_compact"> {
  return handleCompaction.bind(undefined, state);
}

function handleCompaction(state: HandlerSessionState, event: SessionCompactEvent, _ctx: ExtensionContext): void {
  const session = state.session;
  if (!session) return;

  recordCompaction(session, event);
}

function recordCompaction(session: ObservMeTelemetrySession, event: SessionCompactEvent): void {
  const attributes = buildCompactionAttributes(event, session);
  const labels = metricLabels(session.config, session.lineage);
  const span = startActiveChildSpan(
    session,
    SPAN_NAMES.PI_COMPACTION,
    resolveOperationParentSpan(session),
    attributes,
    "compaction",
  );

  span.addEvent(LOG_EVENT_NAMES.COMPACTION_CREATED, attributes);
  span.setStatus({ code: SpanStatusCode.OK });
  endActiveSpan(session, span);
  session.metrics.compactions.add(1, labels);
  recordCompactionTokensBefore(session, attributes, labels);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.COMPACTION_CREATED, "compaction", attributes);
}

function recordCompactionTokensBefore(
  session: ObservMeTelemetrySession,
  attributes: AttributeMap,
  labels: Record<string, string>,
): void {
  const tokensBefore = attributes[COMPACTION_ATTRIBUTES.PI_COMPACTION_TOKENS_BEFORE];
  if (typeof tokensBefore !== "number") return;

  session.metrics.compactionTokensBefore.record(tokensBefore, labels);
}
