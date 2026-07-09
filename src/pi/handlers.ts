import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type { Counter, Histogram, Meter, Span, Tracer, UpDownCounter } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import {
  clearObsAgentsRuntimeState,
  startObsAgentsRuntimeState,
} from "../commands/obs-agents-runtime.ts";
import {
  clearObsSessionRuntimeState,
  recordObsSessionLlmCall,
  recordObsSessionTurn,
  startObsSessionRuntimeState,
} from "../commands/obs-session.ts";
import { clearObsStatusExportError, recordObsStatusExportResult, updateObsStatusRuntimeState } from "../commands/obs-status.ts";
import type { EnsureProjectConfig as BootstrapEnsureProjectConfig } from "../config/bootstrap-project-config.ts";
import { bootstrapProjectObservMeConfig } from "../config/bootstrap-project-config.ts";
import type { LoadSessionConfigOptions, SessionConfigDiagnostics } from "../config/load-config.ts";
import { loadSessionConfig, loadSessionConfigWithDiagnostics } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import { EXTENSION_STATUS_KEY, EXTENSION_STATUS_VALUE } from "../constants.ts";
import { emitUnsafeCaptureWarning } from "../config/validate.ts";
import { ObservMeLogSdk } from "../otel/logs.ts";
import { ObservMeMetricSdk } from "../otel/metrics.ts";
import type { ObservMeOtelSdkController } from "../otel/sdk.ts";
import { startOtelSdk } from "../otel/sdk.ts";
import type { BoundedOtelOperationResult } from "../otel/shutdown.ts";
import { ObservMeTraceSdk } from "../otel/traces.ts";
import {
  AGENT_RUN_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  COMPACTION_ATTRIBUTES,
  LOG_ATTRIBUTES,
  RESOURCE_ATTRIBUTES,
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
import { BoundedMap } from "../util/bounded-map.ts";
import type { AgentLineageContext } from "./agent-lineage.ts";
import { buildResourceLineageAttributes, createAgentLineageContext } from "./agent-lineage.ts";
import { AgentTreeTracker } from "./agent-tree-tracker.ts";
import type { AgentWaitJoinState, SubagentSpawnState } from "./subagent-spawn.ts";
import {
  buildAgentRunAttributes,
  buildBashExecutionAttributes,
  buildBranchAttributes,
  buildBranchPreparationState,
  buildCommonSessionSpanAttributes,
  buildCompactionAttributes,
  buildLineageMetricSafeLogAttributes,
  buildLlmFinalAttributes,
  buildLlmRequestAttributes,
  buildLlmResponseAttributes,
  buildModelChangeAttributes,
  buildThinkingLevelChangeAttributes,
  buildToolCallInputAttributes,
  buildToolFinalAttributes,
  buildToolResultAttributes,
  buildTurnAttributes,
  bashErrorClass,
  bashExecutionFailed,
  bashExecutionMetricLabels,
  bashFailureMetricLabels,
  deleteCurrentLlmRequest,
  deleteCurrentToolCall,
  deriveTurnId,
  endActiveSpan,
  endAllActiveSpans,
  errorClass,
  evictSpan,
  evictSubagentSpawnState,
  evictToolCallState,
  evictWaitJoinState,
  hashValue,
  hasBashCompletionResult,
  isAssistantMessage,
  isBashExecutionMessage,
  isLlmError,
  isMissingFileError,
  isRecord,
  llmMetricLabels,
  mergeToolStateLabels,
  metricLabels,
  modelChangeMetricLabels,
  nextAgentRunId,
  nextLlmRequestId,
  nextToolCallId,
  nextTurnIndex,
  normalizeMetricValue,
  readBashPayload,
  readBoolean,
  readInteger,
  readMessage,
  readSpanTraceId,
  readString,
  readUnknown,
  recordLlmSizeMetrics,
  recordLlmUsageMetrics,
  recordOptionalBashContent,
  recordOptionalLlmContent,
  recordOptionalPromptContent,
  recordOptionalToolArguments,
  recordOptionalToolResult,
  recordPromptSizeMetric,
  recordSpanDurationMs,
  recordTelemetryDrop,
  recordMissingToolCallIdDrop,
  resolveCurrentLlmSpan,
  resolveCurrentToolCallId,
  resolveLlmParentSpan,
  resolveModelId,
  resolveModelProvider,
  resolveOperationParentSpan,
  resolveSessionFilePath,
  resolveSessionId,
  resolveThinkingLevel,
  resolveToolCallState,
  resolveToolParentSpan,
  startActiveChildSpan,
  startActiveRootSpan,
  startToolCallState,
  stringifyAttributes,
  thinkingLevelChangeMetricLabels,
  toolEventHasAmbiguousMissingToolCallId,
  updateCurrentSessionAttributes,
  withoutUndefinedAttributes,
  type TelemetryDropTarget,
} from "./handler-internals.ts";
export { deriveTurnId };

export type AttributePrimitive = boolean | number | string | string[];
export type AttributeMap = Record<string, AttributePrimitive>;
export type TelemetryMeter = Pick<Meter, "createCounter" | "createHistogram" | "createUpDownCounter">;
export type TelemetryTracer = Pick<Tracer, "startSpan">;
export type TelemetryLogger = Pick<Logger, "emit">;
export type Handler = (event: unknown, ctx: ObservMeHandlerContext) => Promise<void> | void;
export type HandlerErrorRecorder = (name: string, error: unknown) => void;
export type LoadSessionConfig = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type StartSessionTelemetry = (options: StartSessionTelemetryOptions) => Promise<ObservMeTelemetrySession>;
export type ReadSessionHeader = (sessionFile: string) => Promise<SessionRecoveryHeader | undefined>;
export type EnsureProjectConfig = BootstrapEnsureProjectConfig;

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
  readonly ensureProjectConfig?: EnsureProjectConfig;
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
  readonly tracer: TelemetryTracer;
  readonly meter: TelemetryMeter;
  readonly logger: TelemetryLogger;
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

const duplicateSessionStartEventName = "session.duplicate_start";
const piApiCompatibilityErrorMessage =
  "ObservMe/Pi API compatibility error: expected Pi ExtensionAPI with on(eventName, handler) before registering ObservMe handlers.";

let defaultHandlerErrorRecorder: HandlerErrorRecorder = recordInternalErrorFallback;

export function registerHandlers(pi: unknown, options: RegisterHandlersOptions = {}): void {
  const api = resolveObservMePiApi(pi);
  let session: ObservMeTelemetrySession | undefined;
  const loadConfigFn = options.loadConfig ?? loadSessionConfig;
  const startTelemetryFn = options.startTelemetry ?? startSessionTelemetry;
  const errorRecorder = createStatefulHandlerErrorRecorder(() => session, options.onHandlerError);
  const lifecycleQueue = new SerializedLifecycleQueue();

  defaultHandlerErrorRecorder = errorRecorder;
  registerObservedHandler(
    api,
    "session_start",
    lifecycleQueue.wrap(createSessionStartHandler(() => session, loadConfigFn, startTelemetryFn, options, value => {
      session = value;
    })),
    () => session,
    errorRecorder,
  );
  registerObservedHandler(api, "agent_start", createAgentStartHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "turn_start", createTurnStartHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "before_provider_request", createBeforeProviderRequestHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "after_provider_response", createAfterProviderResponseHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "message_end", createMessageEndHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "tool_execution_start", createToolExecutionStartHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "tool_call", createToolCallHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "tool_result", createToolResultHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "tool_execution_end", createToolExecutionEndHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "user_bash", createUserBashPreExecutionHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "bashExecution", createBashExecutionHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "model_select", createModelChangeHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "model_change", createModelChangeHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "thinking_level_select", createThinkingLevelChangeHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "thinking_level_change", createThinkingLevelChangeHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "session_before_tree", createSessionBeforeTreeHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "session_tree", createBranchHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "session_compact", createCompactionHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "turn_end", createTurnEndHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "agent_end", createAgentEndHandler(() => session), () => session, errorRecorder);
  registerObservedHandler(api, "session_shutdown", lifecycleQueue.wrap(createSessionShutdownHandler(() => session, value => {
    session = value;
  })), () => session, errorRecorder);
}

function resolveObservMePiApi(pi: unknown): ObservMePiApi {
  if (!isRecord(pi)) throw new TypeError(piApiCompatibilityErrorMessage);

  const on = pi.on;
  if (typeof on !== "function") throw new TypeError(piApiCompatibilityErrorMessage);

  return {
    on: (eventName, handler) => {
      on.call(pi, eventName, handler);
    },
  };
}

function registerObservedHandler(
  api: ObservMePiApi,
  name: string,
  handler: Handler,
  getSession: () => ObservMeTelemetrySession | undefined,
  errorRecorder: HandlerErrorRecorder,
): void {
  api.on(name, safeHandler(name, observeHandler(name, handler, getSession), errorRecorder));
}

function observeHandler(
  name: string,
  fn: Handler,
  getSession: () => ObservMeTelemetrySession | undefined,
): Handler {
  return async (event, ctx) => {
    const startedAtMs = Date.now();
    const sessionBefore = getSession();
    let status = "ok";

    try {
      await fn(event, ctx);
    } catch (error) {
      status = "error";
      throw error;
    } finally {
      recordHandlerObservation(resolveObservationSession(name, sessionBefore, getSession()), name, startedAtMs, status);
    }
  };
}

function resolveObservationSession(
  name: string,
  sessionBefore: ObservMeTelemetrySession | undefined,
  sessionAfter: ObservMeTelemetrySession | undefined,
): ObservMeTelemetrySession | undefined {
  if (name === "session_start") return sessionAfter ?? sessionBefore;
  return sessionBefore ?? sessionAfter;
}

function recordHandlerObservation(
  session: ObservMeTelemetrySession | undefined,
  name: string,
  startedAtMs: number,
  status: string,
): void {
  if (!session) return;

  const operation = normalizeMetricValue(name, "handler");
  session.metrics.eventsObserved.add(1, { operation });
  session.metrics.handlerDurationMs.record(Math.max(0, Date.now() - startedAtMs), { operation, status });
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

class SerializedLifecycleQueue {
  #previous = Promise.resolve();

  wrap(fn: Handler): Handler {
    // Pi docs guarantee /new, /resume, and /fork emit session_shutdown before session_start;
    // ctx.reload() emits session_shutdown then session_start while the old command call frame can
    // continue. ObservMe queues both lifecycle handlers together so async startup, shutdown,
    // reload, and replacement state transitions cannot clear or replace shared runtime state out of order.
    return async (event, ctx) => {
      const current = this.#previous.then(() => Promise.resolve(fn(event, ctx)));
      this.#previous = current.catch(() => undefined);
      await current;
    };
  }
}

export async function startSessionTelemetry(options: StartSessionTelemetryOptions): Promise<ObservMeTelemetrySession> {
  const config = withTelemetrySessionResourceAttributes(options.config, options.lineage);
  const traceSdk = new ObservMeTraceSdk({ config });
  const metricSdk = new ObservMeMetricSdk({ config });
  const logSdk = new ObservMeLogSdk({ config });
  const signalSdk = createCompositeOtelSignalSdk(traceSdk, metricSdk, logSdk);
  const controller = await startOtelSdk({ config, agent: options.lineage, sdkFactory: () => signalSdk });
  const tracer = traceSdk.tracer ?? trace.getTracer("@senad-d/observme");

  const metrics = createObservMeMetrics(metricSdk.meter);
  const session: ObservMeTelemetrySession = {
    config,
    lineage: options.lineage,
    controller,
    tracer,
    meter: metricSdk.meter,
    logger: logSdk.logger,
    metrics,
    spans: createSpanRegistry(config, metrics, () => session),
    agentTree: createAgentTreeTracker(config, options.lineage, metrics, () => session),
    activeAgentRecorded: false,
    agentRunSequence: 0,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences: new Map(),
  };

  return session;
}

export function createCompositeOtelSignalSdk(
  traceSdk: ObservMeTraceSdk,
  metricSdk: ObservMeMetricSdk,
  logSdk: ObservMeLogSdk,
): CompositeOtelSignalSdk {
  return new ObservMeCompositeOtelSignalSdk(traceSdk, metricSdk, logSdk);
}

export function createObservMeMetrics(meter: TelemetryMeter): ObservMeMetrics {
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

export function createHistogram(meter: TelemetryMeter, name: string): Histogram {
  const maybeMeter = meter as Partial<TelemetryMeter>;
  const noopHistogram = { record: (_value: number, _attributes?: Record<string, unknown>) => undefined };
  return typeof maybeMeter.createHistogram === "function" ? maybeMeter.createHistogram(name) : noopHistogram;
}

export function createAgentTreeTracker(
  config: ObservMeConfig,
  lineage: AgentLineageContext,
  metrics: ObservMeMetrics,
  getTelemetryDropTarget?: () => TelemetryDropTarget,
): AgentTreeTracker {
  const tracker = new AgentTreeTracker({
    maxAgents: Math.max(2, config.limits.maxActiveSubagentSpawns + 1),
    onEvict: () => recordTelemetryDrop(resolveTelemetryDropTarget(metrics, getTelemetryDropTarget), "agent_tree_full", { operation: "agent_tree" }),
  });

  tracker.registerAgent(lineage);
  return tracker;
}

export function createSpanRegistry(
  config: ObservMeConfig,
  metrics: ObservMeMetrics,
  getTelemetryDropTarget?: () => TelemetryDropTarget,
): SpanRegistry {
  return {
    activeAgentRuns: new BoundedMap({
      maxSize: config.limits.maxActiveAgentRuns,
      onEvict: eviction => evictSpan(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget)),
    }),
    activeTurns: new BoundedMap({
      maxSize: config.limits.maxActiveTurns,
      onEvict: eviction => evictSpan(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget)),
    }),
    activeLlmRequests: new BoundedMap({
      maxSize: config.limits.maxActiveLlmRequests,
      onEvict: eviction => evictSpan(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget)),
    }),
    activeToolCalls: new BoundedMap({
      maxSize: config.limits.maxActiveToolCalls,
      onEvict: eviction => evictToolCallState(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget)),
    }),
    activeSubagentSpawns: new BoundedMap({
      maxSize: config.limits.maxActiveSubagentSpawns,
      onEvict: eviction => evictSubagentSpawnState(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget)),
    }),
    activeAgentWaits: new BoundedMap({
      maxSize: config.limits.maxActiveAgentWaits,
      onEvict: eviction => evictWaitJoinState(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget)),
    }),
    activeAgentJoins: new BoundedMap({
      maxSize: config.limits.maxActiveAgentJoins,
      onEvict: eviction => evictWaitJoinState(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget)),
    }),
  };
}

function resolveTelemetryDropTarget(
  metrics: ObservMeMetrics,
  getTelemetryDropTarget: (() => TelemetryDropTarget) | undefined,
): TelemetryDropTarget {
  return getTelemetryDropTarget?.() ?? metrics;
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
    [sessionAttributeKeys.SESSION_CWD_HASH]: hashValue(cwd, config),
    [sessionAttributeKeys.SESSION_PARENT_SESSION_HASH]: parentSessionId ? hashValue(parentSessionId, config) : "",
    [sessionAttributeKeys.SESSION_PERSISTED]: readBoolean(event, "persisted") ?? recovery?.resumed ?? false,
    [sessionAttributeKeys.SESSION_FILE_HASH]: sessionFile ? hashValue(sessionFile, config) : "",
    [sessionAttributeKeys.SESSION_VERSION]: readString(recovery?.header, "version") ?? readString(event, "sessionVersion") ?? readString(event, "version") ?? "unknown",
    [sessionAttributeKeys.MODEL_PROVIDER_CURRENT]: resolveModelProvider(event, ctx),
    [sessionAttributeKeys.MODEL_ID_CURRENT]: resolveModelId(event, ctx),
    [sessionAttributeKeys.THINKING_LEVEL_CURRENT]: resolveThinkingLevel(event, ctx),
    ...buildCommonSessionSpanAttributes(sessionId, config, lineage),
  });
}

export function emitLifecycleLog(
  logger: TelemetryLogger,
  eventName: string,
  attributes: AttributeMap,
  severityText: "ERROR" | "INFO" = "INFO",
): void {
  emitStructuredLog(logger, eventName, "lifecycle", attributes, severityText);
}

function emitStructuredLog(
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

async function ensureProjectConfigForHandler(
  options: RegisterHandlersOptions,
  ctx: ObservMeHandlerContext,
): Promise<void> {
  // Pi emits session_start for startup, reload, new, resume, and fork flows. ObservMe keeps
  // bootstrap idempotent across all of them: create once for trusted projects, then never overwrite.
  await bootstrapProjectObservMeConfig(ctx, {
    configDirName: options.configDirName,
    ensureProjectConfig: options.ensureProjectConfig,
  });
}

async function shutDownPreviousSessionBeforeDuplicateStart(
  session: ObservMeTelemetrySession,
  ctx: ObservMeHandlerContext,
  setSession: (session: ObservMeTelemetrySession | undefined) => void,
): Promise<void> {
  emitLifecycleLog(session.logger, duplicateSessionStartEventName, buildDuplicateSessionStartAttributes(session));

  try {
    await shutDownTelemetrySession(session, duplicateSessionStartShutdownEvent(), ctx, setSession);
  } catch (error) {
    recordDuplicateSessionStartShutdownError(session, error);
    clearObsSessionRuntimeState();
    clearObsAgentsRuntimeState();
    setSession(undefined);
  }
}

function buildDuplicateSessionStartAttributes(session: ObservMeTelemetrySession): AttributeMap {
  return withoutUndefinedAttributes({
    [LOG_ATTRIBUTES.PI_SESSION_ID]: readString(session.sessionAttributes, sessionAttributeKeys.SESSION_ID),
    [LOG_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [LOG_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID]: session.lineage.workflowRootAgentId,
    [LOG_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [LOG_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
    reason: "active_session_replaced_before_new_start",
  });
}

function duplicateSessionStartShutdownEvent(): Record<string, unknown> {
  return {
    duplicateSessionStart: true,
    status: "ok",
  };
}

function recordDuplicateSessionStartShutdownError(session: ObservMeTelemetrySession, error: unknown): void {
  session.metrics.handlerErrors.add(1, { operation: "session_start.duplicate_shutdown" });
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.HANDLER_FAILED, handlerErrorAttributes("session_start.duplicate_shutdown", error), "ERROR");
}

async function shutDownTelemetrySession(
  session: ObservMeTelemetrySession,
  event: unknown,
  ctx: ObservMeHandlerContext,
  setSession: (session: ObservMeTelemetrySession | undefined) => void,
): Promise<void> {
  const labels = metricLabels(session.config, session.lineage);
  const shutdownAttributes = buildShutdownAttributes(event, session);
  const failed = workflowFailed(event);

  session.metrics.sessionsShutdown.add(1, labels);
  if (session.activeAgentRecorded) session.metrics.activeAgents.add(-1, labels);
  recordWorkflowShutdownTelemetry(session, shutdownAttributes, failed, labels);
  endAllActiveSpans(session);
  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.SESSION_SHUTDOWN, shutdownAttributes);
  if (failed) session.sessionSpan?.setStatus({ code: SpanStatusCode.ERROR });
  endActiveSpan(session, session.sessionSpan);
  await ctx.ui?.setStatus?.(EXTENSION_STATUS_KEY, undefined);
  await recordControllerOperationResult(session, "flush");
  await recordControllerOperationResult(session, "shutdown");
  clearObsSessionRuntimeState();
  clearObsAgentsRuntimeState();
  setSession(undefined);
}

async function recordControllerOperationResult(
  session: ObservMeTelemetrySession,
  operation: BoundedOtelOperationResult["operation"],
): Promise<void> {
  const result = await runControllerOperation(session, operation);
  recordObsStatusExportResult(result);
  recordExportOperationResult(session, result);
}

async function runControllerOperation(
  session: ObservMeTelemetrySession,
  operation: BoundedOtelOperationResult["operation"],
): Promise<BoundedOtelOperationResult> {
  try {
    return await session.controller[operation](session.config.shutdown.flushTimeoutMs);
  } catch (error) {
    return { operation, completed: false, timedOut: false, error };
  }
}

function createSessionStartHandler(
  getSession: () => ObservMeTelemetrySession | undefined,
  loadConfigFn: LoadSessionConfig,
  startTelemetryFn: StartSessionTelemetry,
  options: RegisterHandlersOptions,
  setSession: (session: ObservMeTelemetrySession | undefined) => void,
): Handler {
  return async (event, ctx) => {
    const previousSession = getSession();
    if (previousSession) await shutDownPreviousSessionBeforeDuplicateStart(previousSession, ctx, setSession);

    await ensureProjectConfigForHandler(options, ctx);
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
    session.sessionSpan = startActiveRootSpan(session, SPAN_NAMES.PI_SESSION, attributes, "session");
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

    await ctx.ui?.setStatus?.(EXTENSION_STATUS_KEY, EXTENSION_STATUS_VALUE);
    setSession(session);
  };
}

function createSessionShutdownHandler(
  getSession: () => ObservMeTelemetrySession | undefined,
  setSession: (session: ObservMeTelemetrySession | undefined) => void,
): Handler {
  return async (event, ctx) => {
    const session = getSession();
    if (!session) return;

    await shutDownTelemetrySession(session, event, ctx, setSession);
  };
}

function createAgentStartHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;

    const runId = nextAgentRunId(session, event);
    const attributes = buildAgentRunAttributes(event, session, runId);
    const span = startActiveChildSpan(session, SPAN_NAMES.PI_AGENT_RUN, session.sessionSpan, attributes, "agent_run");

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
    endActiveSpan(session, span);
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
  };
}

function createBeforeProviderRequestHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, ctx) => {
    const session = getSession();
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
    endActiveSpan(session, span);
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

function dropAmbiguousToolLifecycleEvent(
  session: ObservMeTelemetrySession,
  event: unknown,
  operation: string,
): boolean {
  if (!toolEventHasAmbiguousMissingToolCallId(session, event)) return false;

  recordMissingToolCallIdDrop(session, operation);
  return true;
}

function createToolCallHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;
    if (dropAmbiguousToolLifecycleEvent(session, event, "tool_call")) return;

    const toolCallId = resolveCurrentToolCallId(session, event) ?? nextToolCallId(session, event);
    const state = resolveToolCallState(session, event) ?? startToolCallState(session, event, toolCallId);
    const attributes = buildToolCallInputAttributes(event, session.config);

    state.span.setAttributes(attributes);
    mergeToolStateLabels(state, attributes);
    recordOptionalToolArguments(session, state.span, event);
  };
}

function createToolResultHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;
    if (dropAmbiguousToolLifecycleEvent(session, event, "tool_result")) return;

    const state = resolveToolCallState(session, event);
    if (!state) return;

    const attributes = buildToolResultAttributes(event, session.config);
    state.span.setAttributes(attributes);
    mergeToolStateLabels(state, attributes);
    recordOptionalToolResult(session, state.span, event);
  };
}

function createToolExecutionEndHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
    if (!session) return;
    if (dropAmbiguousToolLifecycleEvent(session, event, "tool_execution_end")) return;

    const toolCallId = resolveCurrentToolCallId(session, event);
    const state = toolCallId ? resolveToolCallState(session, event) : undefined;
    if (!toolCallId || !state) {
      recordTelemetryDrop(session, "tool_call_missing_end", { operation: "tool_execution_end" });
      return;
    }

    const resultAttributes = buildToolResultAttributes(event, session.config);
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
    endActiveSpan(session, state.span);
    deleteCurrentToolCall(session, toolCallId);
  };
}

function createUserBashPreExecutionHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (_event, _ctx) => {
    if (!getSession()) return;
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

    session.currentBranchPreparation = buildBranchPreparationState(event, session.config);
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
  const span = startActiveChildSpan(session, SPAN_NAMES.PI_BRANCH, resolveOperationParentSpan(session), attributes, "branch");

  span.addEvent(LOG_EVENT_NAMES.BRANCH_CREATED, attributes);
  span.setStatus({ code: SpanStatusCode.OK });
  endActiveSpan(session, span);
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
  const span = startActiveChildSpan(session, SPAN_NAMES.PI_COMPACTION, resolveOperationParentSpan(session), attributes, "compaction");

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

function recordBashExecution(session: ObservMeTelemetrySession, event: unknown): void {
  const payload = readBashPayload(event);
  if (!hasBashCompletionResult(payload)) {
    recordTelemetryDrop(session, "bash_completion_incomplete", { operation: "bash_execution" });
    return;
  }

  const attributes = buildBashExecutionAttributes(payload, session);
  const span = startActiveChildSpan(session, SPAN_NAMES.PI_BASH_EXECUTION, resolveToolParentSpan(session), attributes, "bash_execution");
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
  endActiveSpan(session, span);
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.BASH_COMPLETED, attributes, failed ? "ERROR" : "INFO");
}

function readRunIdFromTurnId(turnId: string): string | undefined {
  const separator = "-turn-";
  const separatorIndex = turnId.lastIndexOf(separator);
  if (separatorIndex <= 0) return undefined;
  return turnId.slice(0, separatorIndex);
}

function createTurnEndHandler(getSession: () => ObservMeTelemetrySession | undefined): Handler {
  return (event, _ctx) => {
    const session = getSession();
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

export function withTelemetrySessionResourceAttributes(
  config: ObservMeConfig,
  lineage: AgentLineageContext,
  instanceId = randomUUID(),
): ObservMeConfig {
  const merged = structuredClone(config);
  merged.resource.attributes = {
    ...merged.resource.attributes,
    ...buildTelemetryInstanceResourceAttributes(instanceId),
    ...stringifyAttributes(buildResourceLineageAttributes(lineage)),
  };
  return merged;
}

export function buildTelemetryInstanceResourceAttributes(instanceId: string): Record<string, string> {
  return {
    [RESOURCE_ATTRIBUTES.SERVICE_INSTANCE_ID]: instanceId,
    [RESOURCE_ATTRIBUTES.OBSERVME_INSTANCE_ID]: instanceId,
  };
}

