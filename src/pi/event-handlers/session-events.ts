import { SpanStatusCode } from "@opentelemetry/api";
import { COMPACTION_ATTRIBUTES, SESSION_ATTRIBUTES } from "../../semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../../semconv/metrics.ts";
import { SPAN_NAMES } from "../../semconv/spans.ts";
import {
  buildBranchAttributes,
  buildBranchPreparationState,
  buildCompactionAttributes,
  buildModelChangeAttributes,
  buildThinkingLevelChangeAttributes,
  emitStructuredLog,
  endActiveSpan,
  metricLabels,
  modelChangeMetricLabels,
  resolveOperationParentSpan,
  startActiveChildSpan,
  thinkingLevelChangeMetricLabels,
  updateCurrentSessionAttributes,
} from "../handler-internals.ts";
import type { HandlerRegistrar } from "../handler-runtime.ts";
import type {
  AttributeMap,
  Handler,
  HandlerSessionState,
  ObservMeHandlerContext,
  ObservMeTelemetrySession,
} from "../handler-types.ts";

export function registerSessionEventHandlers(registrar: HandlerRegistrar, state: HandlerSessionState): void {
  registrar.add("model_select", createModelChangeHandler(state));
  registrar.add("model_change", createModelChangeHandler(state));
  registrar.add("thinking_level_select", createThinkingLevelChangeHandler(state));
  registrar.add("thinking_level_change", createThinkingLevelChangeHandler(state));
  registrar.add("session_before_tree", createSessionBeforeTreeHandler(state));
  registrar.add("session_tree", createBranchHandler(state));
  registrar.add("session_compact", createCompactionHandler(state));
}

function createModelChangeHandler(state: HandlerSessionState): Handler {
  return handleModelChange.bind(undefined, state);
}

function handleModelChange(state: HandlerSessionState, event: unknown, ctx: ObservMeHandlerContext): void {
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

function createThinkingLevelChangeHandler(state: HandlerSessionState): Handler {
  return handleThinkingLevelChange.bind(undefined, state);
}

function handleThinkingLevelChange(
  state: HandlerSessionState,
  event: unknown,
  ctx: ObservMeHandlerContext,
): void {
  const session = state.session;
  if (!session) return;

  const attributes = buildThinkingLevelChangeAttributes(event, ctx, session);

  updateCurrentSessionAttributes(session, attributes, [SESSION_ATTRIBUTES.PI_THINKING_LEVEL_CURRENT]);
  session.metrics.thinkingLevelChanges.add(1, thinkingLevelChangeMetricLabels(session));
  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.THINKING_CHANGED, attributes);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.THINKING_CHANGED, "thinking", attributes);
}

function createSessionBeforeTreeHandler(state: HandlerSessionState): Handler {
  return handleSessionBeforeTree.bind(undefined, state);
}

function handleSessionBeforeTree(
  state: HandlerSessionState,
  event: unknown,
  _ctx: ObservMeHandlerContext,
): void {
  const session = state.session;
  if (!session) return;

  session.currentBranchPreparation = buildBranchPreparationState(event, session.config);
}

function createBranchHandler(state: HandlerSessionState): Handler {
  return handleBranch.bind(undefined, state);
}

function handleBranch(state: HandlerSessionState, event: unknown, _ctx: ObservMeHandlerContext): void {
  const session = state.session;
  if (!session) return;

  try {
    recordBranch(session, event);
  } finally {
    session.currentBranchPreparation = undefined;
  }
}

function recordBranch(session: ObservMeTelemetrySession, event: unknown): void {
  const attributes = buildBranchAttributes(event, session);
  const labels = metricLabels(session.config, session.lineage);
  const span = startActiveChildSpan(session, SPAN_NAMES.PI_BRANCH, resolveOperationParentSpan(session), attributes, "branch");

  span.addEvent(LOG_EVENT_NAMES.BRANCH_CREATED, attributes);
  span.setStatus({ code: SpanStatusCode.OK });
  endActiveSpan(session, span);
  session.metrics.branches.add(1, labels);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.BRANCH_CREATED, "branch", attributes);
}

function createCompactionHandler(state: HandlerSessionState): Handler {
  return handleCompaction.bind(undefined, state);
}

function handleCompaction(state: HandlerSessionState, event: unknown, _ctx: ObservMeHandlerContext): void {
  const session = state.session;
  if (!session) return;

  recordCompaction(session, event);
}

function recordCompaction(session: ObservMeTelemetrySession, event: unknown): void {
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
