import { SpanStatusCode } from "@opentelemetry/api";
import type {
  BeforeProviderRequestEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { recordObsSessionLlmCall } from "../../commands/obs-session.ts";
import { LOG_EVENT_NAMES } from "../../semconv/metrics.ts";
import { SPAN_NAMES } from "../../semconv/spans.ts";
import {
  buildLlmFinalAttributes,
  buildLlmRequestAttributes,
  buildLlmResponseAttributes,
  deleteCurrentLlmRequest,
  emitLifecycleLog,
  endActiveSpan,
  isAssistantMessage,
  isBashExecutionMessage,
  isLlmError,
  llmMetricLabels,
  nextLlmRequestId,
  readMessage,
  recordLlmSizeMetrics,
  recordLlmUsageMetrics,
  recordOptionalLlmContent,
  recordOptionalPromptContent,
  recordPromptSizeMetric,
  recordSpanDurationMs,
  resolveCurrentLlmSpan,
  resolveLlmParentSpan,
  startActiveChildSpan,
} from "../handler-internals.ts";
import type { HandlerRegistrar } from "../handler-runtime.ts";
import type { HandlerSessionState, PiEvent, PiHandler } from "../handler-types.ts";
import { recordBashExecution } from "./tool-bash.ts";

export function registerLlmHandlers(registrar: HandlerRegistrar, state: HandlerSessionState): void {
  registrar.add("before_provider_request", createBeforeProviderRequestHandler(state));
  registrar.add("after_provider_response", createAfterProviderResponseHandler(state));
  registrar.add("message_end", createMessageEndHandler(state));
}

function createBeforeProviderRequestHandler(state: HandlerSessionState): PiHandler<"before_provider_request"> {
  return handleBeforeProviderRequest.bind(undefined, state);
}

function handleBeforeProviderRequest(
  state: HandlerSessionState,
  event: BeforeProviderRequestEvent,
  ctx: ExtensionContext,
): void {
  const session = state.session;
  if (!session) return;

  const requestId = nextLlmRequestId(session, event);
  const parentSpan = resolveLlmParentSpan(session);
  const attributes = buildLlmRequestAttributes(event, ctx, session, requestId);
  const span = startActiveChildSpan(session, SPAN_NAMES.PI_LLM_REQUEST, parentSpan, attributes, "llm_request");

  recordPromptSizeMetric(session, event, llmMetricLabels(session, attributes));
  recordOptionalPromptContent(session, span, event);
  session.currentLlmRequestId = requestId;
  session.spans.activeLlmRequests.set(requestId, span);
  session.metrics.llmRequests.add(1, llmMetricLabels(session, attributes));
  recordObsSessionLlmCall();
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.LLM_REQUEST_STARTED, attributes);
}

function createAfterProviderResponseHandler(state: HandlerSessionState): PiHandler<"after_provider_response"> {
  return handleAfterProviderResponse.bind(undefined, state);
}

function handleAfterProviderResponse(
  state: HandlerSessionState,
  event: PiEvent<"after_provider_response">,
  _ctx: ExtensionContext,
): void {
  const session = state.session;
  if (!session) return;

  const span = resolveCurrentLlmSpan(session, event);
  span?.setAttributes(buildLlmResponseAttributes(event));
}

function createMessageEndHandler(state: HandlerSessionState): PiHandler<"message_end"> {
  return handleMessageEnd.bind(undefined, state);
}

function handleMessageEnd(
  state: HandlerSessionState,
  event: PiEvent<"message_end">,
  _ctx: ExtensionContext,
): void {
  const session = state.session;
  if (!session) return;

  const message = readMessage(event);
  if (isBashExecutionMessage(message)) {
    recordBashExecution(session, event);
    return;
  }
  if (!isAssistantMessage(message)) return;

  const span = resolveCurrentLlmSpan(session, event);
  const attributes = buildLlmFinalAttributes(message, session);
  const labels = llmMetricLabels(session, attributes);

  span?.setAttributes(attributes);
  recordLlmUsageMetrics(session, message, labels);
  recordLlmSizeMetrics(session, message, labels);
  recordOptionalLlmContent(session, span, message);

  if (isLlmError(message)) {
    span?.setStatus({ code: SpanStatusCode.ERROR, message: "provider_error" });
    session.metrics.llmErrors.add(1, labels);
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.LLM_REQUEST_FAILED, attributes, "ERROR");
  } else {
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.LLM_REQUEST_COMPLETED, attributes);
  }

  recordSpanDurationMs(span, session.metrics.llmRequestDurationMs, labels);
  endActiveSpan(session, span);
  deleteCurrentLlmRequest(session, event);
}
