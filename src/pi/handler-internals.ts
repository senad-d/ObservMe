import type { Context, Counter, Histogram, Link, Span, SpanContext } from "@opentelemetry/api";
import {
  context as otelContext,
  createTraceState,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { recordObsAgentWaitJoinHint } from "../commands/obs-agents-runtime.ts";
import { recordObsSessionCost, recordObsSessionToolCall } from "../commands/obs-session.ts";
import { recordObsStatusQueueDrop } from "../commands/obs-status.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import { trySha256 } from "../privacy/hash.ts";
import { applyContentCapturePolicy, type ContentCapturePolicyResult } from "../privacy/content-capture.ts";
import {
  AGENT_RUN_ATTRIBUTES,
  BASH_ATTRIBUTES,
  BRANCH_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  COMPACTION_ATTRIBUTES,
  LLM_ATTRIBUTES,
  LOG_ATTRIBUTES,
  SESSION_ATTRIBUTES,
  TOOL_ATTRIBUTES,
  TURN_ATTRIBUTES,
} from "../semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../semconv/metrics.ts";
import { SPAN_NAMES } from "../semconv/spans.ts";
import type { AgentLineageContext, ParentPropagationFailureReason } from "./agent-lineage.ts";
import type {
  AttributeMap,
  AttributePrimitive,
  BranchPreparationState,
  CapturedContent,
  ObservMeHandlerContext,
  ObservMeMetrics,
  ObservMeTelemetrySession,
  PendingBashOperationState,
  TelemetryLogger,
  TelemetryTracer,
  ToolCallState,
} from "./handler-types.ts";
import type { AgentWaitJoinState, SubagentSpawnState } from "./subagent-types.ts";

const OBSERVME_SEMCONV_VERSION = "0.1.0";
const REDACTION_FAILURE_REASON = "redaction_failed";
const TENANT_SALT_UNAVAILABLE_REASON = "tenant_salt_unavailable";

type LlmContentKind = "prompt" | "response" | "thinking";

export type SelfObservabilitySession = Pick<
  ObservMeTelemetrySession,
  "lineage" | "logger" | "metrics" | "sessionAttributes" | "currentAgentRunId" | "currentTurnId"
>;
export type TelemetryDropTarget = ObservMeMetrics | SelfObservabilitySession;

export function emitLifecycleLog(
  logger: TelemetryLogger,
  eventName: string,
  attributes: AttributeMap,
  severityText: "ERROR" | "INFO" = "INFO",
): void {
  emitStructuredLog(logger, eventName, "lifecycle", attributes, severityText);
}

export function emitStructuredLog(
  logger: TelemetryLogger,
  eventName: string,
  category: string,
  attributes: AttributeMap,
  severityText: "ERROR" | "INFO" = "INFO",
): void {
  logger.emit({
    severityText,
    body: eventName,
    attributes: {
      [LOG_ATTRIBUTES.EVENT_NAME]: eventName,
      [LOG_ATTRIBUTES.EVENT_CATEGORY]: category,
      ...attributes,
    },
  });
}

export function recordTelemetryDrop(target: TelemetryDropTarget, reason: string, attributes: AttributeMap = {}): void {
  const normalizedReason = normalizeMetricValue(reason, "telemetry_drop");
  const session = resolveSelfObservabilitySession(target);

  resolveSelfObservabilityMetrics(target).telemetryDropped.add(1, { reason: normalizedReason });
  if (session) emitSelfObservabilityLog(session, LOG_EVENT_NAMES.TELEMETRY_DROPPED, "telemetry", buildTelemetryDropLogAttributes(normalizedReason, attributes));
  recordObsStatusQueueDrop();
}

export function recordRedactionFailure(
  session: SelfObservabilitySession,
  operation: string,
  count = 1,
  attributes: AttributeMap = {},
): void {
  const normalizedOperation = normalizeMetricValue(operation, "redaction");
  const errorClass = normalizeMetricValue(readString(attributes, LOG_ATTRIBUTES.ERROR_TYPE) ?? readString(attributes, "error_class") ?? "redaction_error", "redaction_error");
  const logAttributes = { ...attributes, operation: normalizedOperation, [LOG_ATTRIBUTES.ERROR_TYPE]: errorClass };

  session.metrics.redactionFailures.add(normalizeFailureCount(count), { operation: normalizedOperation, error_class: errorClass });
  emitSelfObservabilityLog(session, LOG_EVENT_NAMES.REDACTION_FAILED, "redaction", logAttributes);
}

function buildTelemetryDropLogAttributes(reason: string, attributes: AttributeMap): AttributeMap {
  return withoutUndefinedAttributes({
    operation: normalizeMetricValue(readString(attributes, "operation") ?? reason, "telemetry"),
    reason,
  });
}

function emitSelfObservabilityLog(
  session: SelfObservabilitySession,
  eventName: string,
  category: string,
  attributes: AttributeMap,
): void {
  emitStructuredLog(session.logger, eventName, category, buildSelfObservabilityLogAttributes(session, attributes), "ERROR");
}

function buildSelfObservabilityLogAttributes(session: SelfObservabilitySession, attributes: AttributeMap): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildLineageMetricSafeLogAttributes(session),
    [LOG_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    operation: readString(attributes, "operation"),
    reason: readString(attributes, "reason"),
    [LOG_ATTRIBUTES.ERROR_TYPE]: readString(attributes, LOG_ATTRIBUTES.ERROR_TYPE),
  });
}

function resolveSelfObservabilityMetrics(target: TelemetryDropTarget): ObservMeMetrics {
  if (isSelfObservabilitySession(target)) return target.metrics;
  return target;
}

function resolveSelfObservabilitySession(target: TelemetryDropTarget): SelfObservabilitySession | undefined {
  if (isSelfObservabilitySession(target)) return target;
  return undefined;
}

function isSelfObservabilitySession(target: TelemetryDropTarget): target is SelfObservabilitySession {
  return "logger" in target && "metrics" in target;
}

function normalizeFailureCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 1;
  return Math.max(1, Math.floor(count));
}

export function stringifyAttributes(attributes: AttributeMap): Record<string, string> {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
}

export function nextAgentRunId(session: ObservMeTelemetrySession, event: unknown): string {
  const explicitRunId = readString(event, "agentRunId") ?? readString(event, "runId");
  if (explicitRunId) return explicitRunId;

  session.agentRunSequence += 1;
  return formatAgentRunId(session.agentRunSequence);
}

export function nextTurnIndex(session: ObservMeTelemetrySession, runId: string, event: unknown): number {
  const explicitTurnIndex = readInteger(event, "turnIndex") ?? readInteger(event, "turn_index");
  if (explicitTurnIndex !== undefined) {
    session.turnSequences.set(runId, Math.max(session.turnSequences.get(runId) ?? 0, explicitTurnIndex));
    return explicitTurnIndex;
  }

  const nextIndex = (session.turnSequences.get(runId) ?? 0) + 1;
  session.turnSequences.set(runId, nextIndex);
  return nextIndex;
}

export function nextLlmRequestId(session: ObservMeTelemetrySession, event: unknown): string {
  const explicitRequestId = readString(event, "llmRequestId") ?? readString(event, "requestId");
  if (explicitRequestId) return explicitRequestId;

  session.llmRequestSequence += 1;
  return `llm-request-${formatSequence(session.llmRequestSequence)}`;
}

export function resolveLlmParentSpan(session: ObservMeTelemetrySession): Span | undefined {
  return resolveOperationParentSpan(session);
}

export function resolveCurrentLlmSpan(session: ObservMeTelemetrySession, event: unknown): Span | undefined {
  const requestId = readString(event, "llmRequestId") ?? readString(event, "requestId") ?? session.currentLlmRequestId;
  return requestId ? session.spans.activeLlmRequests.get(requestId) : undefined;
}

export function deleteCurrentLlmRequest(session: ObservMeTelemetrySession, event: unknown): void {
  const requestId = readString(event, "llmRequestId") ?? readString(event, "requestId") ?? session.currentLlmRequestId;
  if (!requestId) return;

  session.spans.activeLlmRequests.delete(requestId);
  if (session.currentLlmRequestId === requestId) session.currentLlmRequestId = undefined;
}

export function nextToolCallId(session: ObservMeTelemetrySession, event: unknown): string {
  const explicitToolCallId = readToolCallId(event);
  if (explicitToolCallId) return explicitToolCallId;

  session.toolCallSequence += 1;
  return `tool-call-${formatSequence(session.toolCallSequence)}`;
}

export function resolveCurrentToolCallId(session: ObservMeTelemetrySession, event: unknown): string | undefined {
  const explicitToolCallId = readToolCallId(event);
  if (explicitToolCallId) return explicitToolCallId;

  // Legacy Pi tool events without ids can only fall back while one tool is active.
  // Parallel tool events must carry explicit ids so telemetry cannot attach to a sibling span.
  if (session.spans.activeToolCalls.size > 1) return undefined;
  return session.currentToolCallId;
}

export function toolEventHasAmbiguousMissingToolCallId(session: ObservMeTelemetrySession, event: unknown): boolean {
  return readToolCallId(event) === undefined && session.spans.activeToolCalls.size > 1;
}

export function recordMissingToolCallIdDrop(session: ObservMeTelemetrySession, operation: string): void {
  recordTelemetryDrop(session, "tool_call_id_missing_ambiguous", { operation });
}

export function resolveToolCallState(session: ObservMeTelemetrySession, event: unknown): ToolCallState | undefined {
  const toolCallId = resolveCurrentToolCallId(session, event);
  return toolCallId ? session.spans.activeToolCalls.get(toolCallId) : undefined;
}

export function deleteCurrentToolCall(session: ObservMeTelemetrySession, toolCallId: string): void {
  session.spans.activeToolCalls.delete(toolCallId);
  if (session.currentToolCallId === toolCallId) session.currentToolCallId = undefined;
}

export function startToolCallState(session: ObservMeTelemetrySession, event: unknown, toolCallId: string): ToolCallState {
  const existingState = session.spans.activeToolCalls.get(toolCallId);
  const attributes = buildToolStartAttributes(event, session, toolCallId);

  if (existingState) {
    existingState.span.setAttributes(attributes);
    mergeToolStateLabels(existingState, attributes);
    session.currentToolCallId = toolCallId;
    return existingState;
  }

  const span = startActiveChildSpan(session, SPAN_NAMES.PI_TOOL_CALL, resolveToolParentSpan(session), attributes, "tool_call");
  const state = {
    span,
    labels: toolMetricLabels(attributes),
    completionLogAttributes: buildToolLogCorrelationAttributes(session, span, attributes),
  };

  session.currentToolCallId = toolCallId;
  session.spans.activeToolCalls.set(toolCallId, state);
  session.metrics.toolCalls.add(1, state.labels);
  recordObsSessionToolCall();
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TOOL_CALL_STARTED, state.completionLogAttributes);

  return state;
}

export function resolveToolParentSpan(session: ObservMeTelemetrySession): Span | undefined {
  return resolveOperationParentSpan(session);
}

export function resolveOperationParentSpan(session: ObservMeTelemetrySession): Span | undefined {
  if (session.currentTurnId) return session.spans.activeTurns.get(session.currentTurnId) ?? session.sessionSpan;
  if (session.currentAgentRunId) return session.spans.activeAgentRuns.get(session.currentAgentRunId) ?? session.sessionSpan;
  return session.sessionSpan;
}

export function deriveTurnId(agentRunId: string, turnIndex: number): string {
  return `${agentRunId}-turn-${formatSequence(turnIndex)}`;
}

export function formatAgentRunId(index: number): string {
  return `agent-run-${formatSequence(index)}`;
}

export function formatSequence(index: number): string {
  return String(index).padStart(6, "0");
}

export function buildAgentRunAttributes(event: unknown, session: ObservMeTelemetrySession, runId: string): AttributeMap {
  const prompt = readString(event, "prompt") ?? readString(event, "userPrompt") ?? readString(event, "message");

  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_PARENT_ID]: session.lineage.parentAgentId,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_ROLE]: session.lineage.role,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_DEPTH]: session.lineage.depth,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_ID]: runId,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_INDEX]: session.agentRunSequence,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_SOURCE]: readString(event, "source") ?? "unknown",
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_PROMPT_HASH]: prompt ? hashValue(prompt, session.config) : undefined,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_PROMPT_LENGTH]: prompt?.length,
    [AGENT_RUN_ATTRIBUTES.GEN_AI_AGENT_ID]: session.lineage.agentId,
  });
}

export function buildTurnAttributes(
  event: unknown,
  session: ObservMeTelemetrySession,
  runId: string,
  turnId: string,
  turnIndex: number,
  imageCount: number | undefined,
): AttributeMap {
  const userMessage = readString(event, "userMessage") ?? readString(event, "prompt") ?? readString(event, "message");

  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: runId,
    [TURN_ATTRIBUTES.PI_TURN_ID]: turnId,
    [TURN_ATTRIBUTES.PI_TURN_INDEX]: turnIndex,
    [TURN_ATTRIBUTES.PI_TURN_BRANCH_PATH_HASH]: readString(event, "branchPath") ? hashValue(readString(event, "branchPath")!, session.config) : undefined,
    [TURN_ATTRIBUTES.PI_TURN_USER_MESSAGE_HASH]: userMessage ? hashValue(userMessage, session.config) : undefined,
    [TURN_ATTRIBUTES.PI_TURN_USER_MESSAGE_LENGTH]: userMessage?.length,
    [TURN_ATTRIBUTES.PI_TURN_USER_MESSAGE_IMAGE_COUNT]: imageCount,
    [TURN_ATTRIBUTES.PI_MODEL_PROVIDER_CURRENT]: resolveSessionModelProvider(event, {}, session),
    [TURN_ATTRIBUTES.PI_MODEL_ID_CURRENT]: resolveSessionModelId(event, {}, session),
  });
}

export function buildLlmRequestAttributes(
  event: unknown,
  ctx: ObservMeHandlerContext,
  session: ObservMeTelemetrySession,
  requestId: string,
): AttributeMap {
  const payload = readUnknown(event, "payload");
  const provider = resolveSessionModelProvider(event, ctx, session);
  const model = resolveSessionModelId(event, ctx, session);

  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [LLM_ATTRIBUTES.PI_LLM_REQUEST_ID]: requestId,
    [LLM_ATTRIBUTES.GEN_AI_OPERATION_NAME]: readString(payload, "operation") ?? readString(payload, "operationName") ?? "chat",
    [LLM_ATTRIBUTES.GEN_AI_PROVIDER_NAME]: provider,
    [LLM_ATTRIBUTES.GEN_AI_REQUEST_MODEL]: model,
    [LLM_ATTRIBUTES.GEN_AI_CONVERSATION_ID]: resolveCurrentSessionId(session),
    [LLM_ATTRIBUTES.PI_LLM_API]: readString(payload, "api") ?? readString(ctx.model, "api") ?? provider,
    [LLM_ATTRIBUTES.PI_LLM_REQUEST_THINKING_LEVEL]: resolveSessionThinkingLevel(event, session),
    [LLM_ATTRIBUTES.PI_LLM_REQUEST_MESSAGE_COUNT]: countPayloadItems(payload, ["messages", "contents", "input", "prompt"]),
    [LLM_ATTRIBUTES.PI_LLM_REQUEST_TOOL_SCHEMA_COUNT]: countPayloadItems(payload, ["tools", "toolSchemas"]),
    [LLM_ATTRIBUTES.PI_LLM_REQUEST_INPUT_CHARS]: safeJsonLength(payload),
    [LLM_ATTRIBUTES.GEN_AI_REQUEST_TEMPERATURE]: readNumber(payload, "temperature"),
    [LLM_ATTRIBUTES.GEN_AI_REQUEST_MAX_TOKENS]: readNumber(payload, "max_tokens") ?? readNumber(payload, "maxTokens"),
  });
}

export function buildLlmResponseAttributes(event: unknown): AttributeMap {
  return withoutUndefinedAttributes({
    "http.response.status_code": readInteger(event, "status"),
  });
}

export function buildLlmFinalAttributes(message: Record<string, unknown>, session: ObservMeTelemetrySession): AttributeMap {
  const usage = readUsage(message);
  const cost = readCost(usage);
  const stopReason = readString(message, "stopReason") ?? "unknown";
  const errorMessage = readString(message, "errorMessage");

  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [LLM_ATTRIBUTES.GEN_AI_OPERATION_NAME]: "chat",
    [LLM_ATTRIBUTES.GEN_AI_PROVIDER_NAME]: readString(message, "provider") ?? "unknown",
    [LLM_ATTRIBUTES.GEN_AI_REQUEST_MODEL]: readString(message, "model") ?? "unknown",
    [LLM_ATTRIBUTES.GEN_AI_RESPONSE_MODEL]: readString(message, "responseModel"),
    [LLM_ATTRIBUTES.GEN_AI_RESPONSE_ID]: readString(message, "responseId"),
    [LLM_ATTRIBUTES.GEN_AI_RESPONSE_FINISH_REASONS]: [mapStopReason(stopReason)],
    [LLM_ATTRIBUTES.GEN_AI_USAGE_INPUT_TOKENS]: readNumber(usage, "input"),
    [LLM_ATTRIBUTES.GEN_AI_USAGE_OUTPUT_TOKENS]: readNumber(usage, "output"),
    [LLM_ATTRIBUTES.GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: readNumber(usage, "cacheRead"),
    [LLM_ATTRIBUTES.GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: readNumber(usage, "cacheWrite"),
    [LLM_ATTRIBUTES.GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: readNumber(usage, "reasoning"),
    [LLM_ATTRIBUTES.GEN_AI_CONVERSATION_ID]: resolveCurrentSessionId(session),
    [LLM_ATTRIBUTES.ERROR_TYPE]: isLlmError(message) ? "provider_error" : undefined,
    [LLM_ATTRIBUTES.PI_LLM_API]: readString(message, "api"),
    [LLM_ATTRIBUTES.PI_LLM_STOP_REASON]: stopReason,
    [LLM_ATTRIBUTES.PI_LLM_ERROR_MESSAGE_HASH]: errorMessage ? hashValue(errorMessage, session.config) : undefined,
    [LLM_ATTRIBUTES.PI_LLM_USAGE_TOTAL_TOKENS]: readNumber(usage, "totalTokens"),
    [LLM_ATTRIBUTES.PI_LLM_USAGE_CACHE_WRITE_1H_TOKENS]: readNumber(usage, "cacheWrite1h"),
    [LLM_ATTRIBUTES.PI_LLM_COST_INPUT_USD]: readNumber(cost, "input"),
    [LLM_ATTRIBUTES.PI_LLM_COST_OUTPUT_USD]: readNumber(cost, "output"),
    [LLM_ATTRIBUTES.PI_LLM_COST_CACHE_READ_USD]: readNumber(cost, "cacheRead"),
    [LLM_ATTRIBUTES.PI_LLM_COST_CACHE_WRITE_USD]: readNumber(cost, "cacheWrite"),
    [LLM_ATTRIBUTES.PI_LLM_COST_TOTAL_USD]: readNumber(cost, "total"),
  });
}

export function buildToolStartAttributes(event: unknown, session: ObservMeTelemetrySession, toolCallId: string): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    ...buildRequiredToolIdentityAttributes(event, toolCallId),
    ...buildToolArgumentsAttributes(event, session.config),
  });
}

export function buildToolCallInputAttributes(event: unknown, config: ObservMeConfig): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildOptionalToolIdentityAttributes(event),
    ...buildToolArgumentsAttributes(event, config),
  });
}

export function buildToolResultAttributes(event: unknown, config: ObservMeConfig): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildOptionalToolIdentityAttributes(event),
    ...buildToolResultPayloadAttributes(event, config),
  });
}

export function buildToolFinalAttributes(event: unknown): AttributeMap {
  const failed = toolExecutionFailed(event);

  return withoutUndefinedAttributes({
    [TOOL_ATTRIBUTES.PI_TOOL_SUCCESS]: !failed,
    [TOOL_ATTRIBUTES.PI_TOOL_ERROR]: failed,
    [TOOL_ATTRIBUTES.PI_TOOL_ERROR_CLASS]: failed ? toolErrorClass(event) : undefined,
  });
}

export function buildRequiredToolIdentityAttributes(event: unknown, toolCallId: string): AttributeMap {
  const rawToolName = readToolName(event);
  const toolName = safeToolName(rawToolName);
  const category = resolveToolCategory(event, toolName);

  return {
    [TOOL_ATTRIBUTES.PI_TOOL_CALL_ID]: toolCallId,
    [TOOL_ATTRIBUTES.PI_TOOL_NAME]: toolName,
    [TOOL_ATTRIBUTES.PI_TOOL_CATEGORY]: category,
    [TOOL_ATTRIBUTES.GEN_AI_TOOL_CALL_ID]: toolCallId,
    [TOOL_ATTRIBUTES.GEN_AI_TOOL_NAME]: toolName,
    [TOOL_ATTRIBUTES.GEN_AI_TOOL_TYPE]: mapToolType(category),
  };
}

export function buildOptionalToolIdentityAttributes(event: unknown): AttributeMap {
  const rawToolName = readToolName(event);
  const explicitCategory = readToolCategory(event);
  if (!rawToolName && !explicitCategory) return {};

  const toolName = rawToolName ? safeToolName(rawToolName) : undefined;
  const category = resolveToolCategory(event, toolName ?? "unknown");

  return withoutUndefinedAttributes({
    [TOOL_ATTRIBUTES.PI_TOOL_NAME]: toolName,
    [TOOL_ATTRIBUTES.PI_TOOL_CATEGORY]: category,
    [TOOL_ATTRIBUTES.GEN_AI_TOOL_NAME]: toolName,
    [TOOL_ATTRIBUTES.GEN_AI_TOOL_TYPE]: mapToolType(category),
  });
}

export function buildToolLogCorrelationAttributes(
  session: ObservMeTelemetrySession,
  span: Span,
  attributes: AttributeMap,
): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildLineageMetricSafeLogAttributes(session),
    [LOG_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    ...buildToolLogIdentityAttributes(attributes),
    [LOG_ATTRIBUTES.TRACE_ID]: readSpanTraceId(span),
    [LOG_ATTRIBUTES.SPAN_ID]: readSpanId(span),
  });
}

export function buildToolCompletionLogAttributes(
  state: ToolCallState,
  finalAttributes: AttributeMap,
): AttributeMap {
  const errorClass = readString(finalAttributes, TOOL_ATTRIBUTES.PI_TOOL_ERROR_CLASS);
  const normalizedErrorClass = errorClass ? normalizeErrorClass(errorClass) : undefined;

  return withoutUndefinedAttributes({
    ...state.completionLogAttributes,
    [TOOL_ATTRIBUTES.PI_TOOL_SUCCESS]: readBoolean(finalAttributes, TOOL_ATTRIBUTES.PI_TOOL_SUCCESS),
    [TOOL_ATTRIBUTES.PI_TOOL_ERROR]: readBoolean(finalAttributes, TOOL_ATTRIBUTES.PI_TOOL_ERROR),
    [TOOL_ATTRIBUTES.PI_TOOL_ERROR_CLASS]: normalizedErrorClass,
    [LOG_ATTRIBUTES.ERROR_TYPE]: normalizedErrorClass,
  });
}

function buildToolLogIdentityAttributes(attributes: AttributeMap): AttributeMap {
  return withoutUndefinedAttributes({
    [TOOL_ATTRIBUTES.PI_TOOL_CALL_ID]: readString(attributes, TOOL_ATTRIBUTES.PI_TOOL_CALL_ID),
    [TOOL_ATTRIBUTES.PI_TOOL_NAME]: readString(attributes, TOOL_ATTRIBUTES.PI_TOOL_NAME),
    [TOOL_ATTRIBUTES.PI_TOOL_CATEGORY]: readString(attributes, TOOL_ATTRIBUTES.PI_TOOL_CATEGORY),
  });
}

export function buildToolArgumentsAttributes(event: unknown, config: ObservMeConfig): AttributeMap {
  const value = readToolArgumentsText(event);

  return buildToolPayloadAttributes(value, TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_HASH, TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_SIZE, config);
}

export function buildToolResultPayloadAttributes(event: unknown, config: ObservMeConfig): AttributeMap {
  const value = readToolResultText(event);

  return buildToolPayloadAttributes(value, TOOL_ATTRIBUTES.PI_TOOL_RESULT_HASH, TOOL_ATTRIBUTES.PI_TOOL_RESULT_SIZE, config);
}

export function buildToolPayloadAttributes(value: string | undefined, hashKey: string, sizeKey: string, config: ObservMeConfig): AttributeMap {
  return withoutUndefinedAttributes({
    [hashKey]: value === undefined ? undefined : hashValue(value, config),
    [sizeKey]: value?.length,
  });
}

export function recordLlmUsageMetrics(
  session: ObservMeTelemetrySession,
  message: Record<string, unknown>,
  labels: Record<string, string>,
): void {
  const usage = readUsage(message);
  const cost = readCost(usage);

  addCounterIfPresent(session.metrics.llmInputTokens, readNumber(usage, "input"), labels);
  addCounterIfPresent(session.metrics.llmOutputTokens, readNumber(usage, "output"), labels);
  addCounterIfPresent(session.metrics.llmCacheReadTokens, readNumber(usage, "cacheRead"), labels);
  addCounterIfPresent(session.metrics.llmCacheWriteTokens, readNumber(usage, "cacheWrite"), labels);
  addCounterIfPresent(session.metrics.llmCacheWrite1hTokens, readNumber(usage, "cacheWrite1h"), labels);
  const totalCostUsd = readNumber(cost, "total");

  addCounterIfPresent(session.metrics.llmReasoningTokens, readNumber(usage, "reasoning"), labels);
  addCounterIfPresent(session.metrics.llmTotalTokens, readNumber(usage, "totalTokens"), labels);
  addCounterIfPresent(session.metrics.llmCostUsd, totalCostUsd, labels);
  recordObsSessionCost(totalCostUsd);
}

export function recordLlmSizeMetrics(
  session: ObservMeTelemetrySession,
  message: Record<string, unknown>,
  labels: Record<string, string>,
): void {
  const responseText = extractAssistantText(message);
  if (responseText) session.metrics.responseSizeChars.record(responseText.length, labels);
}

export function recordPromptSizeMetric(session: ObservMeTelemetrySession, event: unknown, labels: Record<string, string>): void {
  const payload = readUnknown(event, "payload");
  const promptText = extractPayloadPromptText(payload);
  if (promptText) session.metrics.promptSizeChars.record(promptText.length, labels);
}

export function recordOptionalPromptContent(session: ObservMeTelemetrySession, span: Span, event: unknown): void {
  if (!session.config.capture.prompts) return;

  const payload = readUnknown(event, "payload");
  const promptText = extractPayloadPromptText(payload);
  if (!promptText) return;

  const content = recordRedactedSpanContent(session, span, LLM_ATTRIBUTES.PI_LLM_PROMPT_REDACTED, promptText, "prompt");
  if (content) emitCapturedContentLog(session, span, LOG_EVENT_NAMES.LLM_PROMPT_CAPTURED, "prompt", content);
}

export function recordOptionalLlmContent(session: ObservMeTelemetrySession, span: Span | undefined, message: Record<string, unknown>): void {
  if (!span) return;

  if (session.config.capture.responses) {
    const responseText = extractAssistantText(message);
    if (responseText) {
      const content = recordRedactedSpanContent(session, span, LLM_ATTRIBUTES.PI_LLM_RESPONSE_REDACTED, responseText, "response");
      if (content) emitCapturedContentLog(session, span, LOG_EVENT_NAMES.LLM_RESPONSE_CAPTURED, "response", content);
    }
  }

  if (session.config.capture.thinking) {
    const thinkingText = extractAssistantThinking(message);
    if (thinkingText) {
      const content = recordRedactedSpanContent(session, span, LLM_ATTRIBUTES.PI_LLM_THINKING_REDACTED, thinkingText, "thinking");
      if (content) emitCapturedContentLog(session, span, LOG_EVENT_NAMES.LLM_THINKING_CAPTURED, "thinking", content);
    }
  }
}

export function recordOptionalToolArguments(session: ObservMeTelemetrySession, span: Span, event: unknown): void {
  if (!session.config.capture.toolArguments) return;

  const value = readToolArgumentsText(event);
  if (value === undefined) return;

  recordRedactedToolContent(
    session,
    span,
    TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_REDACTED,
    TOOL_ATTRIBUTES.GEN_AI_TOOL_CALL_ARGUMENTS,
    value,
    "toolArgument",
  );
}

export function recordOptionalToolResult(
  session: ObservMeTelemetrySession,
  span: Span,
  event: unknown,
): CapturedContent | undefined {
  if (!session.config.capture.toolResults) return undefined;

  const value = readToolResultText(event);
  if (value === undefined) return undefined;

  return recordRedactedToolContent(
    session,
    span,
    TOOL_ATTRIBUTES.PI_TOOL_RESULT_REDACTED,
    TOOL_ATTRIBUTES.GEN_AI_TOOL_CALL_RESULT,
    value,
    "toolResult",
  );
}

export function recordOptionalBashContent(session: ObservMeTelemetrySession, span: Span, event: unknown): void {
  if (session.config.capture.bashCommands) {
    const command = readBashCommand(event);
    if (command !== undefined) recordRedactedBashContent(session, span, BASH_ATTRIBUTES.PI_BASH_COMMAND_REDACTED, command, "command");
  }

  if (session.config.capture.bashOutput) {
    const output = readBashOutput(event);
    if (output !== undefined) recordRedactedBashContent(session, span, BASH_ATTRIBUTES.PI_BASH_OUTPUT_REDACTED, output, "output");
  }
}

export function recordRedactedBashContent(
  session: ObservMeTelemetrySession,
  span: Span,
  attributeKey: string,
  value: string,
  kind: "command" | "output",
): void {
  const result = applyContentCapturePolicy({
    captureEnabled: true,
    value,
    kind: kind === "output" ? "bashOutput" : "logBody",
    config: session.config,
  });

  if (!result.captured || result.value === undefined) {
    recordRedactionFailure(session, "bash_content_capture", result.redactionFailures, buildContentCaptureFailureAttributes(result));
    return;
  }

  span.setAttribute(attributeKey, result.value);
  if (result.truncated) span.setAttributes(buildBashCaptureTruncationAttributes(kind, result.originalLength ?? value.length));
}

export function buildBashCaptureTruncationAttributes(kind: "command" | "output", originalLength: number): AttributeMap {
  return withoutUndefinedAttributes({
    [BASH_ATTRIBUTES.PI_BASH_TRUNCATED]: kind === "output" ? true : undefined,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED]: true,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH]: originalLength,
  });
}

export function recordRedactedToolContent(
  session: ObservMeTelemetrySession,
  span: Span,
  attributeKey: string,
  aliasAttributeKey: string,
  value: string,
  kind: "toolArgument" | "toolResult",
): CapturedContent | undefined {
  const result = applyContentCapturePolicy({
    captureEnabled: true,
    value,
    kind,
    config: session.config,
  });

  if (!result.captured || result.value === undefined) {
    recordRedactionFailure(session, "tool_content_capture", result.redactionFailures, buildContentCaptureFailureAttributes(result));
    return undefined;
  }

  span.setAttribute(attributeKey, result.value);
  span.setAttribute(aliasAttributeKey, result.value);
  if (result.truncated) span.setAttributes(result.attributes);

  return {
    value: result.value,
    truncated: result.truncated,
    originalLength: result.originalLength,
  };
}

export function recordRedactedSpanContent(
  session: ObservMeTelemetrySession,
  span: Span,
  attributeKey: string,
  value: string,
  kind: LlmContentKind,
): CapturedContent | undefined {
  const result = applyContentCapturePolicy({
    captureEnabled: true,
    value,
    kind: kind === "prompt" ? "prompt" : "response",
    config: session.config,
  });

  if (!result.captured || result.value === undefined) {
    recordRedactionFailure(session, "llm_content_capture", result.redactionFailures, buildContentCaptureFailureAttributes(result));
    return undefined;
  }

  span.setAttribute(attributeKey, result.value);
  if (result.truncated) span.setAttributes(result.attributes);

  return {
    value: result.value,
    truncated: result.truncated,
    originalLength: result.originalLength,
  };
}

export function buildContentCaptureFailureAttributes(result: ContentCapturePolicyResult): AttributeMap {
  const reason = summarizeContentCaptureErrors(result.errors);
  return withoutUndefinedAttributes({ reason, [LOG_ATTRIBUTES.ERROR_TYPE]: reason });
}

export function summarizeContentCaptureErrors(errors: readonly string[]): string | undefined {
  const firstError = errors.find(error => error.trim().length > 0)?.trim();
  if (!firstError) return undefined;
  if (firstError.startsWith("tenant salt ")) return TENANT_SALT_UNAVAILABLE_REASON;
  return REDACTION_FAILURE_REASON;
}

export function emitCapturedContentLog(
  session: ObservMeTelemetrySession,
  span: Span,
  eventName: string,
  kind: LlmContentKind,
  content: CapturedContent,
): void {
  session.logger.emit({
    severityText: "INFO",
    body: content.value,
    attributes: buildCapturedContentLogAttributes(session, span, eventName, kind, content),
  });
}

export function buildCapturedContentLogAttributes(
  session: ObservMeTelemetrySession,
  span: Span,
  eventName: string,
  kind: LlmContentKind,
  content: CapturedContent,
): AttributeMap {
  return withoutUndefinedAttributes({
    [LOG_ATTRIBUTES.EVENT_NAME]: eventName,
    [LOG_ATTRIBUTES.EVENT_CATEGORY]: "llm_content",
    ...buildLineageMetricSafeLogAttributes(session),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [LLM_ATTRIBUTES.GEN_AI_PROVIDER_NAME]: readString(session.sessionAttributes, SESSION_ATTRIBUTES.PI_MODEL_PROVIDER_CURRENT),
    [LLM_ATTRIBUTES.GEN_AI_REQUEST_MODEL]: readString(session.sessionAttributes, SESSION_ATTRIBUTES.PI_MODEL_ID_CURRENT),
    [LLM_ATTRIBUTES.PI_LLM_CONTENT_KIND]: kind,
    [LOG_ATTRIBUTES.TRACE_ID]: readSpanTraceId(span),
    [LOG_ATTRIBUTES.SPAN_ID]: readSpanId(span),
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED]: content.truncated ? true : undefined,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH]: content.truncated ? content.originalLength : undefined,
  });
}

export function emitCapturedToolErrorLog(
  session: ObservMeTelemetrySession,
  completionLogAttributes: AttributeMap,
  content: CapturedContent,
): void {
  session.logger.emit({
    severityText: "ERROR",
    body: content.value,
    attributes: withoutUndefinedAttributes({
      ...completionLogAttributes,
      [LOG_ATTRIBUTES.EVENT_NAME]: LOG_EVENT_NAMES.TOOL_ERROR_CAPTURED,
      [LOG_ATTRIBUTES.EVENT_CATEGORY]: "tool_content",
      [COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED]: content.truncated ? true : undefined,
      [COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH]: content.truncated ? content.originalLength : undefined,
    }),
  });
}

export function addCounterIfPresent(counter: Counter, value: number | undefined, labels: Record<string, string>): void {
  if (value === undefined || value <= 0) return;
  counter.add(value, labels);
}

export function readSpanTraceId(span: Span | undefined): string | undefined {
  const traceId = span?.spanContext?.().traceId;
  return typeof traceId === "string" ? traceId : undefined;
}

export function readSpanId(span: Span | undefined): string | undefined {
  const spanId = span?.spanContext?.().spanId;
  return typeof spanId === "string" ? spanId : undefined;
}

const spanStartTimesMs = new WeakMap<Span, number>();
const activeSpanOperations = new WeakMap<Span, string>();

export type SessionTraceContextFailureReason = ParentPropagationFailureReason | "trace_context_unavailable";

export interface SessionTraceParentResolution {
  readonly parentContext?: Context;
  readonly links?: Link[];
  readonly continued: boolean;
  readonly failureReason?: SessionTraceContextFailureReason;
}

export interface ActiveRootSpanOptions {
  readonly parentContext?: Context;
  readonly links?: Link[];
}

export function resolveSessionTraceParent(lineage: AgentLineageContext): SessionTraceParentResolution {
  const propagated = lineage.propagatedTraceContext;
  if (propagated) {
    const spanContext = createRemoteSpanContext(
      propagated.traceId,
      propagated.spanId,
      propagated.traceFlags,
      propagated.tracestate,
    );
    if (spanContext) {
      return {
        parentContext: trace.setSpanContext(ROOT_CONTEXT, spanContext),
        continued: true,
      };
    }
  }

  const fallbackSpanContext = createRemoteSpanContext(
    lineage.parentTraceId,
    lineage.parentSpanId,
    TraceFlags.NONE,
  );
  if (fallbackSpanContext) {
    return {
      links: [{ context: fallbackSpanContext }],
      continued: false,
      failureReason: lineage.propagationFailure ?? "trace_context_unavailable",
    };
  }

  if (lineage.propagationFailure || lineage.parentAgentId) {
    return {
      continued: false,
      failureReason: lineage.propagationFailure ?? "trace_context_unavailable",
    };
  }

  return { continued: false };
}

function createRemoteSpanContext(
  traceId: string | undefined,
  spanId: string | undefined,
  traceFlags: number,
  tracestate?: string,
): SpanContext | undefined {
  if (!traceId || !spanId) return undefined;

  const spanContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: traceFlags & TraceFlags.SAMPLED,
    isRemote: true,
    ...(tracestate ? { traceState: createTraceState(tracestate) } : {}),
  };
  return isSpanContextValid(spanContext) ? spanContext : undefined;
}

export function startActiveRootSpan(
  session: ObservMeTelemetrySession,
  name: string,
  attributes: AttributeMap,
  operation: string,
  options: ActiveRootSpanOptions = {},
): Span {
  const span = session.tracer.startSpan(
    name,
    { attributes, ...(options.links && options.links.length > 0 ? { links: options.links } : {}) },
    options.parentContext ?? ROOT_CONTEXT,
  );
  spanStartTimesMs.set(span, Date.now());
  recordActiveSpanStart(session.metrics, span, operation);
  return span;
}

export function startActiveChildSpan(
  session: ObservMeTelemetrySession,
  name: string,
  parent: Span | undefined,
  attributes: AttributeMap,
  operation: string,
): Span {
  const span = startChildSpan(session.tracer, name, parent, attributes);
  recordActiveSpanStart(session.metrics, span, operation);
  return span;
}

export function recordActiveSpanStart(metrics: Pick<ObservMeMetrics, "activeSpans">, span: Span, operation: string): void {
  if (activeSpanOperations.has(span)) return;

  const normalizedOperation = normalizeMetricValue(operation, "span");
  activeSpanOperations.set(span, normalizedOperation);
  metrics.activeSpans.add(1, { operation: normalizedOperation });
}

export function endActiveSpan(session: ObservMeTelemetrySession, span: Span | undefined): void {
  if (!span) return;

  recordActiveSpanEnd(session.metrics, span);
  span.end();
}

export function recordActiveSpanEnd(metrics: Pick<ObservMeMetrics, "activeSpans">, span: Span | undefined): void {
  if (!span) return;

  const operation = activeSpanOperations.get(span);
  if (!operation) return;

  metrics.activeSpans.add(-1, { operation });
  activeSpanOperations.delete(span);
  spanStartTimesMs.delete(span);
}

export function startChildSpan(tracer: TelemetryTracer, name: string, parent: Span | undefined, attributes: AttributeMap): Span {
  const parentContext = parent ? trace.setSpan(otelContext.active(), parent) : otelContext.active();
  const span = tracer.startSpan(name, { attributes }, parentContext);
  spanStartTimesMs.set(span, Date.now());
  return span;
}

export function recordSpanDurationMs(span: Span | undefined, histogram: Histogram, labels: Record<string, string>): void {
  if (!span) return;

  const startTimeMs = spanStartTimesMs.get(span);
  if (startTimeMs === undefined) return;

  histogram.record(Math.max(0, Date.now() - startTimeMs), labels);
  spanStartTimesMs.delete(span);
}

export function evictSpan(span: Span, target: TelemetryDropTarget): void {
  const operation = activeSpanOperations.get(span) ?? "span_registry";
  const metrics = resolveSelfObservabilityMetrics(target);

  span.setAttribute(COMMON_SPAN_ATTRIBUTES.OBSERVME_EVICTED, true);
  span.setStatus({ code: SpanStatusCode.ERROR, message: "span_registry_full" });
  recordActiveSpanEnd(metrics, span);
  span.end();
  recordTelemetryDrop(target, "span_registry_full", { operation });
}

export function evictToolCallState(state: ToolCallState, target: TelemetryDropTarget): void {
  evictSpan(state.span, target);
}

export function evictSubagentSpawnState(state: SubagentSpawnState, target: TelemetryDropTarget): void {
  evictSpan(state.span, target);
}

export function evictWaitJoinState(state: AgentWaitJoinState, target: TelemetryDropTarget): void {
  evictSpan(state.span, target);
  recordObsAgentWaitJoinHint({
    kind: state.kind,
    id: state.id,
    active: false,
    spawnId: state.spawnId,
    childAgentId: state.childAgentId,
    childStatus: state.childStatus,
    joinStatus: "unknown",
    reason: state.reason,
  });
}

export function closePendingUserBashOperation(
  session: ObservMeTelemetrySession,
  reason: "bash_completion_observer_failed" | "bash_overlap_ambiguous" | "bash_session_shutdown",
  evicted: boolean,
): void {
  const pending = session.pendingUserBash;
  if (!pending) return;

  cancelPendingUserBashCompletionPoll(pending);
  if (evicted) pending.span.setAttribute(COMMON_SPAN_ATTRIBUTES.OBSERVME_EVICTED, true);
  pending.span.setStatus({ code: SpanStatusCode.ERROR, message: "bash_execution_incomplete" });
  endActiveSpan(session, pending.span);
  session.pendingUserBash = undefined;
  recordTelemetryDrop(session, reason, { operation: "bash_execution" });
}

export function cancelPendingUserBashCompletionPoll(pending: PendingBashOperationState): void {
  if (!pending.completionPollTimer) return;

  clearTimeout(pending.completionPollTimer);
  pending.completionPollTimer = undefined;
}

export function endAllActiveSpans(session: ObservMeTelemetrySession): void {
  closePendingUserBashOperation(session, "bash_session_shutdown", false);
  for (const state of session.spans.activeAgentJoins.values()) endActiveSpan(session, state.span);
  for (const state of session.spans.activeAgentWaits.values()) endActiveSpan(session, state.span);
  for (const state of session.spans.activeSubagentSpawns.values()) endActiveSpan(session, state.span);
  for (const span of session.spans.activeLlmRequests.values()) endActiveSpan(session, span);
  for (const state of session.spans.activeToolCalls.values()) endActiveSpan(session, state.span);
  for (const span of session.spans.activeTurns.values()) endActiveSpan(session, span);
  for (const span of session.spans.activeAgentRuns.values()) endActiveSpan(session, span);
  session.spans.activeAgentJoins.clear();
  session.spans.activeAgentWaits.clear();
  session.spans.activeSubagentSpawns.clear();
  session.spans.activeLlmRequests.clear();
  session.spans.activeToolCalls.clear();
  session.spans.activeTurns.clear();
  session.spans.activeAgentRuns.clear();
  session.turnSequences.clear();
  session.pendingUserPromptImageCount = undefined;
  session.nextTurnImageCount = undefined;
  session.childFailureAccounting?.clear();
}

export function resolveCurrentSessionId(session: SelfObservabilitySession): string {
  return readString(session.sessionAttributes, SESSION_ATTRIBUTES.PI_SESSION_ID) ?? `session-${session.lineage.workflowId}`;
}

export function buildLineageMetricSafeLogAttributes(session: SelfObservabilitySession): AttributeMap {
  return withoutUndefinedAttributes({
    [LOG_ATTRIBUTES.PI_SESSION_ID]: resolveCurrentSessionId(session),
    [LOG_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [LOG_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID]: session.lineage.workflowRootAgentId,
    [LOG_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [LOG_ATTRIBUTES.PI_AGENT_PARENT_ID]: session.lineage.parentAgentId,
    [LOG_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
  });
}

export function buildModelChangeAttributes(event: unknown, ctx: ObservMeHandlerContext, session: ObservMeTelemetrySession): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildLineageMetricSafeLogAttributes(session),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_ID]: readChangeEntryId(event, "model_change"),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_PARENT_ID]: readChangeEntryParentId(event, "model_change"),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_TYPE]: readChangeEntryType(event, "model_change"),
    [SESSION_ATTRIBUTES.PI_MODEL_PROVIDER_CURRENT]: resolveSessionModelProvider(event, ctx, session),
    [SESSION_ATTRIBUTES.PI_MODEL_ID_CURRENT]: resolveSessionModelId(event, ctx, session),
  });
}

export function buildThinkingLevelChangeAttributes(event: unknown, session: ObservMeTelemetrySession): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildLineageMetricSafeLogAttributes(session),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_ID]: readChangeEntryId(event, "thinking_level_change"),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_PARENT_ID]: readChangeEntryParentId(event, "thinking_level_change"),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_TYPE]: readChangeEntryType(event, "thinking_level_change"),
    [SESSION_ATTRIBUTES.PI_THINKING_LEVEL_CURRENT]: resolveSessionThinkingLevel(event, session),
  });
}

export function buildBranchPreparationState(event: unknown, config: ObservMeConfig): BranchPreparationState {
  const preparation = readBranchPreparation(event);

  return {
    targetId: readBranchTargetId(preparation),
    oldLeafId: readBranchOldLeafId(preparation),
    commonAncestorId: readBranchCommonAncestorIdFromValue(preparation),
    pathHash: readBranchPathHashFromValue(preparation, config),
  };
}

export function buildBranchAttributes(event: unknown, session: ObservMeTelemetrySession): AttributeMap {
  const summaryEntry = readBranchSummaryEntry(event);
  const summary = readBranchSummary(summaryEntry, event);
  const fromId = readBranchFromId(event, summaryEntry, session.currentBranchPreparation);
  const toId = readBranchToId(event, summaryEntry, session.currentBranchPreparation);
  const leafId = readBranchLeafId(event, summaryEntry, toId);
  const commonAncestorId = readBranchCommonAncestorId(event, session.currentBranchPreparation);
  const pathHash = readBranchPathHash(event, session.currentBranchPreparation, fromId, toId, leafId, commonAncestorId, session.config);
  const entry = summaryEntry ?? readUnknown(event, "entry");

  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_ID]: readString(entry, "id") ?? leafId,
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_PARENT_ID]: readBranchEntryParentId(entry, event),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_TYPE]: readString(entry, "type") ?? "session_tree",
    [BRANCH_ATTRIBUTES.PI_BRANCH_FROM_ID]: fromId,
    [BRANCH_ATTRIBUTES.PI_BRANCH_TO_ID]: toId,
    [BRANCH_ATTRIBUTES.PI_BRANCH_COMMON_ANCESTOR_ID]: commonAncestorId,
    [BRANCH_ATTRIBUTES.PI_BRANCH_PATH_HASH]: pathHash,
    [BRANCH_ATTRIBUTES.PI_LEAF_ID]: leafId,
    [BRANCH_ATTRIBUTES.PI_BRANCH_SUMMARY_HASH]: summary ? hashValue(summary, session.config) : undefined,
    [BRANCH_ATTRIBUTES.PI_BRANCH_SUMMARY_LENGTH]: summary?.length,
    [BRANCH_ATTRIBUTES.PI_BRANCH_FROM_HOOK]: readBranchFromHook(summaryEntry, event),
    [BRANCH_ATTRIBUTES.PI_BRANCH_READ_FILES_COUNT]: readBranchFileCount(summaryEntry ?? event, "read"),
    [BRANCH_ATTRIBUTES.PI_BRANCH_MODIFIED_FILES_COUNT]: readBranchFileCount(summaryEntry ?? event, "modified"),
  });
}

export function readBranchPreparation(event: unknown): unknown {
  return readUnknown(event, "preparation") ?? event;
}

export function readBranchSummaryEntry(event: unknown): unknown {
  const explicitEntry = readUnknown(event, "summaryEntry") ?? readUnknown(event, "summary_entry");
  if (explicitEntry !== undefined) return explicitEntry;

  const entry = readUnknown(event, "entry");
  if (readString(entry, "type") === "branch_summary") return entry;
  return undefined;
}

export function readBranchSummary(summaryEntry: unknown, event: unknown): string | undefined {
  return readString(summaryEntry, "summary") ?? readString(event, "summary");
}

export function readBranchFromId(event: unknown, summaryEntry: unknown, preparation: BranchPreparationState | undefined): string | undefined {
  return (
    readTreeId(event, "fromId") ??
    readTreeId(event, "from_id") ??
    readBranchOldLeafId(event) ??
    preparation?.oldLeafId ??
    readTreeId(summaryEntry, "fromId") ??
    readTreeId(summaryEntry, "from_id")
  );
}

export function readBranchToId(event: unknown, summaryEntry: unknown, preparation: BranchPreparationState | undefined): string | undefined {
  return (
    readTreeId(event, "toId") ??
    readTreeId(event, "to_id") ??
    readBranchNewLeafId(event) ??
    readTreeId(summaryEntry, "id") ??
    preparation?.targetId ??
    readTreeId(summaryEntry, "parentId") ??
    readTreeId(summaryEntry, "parent_id")
  );
}

export function readBranchLeafId(event: unknown, summaryEntry: unknown, fallbackToId: string | undefined): string | undefined {
  return readTreeId(event, "leafId") ?? readTreeId(event, "leaf_id") ?? readBranchNewLeafId(event) ?? readTreeId(summaryEntry, "id") ?? fallbackToId;
}

export function readBranchTargetId(value: unknown): string | undefined {
  return readTreeId(value, "targetId") ?? readTreeId(value, "target_id");
}

export function readBranchOldLeafId(value: unknown): string | undefined {
  return readTreeId(value, "oldLeafId") ?? readTreeId(value, "old_leaf_id");
}

export function readBranchNewLeafId(value: unknown): string | undefined {
  return readTreeId(value, "newLeafId") ?? readTreeId(value, "new_leaf_id");
}

export function readBranchCommonAncestorId(event: unknown, preparation: BranchPreparationState | undefined): string | undefined {
  return readBranchCommonAncestorIdFromValue(event) ?? readBranchCommonAncestorIdFromValue(readBranchPreparation(event)) ?? preparation?.commonAncestorId;
}

export function readBranchCommonAncestorIdFromValue(value: unknown): string | undefined {
  return readString(value, "commonAncestorId") ?? readString(value, "common_ancestor_id");
}

export function readBranchEntryParentId(entry: unknown, event: unknown): string | undefined {
  return readTreeId(entry, "parentId") ?? readTreeId(entry, "parent_id") ?? readTreeId(event, "parentId") ?? readTreeId(event, "parent_id");
}

export function readBranchPathHash(
  event: unknown,
  preparation: BranchPreparationState | undefined,
  fromId: string | undefined,
  toId: string | undefined,
  leafId: string | undefined,
  commonAncestorId: string | undefined,
  config: ObservMeConfig,
): string | undefined {
  const pathHash = readBranchPathHashFromValue(event, config) ?? readBranchPathHashFromValue(readBranchPreparation(event), config) ?? preparation?.pathHash;
  if (pathHash !== undefined) return pathHash;

  return hashBranchIds([fromId, toId, leafId, commonAncestorId], config);
}

export function readBranchPathHashFromValue(value: unknown, config: ObservMeConfig): string | undefined {
  const explicitHash = readString(value, "pathHash") ?? readString(value, "path_hash") ?? readString(value, "branchPathHash") ?? readString(value, "branch_path_hash");
  if (explicitHash !== undefined) return normalizeBranchPathHash(explicitHash, config);

  const pathText = readBranchPathText(value);
  return pathText === undefined ? undefined : hashValue(pathText, config);
}

export function normalizeBranchPathHash(value: string, config: ObservMeConfig): string | undefined {
  return hashValue(value, config);
}

export function readBranchPathText(value: unknown): string | undefined {
  return (
    serializeBranchPath(readUnknown(value, "branchPathIds")) ??
    serializeBranchPath(readUnknown(value, "branch_path_ids")) ??
    serializeBranchPath(readUnknown(value, "pathIds")) ??
    serializeBranchPath(readUnknown(value, "path_ids")) ??
    serializeBranchPath(readUnknown(value, "branchPath")) ??
    serializeBranchPath(readUnknown(value, "branch_path")) ??
    serializeBranchPath(readUnknown(value, "path")) ??
    serializeBranchPath(readArray(value, "entriesToSummarize")) ??
    serializeBranchPath(readArray(value, "entries_to_summarize"))
  );
}

export function serializeBranchPath(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!Array.isArray(value)) return undefined;

  const ids = value.map(branchPathItemId).filter((item): item is string => item !== undefined);
  return ids.length > 0 ? ids.join("->") : undefined;
}

export function branchPathItemId(item: unknown): string | undefined {
  if (typeof item === "string" && item.length > 0) return item;
  return readTreeId(item, "id");
}

export function hashBranchIds(ids: Array<string | undefined>, config: ObservMeConfig): string | undefined {
  const presentIds = ids.filter((id): id is string => id !== undefined);
  return presentIds.length === 0 ? undefined : hashValue(presentIds.join("->"), config);
}

export function readBranchFromHook(summaryEntry: unknown, event: unknown): boolean | undefined {
  return (
    readBoolean(summaryEntry, "fromHook") ??
    readBoolean(summaryEntry, "from_hook") ??
    readBoolean(event, "fromExtension") ??
    readBoolean(event, "from_extension") ??
    readBoolean(event, "fromHook") ??
    readBoolean(event, "from_hook")
  );
}

export function readBranchFileCount(source: unknown, kind: "modified" | "read"): number | undefined {
  const directCount = readInteger(source, `${kind}FilesCount`) ?? readInteger(source, `${kind}_files_count`);
  if (directCount !== undefined) return directCount;

  const details = readUnknown(source, "details");
  const camelCaseKey = kind === "read" ? "readFiles" : "modifiedFiles";
  const snakeCaseKey = kind === "read" ? "read_files" : "modified_files";
  return readArray(details, camelCaseKey)?.length ?? readArray(details, snakeCaseKey)?.length;
}

export function buildCompactionAttributes(event: unknown, session: ObservMeTelemetrySession): AttributeMap {
  const entry = readCompactionEntry(event);
  const summary = readCompactionSummary(entry, event);

  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_ID]: readString(entry, "id"),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_PARENT_ID]: readString(entry, "parentId") ?? readString(entry, "parent_id"),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_TYPE]: readString(entry, "type") ?? "compaction",
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_FIRST_KEPT_ENTRY_ID]: readCompactionFirstKeptEntryId(entry, event),
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_TOKENS_BEFORE]: readCompactionTokensBefore(entry, event),
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_SUMMARY_HASH]: summary ? hashValue(summary, session.config) : undefined,
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_SUMMARY_LENGTH]: summary?.length,
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_FROM_HOOK]: readCompactionFromHook(entry, event),
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_REASON]: readCompactionReason(entry, event),
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_WILL_RETRY]: readCompactionWillRetry(entry, event),
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_READ_FILES_COUNT]: readCompactionFileCount(entry, "read"),
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_MODIFIED_FILES_COUNT]: readCompactionFileCount(entry, "modified"),
  });
}

export function readCompactionEntry(event: unknown): unknown {
  const explicitEntry = readUnknown(event, "compactionEntry") ?? readUnknown(event, "compaction_entry");
  if (explicitEntry !== undefined) return explicitEntry;

  const entry = readUnknown(event, "entry");
  if (readString(entry, "type") === "compaction") return entry;
  return event;
}

export function readCompactionSummary(entry: unknown, event: unknown): string | undefined {
  return readString(entry, "summary") ?? readString(event, "summary");
}

export function readCompactionFirstKeptEntryId(entry: unknown, event: unknown): string | undefined {
  return (
    readString(entry, "firstKeptEntryId") ??
    readString(entry, "first_kept_entry_id") ??
    readString(entry, "firstKeptId") ??
    readString(entry, "first_kept_id") ??
    readString(event, "firstKeptEntryId") ??
    readString(event, "first_kept_entry_id")
  );
}

export function readCompactionTokensBefore(entry: unknown, event: unknown): number | undefined {
  return readInteger(entry, "tokensBefore") ?? readInteger(entry, "tokens_before") ?? readInteger(event, "tokensBefore") ?? readInteger(event, "tokens_before");
}

export function readCompactionFromHook(entry: unknown, event: unknown): boolean | undefined {
  return (
    readBoolean(entry, "fromHook") ??
    readBoolean(entry, "from_hook") ??
    readBoolean(event, "fromHook") ??
    readBoolean(event, "from_hook") ??
    readBoolean(event, "fromExtension") ??
    readBoolean(event, "summaryFromExtension")
  );
}

export function readCompactionReason(entry: unknown, event: unknown): string | undefined {
  return readString(event, "reason") ?? readString(entry, "reason");
}

export function readCompactionWillRetry(entry: unknown, event: unknown): boolean | undefined {
  return readBoolean(event, "willRetry") ?? readBoolean(event, "will_retry") ?? readBoolean(entry, "willRetry") ?? readBoolean(entry, "will_retry");
}

export function readCompactionFileCount(entry: unknown, kind: "modified" | "read"): number | undefined {
  const directCount = readInteger(entry, `${kind}FilesCount`) ?? readInteger(entry, `${kind}_files_count`);
  if (directCount !== undefined) return directCount;

  const details = readUnknown(entry, "details");
  const camelCaseKey = kind === "read" ? "readFiles" : "modifiedFiles";
  const snakeCaseKey = kind === "read" ? "read_files" : "modified_files";
  return readArray(details, camelCaseKey)?.length ?? readArray(details, snakeCaseKey)?.length;
}

export function updateCurrentSessionAttributes(
  session: ObservMeTelemetrySession,
  attributes: AttributeMap,
  keys: readonly string[],
): void {
  const currentAttributes = session.sessionAttributes ?? {};
  const updates = Object.fromEntries(keys.map(key => [key, attributes[key]]).filter((entry): entry is [string, AttributePrimitive] => entry[1] !== undefined));

  session.sessionAttributes = { ...currentAttributes, ...updates };
  session.sessionSpan?.setAttributes(updates);
}

export function modelChangeMetricLabels(session: ObservMeTelemetrySession, attributes: AttributeMap): Record<string, string> {
  return {
    ...metricLabels(session.config, session.lineage),
    provider: String(attributes[SESSION_ATTRIBUTES.PI_MODEL_PROVIDER_CURRENT] ?? "unknown"),
    model: String(attributes[SESSION_ATTRIBUTES.PI_MODEL_ID_CURRENT] ?? "unknown"),
  };
}

export function thinkingLevelChangeMetricLabels(session: ObservMeTelemetrySession): Record<string, string> {
  return metricLabels(session.config, session.lineage);
}

export function buildCommonSessionSpanAttributes(
  sessionId: string,
  config: ObservMeConfig,
  lineage: AgentLineageContext,
): AttributeMap {
  return withoutUndefinedAttributes({
    [COMMON_SPAN_ATTRIBUTES.PI_SESSION_ID]: sessionId,
    [COMMON_SPAN_ATTRIBUTES.PI_WORKFLOW_ID]: lineage.workflowId,
    [COMMON_SPAN_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID]: lineage.workflowRootAgentId,
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_ID]: lineage.agentId,
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_PARENT_ID]: lineage.parentAgentId,
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_ROOT_ID]: lineage.rootAgentId,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_CAPTURE_PROMPTS]: config.capture.prompts,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_CAPTURE_RESPONSES]: config.capture.responses,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_CAPTURE_TOOL_ARGUMENTS]: config.capture.toolArguments,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_REDACTION_ENABLED]: config.privacy.redactionEnabled,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_SEMCONV_VERSION]: OBSERVME_SEMCONV_VERSION,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_REPLAYED]: false,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_EVICTED]: false,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED]: false,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH]: 0,
  });
}

export function metricLabels(config: ObservMeConfig, lineage: AgentLineageContext): Record<string, string> {
  return {
    environment: config.environment,
    agent_role: lineage.role,
  };
}

export function llmMetricLabels(session: ObservMeTelemetrySession, attributes: AttributeMap): Record<string, string> {
  return {
    ...metricLabels(session.config, session.lineage),
    provider: String(attributes[LLM_ATTRIBUTES.GEN_AI_PROVIDER_NAME] ?? "unknown"),
    model: String(attributes[LLM_ATTRIBUTES.GEN_AI_REQUEST_MODEL] ?? attributes[LLM_ATTRIBUTES.GEN_AI_RESPONSE_MODEL] ?? "unknown"),
  };
}

export function toolMetricLabels(attributes: AttributeMap): Record<string, string> {
  return {
    tool_name: String(attributes[TOOL_ATTRIBUTES.PI_TOOL_NAME] ?? "unknown"),
    tool_category: String(attributes[TOOL_ATTRIBUTES.PI_TOOL_CATEGORY] ?? "unknown"),
  };
}

export function mergeToolStateLabels(state: ToolCallState, attributes: AttributeMap): void {
  state.labels = {
    ...state.labels,
    ...toolMetricLabelUpdates(attributes),
  };
  state.completionLogAttributes = {
    ...state.completionLogAttributes,
    ...buildToolLogIdentityAttributes(attributes),
  };
}

export function toolMetricLabelUpdates(attributes: AttributeMap): Record<string, string> {
  const updates: Record<string, string> = {};
  const toolName = readString(attributes, TOOL_ATTRIBUTES.PI_TOOL_NAME);
  const toolCategory = readString(attributes, TOOL_ATTRIBUTES.PI_TOOL_CATEGORY);

  if (toolName) updates.tool_name = toolName;
  if (toolCategory) updates.tool_category = toolCategory;

  return updates;
}

export function buildBashPreExecutionAttributes(event: unknown, session: ObservMeTelemetrySession): AttributeMap {
  const command = readBashCommand(event);

  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [BASH_ATTRIBUTES.PI_BASH_COMMAND_HASH]: command === undefined ? undefined : hashValue(command, session.config),
    [BASH_ATTRIBUTES.PI_BASH_EXCLUDE_FROM_CONTEXT]: readBashExcludeFromContext(event),
  });
}

export function buildBashExecutionAttributes(event: unknown, session: ObservMeTelemetrySession): AttributeMap {
  const output = readBashOutput(event);

  return withoutUndefinedAttributes({
    ...buildBashPreExecutionAttributes(event, session),
    [BASH_ATTRIBUTES.PI_BASH_EXIT_CODE]: readBashExitCode(event),
    [BASH_ATTRIBUTES.PI_BASH_CANCELLED]: readBashCancelled(event) ?? false,
    [BASH_ATTRIBUTES.PI_BASH_TRUNCATED]: readBashTruncated(event) ?? false,
    [BASH_ATTRIBUTES.PI_BASH_OUTPUT_SIZE]: output === undefined ? undefined : output.length,
    [BASH_ATTRIBUTES.PI_BASH_OUTPUT_HASH]: output === undefined ? undefined : hashValue(output, session.config),
    [BASH_ATTRIBUTES.PI_BASH_FULL_OUTPUT_PATH_PRESENT]: readBashFullOutputPathPresent(event),
    [BASH_ATTRIBUTES.PI_BASH_EXCLUDE_FROM_CONTEXT]: readBashExcludeFromContext(event) ?? false,
  });
}

export function bashExecutionMetricLabels(
  session: ObservMeTelemetrySession,
  event: unknown,
  failed: boolean,
): Record<string, string> {
  return {
    ...metricLabels(session.config, session.lineage),
    status: bashStatusLabel(event, failed),
  };
}

export function bashFailureMetricLabels(session: ObservMeTelemetrySession, event: unknown): Record<string, string> {
  return {
    ...bashExecutionMetricLabels(session, event, true),
    error_class: bashErrorClass(event),
  };
}

export function bashStatusLabel(event: unknown, failed: boolean): string {
  if (readBashCancelled(event)) return "cancelled";
  if (normalizedStatus(readString(event, "status")) === "timeout") return "timeout";
  return failed ? "error" : "ok";
}

export function readBashPayload(event: unknown): unknown {
  const message = readMessage(event);
  if (isBashExecutionMessage(message)) return message;

  const bashExecution = readUnknown(event, "bashExecution") ?? readUnknown(event, "bash_execution");
  if (isRecord(bashExecution)) return bashExecution;

  const entryMessage = readUnknown(readUnknown(event, "entry"), "message");
  if (isBashExecutionMessage(entryMessage)) return entryMessage;

  return event;
}

export function isBashExecutionMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && readString(value, "role") === "bashExecution";
}

export function readBashCommand(event: unknown): string | undefined {
  const payload = readBashPayload(event);
  return readOptionalString(payload, "command") ?? readOptionalString(payload, "cmd") ?? readOptionalString(payload, "input");
}

export function readBashOutput(event: unknown): string | undefined {
  const payload = readBashPayload(event);
  const directOutput = readOptionalString(payload, "output") ?? readOptionalString(payload, "content");
  if (directOutput !== undefined) return directOutput;

  return combineBashStreams(readOptionalString(payload, "stdout"), readOptionalString(payload, "stderr"));
}

export function combineBashStreams(stdout: string | undefined, stderr: string | undefined): string | undefined {
  if (stdout === undefined) return stderr;
  if (stderr === undefined) return stdout;
  if (stdout.length === 0) return stderr;
  if (stderr.length === 0) return stdout;
  return `${stdout}\n${stderr}`;
}

export function readBashExitCode(event: unknown): number | undefined {
  const payload = readBashPayload(event);
  const result = readUnknown(payload, "result");
  return readInteger(payload, "exitCode") ?? readInteger(payload, "exit_code") ?? readInteger(result, "exitCode") ?? readInteger(result, "exit_code");
}

export function readBashCancelled(event: unknown): boolean | undefined {
  const payload = readBashPayload(event);
  const explicit = readBoolean(payload, "cancelled") ?? readBoolean(payload, "canceled") ?? readBoolean(payload, "isCancelled");
  if (explicit !== undefined) return explicit;

  const status = normalizedStatus(readString(payload, "status"));
  return status === "cancelled" || status === "canceled" ? true : undefined;
}

export function readBashTruncated(event: unknown): boolean | undefined {
  const payload = readBashPayload(event);
  return readBoolean(payload, "truncated") ?? readBoolean(payload, "outputTruncated") ?? readBoolean(payload, "output_truncated");
}

export function readBashFullOutputPathPresent(event: unknown): boolean {
  const payload = readBashPayload(event);
  const explicit = readBoolean(payload, "fullOutputPathPresent") ?? readBoolean(payload, "full_output_path_present");
  if (explicit !== undefined) return explicit;

  return readOptionalString(payload, "fullOutputPath") !== undefined || readOptionalString(payload, "full_output_path") !== undefined;
}

export function readBashExcludeFromContext(event: unknown): boolean | undefined {
  const payload = readBashPayload(event);
  return readBoolean(payload, "excludeFromContext") ?? readBoolean(payload, "exclude_from_context");
}

const bashStartTimestampKeys = [
  "startedAtMs",
  "started_at_ms",
  "startTimeMs",
  "start_time_ms",
  "startedAt",
  "started_at",
  "startTimestamp",
  "start_timestamp",
] as const;
const bashCompletionTimestampKeys = [
  "completedAtMs",
  "completed_at_ms",
  "endedAtMs",
  "ended_at_ms",
  "endTimeMs",
  "end_time_ms",
  "completedAt",
  "completed_at",
  "endedAt",
  "ended_at",
  "endTimestamp",
  "end_timestamp",
  "timestamp",
] as const;

export function readBashPreExecutionTimestampMs(event: unknown): number | undefined {
  return readBashTimestampMs(event, bashStartTimestampKeys) ?? readBashTimestampMs(event, ["timestamp"]);
}

export function readBashCompletionTimestampMs(event: unknown): number | undefined {
  return readBashTimestampMs(event, bashCompletionTimestampKeys);
}

export function resolveBashEventDurationMs(startedAtMs: number | undefined, completionEvent: unknown): number | undefined {
  return safeElapsedDurationMs(startedAtMs, readBashCompletionTimestampMs(completionEvent));
}

export function resolveStandaloneBashEventDurationMs(event: unknown): number | undefined {
  return safeElapsedDurationMs(readBashTimestampMs(event, bashStartTimestampKeys), readBashCompletionTimestampMs(event));
}

export function safeElapsedDurationMs(startedAtMs: number | undefined, completedAtMs: number | undefined): number | undefined {
  if (!isSafeNonNegativeTimeMs(startedAtMs) || !isSafeNonNegativeTimeMs(completedAtMs) || completedAtMs < startedAtMs) return undefined;

  const durationMs = completedAtMs - startedAtMs;
  return Number.isFinite(durationMs) && durationMs <= Number.MAX_SAFE_INTEGER ? durationMs : undefined;
}

function readBashTimestampMs(event: unknown, keys: readonly string[]): number | undefined {
  const payload = readBashPayload(event);
  const payloadTimestamp = readTimestampMsForKeys(payload, keys);
  if (payloadTimestamp !== undefined) return payloadTimestamp;

  const eventTimestamp = readTimestampMsForKeys(event, keys);
  if (eventTimestamp !== undefined) return eventTimestamp;

  return readTimestampMsForKeys(readUnknown(event, "entry"), keys);
}

function readTimestampMsForKeys(value: unknown, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const timestamp = parseTimestampMs(readUnknown(value, key));
    if (timestamp !== undefined) return timestamp;
  }

  return undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number") return isSafeNonNegativeTimeMs(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;

  const numericTimestamp = Number(value);
  if (isSafeNonNegativeTimeMs(numericTimestamp)) return numericTimestamp;

  const parsedTimestamp = Date.parse(value);
  return isSafeNonNegativeTimeMs(parsedTimestamp) ? parsedTimestamp : undefined;
}

function isSafeNonNegativeTimeMs(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

export function hasBashCompletionResult(event: unknown): boolean {
  const payload = readBashPayload(event);
  const status = normalizedStatus(readString(payload, "status"));

  return (
    readBashExitCode(payload) !== undefined ||
    readBashCancelled(payload) !== undefined ||
    readBashTruncated(payload) !== undefined ||
    readBashOutput(payload) !== undefined ||
    readBoolean(payload, "failed") !== undefined ||
    status === "ok" ||
    status === "success" ||
    status === "completed" ||
    statusIndicatesToolFailure(status)
  );
}

export function bashExecutionFailed(event: unknown): boolean {
  if (readBashCancelled(event)) return true;
  if (bashExitCodeIndicatesFailure(event)) return true;

  const payload = readBashPayload(event);
  return readBoolean(payload, "failed") === true || statusIndicatesToolFailure(readString(payload, "status"));
}

export function bashErrorClass(event: unknown): string {
  const payload = readBashPayload(event);
  const explicit = readString(payload, "errorClass") ?? readString(payload, "error_class");
  if (explicit) return normalizeErrorClass(explicit);
  if (readBashCancelled(payload)) return "cancelled";
  if (bashExitCodeIndicatesFailure(payload)) return "non_zero_exit";
  if (normalizedStatus(readString(payload, "status")) === "timeout") return "timeout";
  return "bash_error";
}

export function bashExitCodeIndicatesFailure(event: unknown): boolean {
  const exitCode = readBashExitCode(event);
  return exitCode !== undefined && exitCode !== 0;
}

export function normalizedStatus(status: string | undefined): string | undefined {
  return status?.trim().toLowerCase();
}

export function readToolCallId(event: unknown): string | undefined {
  const toolCall = readUnknown(event, "toolCall");

  return (
    readString(event, "toolCallId") ??
    readString(event, "tool_call_id") ??
    readString(event, "callId") ??
    readString(event, "id") ??
    readString(toolCall, "id") ??
    readString(toolCall, "toolCallId")
  );
}

export function readToolName(event: unknown): string | undefined {
  const tool = readUnknown(event, "tool");
  const toolCall = readUnknown(event, "toolCall");

  return (
    readString(event, "toolName") ??
    readString(event, "tool_name") ??
    readString(event, "name") ??
    readString(tool, "name") ??
    readString(toolCall, "name") ??
    readString(toolCall, "toolName")
  );
}

export function readToolCategory(event: unknown): string | undefined {
  return normalizeToolCategory(readString(event, "toolCategory") ?? readString(event, "tool_category") ?? readString(event, "category"));
}

export function safeToolName(rawName: string | undefined): string {
  if (!rawName) return "unknown";

  const normalizedName = rawName.trim().toLowerCase();
  if (/^[a-z][a-z0-9_.:-]{0,63}$/u.test(normalizedName)) return normalizedName;
  return "custom";
}

export function resolveToolCategory(event: unknown, toolName: string): string {
  const explicitCategory = readToolCategory(event);
  if (explicitCategory) return explicitCategory;
  if (isShellToolName(toolName)) return "shell";
  if (isFilesystemToolName(toolName)) return "filesystem";
  if (isNetworkToolName(toolName)) return "network";
  if (toolName === "unknown") return "unknown";
  return "custom";
}

export function normalizeToolCategory(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim().toLowerCase();
  if (normalizedValue === "shell" || normalizedValue === "filesystem" || normalizedValue === "network" || normalizedValue === "custom" || normalizedValue === "unknown") return normalizedValue;
  return undefined;
}

export function isShellToolName(toolName: string): boolean {
  return toolName === "bash" || toolName === "shell" || toolName === "user_bash" || toolName.includes("bash");
}

export function isFilesystemToolName(toolName: string): boolean {
  return /^(read|write|edit|ls|grep|rg|find|glob|file|filesystem|path)([_.:-]|$)/u.test(toolName);
}

export function isNetworkToolName(toolName: string): boolean {
  return /^(aws|http|fetch|curl|web|network)([_.:-]|$)/u.test(toolName);
}

export function mapToolType(category: string): string {
  if (category === "filesystem" || category === "network") return "extension";
  return "function";
}

export function readToolArgumentsText(event: unknown): string | undefined {
  const toolCall = readUnknown(event, "toolCall");
  const value =
    readUnknown(event, "arguments") ??
    readUnknown(event, "args") ??
    readUnknown(event, "input") ??
    readUnknown(event, "parameters") ??
    readUnknown(event, "params") ??
    readUnknown(toolCall, "arguments") ??
    readUnknown(toolCall, "input");

  return serializeToolPayload(value);
}

export function readToolResultText(event: unknown): string | undefined {
  const error = readUnknown(event, "error");
  const value =
    readUnknown(event, "result") ??
    readUnknown(event, "output") ??
    readUnknown(event, "response") ??
    readUnknown(event, "content") ??
    readUnknown(event, "errorMessage") ??
    readUnknown(event, "error_message") ??
    readString(error, "message") ??
    error;

  return serializeToolPayload(value);
}

export function serializeToolPayload(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.name;

  try {
    return JSON.stringify(value) ?? formatNonJsonToolPayload(value);
  } catch (error) {
    return formatUnserializableToolPayload(value, error);
  }
}

function formatNonJsonToolPayload(value: unknown): string {
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.description ? `Symbol(${value.description})` : "Symbol()";
  if (typeof value === "bigint") return value.toString();
  if (isRecord(value)) return `[Unserializable ${readObjectTypeName(value)}]`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return "unserializable value";
}

function formatUnserializableToolPayload(value: unknown, error: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (!isRecord(value)) return formatNonJsonToolPayload(value);

  const failureKind = error instanceof Error ? error.name : "unknown serialization failure";
  return `[Unserializable ${readObjectTypeName(value)}: ${failureKind}]`;
}

function readObjectTypeName(value: object): string {
  return value.constructor?.name || "Object";
}

export function toolExecutionFailed(event: unknown): boolean {
  const success = readBoolean(event, "success") ?? readBoolean(readUnknown(event, "result"), "success");
  if (success !== undefined) return !success;

  return (
    readBoolean(event, "isError") === true ||
    readBoolean(event, "failed") === true ||
    readBoolean(readUnknown(event, "result"), "isError") === true ||
    readUnknown(event, "error") !== undefined ||
    statusIndicatesToolFailure(readString(event, "status")) ||
    exitCodeIndicatesFailure(event)
  );
}

export function statusIndicatesToolFailure(status: string | undefined): boolean {
  const normalizedValue = normalizedStatus(status);
  return normalizedValue === "error" || normalizedValue === "failed" || normalizedValue === "failure" || normalizedValue === "timeout" || normalizedValue === "cancelled" || normalizedValue === "canceled";
}

export function exitCodeIndicatesFailure(event: unknown): boolean {
  const exitCode = readInteger(event, "exitCode") ?? readInteger(event, "exit_code");
  return exitCode !== undefined && exitCode !== 0;
}

export function toolErrorClass(event: unknown): string {
  const result = readUnknown(event, "result");
  const explicit = readString(event, "errorClass") ?? readString(event, "error_class") ?? readString(result, "errorClass") ?? readString(result, "error_class");
  if (explicit) return normalizeErrorClass(explicit);

  const error = readUnknown(event, "error") ?? readUnknown(result, "error");
  if (error instanceof Error) return normalizeErrorClass(error.name);
  if (isRecord(error)) return normalizeErrorClass(readString(error, "name") ?? readString(error, "code") ?? readString(error, "type") ?? "tool_error");

  const status = readString(event, "status");
  if (statusIndicatesToolFailure(status)) return normalizeErrorClass(status ?? "tool_error");
  return "tool_error";
}

export function normalizeErrorClass(value: string): string {
  const trimmedValue = value.trim();
  if (/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(trimmedValue)) return trimmedValue;
  return "tool_error";
}

export function readMessage(event: unknown): unknown {
  return readUnknown(event, "message") ?? event;
}

export function isAssistantMessage(message: unknown): message is Record<string, unknown> {
  return isRecord(message) && readString(message, "role") === "assistant";
}

export function isLlmError(message: Record<string, unknown>): boolean {
  return readString(message, "stopReason") === "error" || Boolean(readString(message, "errorMessage"));
}

export function readUsage(message: Record<string, unknown>): Record<string, unknown> {
  const usage = readUnknown(message, "usage");
  return isRecord(usage) ? usage : {};
}

export function readCost(usage: Record<string, unknown>): Record<string, unknown> {
  const cost = readUnknown(usage, "cost");
  return isRecord(cost) ? cost : {};
}

export function mapStopReason(stopReason: string): string {
  if (stopReason === "toolUse") return "tool_calls";
  if (stopReason === "length") return "length";
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "cancelled";
  return "stop";
}

export function countPayloadItems(payload: unknown, keys: readonly string[]): number | undefined {
  const counts = keys.map(key => countPayloadItemSource(readUnknown(payload, key))).filter((value): value is number => value !== undefined);
  if (counts.length === 0) return undefined;
  return counts.reduce((total, value) => total + value, 0);
}

export function countPayloadItemSource(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string" && value.trim() !== "") return 1;
  if (isRecord(value)) return 1;
  return undefined;
}

interface SafeJsonLengthResult {
  readonly length?: number;
  readonly failureKind?: string;
}

export function safeJsonLength(value: unknown): number | undefined {
  if (value === undefined) return undefined;

  return readSafeJsonLength(value).length;
}

function readSafeJsonLength(value: unknown): SafeJsonLengthResult {
  try {
    return { length: JSON.stringify(value)?.length };
  } catch (error) {
    return { failureKind: readJsonStringifyFailureKind(error) };
  }
}

function readJsonStringifyFailureKind(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

const promptPayloadTextKeys = ["messages", "contents", "input", "prompt"] as const;

export function extractPayloadPromptText(payload: unknown): string | undefined {
  for (const key of promptPayloadTextKeys) {
    const text = extractContentText(readUnknown(payload, key)).join("\n").trim();
    if (text.length > 0) return text;
  }

  return undefined;
}

export function extractAssistantText(message: Record<string, unknown>): string | undefined {
  const content = readUnknown(message, "content");
  const text = extractContentText(content).join("\n").trim();
  return text.length === 0 ? undefined : text;
}

export function extractAssistantThinking(message: Record<string, unknown>): string | undefined {
  const content = readArray(message, "content") ?? [];
  const thinking = content.map(extractThinkingText).filter((value): value is string => value !== undefined).join("\n").trim();
  return thinking.length === 0 ? undefined : thinking;
}

export function extractContentText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractContentText);
  if (!isRecord(value)) return [];

  const directText = readString(value, "text");
  if (directText) return [directText];

  return extractContentText(readUnknown(value, "content"));
}

export function extractThinkingText(value: unknown): string | undefined {
  if (!isRecord(value) || readString(value, "type") !== "thinking") return undefined;
  return readString(value, "thinking");
}

export function resolveSessionFilePath(event: unknown, ctx: ObservMeHandlerContext): string | undefined {
  return ctx.sessionManager?.getSessionFile() ?? readString(event, "sessionFile") ?? readString(event, "session_file");
}

export function resolveSessionId(event: unknown, ctx: ObservMeHandlerContext, lineage: AgentLineageContext): string {
  return (
    ctx.sessionManager?.getSessionId() ??
    readString(event, "sessionId") ??
    readString(event, "session_id") ??
    readString(event, "id") ??
    `session-${lineage.workflowId}`
  );
}

export function resolveModelProvider(ctx: ObservMeHandlerContext): string {
  return readString(ctx.model, "provider") ?? "unknown";
}

export function resolveModelId(ctx: ObservMeHandlerContext): string {
  return readString(ctx.model, "id") ?? "unknown";
}

export function resolveThinkingLevel(thinkingLevel: unknown): string {
  return typeof thinkingLevel === "string" && thinkingLevel.trim() ? thinkingLevel.trim() : "unknown";
}

export function resolveSessionModelProvider(
  event: unknown,
  ctx: ObservMeHandlerContext,
  session: ObservMeTelemetrySession,
): string {
  return readModelProvider(event, ctx) ?? readString(session.sessionAttributes, SESSION_ATTRIBUTES.PI_MODEL_PROVIDER_CURRENT) ?? "unknown";
}

export function resolveSessionModelId(event: unknown, ctx: ObservMeHandlerContext, session: ObservMeTelemetrySession): string {
  return readModelId(event, ctx) ?? readString(session.sessionAttributes, SESSION_ATTRIBUTES.PI_MODEL_ID_CURRENT) ?? "unknown";
}

export function resolveSessionThinkingLevel(
  event: unknown,
  session: ObservMeTelemetrySession,
): string {
  return readThinkingLevel(event) ?? readString(session.sessionAttributes, SESSION_ATTRIBUTES.PI_THINKING_LEVEL_CURRENT) ?? "unknown";
}

export function readModelProvider(event: unknown, ctx: ObservMeHandlerContext): string | undefined {
  const payload = readChangePayload(event, "model_change");
  const selectedModel = readModelObject(payload);

  return (
    readString(payload, "provider") ??
    readString(payload, "modelProvider") ??
    readString(payload, "model_provider") ??
    readString(selectedModel, "provider") ??
    readString(selectedModel, "modelProvider") ??
    readString(ctx.model, "provider")
  );
}

export function readModelId(event: unknown, ctx: ObservMeHandlerContext): string | undefined {
  const payload = readChangePayload(event, "model_change");
  const selectedModel = readModelObject(payload);

  return (
    readString(payload, "modelId") ??
    readString(payload, "model_id") ??
    readString(payload, "modelName") ??
    readString(payload, "selectedModel") ??
    readString(payload, "selection") ??
    readString(payload, "model") ??
    readModelIdFromObject(selectedModel) ??
    readString(ctx.model, "id")
  );
}

export function readThinkingLevel(event: unknown): string | undefined {
  const payload = readChangePayload(event, "thinking_level_change");
  const selectedThinking = readUnknown(payload, "thinking") ?? readUnknown(payload, "selection");

  return (
    readString(payload, "thinkingLevel") ??
    readString(payload, "thinking_level") ??
    readString(payload, "level") ??
    readString(payload, "selection") ??
    readString(selectedThinking, "level")
  );
}

export function readModelObject(value: unknown): unknown {
  const selectedModel = readUnknown(value, "selectedModel") ?? readUnknown(value, "selection") ?? readUnknown(value, "model");
  return typeof selectedModel === "string" ? undefined : selectedModel;
}

export function readModelIdFromObject(value: unknown): string | undefined {
  return readString(value, "id") ?? readString(value, "model") ?? readString(value, "modelId") ?? readString(value, "name");
}

export function readChangePayload(event: unknown, entryType: string): unknown {
  const entry = readUnknown(event, "entry");
  if (readString(entry, "type") === entryType) return entry;
  return event;
}

export function readChangeEntryId(event: unknown, entryType: string): string | undefined {
  return readString(readChangePayload(event, entryType), "id");
}

export function readChangeEntryParentId(event: unknown, entryType: string): string | undefined {
  const payload = readChangePayload(event, entryType);
  return readString(payload, "parentId") ?? readString(payload, "parent_id");
}

export function readChangeEntryType(event: unknown, entryType: string): string {
  return readString(readChangePayload(event, entryType), "type") ?? entryType;
}

export function withoutUndefinedAttributes(attributes: Record<string, AttributePrimitive | undefined>): AttributeMap {
  return Object.fromEntries(Object.entries(attributes).filter((entry): entry is [string, AttributePrimitive] => entry[1] !== undefined));
}

export function hashValue(value: string, config: ObservMeConfig): string | undefined {
  return trySha256(value, config);
}

export function readString(value: unknown, key: string): string | undefined {
  const child = readUnknown(value, key);
  if (typeof child === "string" && child.length > 0) return child;
  if (typeof child === "number" || typeof child === "boolean") return String(child);
  return undefined;
}

export function readTreeId(value: unknown, key: string): string | undefined {
  const child = readUnknown(value, key);
  if (child === null) return "root";
  if (typeof child === "string" && child.length > 0) return child;
  if (typeof child === "number" || typeof child === "boolean") return String(child);
  return undefined;
}

export function readOptionalString(value: unknown, key: string): string | undefined {
  const child = readUnknown(value, key);
  if (typeof child === "string") return child;
  if (typeof child === "number" || typeof child === "boolean") return String(child);
  return undefined;
}

export function readBoolean(value: unknown, key: string): boolean | undefined {
  const child = readUnknown(value, key);
  return typeof child === "boolean" ? child : undefined;
}

export function readInteger(value: unknown, key: string): number | undefined {
  const child = readUnknown(value, key);
  if (typeof child === "number" && Number.isInteger(child)) return child;
  if (typeof child === "string" && /^\d+$/u.test(child)) return Number(child);
  return undefined;
}

export function readNumber(value: unknown, key: string): number | undefined {
  const child = readUnknown(value, key);
  if (typeof child === "number" && Number.isFinite(child)) return child;
  if (typeof child === "string" && child.trim() !== "") {
    const parsed = Number(child);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function readArray(value: unknown, key: string): unknown[] | undefined {
  const child = readUnknown(value, key);
  return Array.isArray(child) ? child : undefined;
}

export function readUnknown(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function normalizeMetricValue(value: string, fallback: string): string {
  const normalizedValue = value.trim().toLowerCase().replaceAll(/[^a-z0-9_.:-]/gu, "_");
  if (/^[a-z][a-z0-9_.:-]{0,63}$/u.test(normalizedValue)) return normalizedValue;
  return fallback;
}
