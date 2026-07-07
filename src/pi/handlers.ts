import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { Counter, Histogram, Meter, Span, Tracer, UpDownCounter } from "@opentelemetry/api";
import { context as otelContext, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import {
  clearObsAgentsRuntimeState,
  startObsAgentsRuntimeState,
} from "../commands/obs-agents-runtime.ts";
import {
  clearObsSessionRuntimeState,
  recordObsSessionCost,
  recordObsSessionLlmCall,
  recordObsSessionToolCall,
  recordObsSessionTurn,
  startObsSessionRuntimeState,
} from "../commands/obs-session.ts";
import { clearObsStatusExportError, recordObsStatusExportResult, recordObsStatusQueueDrop, updateObsStatusRuntimeState } from "../commands/obs-status.ts";
import type { LoadSessionConfigOptions, SessionConfigDiagnostics } from "../config/load-config.ts";
import { loadSessionConfig, loadSessionConfigWithDiagnostics } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import { EXTENSION_DISPLAY_NAME, EXTENSION_STATUS_KEY } from "../constants.ts";
import { emitUnsafeCaptureWarning } from "../config/validate.ts";
import { ObservMeLogSdk } from "../otel/logs.ts";
import { ObservMeMetricSdk } from "../otel/metrics.ts";
import type { ObservMeOtelSdkController } from "../otel/sdk.ts";
import { startOtelSdk } from "../otel/sdk.ts";
import type { BoundedOtelOperationResult } from "../otel/shutdown.ts";
import { ObservMeTraceSdk } from "../otel/traces.ts";
import {
  AGENT_RUN_ATTRIBUTES,
  BASH_ATTRIBUTES,
  BRANCH_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  COMPACTION_ATTRIBUTES,
  LLM_ATTRIBUTES,
  LOG_ATTRIBUTES,
  TOOL_ATTRIBUTES,
  TURN_ATTRIBUTES,
} from "../semconv/attributes.ts";
import {
  LOG_EVENT_NAMES,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_GAUGE_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
  OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES,
  OFFICIAL_GENAI_METRIC_NAMES,
} from "../semconv/metrics.ts";
import { SPAN_NAMES } from "../semconv/spans.ts";
import { redactValue } from "../privacy/redact.ts";
import { BoundedMap } from "../util/bounded-map.ts";
import type { AgentLineageContext } from "./agent-lineage.ts";
import { buildResourceLineageAttributes, createAgentLineageContext } from "./agent-lineage.ts";
import { AgentTreeTracker } from "./agent-tree-tracker.ts";
import type { AgentWaitJoinState, SubagentSpawnState } from "./subagent-spawn.ts";

export type AttributePrimitive = boolean | number | string | string[];
export type AttributeMap = Record<string, AttributePrimitive>;
export type Handler = (event: unknown, ctx: ObservMeHandlerContext) => Promise<void> | void;
export type HandlerErrorRecorder = (name: string, error: unknown) => void;
export type LoadSessionConfig = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type StartSessionTelemetry = (options: StartSessionTelemetryOptions) => Promise<ObservMeTelemetrySession>;
export type ReadSessionHeader = (sessionFile: string) => Promise<SessionRecoveryHeader | undefined>;

export interface MinimalSessionCorrelation {
  readonly workflowId?: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly rootAgentId?: string;
  readonly parentSessionId?: string;
  readonly depth?: number;
  readonly spawnId?: string;
  readonly capability?: string;
}

export interface SessionRecoveryHeader {
  readonly type?: string;
  readonly version?: number | string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly correlation?: MinimalSessionCorrelation;
}

export interface StartupRecoveryState {
  readonly resumed: boolean;
  readonly sessionFile?: string;
  readonly header?: SessionRecoveryHeader;
  readonly customCorrelation?: MinimalSessionCorrelation;
}

export interface ObservMeHandlerContext {
  readonly cwd?: string;
  readonly sessionFile?: string;
  readonly session_file?: string;
  readonly sessionId?: string;
  readonly session_id?: string;
  readonly model?: unknown;
  readonly thinking?: unknown;
  readonly ui?: {
    notify?: (message: string, level?: "warning" | "info" | "error") => Promise<void> | void;
    setStatus?: (key: string, value: string | undefined) => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
  readonly [key: string]: unknown;
}

export interface ObservMePiApi {
  on: (eventName: string, handler: Handler) => void;
}

export interface RegisterHandlersOptions {
  readonly loadConfig?: LoadSessionConfig;
  readonly startTelemetry?: StartSessionTelemetry;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
  readonly trustedParentContext?: boolean;
  readonly readSessionHeader?: ReadSessionHeader;
  readonly onHandlerError?: HandlerErrorRecorder;
}

export interface StartSessionTelemetryOptions {
  readonly config: ObservMeConfig;
  readonly lineage: AgentLineageContext;
}

export interface ObservMeTelemetrySession {
  readonly config: ObservMeConfig;
  readonly lineage: AgentLineageContext;
  readonly controller: Pick<ObservMeOtelSdkController, "flush" | "shutdown">;
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly logger: Logger;
  readonly metrics: ObservMeMetrics;
  readonly spans: SpanRegistry;
  agentTree: AgentTreeTracker;
  sessionSpan?: Span;
  sessionAttributes?: AttributeMap;
  workflowStartedAtMs?: number;
  activeAgentRecorded: boolean;
  currentAgentRunId?: string;
  currentTurnId?: string;
  currentLlmRequestId?: string;
  currentToolCallId?: string;
  currentBranchPreparation?: BranchPreparationState;
  agentRunSequence: number;
  llmRequestSequence: number;
  toolCallSequence: number;
  turnSequences: Map<string, number>;
}

export interface ObservMeMetrics {
  readonly handlerErrors: Counter;
  readonly telemetryDropped: Counter;
  readonly exportErrors: Counter;
  readonly sessionsStarted: Counter;
  readonly sessionsShutdown: Counter;
  readonly workflowsStarted: Counter;
  readonly workflowsCompleted: Counter;
  readonly workflowErrors: Counter;
  readonly agentRuns: Counter;
  readonly agentRunErrors: Counter;
  readonly turnsStarted: Counter;
  readonly turnsCompleted: Counter;
  readonly llmRequests: Counter;
  readonly llmErrors: Counter;
  readonly llmInputTokens: Counter;
  readonly llmOutputTokens: Counter;
  readonly llmCacheReadTokens: Counter;
  readonly llmCacheWriteTokens: Counter;
  readonly llmCacheWrite1hTokens: Counter;
  readonly llmReasoningTokens: Counter;
  readonly llmTotalTokens: Counter;
  readonly llmCostUsd: Counter;
  readonly toolCalls: Counter;
  readonly toolFailures: Counter;
  readonly bashExecutions: Counter;
  readonly bashFailures: Counter;
  readonly modelChanges: Counter;
  readonly thinkingLevelChanges: Counter;
  readonly compactions: Counter;
  readonly branches: Counter;
  readonly subagentsSpawned: Counter;
  readonly subagentSpawnFailures: Counter;
  readonly orphanAgents: Counter;
  readonly traceContextPropagationFailures: Counter;
  readonly childAgentFailures: Counter;
  readonly parentRecoveredFromChildFailure: Counter;
  readonly redactionFailures: Counter;
  readonly eventsObserved: Counter;
  readonly activeSpans: UpDownCounter;
  readonly activeAgents: UpDownCounter;
  readonly workflowDurationMs: Histogram;
  readonly agentRunDurationMs: Histogram;
  readonly agentLifetimeDurationMs: Histogram;
  readonly subagentSpawnDurationMs: Histogram;
  readonly agentFanoutCount: Histogram;
  readonly agentTreeDepth: Histogram;
  readonly agentTreeWidth: Histogram;
  readonly agentWaitDurationMs: Histogram;
  readonly agentJoinDurationMs: Histogram;
  readonly turnDurationMs: Histogram;
  readonly llmRequestDurationMs: Histogram;
  readonly toolDurationMs: Histogram;
  readonly bashDurationMs: Histogram;
  readonly compactionTokensBefore: Histogram;
  readonly promptSizeChars: Histogram;
  readonly responseSizeChars: Histogram;
  readonly toolResultSizeChars: Histogram;
  readonly handlerDurationMs: Histogram;
  readonly genAiClientTokenUsage: Histogram;
  readonly genAiClientOperationDuration: Histogram;
}

export interface SpanRegistry {
  readonly activeAgentRuns: BoundedMap<string, Span>;
  readonly activeTurns: BoundedMap<string, Span>;
  readonly activeLlmRequests: BoundedMap<string, Span>;
  readonly activeToolCalls: BoundedMap<string, ToolCallState>;
  readonly activeSubagentSpawns: BoundedMap<string, SubagentSpawnState>;
  readonly activeAgentWaits: BoundedMap<string, AgentWaitJoinState>;
  readonly activeAgentJoins: BoundedMap<string, AgentWaitJoinState>;
}

export interface ToolCallState {
  readonly span: Span;
  labels: Record<string, string>;
}

export interface BranchPreparationState {
  readonly targetId?: string;
  readonly oldLeafId?: string;
  readonly commonAncestorId?: string;
  readonly pathHash?: string;
}

export interface CompositeOtelSignalSdk {
  readonly traceSdk: ObservMeTraceSdk;
  readonly metricSdk: ObservMeMetricSdk;
  readonly logSdk: ObservMeLogSdk;
  start: () => void;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export const OBSERVME_SEMCONV_VERSION = "0.1.0";

const sessionAttributeKeys = {
  SESSION_ID: "pi.session.id",
  SESSION_NAME: "pi.session.name",
  SESSION_CWD_HASH: "pi.session.cwd_hash",
  SESSION_PARENT_SESSION_HASH: "pi.session.parent_session_hash",
  SESSION_PERSISTED: "pi.session.persisted",
  SESSION_FILE_HASH: "pi.session.file_hash",
  SESSION_VERSION: "pi.session.version",
  MODEL_PROVIDER_CURRENT: "pi.model.provider.current",
  MODEL_ID_CURRENT: "pi.model.id.current",
  THINKING_LEVEL_CURRENT: "pi.thinking.level.current",
} as const;

let defaultHandlerErrorRecorder: HandlerErrorRecorder = recordInternalErrorFallback;

export function registerHandlers(pi: unknown, options: RegisterHandlersOptions = {}): void {
  const api = pi as ObservMePiApi;
  let session: ObservMeTelemetrySession | undefined;
  const loadConfigFn = options.loadConfig ?? loadSessionConfig;
  const startTelemetryFn = options.startTelemetry ?? startSessionTelemetry;
  const errorRecorder = createStatefulHandlerErrorRecorder(() => session, options.onHandlerError);

  defaultHandlerErrorRecorder = errorRecorder;
  api.on("session_start", safeHandler("session_start", createSessionStartHandler(loadConfigFn, startTelemetryFn, options, value => {
    session = value;
  }), errorRecorder));
  api.on("agent_start", safeHandler("agent_start", createAgentStartHandler(() => session), errorRecorder));
  api.on("turn_start", safeHandler("turn_start", createTurnStartHandler(() => session), errorRecorder));
  api.on("before_provider_request", safeHandler("before_provider_request", createBeforeProviderRequestHandler(() => session), errorRecorder));
  api.on("after_provider_response", safeHandler("after_provider_response", createAfterProviderResponseHandler(() => session), errorRecorder));
  api.on("message_end", safeHandler("message_end", createMessageEndHandler(() => session), errorRecorder));
  api.on("tool_execution_start", safeHandler("tool_execution_start", createToolExecutionStartHandler(() => session), errorRecorder));
  api.on("tool_call", safeHandler("tool_call", createToolCallHandler(() => session), errorRecorder));
  api.on("tool_result", safeHandler("tool_result", createToolResultHandler(() => session), errorRecorder));
  api.on("tool_execution_end", safeHandler("tool_execution_end", createToolExecutionEndHandler(() => session), errorRecorder));
  api.on("user_bash", safeHandler("user_bash", createBashExecutionHandler(() => session), errorRecorder));
  api.on("bashExecution", safeHandler("bashExecution", createBashExecutionHandler(() => session), errorRecorder));
  api.on("model_select", safeHandler("model_select", createModelChangeHandler(() => session), errorRecorder));
  api.on("model_change", safeHandler("model_change", createModelChangeHandler(() => session), errorRecorder));
  api.on("thinking_level_select", safeHandler("thinking_level_select", createThinkingLevelChangeHandler(() => session), errorRecorder));
  api.on("thinking_level_change", safeHandler("thinking_level_change", createThinkingLevelChangeHandler(() => session), errorRecorder));
  api.on("session_before_tree", safeHandler("session_before_tree", createSessionBeforeTreeHandler(() => session), errorRecorder));
  api.on("session_tree", safeHandler("session_tree", createBranchHandler(() => session), errorRecorder));
  api.on("session_compact", safeHandler("session_compact", createCompactionHandler(() => session), errorRecorder));
  api.on("turn_end", safeHandler("turn_end", createTurnEndHandler(() => session), errorRecorder));
  api.on("agent_end", safeHandler("agent_end", createAgentEndHandler(() => session), errorRecorder));
  api.on("session_shutdown", safeHandler("session_shutdown", createSessionShutdownHandler(() => session, value => {
    session = value;
  }), errorRecorder));
}

export function safeHandler(name: string, fn: Handler, recorder: HandlerErrorRecorder = defaultHandlerErrorRecorder): Handler {
  return async (event, ctx) => {
    try {
      await fn(event, ctx);
    } catch (error) {
      recorder(name, error);
    }
  };
}

export async function startSessionTelemetry(options: StartSessionTelemetryOptions): Promise<ObservMeTelemetrySession> {
  const config = withLineageResourceAttributes(options.config, options.lineage);
  const traceSdk = new ObservMeTraceSdk({ config });
  const metricSdk = new ObservMeMetricSdk({ config });
  const logSdk = new ObservMeLogSdk({ config });
  const signalSdk = createCompositeOtelSignalSdk(traceSdk, metricSdk, logSdk);
  const controller = await startOtelSdk({ config, agent: options.lineage, sdkFactory: () => signalSdk });
  const tracer = traceSdk.tracer ?? trace.getTracer("@senad-d/observme");

  const metrics = createObservMeMetrics(metricSdk.meter);

  return {
    config,
    lineage: options.lineage,
    controller,
    tracer,
    meter: metricSdk.meter,
    logger: logSdk.logger,
    metrics,
    spans: createSpanRegistry(config, metrics),
    agentTree: createAgentTreeTracker(config, options.lineage, metrics),
    activeAgentRecorded: false,
    agentRunSequence: 0,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences: new Map(),
  };
}

export function createCompositeOtelSignalSdk(
  traceSdk: ObservMeTraceSdk,
  metricSdk: ObservMeMetricSdk,
  logSdk: ObservMeLogSdk,
): CompositeOtelSignalSdk {
  return new ObservMeCompositeOtelSignalSdk(traceSdk, metricSdk, logSdk);
}

export function createObservMeMetrics(meter: Meter): ObservMeMetrics {
  return {
    handlerErrors: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.HANDLER_ERRORS_TOTAL),
    telemetryDropped: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL),
    exportErrors: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.EXPORT_ERRORS_TOTAL),
    sessionsStarted: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.SESSIONS_STARTED_TOTAL),
    sessionsShutdown: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.SESSIONS_SHUTDOWN_TOTAL),
    workflowsStarted: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.WORKFLOWS_STARTED_TOTAL),
    workflowsCompleted: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.WORKFLOWS_COMPLETED_TOTAL),
    workflowErrors: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.WORKFLOW_ERRORS_TOTAL),
    agentRuns: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.AGENT_RUNS_TOTAL),
    agentRunErrors: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.AGENT_RUN_ERRORS_TOTAL),
    turnsStarted: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.TURNS_STARTED_TOTAL),
    turnsCompleted: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.TURNS_COMPLETED_TOTAL),
    llmRequests: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.LLM_REQUESTS_TOTAL),
    llmErrors: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.LLM_ERRORS_TOTAL),
    llmInputTokens: meter.createCounter(OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_INPUT_TOKENS_TOTAL),
    llmOutputTokens: meter.createCounter(OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_OUTPUT_TOKENS_TOTAL),
    llmCacheReadTokens: meter.createCounter(OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_READ_TOKENS_TOTAL),
    llmCacheWriteTokens: meter.createCounter(OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_WRITE_TOKENS_TOTAL),
    llmCacheWrite1hTokens: meter.createCounter(OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_WRITE_1H_TOKENS_TOTAL),
    llmReasoningTokens: meter.createCounter(OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_REASONING_TOKENS_TOTAL),
    llmTotalTokens: meter.createCounter(OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_TOTAL_TOKENS_TOTAL),
    llmCostUsd: meter.createCounter(OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_COST_USD_TOTAL),
    toolCalls: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.TOOL_CALLS_TOTAL),
    toolFailures: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.TOOL_FAILURES_TOTAL),
    bashExecutions: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL),
    bashFailures: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.BASH_FAILURES_TOTAL),
    modelChanges: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.MODEL_CHANGES_TOTAL),
    thinkingLevelChanges: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.THINKING_LEVEL_CHANGES_TOTAL),
    compactions: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.COMPACTIONS_TOTAL),
    branches: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.BRANCHES_TOTAL),
    subagentsSpawned: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL),
    subagentSpawnFailures: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL),
    orphanAgents: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL),
    traceContextPropagationFailures: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL),
    childAgentFailures: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.CHILD_AGENT_FAILURES_TOTAL),
    parentRecoveredFromChildFailure: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.PARENT_RECOVERED_FROM_CHILD_FAILURE_TOTAL),
    redactionFailures: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.REDACTION_FAILURES_TOTAL),
    eventsObserved: meter.createCounter(OBSERVME_COUNTER_METRIC_NAMES.EVENTS_OBSERVED_TOTAL),
    activeSpans: meter.createUpDownCounter(OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_SPANS),
    activeAgents: meter.createUpDownCounter(OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_AGENTS),
    workflowDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.WORKFLOW_DURATION_MS),
    agentRunDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_RUN_DURATION_MS),
    agentLifetimeDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_LIFETIME_DURATION_MS),
    subagentSpawnDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.SUBAGENT_SPAWN_DURATION_MS),
    agentFanoutCount: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_FANOUT_COUNT),
    agentTreeDepth: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_DEPTH),
    agentTreeWidth: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_WIDTH),
    agentWaitDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS),
    agentJoinDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_JOIN_DURATION_MS),
    turnDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.TURN_DURATION_MS),
    llmRequestDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.LLM_REQUEST_DURATION_MS),
    toolDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.TOOL_DURATION_MS),
    bashDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS),
    compactionTokensBefore: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.COMPACTION_TOKENS_BEFORE),
    promptSizeChars: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.PROMPT_SIZE_CHARS),
    responseSizeChars: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.RESPONSE_SIZE_CHARS),
    toolResultSizeChars: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.TOOL_RESULT_SIZE_CHARS),
    handlerDurationMs: createHistogram(meter, OBSERVME_HISTOGRAM_METRIC_NAMES.HANDLER_DURATION_MS),
    genAiClientTokenUsage: createHistogram(meter, OFFICIAL_GENAI_METRIC_NAMES.CLIENT_TOKEN_USAGE),
    genAiClientOperationDuration: createHistogram(meter, OFFICIAL_GENAI_METRIC_NAMES.CLIENT_OPERATION_DURATION),
  };
}

export function createHistogram(meter: Meter, name: string): Histogram {
  const maybeMeter = meter as Partial<Meter>;
  const noopHistogram = { record: (_value: number, _attributes?: Record<string, unknown>) => undefined };
  return typeof maybeMeter.createHistogram === "function" ? maybeMeter.createHistogram(name) : noopHistogram;
}

export function createAgentTreeTracker(
  config: ObservMeConfig,
  lineage: AgentLineageContext,
  metrics: ObservMeMetrics,
): AgentTreeTracker {
  const tracker = new AgentTreeTracker({
    maxAgents: Math.max(2, config.limits.maxActiveSubagentSpawns + 1),
    onEvict: () => {
      metrics.telemetryDropped.add(1, { reason: "agent_tree_full" });
      recordObsStatusQueueDrop();
    },
  });

  tracker.registerAgent(lineage);
  return tracker;
}

export function createSpanRegistry(config: ObservMeConfig, metrics: ObservMeMetrics): SpanRegistry {
  return {
    activeAgentRuns: new BoundedMap({
      maxSize: config.limits.maxActiveAgentRuns,
      onEvict: eviction => evictSpan(eviction.value, metrics),
    }),
    activeTurns: new BoundedMap({
      maxSize: config.limits.maxActiveTurns,
      onEvict: eviction => evictSpan(eviction.value, metrics),
    }),
    activeLlmRequests: new BoundedMap({
      maxSize: config.limits.maxActiveLlmRequests,
      onEvict: eviction => evictSpan(eviction.value, metrics),
    }),
    activeToolCalls: new BoundedMap({
      maxSize: config.limits.maxActiveToolCalls,
      onEvict: eviction => evictToolCallState(eviction.value, metrics),
    }),
    activeSubagentSpawns: new BoundedMap({
      maxSize: config.limits.maxActiveSubagentSpawns,
      onEvict: eviction => evictSubagentSpawnState(eviction.value, metrics),
    }),
    activeAgentWaits: new BoundedMap({
      maxSize: config.limits.maxActiveAgentWaits,
      onEvict: eviction => evictWaitJoinState(eviction.value, metrics),
    }),
    activeAgentJoins: new BoundedMap({
      maxSize: config.limits.maxActiveAgentJoins,
      onEvict: eviction => evictWaitJoinState(eviction.value, metrics),
    }),
  };
}

export function buildSessionAttributes(
  event: unknown,
  ctx: ObservMeHandlerContext,
  config: ObservMeConfig,
  lineage: AgentLineageContext,
  recovery?: StartupRecoveryState,
): AttributeMap {
  const cwd = recovery?.header?.cwd ?? readString(ctx, "cwd") ?? process.cwd();
  const sessionId = recovery?.header?.id ?? resolveSessionId(event, ctx, lineage);
  const parentSessionId = recovery?.header?.parentSession ?? readString(event, "parentSessionId") ?? lineage.parentSessionId;
  const sessionFile = recovery?.sessionFile ?? resolveSessionFilePath(event, ctx);

  return withoutUndefinedAttributes({
    [sessionAttributeKeys.SESSION_ID]: sessionId,
    [sessionAttributeKeys.SESSION_NAME]: readString(event, "sessionName") ?? readString(event, "name") ?? "unknown",
    [sessionAttributeKeys.SESSION_CWD_HASH]: hashValue(cwd),
    [sessionAttributeKeys.SESSION_PARENT_SESSION_HASH]: parentSessionId ? hashValue(parentSessionId) : "",
    [sessionAttributeKeys.SESSION_PERSISTED]: readBoolean(event, "persisted") ?? recovery?.resumed ?? false,
    [sessionAttributeKeys.SESSION_FILE_HASH]: sessionFile ? hashValue(sessionFile) : "",
    [sessionAttributeKeys.SESSION_VERSION]: readString(recovery?.header, "version") ?? readString(event, "sessionVersion") ?? readString(event, "version") ?? "unknown",
    [sessionAttributeKeys.MODEL_PROVIDER_CURRENT]: resolveModelProvider(event, ctx),
    [sessionAttributeKeys.MODEL_ID_CURRENT]: resolveModelId(event, ctx),
    [sessionAttributeKeys.THINKING_LEVEL_CURRENT]: resolveThinkingLevel(event, ctx),
    ...buildCommonSessionSpanAttributes(sessionId, config, lineage),
  });
}

export function emitLifecycleLog(
  logger: Logger,
  eventName: string,
  attributes: AttributeMap,
  severityText: "ERROR" | "INFO" = "INFO",
): void {
  emitStructuredLog(logger, eventName, "lifecycle", attributes, severityText);
}

function emitStructuredLog(
  logger: Logger,
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

export function isRootWorkflow(lineage: AgentLineageContext): boolean {
  return lineage.role === "root" || lineage.role === "orchestrator";
}

export function workflowFailed(event: unknown): boolean {
  const status = readString(event, "status") ?? readString(event, "outcome");
  return readBoolean(event, "failed") === true || Boolean(readUnknown(event, "error")) || status === "failed" || status === "error";
}

export async function readSessionHeaderFromFile(sessionFile: string): Promise<SessionRecoveryHeader | undefined> {
  let file;

  try {
    file = await open(sessionFile, "r");
    const buffer = Buffer.alloc(65_536);
    const result = await file.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, result.bytesRead).toString("utf8").split(/\r?\n/u)[0]?.trim();
    if (!firstLine) return undefined;

    return normalizeSessionHeader(JSON.parse(firstLine));
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}

class ObservMeCompositeOtelSignalSdk implements CompositeOtelSignalSdk {
  readonly traceSdk: ObservMeTraceSdk;
  readonly metricSdk: ObservMeMetricSdk;
  readonly logSdk: ObservMeLogSdk;

  constructor(traceSdk: ObservMeTraceSdk, metricSdk: ObservMeMetricSdk, logSdk: ObservMeLogSdk) {
    this.traceSdk = traceSdk;
    this.metricSdk = metricSdk;
    this.logSdk = logSdk;
  }

  start(): void {
    this.traceSdk.start();
    this.metricSdk.start();
    this.logSdk.start();
  }

  async forceFlush(): Promise<void> {
    await Promise.all([this.traceSdk.forceFlush(), this.metricSdk.forceFlush(), this.logSdk.forceFlush()]);
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.traceSdk.shutdown(), this.metricSdk.shutdown(), this.logSdk.shutdown()]);
  }
}

async function resolveStartupRecovery(
  event: unknown,
  ctx: ObservMeHandlerContext,
  config: ObservMeConfig,
  options: RegisterHandlersOptions,
): Promise<StartupRecoveryState> {
  const sessionFile = resolveSessionFilePath(event, ctx);
  const readHeader = options.readSessionHeader ?? readSessionHeaderFromFile;
  const header = sessionFile ? await readHeader(sessionFile) : undefined;
  const customCorrelation = config.agent.writeCorrelationEntry ? readExplicitCustomCorrelation(event) : undefined;

  return {
    resumed: isExistingSessionStart(event),
    sessionFile,
    header,
    customCorrelation,
  };
}

function emitStartupReplayTelemetry(session: ObservMeTelemetrySession, attributes: AttributeMap): void {
  const replayAttributes = {
    ...attributes,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_REPLAYED]: true,
  };

  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.SESSION_STARTED, replayAttributes);
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.SESSION_STARTED, replayAttributes);
}

function buildRecoveryLineageEnv(
  config: ObservMeConfig,
  env: NodeJS.ProcessEnv = process.env,
  correlation: MinimalSessionCorrelation | undefined,
): NodeJS.ProcessEnv {
  if (!correlation) return env;

  return {
    ...env,
    ...definedEnvValue(config.workflow.idEnv, correlation.workflowId),
    ...definedEnvValue(config.agent.idEnv, correlation.agentId),
    ...definedEnvValue(config.agent.parentIdEnv, correlation.parentAgentId),
    ...definedEnvValue(config.agent.rootIdEnv, correlation.rootAgentId),
    ...definedEnvValue(config.agent.parentSessionIdEnv, correlation.parentSessionId),
    ...definedEnvValue(config.agent.depthEnv, correlation.depth === undefined ? undefined : String(correlation.depth)),
    ...definedEnvValue(config.agent.spawnIdEnv, correlation.spawnId),
    ...definedEnvValue(config.agent.capabilityEnv, correlation.capability),
  };
}

function definedEnvValue(name: string, value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined || value === "" ? {} : { [name]: value };
}

function readExplicitCustomCorrelation(event: unknown): MinimalSessionCorrelation | undefined {
  const value = readUnknown(event, "customCorrelation") ?? readUnknown(event, "observmeCorrelation");
  return normalizeMinimalCorrelation(value);
}

function normalizeSessionHeader(value: unknown): SessionRecoveryHeader | undefined {
  if (!isRecord(value) || readString(value, "type") !== "session") return undefined;

  return withoutUndefinedObjectValues({
    type: "session",
    version: readString(value, "version") ?? readInteger(value, "version"),
    id: readString(value, "id"),
    timestamp: readString(value, "timestamp"),
    cwd: readString(value, "cwd"),
    parentSession: readString(value, "parentSession"),
    correlation: normalizeMinimalCorrelation(readUnknown(value, "observmeCorrelation") ?? readUnknown(value, "correlation")),
  });
}

function normalizeMinimalCorrelation(value: unknown): MinimalSessionCorrelation | undefined {
  if (!isRecord(value)) return undefined;

  const correlation = withoutUndefinedObjectValues({
    workflowId: readString(value, "workflowId"),
    agentId: readString(value, "agentId"),
    parentAgentId: readString(value, "parentAgentId"),
    rootAgentId: readString(value, "rootAgentId"),
    parentSessionId: readString(value, "parentSessionId"),
    depth: readInteger(value, "depth"),
    spawnId: readString(value, "spawnId"),
    capability: readString(value, "capability"),
  });

  return Object.keys(correlation).length === 0 ? undefined : correlation;
}

function withoutUndefinedObjectValues<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, T[keyof T]] => entry[1] !== undefined)) as T;
}

function isExistingSessionStart(event: unknown): boolean {
  const reason = readString(event, "reason");
  return reason === "resume" || reason === "reload" || readBoolean(event, "resumed") === true || readBoolean(event, "existingSession") === true;
}

async function loadSessionConfigForHandler(
  loadConfigFn: LoadSessionConfig,
  options: RegisterHandlersOptions,
  ctx: ObservMeHandlerContext,
): Promise<{ readonly config: ObservMeConfig; readonly diagnostics?: SessionConfigDiagnostics }> {
  const loadOptions = { ctx, cwd: ctx.cwd, configDirName: options.configDirName, env: options.env };

  if (options.loadConfig) return { config: await loadConfigFn(loadOptions), diagnostics: undefined };
  return loadSessionConfigWithDiagnostics(loadOptions);
}

function createSessionStartHandler(
  loadConfigFn: LoadSessionConfig,
  startTelemetryFn: StartSessionTelemetry,
  options: RegisterHandlersOptions,
  setSession: (session: ObservMeTelemetrySession) => void,
): Handler {
  return async (event, ctx) => {
    const loadedConfig = await loadSessionConfigForHandler(loadConfigFn, options, ctx);
    const config = loadedConfig.config;
    await emitUnsafeCaptureWarning(config, ctx);

    const recovery = await resolveStartupRecovery(event, ctx, config, options);
    const lineage = createAgentLineageContext({
      config,
      env: buildRecoveryLineageEnv(config, options.env, recovery.customCorrelation ?? recovery.header?.correlation),
      trustedParentContext: options.trustedParentContext === true || Boolean(recovery.customCorrelation ?? recovery.header?.correlation),
    });
    const session = await startTelemetryFn({ config, lineage });
    updateObsStatusRuntimeState({ config: session.config, configDiagnostics: loadedConfig.diagnostics });
    clearObsStatusExportError();
    setSession(session);
    const attributes = buildSessionAttributes(event, ctx, session.config, lineage, recovery);
    const labels = metricLabels(session.config, lineage);

    session.sessionAttributes = attributes;
    session.sessionSpan = session.tracer.startSpan(SPAN_NAMES.PI_SESSION, { attributes });
    startObsSessionRuntimeState({
      sessionId: readString(attributes, sessionAttributeKeys.SESSION_ID),
      traceId: readSpanTraceId(session.sessionSpan),
      traceUrlTemplate: session.config.query.links.traceUrlTemplate,
    });
    startObsAgentsRuntimeState({
      lineage,
      agentTree: session.agentTree,
      sessionId: readString(attributes, sessionAttributeKeys.SESSION_ID),
      traceId: readSpanTraceId(session.sessionSpan),
    });
    session.workflowStartedAtMs = Date.now();
    session.metrics.sessionsStarted.add(1, labels);
    session.metrics.activeAgents.add(1, labels);
    session.activeAgentRecorded = true;
    session.sessionSpan.addEvent(LOG_EVENT_NAMES.SESSION_STARTED, attributes);
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.SESSION_STARTED, attributes);
    if (recovery.resumed && session.config.replayOnStart) emitStartupReplayTelemetry(session, attributes);

    if (isRootWorkflow(lineage)) {
      session.metrics.workflowsStarted.add(1, labels);
      emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_STARTED, attributes);
    }

    await ctx.ui?.setStatus?.(EXTENSION_STATUS_KEY, `${EXTENSION_DISPLAY_NAME} loaded`);
    setSession(session);
  };
}

function createSessionShutdownHandler(
  getSession: () => ObservMeTelemetrySession | undefined,
  setSession: (session: ObservMeTelemetrySession | undefined) => void,
): Handler {
  return async (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const labels = metricLabels(session.config, session.lineage);
    const shutdownAttributes = buildShutdownAttributes(event, session);
    const failed = workflowFailed(event);

    session.metrics.sessionsShutdown.add(1, labels);
    if (session.activeAgentRecorded) session.metrics.activeAgents.add(-1, labels);
    recordWorkflowShutdownTelemetry(session, shutdownAttributes, failed, labels);
    endAllActiveSpans(session);
    session.sessionSpan?.addEvent(LOG_EVENT_NAMES.SESSION_SHUTDOWN, shutdownAttributes);
    if (failed) session.sessionSpan?.setStatus({ code: SpanStatusCode.ERROR });
    session.sessionSpan?.end();
    await _ctx.ui?.setStatus?.(EXTENSION_STATUS_KEY, undefined);
    const flushResult = await session.controller.flush(session.config.shutdown.flushTimeoutMs);
    recordObsStatusExportResult(flushResult);
    recordExportOperationResult(session, flushResult);
    const shutdownResult = await session.controller.shutdown(session.config.shutdown.flushTimeoutMs);
    recordObsStatusExportResult(shutdownResult);
    recordExportOperationResult(session, shutdownResult);
    clearObsSessionRuntimeState();
    clearObsAgentsRuntimeState();
    setSession(undefined);
  };
}

function createAgentStartHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const runId = nextAgentRunId(session, event);
    const attributes = buildAgentRunAttributes(event, session, runId);
    const span = startChildSpan(session.tracer, SPAN_NAMES.PI_AGENT_RUN, session.sessionSpan, attributes);

    session.currentAgentRunId = runId;
    session.spans.activeAgentRuns.set(runId, span);
    session.metrics.agentRuns.add(1, metricLabels(session.config, session.lineage));
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.AGENT_RUN_STARTED, attributes);
  };
}

function createAgentEndHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const runId = readString(event, "agentRunId") ?? readString(event, "runId") ?? session.currentAgentRunId;
    if (!runId) return;

    const span = session.spans.activeAgentRuns.get(runId);
    if (workflowFailed(event)) span?.setStatus({ code: SpanStatusCode.ERROR });
    recordSpanDurationMs(span, session.metrics.agentRunDurationMs, metricLabels(session.config, session.lineage));
    span?.end();
    session.spans.activeAgentRuns.delete(runId);
    if (session.currentAgentRunId === runId) session.currentAgentRunId = undefined;
    emitLifecycleLog(session.logger, workflowFailed(event) ? LOG_EVENT_NAMES.AGENT_RUN_FAILED : LOG_EVENT_NAMES.AGENT_RUN_COMPLETED, {
      [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_ID]: runId,
      ...buildLineageMetricSafeLogAttributes(session),
    });
  };
}

function createTurnStartHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const runId = session.currentAgentRunId ?? nextAgentRunId(session, { source: "unknown" });
    const runSpan = session.spans.activeAgentRuns.get(runId) ?? session.sessionSpan;
    const turnIndex = nextTurnIndex(session, runId, event);
    const turnId = deriveTurnId(runId, turnIndex);
    const attributes = buildTurnAttributes(event, session, runId, turnId, turnIndex);
    const span = startChildSpan(session.tracer, SPAN_NAMES.PI_TURN, runSpan, attributes);

    session.currentTurnId = turnId;
    session.spans.activeTurns.set(turnId, span);
    session.metrics.turnsStarted.add(1, metricLabels(session.config, session.lineage));
    recordObsSessionTurn();
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TURN_STARTED, attributes);
  };
}

function createBeforeProviderRequestHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, ctx) => {
    const session = getSession();
    if (!session) return;

    const requestId = nextLlmRequestId(session, event);
    const parentSpan = resolveLlmParentSpan(session);
    const attributes = buildLlmRequestAttributes(event, ctx, session, requestId);
    const span = startChildSpan(session.tracer, SPAN_NAMES.PI_LLM_REQUEST, parentSpan, attributes);

    recordPromptSizeMetric(session, event, llmMetricLabels(session, attributes));
    recordOptionalPromptContent(session, span, event);
    session.currentLlmRequestId = requestId;
    session.spans.activeLlmRequests.set(requestId, span);
    session.metrics.llmRequests.add(1, llmMetricLabels(session, attributes));
    recordObsSessionLlmCall();
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.LLM_REQUEST_STARTED, attributes);
  };
}

function createAfterProviderResponseHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const span = resolveCurrentLlmSpan(session, event);
    span?.setAttributes(buildLlmResponseAttributes(event));
  };
}

function createMessageEndHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
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
    span?.end();
    deleteCurrentLlmRequest(session, event);
  };
}

function createToolExecutionStartHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const toolCallId = nextToolCallId(session, event);
    const state = startToolCallState(session, event, toolCallId);
    recordOptionalToolArguments(session, state.span, event);
  };
}

function createToolCallHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const toolCallId = resolveCurrentToolCallId(session, event) ?? nextToolCallId(session, event);
    const state = resolveToolCallState(session, event) ?? startToolCallState(session, event, toolCallId);
    const attributes = buildToolCallInputAttributes(event);

    state.span.setAttributes(attributes);
    mergeToolStateLabels(state, attributes);
    recordOptionalToolArguments(session, state.span, event);
  };
}

function createToolResultHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const state = resolveToolCallState(session, event);
    if (!state) return;

    const attributes = buildToolResultAttributes(event);
    state.span.setAttributes(attributes);
    mergeToolStateLabels(state, attributes);
    recordOptionalToolResult(session, state.span, event);
  };
}

function createToolExecutionEndHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const toolCallId = resolveCurrentToolCallId(session, event) ?? nextToolCallId(session, event);
    const state = resolveToolCallState(session, event) ?? startToolCallState(session, event, toolCallId);
    const resultAttributes = buildToolResultAttributes(event);
    const finalAttributes = buildToolFinalAttributes(event);
    const failed = finalAttributes[TOOL_ATTRIBUTES.PI_TOOL_SUCCESS] === false;

    state.span.setAttributes({ ...resultAttributes, ...finalAttributes });
    mergeToolStateLabels(state, resultAttributes);
    recordOptionalToolResult(session, state.span, event);

    if (failed) {
      const errorClass = String(finalAttributes[TOOL_ATTRIBUTES.PI_TOOL_ERROR_CLASS] ?? "tool_error");
      state.span.setStatus({ code: SpanStatusCode.ERROR, message: errorClass });
      session.metrics.toolFailures.add(1, state.labels);
      emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TOOL_CALL_FAILED, finalAttributes, "ERROR");
    } else {
      state.span.setStatus({ code: SpanStatusCode.OK });
      emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TOOL_CALL_COMPLETED, finalAttributes);
    }

    recordSpanDurationMs(state.span, session.metrics.toolDurationMs, state.labels);
    state.span.end();
    deleteCurrentToolCall(session, toolCallId);
  };
}

function createBashExecutionHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    recordBashExecution(session, event);
  };
}

function createModelChangeHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, ctx) => {
    const session = getSession();
    if (!session) return;

    const attributes = buildModelChangeAttributes(event, ctx, session);

    updateCurrentSessionAttributes(session, attributes, [
      sessionAttributeKeys.MODEL_PROVIDER_CURRENT,
      sessionAttributeKeys.MODEL_ID_CURRENT,
    ]);
    session.metrics.modelChanges.add(1, modelChangeMetricLabels(session, attributes));
    session.sessionSpan?.addEvent(LOG_EVENT_NAMES.MODEL_CHANGED, attributes);
    emitStructuredLog(session.logger, LOG_EVENT_NAMES.MODEL_CHANGED, "model", attributes);
  };
}

function createThinkingLevelChangeHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, ctx) => {
    const session = getSession();
    if (!session) return;

    const attributes = buildThinkingLevelChangeAttributes(event, ctx, session);

    updateCurrentSessionAttributes(session, attributes, [sessionAttributeKeys.THINKING_LEVEL_CURRENT]);
    session.metrics.thinkingLevelChanges.add(1, thinkingLevelChangeMetricLabels(session));
    session.sessionSpan?.addEvent(LOG_EVENT_NAMES.THINKING_CHANGED, attributes);
    emitStructuredLog(session.logger, LOG_EVENT_NAMES.THINKING_CHANGED, "thinking", attributes);
  };
}

function createSessionBeforeTreeHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    session.currentBranchPreparation = buildBranchPreparationState(event);
  };
}

function createBranchHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    try {
      recordBranch(session, event);
    } finally {
      session.currentBranchPreparation = undefined;
    }
  };
}

function recordBranch(session: ObservMeTelemetrySession, event: unknown): void {
  const attributes = buildBranchAttributes(event, session);
  const labels = metricLabels(session.config, session.lineage);
  const span = startChildSpan(session.tracer, SPAN_NAMES.PI_BRANCH, resolveOperationParentSpan(session), attributes);

  span.addEvent(LOG_EVENT_NAMES.BRANCH_CREATED, attributes);
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
  session.metrics.branches.add(1, labels);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.BRANCH_CREATED, "branch", attributes);
}

function createCompactionHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    recordCompaction(session, event);
  };
}

function recordCompaction(session: ObservMeTelemetrySession, event: unknown): void {
  const attributes = buildCompactionAttributes(event, session);
  const labels = metricLabels(session.config, session.lineage);
  const span = startChildSpan(session.tracer, SPAN_NAMES.PI_COMPACTION, resolveOperationParentSpan(session), attributes);

  span.addEvent(LOG_EVENT_NAMES.COMPACTION_CREATED, attributes);
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
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

function recordBashExecution(session: ObservMeTelemetrySession, event: unknown): void {
  const payload = readBashPayload(event);
  const attributes = buildBashExecutionAttributes(payload, session);
  const span = startChildSpan(session.tracer, SPAN_NAMES.PI_BASH_EXECUTION, resolveToolParentSpan(session), attributes);
  const failed = bashExecutionFailed(payload);

  recordOptionalBashContent(session, span, payload);
  session.metrics.bashExecutions.add(1, bashExecutionMetricLabels(session, payload, failed));

  if (failed) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: bashErrorClass(payload) });
    session.metrics.bashFailures.add(1, bashFailureMetricLabels(session, payload));
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.addEvent(LOG_EVENT_NAMES.BASH_COMPLETED, attributes);
  recordSpanDurationMs(span, session.metrics.bashDurationMs, bashExecutionMetricLabels(session, payload, failed));
  span.end();
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.BASH_COMPLETED, attributes, failed ? "ERROR" : "INFO");
}

function createTurnEndHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const runId = readString(event, "agentRunId") ?? readString(event, "runId") ?? session.currentAgentRunId;
    if (!runId) return;

    const turnIndex = readInteger(event, "turnIndex") ?? readInteger(event, "turn_index") ?? session.turnSequences.get(runId);
    if (!turnIndex) return;

    const turnId = readString(event, "turnId") ?? readString(event, "turn_id") ?? deriveTurnId(runId, turnIndex);
    const span = session.spans.activeTurns.get(turnId);

    if (workflowFailed(event)) span?.setStatus({ code: SpanStatusCode.ERROR });
    recordSpanDurationMs(span, session.metrics.turnDurationMs, metricLabels(session.config, session.lineage));
    span?.end();
    session.spans.activeTurns.delete(turnId);
    if (session.currentTurnId === turnId) session.currentTurnId = undefined;
    session.metrics.turnsCompleted.add(1, metricLabels(session.config, session.lineage));
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TURN_COMPLETED, {
      [TURN_ATTRIBUTES.PI_TURN_ID]: turnId,
      [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_ID]: runId,
      ...buildLineageMetricSafeLogAttributes(session),
    });
  };
}

function recordWorkflowShutdownTelemetry(
  session: ObservMeTelemetrySession,
  attributes: AttributeMap,
  failed: boolean,
  labels: Record<string, string>,
): void {
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.SESSION_SHUTDOWN, attributes);
  if (!isRootWorkflow(session.lineage)) return;

  if (failed) {
    session.metrics.workflowErrors.add(1, labels);
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_FAILED, attributes, "ERROR");
    return;
  }

  session.metrics.workflowsCompleted.add(1, labels);
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_COMPLETED, attributes);
}

function recordExportOperationResult(session: ObservMeTelemetrySession, result: BoundedOtelOperationResult): void {
  if (result.completed && !result.timedOut && !result.error) return;

  const attributes = exportFailureAttributes(result);
  session.metrics.exportErrors.add(1, exportFailureMetricLabels(result));
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.EXPORT_FAILED, attributes, "ERROR");
}

function exportFailureAttributes(result: BoundedOtelOperationResult): AttributeMap {
  return {
    operation: result.operation,
    reason: exportFailureReason(result),
    status: result.timedOut ? "timeout" : "error",
    [LOG_ATTRIBUTES.ERROR_TYPE]: exportFailureErrorClass(result),
  };
}

function exportFailureMetricLabels(result: BoundedOtelOperationResult): Record<string, string> {
  return {
    operation: result.operation,
    reason: exportFailureReason(result),
    error_class: exportFailureErrorClass(result),
  };
}

function exportFailureReason(result: BoundedOtelOperationResult): "export_error" | "export_timeout" {
  return result.timedOut ? "export_timeout" : "export_error";
}

function exportFailureErrorClass(result: BoundedOtelOperationResult): string {
  if (result.timedOut) return "timeout";
  if (!result.error) return "unknown";
  return normalizeMetricValue(errorClass(result.error), "error");
}

function buildShutdownAttributes(event: unknown, session: ObservMeTelemetrySession): AttributeMap {
  return withoutUndefinedAttributes({
    [LOG_ATTRIBUTES.PI_SESSION_ID]: readString(session.sessionAttributes, sessionAttributeKeys.SESSION_ID),
    [LOG_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [LOG_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID]: session.lineage.workflowRootAgentId,
    [LOG_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [LOG_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
    "pi.workflow.duration_ms": session.workflowStartedAtMs ? Date.now() - session.workflowStartedAtMs : 0,
    "pi.workflow.status": workflowFailed(event) ? "error" : "ok",
  });
}

function createStatefulHandlerErrorRecorder(
  getSession: () => ObservMeTelemetrySession | undefined,
  fallback?: HandlerErrorRecorder,
): HandlerErrorRecorder {
  return (name, error) => {
    const session = getSession();
    session?.metrics.handlerErrors.add(1, { operation: normalizeMetricValue(name, "handler") });
    if (session) emitLifecycleLog(session.logger, LOG_EVENT_NAMES.HANDLER_FAILED, handlerErrorAttributes(name, error), "ERROR");
    if (!session) fallback?.(name, error);
  };
}

function handlerErrorAttributes(name: string, error: unknown): AttributeMap {
  return {
    handler: name,
    [LOG_ATTRIBUTES.ERROR_TYPE]: errorClass(error),
  };
}

function recordInternalErrorFallback(_name: string, _error: unknown): void {
  return undefined;
}

function withLineageResourceAttributes(config: ObservMeConfig, lineage: AgentLineageContext): ObservMeConfig {
  const merged = structuredClone(config);
  merged.resource.attributes = {
    ...merged.resource.attributes,
    ...stringifyAttributes(buildResourceLineageAttributes(lineage)),
  };
  return merged;
}

function stringifyAttributes(attributes: AttributeMap): Record<string, string> {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
}

function nextAgentRunId(session: ObservMeTelemetrySession, event: unknown): string {
  const explicitRunId = readString(event, "agentRunId") ?? readString(event, "runId");
  if (explicitRunId) return explicitRunId;

  session.agentRunSequence += 1;
  return formatAgentRunId(session.agentRunSequence);
}

function nextTurnIndex(session: ObservMeTelemetrySession, runId: string, event: unknown): number {
  const explicitTurnIndex = readInteger(event, "turnIndex") ?? readInteger(event, "turn_index");
  if (explicitTurnIndex !== undefined) {
    session.turnSequences.set(runId, Math.max(session.turnSequences.get(runId) ?? 0, explicitTurnIndex));
    return explicitTurnIndex;
  }

  const nextIndex = (session.turnSequences.get(runId) ?? 0) + 1;
  session.turnSequences.set(runId, nextIndex);
  return nextIndex;
}

function nextLlmRequestId(session: ObservMeTelemetrySession, event: unknown): string {
  const explicitRequestId = readString(event, "llmRequestId") ?? readString(event, "requestId");
  if (explicitRequestId) return explicitRequestId;

  session.llmRequestSequence += 1;
  return `llm-request-${formatSequence(session.llmRequestSequence)}`;
}

function resolveLlmParentSpan(session: ObservMeTelemetrySession): Span | undefined {
  if (session.currentTurnId) return session.spans.activeTurns.get(session.currentTurnId) ?? session.sessionSpan;
  if (session.currentAgentRunId) return session.spans.activeAgentRuns.get(session.currentAgentRunId) ?? session.sessionSpan;
  return session.sessionSpan;
}

function resolveCurrentLlmSpan(session: ObservMeTelemetrySession, event: unknown): Span | undefined {
  const requestId = readString(event, "llmRequestId") ?? readString(event, "requestId") ?? session.currentLlmRequestId;
  return requestId ? session.spans.activeLlmRequests.get(requestId) : undefined;
}

function deleteCurrentLlmRequest(session: ObservMeTelemetrySession, event: unknown): void {
  const requestId = readString(event, "llmRequestId") ?? readString(event, "requestId") ?? session.currentLlmRequestId;
  if (!requestId) return;

  session.spans.activeLlmRequests.delete(requestId);
  if (session.currentLlmRequestId === requestId) session.currentLlmRequestId = undefined;
}

function nextToolCallId(session: ObservMeTelemetrySession, event: unknown): string {
  const explicitToolCallId = readToolCallId(event);
  if (explicitToolCallId) return explicitToolCallId;

  session.toolCallSequence += 1;
  return `tool-call-${formatSequence(session.toolCallSequence)}`;
}

function resolveCurrentToolCallId(session: ObservMeTelemetrySession, event: unknown): string | undefined {
  return readToolCallId(event) ?? session.currentToolCallId;
}

function resolveToolCallState(session: ObservMeTelemetrySession, event: unknown): ToolCallState | undefined {
  const toolCallId = resolveCurrentToolCallId(session, event);
  return toolCallId ? session.spans.activeToolCalls.get(toolCallId) : undefined;
}

function deleteCurrentToolCall(session: ObservMeTelemetrySession, toolCallId: string): void {
  session.spans.activeToolCalls.delete(toolCallId);
  if (session.currentToolCallId === toolCallId) session.currentToolCallId = undefined;
}

function startToolCallState(session: ObservMeTelemetrySession, event: unknown, toolCallId: string): ToolCallState {
  const existingState = session.spans.activeToolCalls.get(toolCallId);
  const attributes = buildToolStartAttributes(event, session, toolCallId);

  if (existingState) {
    existingState.span.setAttributes(attributes);
    mergeToolStateLabels(existingState, attributes);
    session.currentToolCallId = toolCallId;
    return existingState;
  }

  const span = startChildSpan(session.tracer, SPAN_NAMES.PI_TOOL_CALL, resolveToolParentSpan(session), attributes);
  const state = { span, labels: toolMetricLabels(attributes) };

  session.currentToolCallId = toolCallId;
  session.spans.activeToolCalls.set(toolCallId, state);
  session.metrics.toolCalls.add(1, state.labels);
  recordObsSessionToolCall();
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.TOOL_CALL_STARTED, attributes);

  return state;
}

function resolveToolParentSpan(session: ObservMeTelemetrySession): Span | undefined {
  return resolveOperationParentSpan(session);
}

function resolveOperationParentSpan(session: ObservMeTelemetrySession): Span | undefined {
  if (session.currentTurnId) return session.spans.activeTurns.get(session.currentTurnId) ?? session.sessionSpan;
  if (session.currentAgentRunId) return session.spans.activeAgentRuns.get(session.currentAgentRunId) ?? session.sessionSpan;
  return session.sessionSpan;
}

export function deriveTurnId(agentRunId: string, turnIndex: number): string {
  return `${agentRunId}-turn-${formatSequence(turnIndex)}`;
}

function formatAgentRunId(index: number): string {
  return `agent-run-${formatSequence(index)}`;
}

function formatSequence(index: number): string {
  return String(index).padStart(6, "0");
}

function buildAgentRunAttributes(event: unknown, session: ObservMeTelemetrySession, runId: string): AttributeMap {
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
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_PROMPT_HASH]: prompt ? hashValue(prompt) : undefined,
    [AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_PROMPT_LENGTH]: prompt?.length,
    [AGENT_RUN_ATTRIBUTES.GEN_AI_AGENT_ID]: session.lineage.agentId,
  });
}

function buildTurnAttributes(
  event: unknown,
  session: ObservMeTelemetrySession,
  runId: string,
  turnId: string,
  turnIndex: number,
): AttributeMap {
  const userMessage = readString(event, "userMessage") ?? readString(event, "prompt") ?? readString(event, "message");

  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: runId,
    [TURN_ATTRIBUTES.PI_TURN_ID]: turnId,
    [TURN_ATTRIBUTES.PI_TURN_INDEX]: turnIndex,
    [TURN_ATTRIBUTES.PI_TURN_BRANCH_PATH_HASH]: readString(event, "branchPath") ? hashValue(readString(event, "branchPath")!) : undefined,
    [TURN_ATTRIBUTES.PI_TURN_USER_MESSAGE_HASH]: userMessage ? hashValue(userMessage) : undefined,
    [TURN_ATTRIBUTES.PI_TURN_USER_MESSAGE_LENGTH]: userMessage?.length,
    [TURN_ATTRIBUTES.PI_TURN_USER_MESSAGE_IMAGE_COUNT]: readInteger(event, "imageCount") ?? 0,
    [TURN_ATTRIBUTES.PI_MODEL_PROVIDER_CURRENT]: resolveSessionModelProvider(event, {}, session),
    [TURN_ATTRIBUTES.PI_MODEL_ID_CURRENT]: resolveSessionModelId(event, {}, session),
  });
}

function buildLlmRequestAttributes(
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
    "pi.llm.request.id": requestId,
    [LLM_ATTRIBUTES.GEN_AI_OPERATION_NAME]: readString(payload, "operation") ?? readString(payload, "operationName") ?? "chat",
    [LLM_ATTRIBUTES.GEN_AI_PROVIDER_NAME]: provider,
    [LLM_ATTRIBUTES.GEN_AI_REQUEST_MODEL]: model,
    [LLM_ATTRIBUTES.GEN_AI_CONVERSATION_ID]: resolveCurrentSessionId(session),
    [LLM_ATTRIBUTES.PI_LLM_API]: readString(payload, "api") ?? readString(ctx.model, "api") ?? provider,
    [LLM_ATTRIBUTES.PI_LLM_REQUEST_THINKING_LEVEL]: resolveSessionThinkingLevel(event, ctx, session),
    [LLM_ATTRIBUTES.PI_LLM_REQUEST_MESSAGE_COUNT]: countPayloadItems(payload, ["messages", "contents"]),
    [LLM_ATTRIBUTES.PI_LLM_REQUEST_TOOL_SCHEMA_COUNT]: countPayloadItems(payload, ["tools", "toolSchemas"]),
    [LLM_ATTRIBUTES.PI_LLM_REQUEST_INPUT_CHARS]: safeJsonLength(payload),
    [LLM_ATTRIBUTES.GEN_AI_REQUEST_TEMPERATURE]: readNumber(payload, "temperature"),
    [LLM_ATTRIBUTES.GEN_AI_REQUEST_MAX_TOKENS]: readNumber(payload, "max_tokens") ?? readNumber(payload, "maxTokens"),
  });
}

function buildLlmResponseAttributes(event: unknown): AttributeMap {
  return withoutUndefinedAttributes({
    "http.response.status_code": readInteger(event, "status"),
  });
}

function buildLlmFinalAttributes(message: Record<string, unknown>, session: ObservMeTelemetrySession): AttributeMap {
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
    [LLM_ATTRIBUTES.PI_LLM_ERROR_MESSAGE_HASH]: errorMessage ? hashValue(errorMessage) : undefined,
    [LLM_ATTRIBUTES.PI_LLM_USAGE_TOTAL_TOKENS]: readNumber(usage, "totalTokens"),
    [LLM_ATTRIBUTES.PI_LLM_USAGE_CACHE_WRITE_1H_TOKENS]: readNumber(usage, "cacheWrite1h"),
    [LLM_ATTRIBUTES.PI_LLM_COST_INPUT_USD]: readNumber(cost, "input"),
    [LLM_ATTRIBUTES.PI_LLM_COST_OUTPUT_USD]: readNumber(cost, "output"),
    [LLM_ATTRIBUTES.PI_LLM_COST_CACHE_READ_USD]: readNumber(cost, "cacheRead"),
    [LLM_ATTRIBUTES.PI_LLM_COST_CACHE_WRITE_USD]: readNumber(cost, "cacheWrite"),
    [LLM_ATTRIBUTES.PI_LLM_COST_TOTAL_USD]: readNumber(cost, "total"),
  });
}

function buildToolStartAttributes(event: unknown, session: ObservMeTelemetrySession, toolCallId: string): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    ...buildRequiredToolIdentityAttributes(event, toolCallId),
    ...buildToolArgumentsAttributes(event),
  });
}

function buildToolCallInputAttributes(event: unknown): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildOptionalToolIdentityAttributes(event),
    ...buildToolArgumentsAttributes(event),
  });
}

function buildToolResultAttributes(event: unknown): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildOptionalToolIdentityAttributes(event),
    ...buildToolResultPayloadAttributes(event),
  });
}

function buildToolFinalAttributes(event: unknown): AttributeMap {
  const failed = toolExecutionFailed(event);

  return withoutUndefinedAttributes({
    [TOOL_ATTRIBUTES.PI_TOOL_SUCCESS]: !failed,
    [TOOL_ATTRIBUTES.PI_TOOL_ERROR]: failed,
    [TOOL_ATTRIBUTES.PI_TOOL_ERROR_CLASS]: failed ? toolErrorClass(event) : undefined,
  });
}

function buildRequiredToolIdentityAttributes(event: unknown, toolCallId: string): AttributeMap {
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

function buildOptionalToolIdentityAttributes(event: unknown): AttributeMap {
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

function buildToolArgumentsAttributes(event: unknown): AttributeMap {
  const value = readToolArgumentsText(event);

  return buildToolPayloadAttributes(value, TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_HASH, TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_SIZE);
}

function buildToolResultPayloadAttributes(event: unknown): AttributeMap {
  const value = readToolResultText(event);

  return buildToolPayloadAttributes(value, TOOL_ATTRIBUTES.PI_TOOL_RESULT_HASH, TOOL_ATTRIBUTES.PI_TOOL_RESULT_SIZE);
}

function buildToolPayloadAttributes(value: string | undefined, hashKey: string, sizeKey: string): AttributeMap {
  return withoutUndefinedAttributes({
    [hashKey]: value === undefined ? undefined : hashValue(value),
    [sizeKey]: value?.length,
  });
}

function recordLlmUsageMetrics(
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

function recordLlmSizeMetrics(
  session: ObservMeTelemetrySession,
  message: Record<string, unknown>,
  labels: Record<string, string>,
): void {
  const responseText = extractAssistantText(message);
  if (responseText) session.metrics.responseSizeChars.record(responseText.length, labels);
}

function recordPromptSizeMetric(session: ObservMeTelemetrySession, event: unknown, labels: Record<string, string>): void {
  const payload = readUnknown(event, "payload");
  const promptText = extractPayloadPromptText(payload);
  if (promptText) session.metrics.promptSizeChars.record(promptText.length, labels);
}

function recordOptionalPromptContent(session: ObservMeTelemetrySession, span: Span, event: unknown): void {
  if (!session.config.capture.prompts) return;

  const payload = readUnknown(event, "payload");
  const promptText = extractPayloadPromptText(payload);
  if (!promptText) return;

  recordRedactedSpanContent(session, span, LLM_ATTRIBUTES.PI_LLM_PROMPT_REDACTED, promptText, "prompt");
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.LLM_PROMPT_CAPTURED, buildLineageMetricSafeLogAttributes(session));
}

function recordOptionalLlmContent(session: ObservMeTelemetrySession, span: Span | undefined, message: Record<string, unknown>): void {
  if (!span) return;

  if (session.config.capture.responses) {
    const responseText = extractAssistantText(message);
    if (responseText) {
      recordRedactedSpanContent(session, span, LLM_ATTRIBUTES.PI_LLM_RESPONSE_REDACTED, responseText, "response");
      emitLifecycleLog(session.logger, LOG_EVENT_NAMES.LLM_RESPONSE_CAPTURED, buildLineageMetricSafeLogAttributes(session));
    }
  }

  if (session.config.capture.thinking) {
    const thinkingText = extractAssistantThinking(message);
    if (thinkingText) {
      recordRedactedSpanContent(session, span, LLM_ATTRIBUTES.PI_LLM_THINKING_REDACTED, thinkingText, "response");
      emitLifecycleLog(session.logger, LOG_EVENT_NAMES.LLM_THINKING_CAPTURED, buildLineageMetricSafeLogAttributes(session));
    }
  }
}

function recordOptionalToolArguments(session: ObservMeTelemetrySession, span: Span, event: unknown): void {
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

function recordOptionalToolResult(session: ObservMeTelemetrySession, span: Span, event: unknown): void {
  if (!session.config.capture.toolResults) return;

  const value = readToolResultText(event);
  if (value === undefined) return;

  recordRedactedToolContent(
    session,
    span,
    TOOL_ATTRIBUTES.PI_TOOL_RESULT_REDACTED,
    TOOL_ATTRIBUTES.GEN_AI_TOOL_CALL_RESULT,
    value,
    "toolResult",
  );
}

function recordOptionalBashContent(session: ObservMeTelemetrySession, span: Span, event: unknown): void {
  if (session.config.capture.bashCommands) {
    const command = readBashCommand(event);
    if (command !== undefined) recordRedactedBashContent(session, span, BASH_ATTRIBUTES.PI_BASH_COMMAND_REDACTED, command, "command");
  }

  if (session.config.capture.bashOutput) {
    const output = readBashOutput(event);
    if (output !== undefined) recordRedactedBashContent(session, span, BASH_ATTRIBUTES.PI_BASH_OUTPUT_REDACTED, output, "output");
  }
}

function recordRedactedBashContent(
  session: ObservMeTelemetrySession,
  span: Span,
  attributeKey: string,
  value: string,
  kind: "command" | "output",
): void {
  const result = redactValue(value, {
    pathMode: session.config.privacy.pathMode,
    customRedactionPatterns: session.config.privacy.customRedactionPatterns,
    maxOutputChars: kind === "output" ? session.config.limits.maxBashOutputChars : session.config.limits.maxLogBodyChars,
  });

  if (result.dropped || result.value === undefined) {
    session.metrics.redactionFailures.add(result.failureMetrics.redactionFailures || 1, { operation: "bash_content_capture" });
    return;
  }

  span.setAttribute(attributeKey, result.value);
  if (result.truncated) span.setAttributes(buildBashCaptureTruncationAttributes(kind, result.originalLength ?? value.length));
}

function buildBashCaptureTruncationAttributes(kind: "command" | "output", originalLength: number): AttributeMap {
  return withoutUndefinedAttributes({
    [BASH_ATTRIBUTES.PI_BASH_TRUNCATED]: kind === "output" ? true : undefined,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED]: true,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH]: originalLength,
  });
}

function recordRedactedToolContent(
  session: ObservMeTelemetrySession,
  span: Span,
  attributeKey: string,
  aliasAttributeKey: string,
  value: string,
  kind: "toolArgument" | "toolResult",
): void {
  const result = redactValue(value, {
    pathMode: session.config.privacy.pathMode,
    customRedactionPatterns: session.config.privacy.customRedactionPatterns,
    maxOutputChars: kind === "toolArgument" ? session.config.limits.maxToolArgumentChars : session.config.limits.maxToolResultChars,
  });

  if (result.dropped || result.value === undefined) {
    session.metrics.redactionFailures.add(result.failureMetrics.redactionFailures || 1, { operation: "tool_content_capture" });
    return;
  }

  span.setAttribute(attributeKey, result.value);
  span.setAttribute(aliasAttributeKey, result.value);
  if (result.truncated) span.setAttributes({ [COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED]: true, [COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH]: result.originalLength ?? value.length });
}

function recordRedactedSpanContent(
  session: ObservMeTelemetrySession,
  span: Span,
  attributeKey: string,
  value: string,
  kind: "prompt" | "response",
): void {
  const result = redactValue(value, {
    pathMode: session.config.privacy.pathMode,
    customRedactionPatterns: session.config.privacy.customRedactionPatterns,
    maxOutputChars: kind === "prompt" ? session.config.limits.maxPromptChars : session.config.limits.maxResponseChars,
  });

  if (result.dropped || result.value === undefined) {
    session.metrics.redactionFailures.add(result.failureMetrics.redactionFailures || 1, { operation: "llm_content_capture" });
    return;
  }

  span.setAttribute(attributeKey, result.value);
  if (result.truncated) span.setAttributes({ [COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED]: true, [COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH]: result.originalLength ?? value.length });
}

function addCounterIfPresent(counter: Counter, value: number | undefined, labels: Record<string, string>): void {
  if (value === undefined || value <= 0) return;
  counter.add(value, labels);
}

function readSpanTraceId(span: Span | undefined): string | undefined {
  const traceId = span?.spanContext?.().traceId;
  return typeof traceId === "string" ? traceId : undefined;
}

const spanStartTimesMs = new WeakMap<Span, number>();

function startChildSpan(tracer: Tracer, name: string, parent: Span | undefined, attributes: AttributeMap): Span {
  const parentContext = parent ? trace.setSpan(otelContext.active(), parent) : otelContext.active();
  const span = tracer.startSpan(name, { attributes }, parentContext);
  spanStartTimesMs.set(span, Date.now());
  return span;
}

function recordSpanDurationMs(span: Span | undefined, histogram: Histogram, labels: Record<string, string>): void {
  if (!span) return;

  const startTimeMs = spanStartTimesMs.get(span);
  if (startTimeMs === undefined) return;

  histogram.record(Math.max(0, Date.now() - startTimeMs), labels);
  spanStartTimesMs.delete(span);
}

function evictSpan(span: Span, metrics: ObservMeMetrics): void {
  span.setAttribute(COMMON_SPAN_ATTRIBUTES.OBSERVME_EVICTED, true);
  span.setStatus({ code: SpanStatusCode.ERROR, message: "span_registry_full" });
  span.end();
  metrics.telemetryDropped.add(1, { reason: "span_registry_full" });
  recordObsStatusQueueDrop();
}

function evictToolCallState(state: ToolCallState, metrics: ObservMeMetrics): void {
  evictSpan(state.span, metrics);
}

function evictSubagentSpawnState(state: SubagentSpawnState, metrics: ObservMeMetrics): void {
  evictSpan(state.span, metrics);
}

function evictWaitJoinState(state: AgentWaitJoinState, metrics: ObservMeMetrics): void {
  evictSpan(state.span, metrics);
}

function endAllActiveSpans(session: ObservMeTelemetrySession): void {
  for (const state of session.spans.activeAgentJoins.values()) state.span.end();
  for (const state of session.spans.activeAgentWaits.values()) state.span.end();
  for (const state of session.spans.activeSubagentSpawns.values()) state.span.end();
  for (const span of session.spans.activeLlmRequests.values()) span.end();
  for (const state of session.spans.activeToolCalls.values()) state.span.end();
  for (const span of session.spans.activeTurns.values()) span.end();
  for (const span of session.spans.activeAgentRuns.values()) span.end();
  session.spans.activeAgentJoins.clear();
  session.spans.activeAgentWaits.clear();
  session.spans.activeSubagentSpawns.clear();
  session.spans.activeLlmRequests.clear();
  session.spans.activeToolCalls.clear();
  session.spans.activeTurns.clear();
  session.spans.activeAgentRuns.clear();
}

function resolveCurrentSessionId(session: ObservMeTelemetrySession): string {
  return readString(session.sessionAttributes, sessionAttributeKeys.SESSION_ID) ?? `session-${session.lineage.workflowId}`;
}

function buildLineageMetricSafeLogAttributes(session: ObservMeTelemetrySession): AttributeMap {
  return {
    [LOG_ATTRIBUTES.PI_SESSION_ID]: resolveCurrentSessionId(session),
    [LOG_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [LOG_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID]: session.lineage.workflowRootAgentId,
    [LOG_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [LOG_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
  };
}

function buildModelChangeAttributes(event: unknown, ctx: ObservMeHandlerContext, session: ObservMeTelemetrySession): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildLineageMetricSafeLogAttributes(session),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_ID]: readChangeEntryId(event, "model_change"),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_PARENT_ID]: readChangeEntryParentId(event, "model_change"),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_TYPE]: readChangeEntryType(event, "model_change"),
    [sessionAttributeKeys.MODEL_PROVIDER_CURRENT]: resolveSessionModelProvider(event, ctx, session),
    [sessionAttributeKeys.MODEL_ID_CURRENT]: resolveSessionModelId(event, ctx, session),
  });
}

function buildThinkingLevelChangeAttributes(event: unknown, ctx: ObservMeHandlerContext, session: ObservMeTelemetrySession): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildLineageMetricSafeLogAttributes(session),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_ID]: readChangeEntryId(event, "thinking_level_change"),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_PARENT_ID]: readChangeEntryParentId(event, "thinking_level_change"),
    [COMMON_SPAN_ATTRIBUTES.PI_ENTRY_TYPE]: readChangeEntryType(event, "thinking_level_change"),
    [sessionAttributeKeys.THINKING_LEVEL_CURRENT]: resolveSessionThinkingLevel(event, ctx, session),
  });
}

function buildBranchPreparationState(event: unknown): BranchPreparationState {
  const preparation = readBranchPreparation(event);

  return {
    targetId: readBranchTargetId(preparation),
    oldLeafId: readBranchOldLeafId(preparation),
    commonAncestorId: readBranchCommonAncestorIdFromValue(preparation),
    pathHash: readBranchPathHashFromValue(preparation),
  };
}

function buildBranchAttributes(event: unknown, session: ObservMeTelemetrySession): AttributeMap {
  const summaryEntry = readBranchSummaryEntry(event);
  const summary = readBranchSummary(summaryEntry, event);
  const fromId = readBranchFromId(event, summaryEntry, session.currentBranchPreparation);
  const toId = readBranchToId(event, summaryEntry, session.currentBranchPreparation);
  const leafId = readBranchLeafId(event, summaryEntry, toId);
  const commonAncestorId = readBranchCommonAncestorId(event, session.currentBranchPreparation);
  const pathHash = readBranchPathHash(event, session.currentBranchPreparation, fromId, toId, leafId, commonAncestorId);
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
    [BRANCH_ATTRIBUTES.PI_BRANCH_SUMMARY_HASH]: summary ? hashValue(summary) : undefined,
    [BRANCH_ATTRIBUTES.PI_BRANCH_SUMMARY_LENGTH]: summary?.length,
    [BRANCH_ATTRIBUTES.PI_BRANCH_FROM_HOOK]: readBranchFromHook(summaryEntry, event),
    [BRANCH_ATTRIBUTES.PI_BRANCH_READ_FILES_COUNT]: readBranchFileCount(summaryEntry ?? event, "read"),
    [BRANCH_ATTRIBUTES.PI_BRANCH_MODIFIED_FILES_COUNT]: readBranchFileCount(summaryEntry ?? event, "modified"),
  });
}

function readBranchPreparation(event: unknown): unknown {
  return readUnknown(event, "preparation") ?? event;
}

function readBranchSummaryEntry(event: unknown): unknown {
  const explicitEntry = readUnknown(event, "summaryEntry") ?? readUnknown(event, "summary_entry");
  if (explicitEntry !== undefined) return explicitEntry;

  const entry = readUnknown(event, "entry");
  if (readString(entry, "type") === "branch_summary") return entry;
  return undefined;
}

function readBranchSummary(summaryEntry: unknown, event: unknown): string | undefined {
  return readString(summaryEntry, "summary") ?? readString(event, "summary");
}

function readBranchFromId(event: unknown, summaryEntry: unknown, preparation: BranchPreparationState | undefined): string | undefined {
  return (
    readTreeId(event, "fromId") ??
    readTreeId(event, "from_id") ??
    readBranchOldLeafId(event) ??
    preparation?.oldLeafId ??
    readTreeId(summaryEntry, "fromId") ??
    readTreeId(summaryEntry, "from_id")
  );
}

function readBranchToId(event: unknown, summaryEntry: unknown, preparation: BranchPreparationState | undefined): string | undefined {
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

function readBranchLeafId(event: unknown, summaryEntry: unknown, fallbackToId: string | undefined): string | undefined {
  return readTreeId(event, "leafId") ?? readTreeId(event, "leaf_id") ?? readBranchNewLeafId(event) ?? readTreeId(summaryEntry, "id") ?? fallbackToId;
}

function readBranchTargetId(value: unknown): string | undefined {
  return readTreeId(value, "targetId") ?? readTreeId(value, "target_id");
}

function readBranchOldLeafId(value: unknown): string | undefined {
  return readTreeId(value, "oldLeafId") ?? readTreeId(value, "old_leaf_id");
}

function readBranchNewLeafId(value: unknown): string | undefined {
  return readTreeId(value, "newLeafId") ?? readTreeId(value, "new_leaf_id");
}

function readBranchCommonAncestorId(event: unknown, preparation: BranchPreparationState | undefined): string | undefined {
  return readBranchCommonAncestorIdFromValue(event) ?? readBranchCommonAncestorIdFromValue(readBranchPreparation(event)) ?? preparation?.commonAncestorId;
}

function readBranchCommonAncestorIdFromValue(value: unknown): string | undefined {
  return readString(value, "commonAncestorId") ?? readString(value, "common_ancestor_id");
}

function readBranchEntryParentId(entry: unknown, event: unknown): string | undefined {
  return readTreeId(entry, "parentId") ?? readTreeId(entry, "parent_id") ?? readTreeId(event, "parentId") ?? readTreeId(event, "parent_id");
}

function readBranchPathHash(
  event: unknown,
  preparation: BranchPreparationState | undefined,
  fromId: string | undefined,
  toId: string | undefined,
  leafId: string | undefined,
  commonAncestorId: string | undefined,
): string | undefined {
  const pathHash = readBranchPathHashFromValue(event) ?? readBranchPathHashFromValue(readBranchPreparation(event)) ?? preparation?.pathHash;
  if (pathHash !== undefined) return pathHash;

  return hashBranchIds([fromId, toId, leafId, commonAncestorId]);
}

function readBranchPathHashFromValue(value: unknown): string | undefined {
  const explicitHash = readString(value, "pathHash") ?? readString(value, "path_hash") ?? readString(value, "branchPathHash") ?? readString(value, "branch_path_hash");
  if (explicitHash !== undefined) return normalizeBranchPathHash(explicitHash);

  const pathText = readBranchPathText(value);
  return pathText === undefined ? undefined : hashValue(pathText);
}

function normalizeBranchPathHash(value: string): string {
  return /^[a-f0-9]{64}$/u.test(value) ? value : hashValue(value);
}

function readBranchPathText(value: unknown): string | undefined {
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

function serializeBranchPath(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!Array.isArray(value)) return undefined;

  const ids = value.map(branchPathItemId).filter((item): item is string => item !== undefined);
  return ids.length > 0 ? ids.join("->") : undefined;
}

function branchPathItemId(item: unknown): string | undefined {
  if (typeof item === "string" && item.length > 0) return item;
  return readTreeId(item, "id");
}

function hashBranchIds(ids: Array<string | undefined>): string | undefined {
  const presentIds = ids.filter((id): id is string => id !== undefined);
  return presentIds.length === 0 ? undefined : hashValue(presentIds.join("->"));
}

function readBranchFromHook(summaryEntry: unknown, event: unknown): boolean | undefined {
  return (
    readBoolean(summaryEntry, "fromHook") ??
    readBoolean(summaryEntry, "from_hook") ??
    readBoolean(event, "fromExtension") ??
    readBoolean(event, "from_extension") ??
    readBoolean(event, "fromHook") ??
    readBoolean(event, "from_hook")
  );
}

function readBranchFileCount(source: unknown, kind: "modified" | "read"): number | undefined {
  const directCount = readInteger(source, `${kind}FilesCount`) ?? readInteger(source, `${kind}_files_count`);
  if (directCount !== undefined) return directCount;

  const details = readUnknown(source, "details");
  const camelCaseKey = kind === "read" ? "readFiles" : "modifiedFiles";
  const snakeCaseKey = kind === "read" ? "read_files" : "modified_files";
  return readArray(details, camelCaseKey)?.length ?? readArray(details, snakeCaseKey)?.length;
}

function buildCompactionAttributes(event: unknown, session: ObservMeTelemetrySession): AttributeMap {
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
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_SUMMARY_HASH]: summary ? hashValue(summary) : undefined,
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_SUMMARY_LENGTH]: summary?.length,
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_FROM_HOOK]: readCompactionFromHook(entry, event),
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_REASON]: readCompactionReason(entry, event),
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_WILL_RETRY]: readCompactionWillRetry(entry, event),
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_READ_FILES_COUNT]: readCompactionFileCount(entry, "read"),
    [COMPACTION_ATTRIBUTES.PI_COMPACTION_MODIFIED_FILES_COUNT]: readCompactionFileCount(entry, "modified"),
  });
}

function readCompactionEntry(event: unknown): unknown {
  const explicitEntry = readUnknown(event, "compactionEntry") ?? readUnknown(event, "compaction_entry");
  if (explicitEntry !== undefined) return explicitEntry;

  const entry = readUnknown(event, "entry");
  if (readString(entry, "type") === "compaction") return entry;
  return event;
}

function readCompactionSummary(entry: unknown, event: unknown): string | undefined {
  return readString(entry, "summary") ?? readString(event, "summary");
}

function readCompactionFirstKeptEntryId(entry: unknown, event: unknown): string | undefined {
  return (
    readString(entry, "firstKeptEntryId") ??
    readString(entry, "first_kept_entry_id") ??
    readString(entry, "firstKeptId") ??
    readString(entry, "first_kept_id") ??
    readString(event, "firstKeptEntryId") ??
    readString(event, "first_kept_entry_id")
  );
}

function readCompactionTokensBefore(entry: unknown, event: unknown): number | undefined {
  return readInteger(entry, "tokensBefore") ?? readInteger(entry, "tokens_before") ?? readInteger(event, "tokensBefore") ?? readInteger(event, "tokens_before");
}

function readCompactionFromHook(entry: unknown, event: unknown): boolean | undefined {
  return (
    readBoolean(entry, "fromHook") ??
    readBoolean(entry, "from_hook") ??
    readBoolean(event, "fromHook") ??
    readBoolean(event, "from_hook") ??
    readBoolean(event, "fromExtension") ??
    readBoolean(event, "summaryFromExtension")
  );
}

function readCompactionReason(entry: unknown, event: unknown): string | undefined {
  return readString(event, "reason") ?? readString(entry, "reason");
}

function readCompactionWillRetry(entry: unknown, event: unknown): boolean | undefined {
  return readBoolean(event, "willRetry") ?? readBoolean(event, "will_retry") ?? readBoolean(entry, "willRetry") ?? readBoolean(entry, "will_retry");
}

function readCompactionFileCount(entry: unknown, kind: "modified" | "read"): number | undefined {
  const directCount = readInteger(entry, `${kind}FilesCount`) ?? readInteger(entry, `${kind}_files_count`);
  if (directCount !== undefined) return directCount;

  const details = readUnknown(entry, "details");
  const camelCaseKey = kind === "read" ? "readFiles" : "modifiedFiles";
  const snakeCaseKey = kind === "read" ? "read_files" : "modified_files";
  return readArray(details, camelCaseKey)?.length ?? readArray(details, snakeCaseKey)?.length;
}

function updateCurrentSessionAttributes(
  session: ObservMeTelemetrySession,
  attributes: AttributeMap,
  keys: readonly string[],
): void {
  const currentAttributes = session.sessionAttributes ?? {};
  const updates = Object.fromEntries(keys.map(key => [key, attributes[key]]).filter((entry): entry is [string, AttributePrimitive] => entry[1] !== undefined));

  session.sessionAttributes = { ...currentAttributes, ...updates };
  session.sessionSpan?.setAttributes(updates);
}

function modelChangeMetricLabels(session: ObservMeTelemetrySession, attributes: AttributeMap): Record<string, string> {
  return {
    ...metricLabels(session.config, session.lineage),
    provider: String(attributes[sessionAttributeKeys.MODEL_PROVIDER_CURRENT] ?? "unknown"),
    model: String(attributes[sessionAttributeKeys.MODEL_ID_CURRENT] ?? "unknown"),
  };
}

function thinkingLevelChangeMetricLabels(session: ObservMeTelemetrySession): Record<string, string> {
  return metricLabels(session.config, session.lineage);
}

function buildCommonSessionSpanAttributes(
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

function metricLabels(config: ObservMeConfig, lineage: AgentLineageContext): Record<string, string> {
  return {
    environment: config.environment,
    agent_role: lineage.role,
  };
}

function llmMetricLabels(session: ObservMeTelemetrySession, attributes: AttributeMap): Record<string, string> {
  return {
    ...metricLabels(session.config, session.lineage),
    provider: String(attributes[LLM_ATTRIBUTES.GEN_AI_PROVIDER_NAME] ?? "unknown"),
    model: String(attributes[LLM_ATTRIBUTES.GEN_AI_REQUEST_MODEL] ?? attributes[LLM_ATTRIBUTES.GEN_AI_RESPONSE_MODEL] ?? "unknown"),
  };
}

function toolMetricLabels(attributes: AttributeMap): Record<string, string> {
  return {
    tool_name: String(attributes[TOOL_ATTRIBUTES.PI_TOOL_NAME] ?? "unknown"),
    tool_category: String(attributes[TOOL_ATTRIBUTES.PI_TOOL_CATEGORY] ?? "unknown"),
  };
}

function mergeToolStateLabels(state: ToolCallState, attributes: AttributeMap): void {
  state.labels = {
    ...state.labels,
    ...toolMetricLabelUpdates(attributes),
  };
}

function toolMetricLabelUpdates(attributes: AttributeMap): Record<string, string> {
  const updates: Record<string, string> = {};
  const toolName = readString(attributes, TOOL_ATTRIBUTES.PI_TOOL_NAME);
  const toolCategory = readString(attributes, TOOL_ATTRIBUTES.PI_TOOL_CATEGORY);

  if (toolName) updates.tool_name = toolName;
  if (toolCategory) updates.tool_category = toolCategory;

  return updates;
}

function buildBashExecutionAttributes(event: unknown, session: ObservMeTelemetrySession): AttributeMap {
  const command = readBashCommand(event);
  const output = readBashOutput(event);

  return withoutUndefinedAttributes({
    ...buildCommonSessionSpanAttributes(resolveCurrentSessionId(session), session.config, session.lineage),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
    [LOG_ATTRIBUTES.PI_TURN_ID]: session.currentTurnId,
    [BASH_ATTRIBUTES.PI_BASH_COMMAND_HASH]: command === undefined ? undefined : hashValue(command),
    [BASH_ATTRIBUTES.PI_BASH_EXIT_CODE]: readBashExitCode(event),
    [BASH_ATTRIBUTES.PI_BASH_CANCELLED]: readBashCancelled(event) ?? false,
    [BASH_ATTRIBUTES.PI_BASH_TRUNCATED]: readBashTruncated(event) ?? false,
    [BASH_ATTRIBUTES.PI_BASH_OUTPUT_SIZE]: output === undefined ? undefined : output.length,
    [BASH_ATTRIBUTES.PI_BASH_OUTPUT_HASH]: output === undefined ? undefined : hashValue(output),
    [BASH_ATTRIBUTES.PI_BASH_FULL_OUTPUT_PATH_PRESENT]: readBashFullOutputPathPresent(event),
    [BASH_ATTRIBUTES.PI_BASH_EXCLUDE_FROM_CONTEXT]: readBashExcludeFromContext(event) ?? false,
  });
}

function bashExecutionMetricLabels(
  session: ObservMeTelemetrySession,
  event: unknown,
  failed: boolean,
): Record<string, string> {
  return {
    ...metricLabels(session.config, session.lineage),
    status: bashStatusLabel(event, failed),
  };
}

function bashFailureMetricLabels(session: ObservMeTelemetrySession, event: unknown): Record<string, string> {
  return {
    ...bashExecutionMetricLabels(session, event, true),
    error_class: bashErrorClass(event),
  };
}

function bashStatusLabel(event: unknown, failed: boolean): string {
  if (readBashCancelled(event)) return "cancelled";
  if (normalizedStatus(readString(event, "status")) === "timeout") return "timeout";
  return failed ? "error" : "ok";
}

function readBashPayload(event: unknown): unknown {
  const message = readMessage(event);
  if (isBashExecutionMessage(message)) return message;

  const bashExecution = readUnknown(event, "bashExecution") ?? readUnknown(event, "bash_execution");
  if (isRecord(bashExecution)) return bashExecution;

  const entryMessage = readUnknown(readUnknown(event, "entry"), "message");
  if (isBashExecutionMessage(entryMessage)) return entryMessage;

  return event;
}

function isBashExecutionMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && readString(value, "role") === "bashExecution";
}

function readBashCommand(event: unknown): string | undefined {
  const payload = readBashPayload(event);
  return readOptionalString(payload, "command") ?? readOptionalString(payload, "cmd") ?? readOptionalString(payload, "input");
}

function readBashOutput(event: unknown): string | undefined {
  const payload = readBashPayload(event);
  const directOutput = readOptionalString(payload, "output") ?? readOptionalString(payload, "content");
  if (directOutput !== undefined) return directOutput;

  return combineBashStreams(readOptionalString(payload, "stdout"), readOptionalString(payload, "stderr"));
}

function combineBashStreams(stdout: string | undefined, stderr: string | undefined): string | undefined {
  if (stdout === undefined) return stderr;
  if (stderr === undefined) return stdout;
  if (stdout.length === 0) return stderr;
  if (stderr.length === 0) return stdout;
  return `${stdout}\n${stderr}`;
}

function readBashExitCode(event: unknown): number | undefined {
  const payload = readBashPayload(event);
  const result = readUnknown(payload, "result");
  return readInteger(payload, "exitCode") ?? readInteger(payload, "exit_code") ?? readInteger(result, "exitCode") ?? readInteger(result, "exit_code");
}

function readBashCancelled(event: unknown): boolean | undefined {
  const payload = readBashPayload(event);
  const explicit = readBoolean(payload, "cancelled") ?? readBoolean(payload, "canceled") ?? readBoolean(payload, "isCancelled");
  if (explicit !== undefined) return explicit;

  const status = normalizedStatus(readString(payload, "status"));
  return status === "cancelled" || status === "canceled" ? true : undefined;
}

function readBashTruncated(event: unknown): boolean | undefined {
  const payload = readBashPayload(event);
  return readBoolean(payload, "truncated") ?? readBoolean(payload, "outputTruncated") ?? readBoolean(payload, "output_truncated");
}

function readBashFullOutputPathPresent(event: unknown): boolean {
  const payload = readBashPayload(event);
  const explicit = readBoolean(payload, "fullOutputPathPresent") ?? readBoolean(payload, "full_output_path_present");
  if (explicit !== undefined) return explicit;

  return readOptionalString(payload, "fullOutputPath") !== undefined || readOptionalString(payload, "full_output_path") !== undefined;
}

function readBashExcludeFromContext(event: unknown): boolean | undefined {
  const payload = readBashPayload(event);
  return readBoolean(payload, "excludeFromContext") ?? readBoolean(payload, "exclude_from_context");
}

function bashExecutionFailed(event: unknown): boolean {
  if (readBashCancelled(event)) return true;
  if (bashExitCodeIndicatesFailure(event)) return true;

  const payload = readBashPayload(event);
  return readBoolean(payload, "failed") === true || statusIndicatesToolFailure(readString(payload, "status"));
}

function bashErrorClass(event: unknown): string {
  const payload = readBashPayload(event);
  const explicit = readString(payload, "errorClass") ?? readString(payload, "error_class");
  if (explicit) return normalizeErrorClass(explicit);
  if (readBashCancelled(payload)) return "cancelled";
  if (bashExitCodeIndicatesFailure(payload)) return "non_zero_exit";
  if (normalizedStatus(readString(payload, "status")) === "timeout") return "timeout";
  return "bash_error";
}

function bashExitCodeIndicatesFailure(event: unknown): boolean {
  const exitCode = readBashExitCode(event);
  return exitCode !== undefined && exitCode !== 0;
}

function normalizedStatus(status: string | undefined): string | undefined {
  return status?.trim().toLowerCase();
}

function readToolCallId(event: unknown): string | undefined {
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

function readToolName(event: unknown): string | undefined {
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

function readToolCategory(event: unknown): string | undefined {
  return normalizeToolCategory(readString(event, "toolCategory") ?? readString(event, "tool_category") ?? readString(event, "category"));
}

function safeToolName(rawName: string | undefined): string {
  if (!rawName) return "unknown";

  const normalizedName = rawName.trim().toLowerCase();
  if (/^[a-z][a-z0-9_.:-]{0,63}$/u.test(normalizedName)) return normalizedName;
  return "custom";
}

function resolveToolCategory(event: unknown, toolName: string): string {
  const explicitCategory = readToolCategory(event);
  if (explicitCategory) return explicitCategory;
  if (isShellToolName(toolName)) return "shell";
  if (isFilesystemToolName(toolName)) return "filesystem";
  if (isNetworkToolName(toolName)) return "network";
  if (toolName === "unknown") return "unknown";
  return "custom";
}

function normalizeToolCategory(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim().toLowerCase();
  if (normalizedValue === "shell" || normalizedValue === "filesystem" || normalizedValue === "network" || normalizedValue === "custom" || normalizedValue === "unknown") return normalizedValue;
  return undefined;
}

function isShellToolName(toolName: string): boolean {
  return toolName === "bash" || toolName === "shell" || toolName === "user_bash" || toolName.includes("bash");
}

function isFilesystemToolName(toolName: string): boolean {
  return /^(read|write|edit|ls|grep|rg|find|glob|file|filesystem|path)([_.:-]|$)/u.test(toolName);
}

function isNetworkToolName(toolName: string): boolean {
  return /^(aws|http|fetch|curl|web|network)([_.:-]|$)/u.test(toolName);
}

function mapToolType(category: string): string {
  if (category === "filesystem" || category === "network") return "extension";
  return "function";
}

function readToolArgumentsText(event: unknown): string | undefined {
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

function readToolResultText(event: unknown): string | undefined {
  const value = readUnknown(event, "result") ?? readUnknown(event, "output") ?? readUnknown(event, "response") ?? readUnknown(event, "content");

  return serializeToolPayload(value);
}

function serializeToolPayload(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.name;

  try {
    return JSON.stringify(value) ?? String(value);
  } catch (_error) {
    return String(value);
  }
}

function toolExecutionFailed(event: unknown): boolean {
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

function statusIndicatesToolFailure(status: string | undefined): boolean {
  const normalizedValue = normalizedStatus(status);
  return normalizedValue === "error" || normalizedValue === "failed" || normalizedValue === "failure" || normalizedValue === "timeout" || normalizedValue === "cancelled" || normalizedValue === "canceled";
}

function exitCodeIndicatesFailure(event: unknown): boolean {
  const exitCode = readInteger(event, "exitCode") ?? readInteger(event, "exit_code");
  return exitCode !== undefined && exitCode !== 0;
}

function toolErrorClass(event: unknown): string {
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

function normalizeErrorClass(value: string): string {
  const trimmedValue = value.trim();
  if (/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(trimmedValue)) return trimmedValue;
  return "tool_error";
}

function readMessage(event: unknown): unknown {
  return readUnknown(event, "message") ?? event;
}

function isAssistantMessage(message: unknown): message is Record<string, unknown> {
  return isRecord(message) && readString(message, "role") === "assistant";
}

function isLlmError(message: Record<string, unknown>): boolean {
  return readString(message, "stopReason") === "error" || Boolean(readString(message, "errorMessage"));
}

function readUsage(message: Record<string, unknown>): Record<string, unknown> {
  const usage = readUnknown(message, "usage");
  return isRecord(usage) ? usage : {};
}

function readCost(usage: Record<string, unknown>): Record<string, unknown> {
  const cost = readUnknown(usage, "cost");
  return isRecord(cost) ? cost : {};
}

function mapStopReason(stopReason: string): string {
  if (stopReason === "toolUse") return "tool_calls";
  if (stopReason === "length") return "length";
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "cancelled";
  return "stop";
}

function countPayloadItems(payload: unknown, keys: readonly string[]): number | undefined {
  const counts = keys.map(key => readArray(payload, key)?.length).filter((value): value is number => value !== undefined);
  if (counts.length === 0) return undefined;
  return counts.reduce((total, value) => total + value, 0);
}

function safeJsonLength(value: unknown): number | undefined {
  if (value === undefined) return undefined;

  try {
    return JSON.stringify(value)?.length;
  } catch (_error) {
    return undefined;
  }
}

function extractPayloadPromptText(payload: unknown): string | undefined {
  const messages = readArray(payload, "messages") ?? readArray(payload, "contents");
  if (!messages) return undefined;

  const text = messages.flatMap(extractContentText).join("\n").trim();
  return text.length === 0 ? undefined : text;
}

function extractAssistantText(message: Record<string, unknown>): string | undefined {
  const content = readUnknown(message, "content");
  const text = extractContentText(content).join("\n").trim();
  return text.length === 0 ? undefined : text;
}

function extractAssistantThinking(message: Record<string, unknown>): string | undefined {
  const content = readArray(message, "content") ?? [];
  const thinking = content.map(extractThinkingText).filter((value): value is string => value !== undefined).join("\n").trim();
  return thinking.length === 0 ? undefined : thinking;
}

function extractContentText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractContentText);
  if (!isRecord(value)) return [];

  const directText = readString(value, "text");
  if (directText) return [directText];

  return extractContentText(readUnknown(value, "content"));
}

function extractThinkingText(value: unknown): string | undefined {
  if (!isRecord(value) || readString(value, "type") !== "thinking") return undefined;
  return readString(value, "thinking");
}

function resolveSessionFilePath(event: unknown, ctx: ObservMeHandlerContext): string | undefined {
  return readString(event, "sessionFile") ?? readString(event, "session_file") ?? readString(ctx, "sessionFile") ?? readString(ctx, "session_file");
}

function resolveSessionId(event: unknown, ctx: ObservMeHandlerContext, lineage: AgentLineageContext): string {
  return (
    readString(event, "sessionId") ??
    readString(event, "session_id") ??
    readString(event, "id") ??
    readString(ctx, "sessionId") ??
    readString(ctx, "session_id") ??
    `session-${lineage.workflowId}`
  );
}

function resolveModelProvider(event: unknown, ctx: ObservMeHandlerContext): string {
  return readModelProvider(event, ctx) ?? "unknown";
}

function resolveModelId(event: unknown, ctx: ObservMeHandlerContext): string {
  return readModelId(event, ctx) ?? "unknown";
}

function resolveThinkingLevel(event: unknown, ctx: ObservMeHandlerContext): string {
  return readThinkingLevel(event, ctx) ?? "unknown";
}

function resolveSessionModelProvider(
  event: unknown,
  ctx: ObservMeHandlerContext,
  session: ObservMeTelemetrySession,
): string {
  return readModelProvider(event, ctx) ?? readString(session.sessionAttributes, sessionAttributeKeys.MODEL_PROVIDER_CURRENT) ?? "unknown";
}

function resolveSessionModelId(event: unknown, ctx: ObservMeHandlerContext, session: ObservMeTelemetrySession): string {
  return readModelId(event, ctx) ?? readString(session.sessionAttributes, sessionAttributeKeys.MODEL_ID_CURRENT) ?? "unknown";
}

function resolveSessionThinkingLevel(
  event: unknown,
  ctx: ObservMeHandlerContext,
  session: ObservMeTelemetrySession,
): string {
  return readThinkingLevel(event, ctx) ?? readString(session.sessionAttributes, sessionAttributeKeys.THINKING_LEVEL_CURRENT) ?? "unknown";
}

function readModelProvider(event: unknown, ctx: ObservMeHandlerContext): string | undefined {
  const payload = readChangePayload(event, "model_change");
  const selectedModel = readModelObject(payload);

  return (
    readString(payload, "provider") ??
    readString(payload, "modelProvider") ??
    readString(payload, "model_provider") ??
    readString(selectedModel, "provider") ??
    readString(selectedModel, "modelProvider") ??
    readString(ctx.model, "provider") ??
    readString(ctx, "modelProvider") ??
    readString(ctx, "model_provider")
  );
}

function readModelId(event: unknown, ctx: ObservMeHandlerContext): string | undefined {
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
    readString(ctx.model, "id") ??
    readString(ctx.model, "model") ??
    readString(ctx, "modelId") ??
    readString(ctx, "model_id")
  );
}

function readThinkingLevel(event: unknown, ctx: ObservMeHandlerContext): string | undefined {
  const payload = readChangePayload(event, "thinking_level_change");
  const selectedThinking = readUnknown(payload, "thinking") ?? readUnknown(payload, "selection");

  return (
    readString(payload, "thinkingLevel") ??
    readString(payload, "thinking_level") ??
    readString(payload, "level") ??
    readString(payload, "selection") ??
    readString(selectedThinking, "level") ??
    readString(ctx.thinking, "level") ??
    readString(ctx, "thinkingLevel") ??
    readString(ctx, "thinking_level")
  );
}

function readModelObject(value: unknown): unknown {
  const selectedModel = readUnknown(value, "selectedModel") ?? readUnknown(value, "selection") ?? readUnknown(value, "model");
  return typeof selectedModel === "string" ? undefined : selectedModel;
}

function readModelIdFromObject(value: unknown): string | undefined {
  return readString(value, "id") ?? readString(value, "model") ?? readString(value, "modelId") ?? readString(value, "name");
}

function readChangePayload(event: unknown, entryType: string): unknown {
  const entry = readUnknown(event, "entry");
  if (readString(entry, "type") === entryType) return entry;
  return event;
}

function readChangeEntryId(event: unknown, entryType: string): string | undefined {
  return readString(readChangePayload(event, entryType), "id");
}

function readChangeEntryParentId(event: unknown, entryType: string): string | undefined {
  const payload = readChangePayload(event, entryType);
  return readString(payload, "parentId") ?? readString(payload, "parent_id");
}

function readChangeEntryType(event: unknown, entryType: string): string {
  return readString(readChangePayload(event, entryType), "type") ?? entryType;
}

function withoutUndefinedAttributes(attributes: Record<string, AttributePrimitive | undefined>): AttributeMap {
  return Object.fromEntries(Object.entries(attributes).filter((entry): entry is [string, AttributePrimitive] => entry[1] !== undefined));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readString(value: unknown, key: string): string | undefined {
  const child = readUnknown(value, key);
  if (typeof child === "string" && child.length > 0) return child;
  if (typeof child === "number" || typeof child === "boolean") return String(child);
  return undefined;
}

function readTreeId(value: unknown, key: string): string | undefined {
  const child = readUnknown(value, key);
  if (child === null) return "root";
  if (typeof child === "string" && child.length > 0) return child;
  if (typeof child === "number" || typeof child === "boolean") return String(child);
  return undefined;
}

function readOptionalString(value: unknown, key: string): string | undefined {
  const child = readUnknown(value, key);
  if (typeof child === "string") return child;
  if (typeof child === "number" || typeof child === "boolean") return String(child);
  return undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  const child = readUnknown(value, key);
  return typeof child === "boolean" ? child : undefined;
}

function readInteger(value: unknown, key: string): number | undefined {
  const child = readUnknown(value, key);
  if (typeof child === "number" && Number.isInteger(child)) return child;
  if (typeof child === "string" && /^\d+$/u.test(child)) return Number(child);
  return undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const child = readUnknown(value, key);
  if (typeof child === "number" && Number.isFinite(child)) return child;
  if (typeof child === "string" && child.trim() !== "") {
    const parsed = Number(child);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readArray(value: unknown, key: string): unknown[] | undefined {
  const child = readUnknown(value, key);
  return Array.isArray(child) ? child : undefined;
}

function readUnknown(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function normalizeMetricValue(value: string, fallback: string): string {
  const normalizedValue = value.trim().toLowerCase().replaceAll(/[^a-z0-9_.:-]/gu, "_");
  if (/^[a-z][a-z0-9_.:-]{0,63}$/u.test(normalizedValue)) return normalizedValue;
  return fallback;
}
