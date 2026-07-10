import { SpanStatusCode } from "@opentelemetry/api";
import { TOOL_ATTRIBUTES } from "../../semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../../semconv/metrics.ts";
import { SPAN_NAMES } from "../../semconv/spans.ts";
import {
  bashErrorClass,
  bashExecutionFailed,
  bashExecutionMetricLabels,
  bashFailureMetricLabels,
  buildBashExecutionAttributes,
  buildBashPreExecutionAttributes,
  buildToolCallInputAttributes,
  buildToolCompletionLogAttributes,
  buildToolFinalAttributes,
  buildToolResultAttributes,
  closePendingUserBashOperation,
  deleteCurrentToolCall,
  emitLifecycleLog,
  endActiveSpan,
  hasBashCompletionResult,
  mergeToolStateLabels,
  nextToolCallId,
  readBashPayload,
  readBashPreExecutionTimestampMs,
  recordMissingToolCallIdDrop,
  recordOptionalBashContent,
  recordOptionalToolArguments,
  recordOptionalToolResult,
  recordSpanDurationMs,
  recordTelemetryDrop,
  resolveBashEventDurationMs,
  resolveCurrentToolCallId,
  resolveStandaloneBashEventDurationMs,
  resolveToolCallState,
  resolveToolParentSpan,
  safeElapsedDurationMs,
  startActiveChildSpan,
  startToolCallState,
  toolEventHasAmbiguousMissingToolCallId,
} from "../handler-internals.ts";
import { monotonicNowMs } from "../handler-runtime.ts";
import type { HandlerRegistrar } from "../handler-runtime.ts";
import type {
  Handler,
  HandlerSessionState,
  ObservMeHandlerContext,
  ObservMeTelemetrySession,
  PendingBashOperationState,
} from "../handler-types.ts";

export function registerToolBashHandlers(registrar: HandlerRegistrar, state: HandlerSessionState): void {
  registrar.add("tool_execution_start", createToolExecutionStartHandler(state));
  registrar.add("tool_call", createToolCallHandler(state));
  registrar.add("tool_result", createToolResultHandler(state));
  registrar.add("tool_execution_end", createToolExecutionEndHandler(state));
  registrar.add("user_bash", createUserBashPreExecutionHandler(state));
  registrar.add("bashExecution", createBashExecutionHandler(state));
}

export function recordBashExecution(session: ObservMeTelemetrySession, event: unknown): void {
  const payload = readBashPayload(event);
  if (!hasBashCompletionResult(payload)) {
    recordTelemetryDrop(session, "bash_completion_incomplete", { operation: "bash_execution" });
    return;
  }

  const pending = session.pendingUserBash;
  const attributes = buildBashExecutionAttributes(payload, session);
  const span = pending?.span ?? startActiveChildSpan(
    session,
    SPAN_NAMES.PI_BASH_EXECUTION,
    resolveToolParentSpan(session),
    attributes,
    "bash_execution",
  );
  const failed = bashExecutionFailed(payload);
  const labels = bashExecutionMetricLabels(session, payload, failed);
  const durationMs = resolveBashDurationMs(session, pending, payload);

  span.setAttributes(attributes);
  recordOptionalBashContent(session, span, payload);
  session.metrics.bashExecutions.add(1, labels);

  if (failed) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: bashErrorClass(payload) });
    session.metrics.bashFailures.add(1, bashFailureMetricLabels(session, payload));
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.addEvent(LOG_EVENT_NAMES.BASH_COMPLETED, attributes);
  if (durationMs !== undefined) session.metrics.bashDurationMs.record(durationMs, labels);
  endActiveSpan(session, span);
  if (session.pendingUserBash === pending) session.pendingUserBash = undefined;
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.BASH_COMPLETED, attributes, failed ? "ERROR" : "INFO");
}

function createToolExecutionStartHandler(state: HandlerSessionState): Handler {
  return handleToolExecutionStart.bind(undefined, state);
}

function handleToolExecutionStart(
  state: HandlerSessionState,
  event: unknown,
  _ctx: ObservMeHandlerContext,
): void {
  const session = state.session;
  if (!session) return;

  const toolCallId = nextToolCallId(session, event);
  const toolState = startToolCallState(session, event, toolCallId);
  recordOptionalToolArguments(session, toolState.span, event);
}

function createToolCallHandler(state: HandlerSessionState): Handler {
  return handleToolCall.bind(undefined, state);
}

function handleToolCall(state: HandlerSessionState, event: unknown, _ctx: ObservMeHandlerContext): void {
  const session = state.session;
  if (!session) return;
  if (dropAmbiguousToolLifecycleEvent(session, event, "tool_call")) return;

  const toolCallId = resolveCurrentToolCallId(session, event) ?? nextToolCallId(session, event);
  const toolState = resolveToolCallState(session, event) ?? startToolCallState(session, event, toolCallId);
  const attributes = buildToolCallInputAttributes(event, session.config);

  toolState.span.setAttributes(attributes);
  mergeToolStateLabels(toolState, attributes);
  recordOptionalToolArguments(session, toolState.span, event);
}

function createToolResultHandler(state: HandlerSessionState): Handler {
  return handleToolResult.bind(undefined, state);
}

function handleToolResult(state: HandlerSessionState, event: unknown, _ctx: ObservMeHandlerContext): void {
  const session = state.session;
  if (!session) return;
  if (dropAmbiguousToolLifecycleEvent(session, event, "tool_result")) return;

  const toolState = resolveToolCallState(session, event);
  if (!toolState) return;

  const attributes = buildToolResultAttributes(event, session.config);
  toolState.span.setAttributes(attributes);
  mergeToolStateLabels(toolState, attributes);
  recordOptionalToolResult(session, toolState.span, event);
}

function createToolExecutionEndHandler(state: HandlerSessionState): Handler {
  return handleToolExecutionEnd.bind(undefined, state);
}

function handleToolExecutionEnd(
  state: HandlerSessionState,
  event: unknown,
  _ctx: ObservMeHandlerContext,
): void {
  const session = state.session;
  if (!session) return;
  if (dropAmbiguousToolLifecycleEvent(session, event, "tool_execution_end")) return;

  const toolCallId = resolveCurrentToolCallId(session, event);
  const toolState = toolCallId ? resolveToolCallState(session, event) : undefined;
  if (!toolCallId || !toolState) {
    recordTelemetryDrop(session, "tool_call_missing_end", { operation: "tool_execution_end" });
    return;
  }

  const resultAttributes = buildToolResultAttributes(event, session.config);
  const finalAttributes = buildToolFinalAttributes(event);
  const failed = finalAttributes[TOOL_ATTRIBUTES.PI_TOOL_SUCCESS] === false;

  toolState.span.setAttributes({ ...resultAttributes, ...finalAttributes });
  mergeToolStateLabels(toolState, resultAttributes);
  recordOptionalToolResult(session, toolState.span, event);
  const completionLogAttributes = buildToolCompletionLogAttributes(toolState, finalAttributes);

  if (failed) {
    const errorClass = String(finalAttributes[TOOL_ATTRIBUTES.PI_TOOL_ERROR_CLASS] ?? "tool_error");
    toolState.span.setStatus({ code: SpanStatusCode.ERROR, message: errorClass });
    session.metrics.toolFailures.add(1, toolState.labels);
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TOOL_CALL_FAILED, completionLogAttributes, "ERROR");
  } else {
    toolState.span.setStatus({ code: SpanStatusCode.OK });
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TOOL_CALL_COMPLETED, completionLogAttributes);
  }

  recordSpanDurationMs(toolState.span, session.metrics.toolDurationMs, toolState.labels);
  endActiveSpan(session, toolState.span);
  deleteCurrentToolCall(session, toolCallId);
}

function createUserBashPreExecutionHandler(state: HandlerSessionState): Handler {
  return handleUserBashPreExecution.bind(undefined, state);
}

function handleUserBashPreExecution(
  state: HandlerSessionState,
  event: unknown,
  _ctx: ObservMeHandlerContext,
): void {
  const session = state.session;
  if (!session) return;

  startPendingUserBashOperation(session, event);
}

function createBashExecutionHandler(state: HandlerSessionState): Handler {
  return handleBashExecution.bind(undefined, state);
}

function handleBashExecution(state: HandlerSessionState, event: unknown, _ctx: ObservMeHandlerContext): void {
  const session = state.session;
  if (!session) return;

  recordBashExecution(session, event);
}

function dropAmbiguousToolLifecycleEvent(
  session: ObservMeTelemetrySession,
  event: unknown,
  operation: string,
): boolean {
  if (!toolEventHasAmbiguousMissingToolCallId(session, event)) return false;

  recordMissingToolCallIdDrop(session, operation);
  return true;
}

function startPendingUserBashOperation(session: ObservMeTelemetrySession, event: unknown): void {
  if (session.pendingUserBash) {
    closePendingUserBashOperation(session, "bash_overlap_ambiguous", true);
    return;
  }

  const attributes = buildBashPreExecutionAttributes(event, session);
  const span = startActiveChildSpan(
    session,
    SPAN_NAMES.PI_BASH_EXECUTION,
    resolveToolParentSpan(session),
    attributes,
    "bash_execution",
  );
  session.pendingUserBash = {
    span,
    startedAtMs: session.now?.() ?? monotonicNowMs(),
    eventStartedAtMs: readBashPreExecutionTimestampMs(event),
  };
  recordOptionalBashContent(session, span, event);
}

function resolveBashDurationMs(
  session: ObservMeTelemetrySession,
  pending: PendingBashOperationState | undefined,
  completionEvent: unknown,
): number | undefined {
  if (!pending) return resolveStandaloneBashEventDurationMs(completionEvent);

  const eventDurationMs = resolveBashEventDurationMs(pending.eventStartedAtMs, completionEvent);
  if (eventDurationMs !== undefined) return eventDurationMs;

  return safeElapsedDurationMs(pending.startedAtMs, session.now?.() ?? monotonicNowMs());
}
