import { SpanStatusCode } from "@opentelemetry/api";
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";
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
  cancelPendingUserBashCompletionPoll,
  closePendingUserBashOperation,
  deleteCurrentToolCall,
  emitCapturedToolErrorLog,
  emitLifecycleLog,
  endActiveSpan,
  hasBashCompletionResult,
  isBashExecutionMessage,
  mergeToolStateLabels,
  nextToolCallId,
  readBashCompletionTimestampMs,
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
  HandlerSessionState,
  ObservMeSessionManager,
  ObservMeTelemetrySession,
  PendingBashOperationState,
  PiEvent,
  PiHandler,
  ToolCallState,
} from "../handler-types.ts";

const INITIAL_BASH_COMPLETION_POLL_DELAY_MS = 10;
const MAX_BASH_COMPLETION_POLL_DELAY_MS = 250;

export function registerToolBashHandlers(registrar: HandlerRegistrar, state: HandlerSessionState): void {
  registrar.add("tool_execution_start", createToolExecutionStartHandler(state));
  registrar.add("tool_call", createToolCallHandler(state));
  registrar.add("tool_result", createToolResultHandler(state));
  registrar.add("tool_execution_end", createToolExecutionEndHandler(state));
  registrar.add("user_bash", createUserBashPreExecutionHandler(state));
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
  if (pending && session.pendingUserBash === pending) {
    cancelPendingUserBashCompletionPoll(pending);
    session.pendingUserBash = undefined;
  }
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.BASH_COMPLETED, attributes, failed ? "ERROR" : "INFO");
}

function createToolExecutionStartHandler(state: HandlerSessionState): PiHandler<"tool_execution_start"> {
  return handleToolExecutionStart.bind(undefined, state);
}

function handleToolExecutionStart(
  state: HandlerSessionState,
  event: PiEvent<"tool_execution_start">,
  _ctx: ExtensionContext,
): void {
  const session = state.session;
  if (!session) return;

  const toolCallId = nextToolCallId(session, event);
  const toolState = startToolCallState(session, event, toolCallId);
  observeToolInput(session, toolState, event);
}

function createToolCallHandler(state: HandlerSessionState): PiHandler<"tool_call"> {
  return handleToolCall.bind(undefined, state);
}

function handleToolCall(state: HandlerSessionState, event: ToolCallEvent, _ctx: ExtensionContext): void {
  const session = state.session;
  if (!session) return;
  if (dropAmbiguousToolLifecycleEvent(session, event, "tool_call")) return;

  const toolCallId = resolveCurrentToolCallId(session, event) ?? nextToolCallId(session, event);
  const toolState = resolveToolCallState(session, event) ?? startToolCallState(session, event, toolCallId);
  observeToolInput(session, toolState, event);
}

function createToolResultHandler(state: HandlerSessionState): PiHandler<"tool_result"> {
  return handleToolResult.bind(undefined, state);
}

function handleToolResult(state: HandlerSessionState, event: ToolResultEvent, _ctx: ExtensionContext): void {
  const session = state.session;
  if (!session) return;
  if (dropAmbiguousToolLifecycleEvent(session, event, "tool_result")) return;

  const toolState = resolveToolCallState(session, event);
  if (!toolState) return;

  reconcileToolInput(session, toolState, event);
  const attributes = buildToolResultAttributes(event, session.config);
  toolState.span.setAttributes(attributes);
  mergeToolStateLabels(toolState, attributes);
  captureToolResult(session, toolState, event);
}

function observeToolInput(
  session: ObservMeTelemetrySession,
  toolState: ToolCallState,
  event: unknown,
): void {
  const attributes = buildToolCallInputAttributes(event, session.config);
  toolState.span.setAttributes(attributes);
  mergeToolStateLabels(toolState, attributes);
  toolState.inputEvent = event;
}

function reconcileToolInput(
  session: ObservMeTelemetrySession,
  toolState: ToolCallState,
  event: unknown,
): void {
  observeToolInput(session, toolState, event);
  recordOptionalToolArguments(session, toolState.span, event);
  toolState.inputReconciled = true;
  toolState.inputEvent = undefined;
}

function captureToolResult(session: ObservMeTelemetrySession, toolState: ToolCallState, event: unknown): void {
  const capturedResult = recordOptionalToolResult(session, toolState.span, event);
  if (capturedResult) toolState.capturedResult = capturedResult;
}

function createToolExecutionEndHandler(state: HandlerSessionState): PiHandler<"tool_execution_end"> {
  return handleToolExecutionEnd.bind(undefined, state);
}

function handleToolExecutionEnd(
  state: HandlerSessionState,
  event: PiEvent<"tool_execution_end">,
  _ctx: ExtensionContext,
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

  if (!toolState.inputReconciled && toolState.inputEvent) {
    reconcileToolInput(session, toolState, toolState.inputEvent);
  }

  const resultAttributes = buildToolResultAttributes(event, session.config);
  const finalAttributes = buildToolFinalAttributes(event);
  const failed = finalAttributes[TOOL_ATTRIBUTES.PI_TOOL_SUCCESS] === false;

  toolState.span.setAttributes({ ...resultAttributes, ...finalAttributes });
  mergeToolStateLabels(toolState, resultAttributes);
  captureToolResult(session, toolState, event);
  const resultSizeChars = resultAttributes[TOOL_ATTRIBUTES.PI_TOOL_RESULT_SIZE];
  if (typeof resultSizeChars === "number") session.metrics.toolResultSizeChars.record(resultSizeChars, toolState.labels);
  const completionLogAttributes = buildToolCompletionLogAttributes(toolState, finalAttributes);

  if (failed) {
    const errorClass = String(finalAttributes[TOOL_ATTRIBUTES.PI_TOOL_ERROR_CLASS] ?? "tool_error");
    toolState.span.setStatus({ code: SpanStatusCode.ERROR, message: errorClass });
    session.metrics.toolFailures.add(1, toolState.labels);
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TOOL_CALL_FAILED, completionLogAttributes, "ERROR");
    if (toolState.capturedResult) emitCapturedToolErrorLog(session, completionLogAttributes, toolState.capturedResult);
  } else {
    toolState.span.setStatus({ code: SpanStatusCode.OK });
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TOOL_CALL_COMPLETED, completionLogAttributes);
  }

  recordSpanDurationMs(toolState.span, session.metrics.toolDurationMs, toolState.labels);
  endActiveSpan(session, toolState.span);
  deleteCurrentToolCall(session, toolCallId);
}

function createUserBashPreExecutionHandler(state: HandlerSessionState): PiHandler<"user_bash"> {
  return handleUserBashPreExecution.bind(undefined, state);
}

function handleUserBashPreExecution(
  state: HandlerSessionState,
  event: UserBashEvent,
  ctx: ExtensionContext,
): void {
  const session = state.session;
  if (!session) return;

  startPendingUserBashOperation(session, event, ctx);
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

function startPendingUserBashOperation(
  session: ObservMeTelemetrySession,
  event: unknown,
  ctx: ExtensionContext,
): void {
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
  const pending: PendingBashOperationState = {
    span,
    startedAtMs: session.now?.() ?? monotonicNowMs(),
    observedStartedAtUnixMs: Date.now(),
    eventStartedAtMs: readBashPreExecutionTimestampMs(event),
    readSessionEntries: resolveBashSessionEntriesReader(ctx),
    completionPollDelayMs: INITIAL_BASH_COMPLETION_POLL_DELAY_MS,
  };
  session.pendingUserBash = pending;
  recordOptionalBashContent(session, span, event);
  startPendingUserBashCompletionObservation(session, pending);
}

function resolveBashSessionEntriesReader(
  ctx: ExtensionContext,
): (() => ReturnType<ObservMeSessionManager["getEntries"]>) | undefined {
  const sessionManager = ctx.sessionManager as Partial<ObservMeSessionManager> | undefined;
  if (typeof sessionManager?.getEntries !== "function") return undefined;
  return sessionManager.getEntries.bind(sessionManager);
}

function startPendingUserBashCompletionObservation(
  session: ObservMeTelemetrySession,
  pending: PendingBashOperationState,
): void {
  if (!pending.readSessionEntries) return;

  try {
    pending.nextSessionEntryIndex = pending.readSessionEntries().length;
    schedulePendingUserBashCompletionPoll(session, pending);
  } catch {
    closePendingUserBashOperation(session, "bash_completion_observer_failed", false);
  }
}

function schedulePendingUserBashCompletionPoll(
  session: ObservMeTelemetrySession,
  pending: PendingBashOperationState,
): void {
  const timer = setTimeout(
    pollPendingUserBashCompletion.bind(undefined, session, pending),
    pending.completionPollDelayMs,
  );
  timer.unref();
  pending.completionPollTimer = timer;
  pending.completionPollDelayMs = Math.min(
    MAX_BASH_COMPLETION_POLL_DELAY_MS,
    pending.completionPollDelayMs * 2,
  );
}

function pollPendingUserBashCompletion(
  session: ObservMeTelemetrySession,
  pending: PendingBashOperationState,
): void {
  pending.completionPollTimer = undefined;
  if (session.pendingUserBash !== pending) return;

  try {
    const completionEntry = findPendingUserBashCompletionEntry(pending);
    if (completionEntry) {
      recordBashExecution(session, completionEntry);
      return;
    }
    schedulePendingUserBashCompletionPoll(session, pending);
  } catch {
    closePendingUserBashOperation(session, "bash_completion_observer_failed", false);
  }
}

function findPendingUserBashCompletionEntry(pending: PendingBashOperationState): unknown {
  const entries = pending.readSessionEntries?.() ?? [];
  const firstCandidateIndex = pending.nextSessionEntryIndex ?? entries.length;
  pending.nextSessionEntryIndex = entries.length;

  for (let index = firstCandidateIndex; index < entries.length; index += 1) {
    if (isBashExecutionMessage(readBashPayload(entries[index]))) return entries[index];
  }

  return undefined;
}

function resolveBashDurationMs(
  session: ObservMeTelemetrySession,
  pending: PendingBashOperationState | undefined,
  completionEvent: unknown,
): number | undefined {
  if (!pending) return resolveStandaloneBashEventDurationMs(completionEvent);

  const eventDurationMs = resolveBashEventDurationMs(pending.eventStartedAtMs, completionEvent);
  if (eventDurationMs !== undefined) return eventDurationMs;

  const observedDurationMs = safeElapsedDurationMs(
    pending.observedStartedAtUnixMs,
    readBashCompletionTimestampMs(completionEvent),
  );
  if (observedDurationMs !== undefined) return observedDurationMs;

  return safeElapsedDurationMs(pending.startedAtMs, session.now?.() ?? monotonicNowMs());
}
