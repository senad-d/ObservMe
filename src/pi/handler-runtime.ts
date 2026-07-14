import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Histogram, Span } from "@opentelemetry/api";
import type { ObservMeConfig } from "../config/schema.ts";
import { createLogSessionScopedOtelSdk, type ObservMeLogSdk } from "../otel/logs.ts";
import { createMetricSessionScopedOtelSdk, type ObservMeMetricSdk } from "../otel/metrics.ts";
import { startOtelSdk, toOtelStartupError, type SessionScopedOtelSdk } from "../otel/sdk.ts";
import { runBoundedOtelOperation } from "../otel/shutdown.ts";
import { createTraceSessionScopedOtelSdk, type ObservMeTraceSdk } from "../otel/traces.ts";
import { inheritTenantSaltEnvironment } from "../privacy/hash.ts";
import { LOG_ATTRIBUTES, RESOURCE_ATTRIBUTES } from "../semconv/attributes.ts";
import {
  LOG_EVENT_NAMES,
  OBSERVME_AGENT_LEASE_METRIC_OPTIONS,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_GAUGE_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
  OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES,
  OFFICIAL_GENAI_METRIC_NAMES,
} from "../semconv/metrics.ts";
import { BoundedMap, type BoundedMapEviction } from "../util/bounded-map.ts";
import { createActiveAgentLease } from "./active-agent-lease.ts";
import type { AgentLineageContext } from "./agent-lineage.ts";
import { buildResourceLineageAttributes } from "./agent-lineage.ts";
import type { AgentTreeNode } from "./agent-tree-tracker.ts";
import { AgentTreeTracker } from "./agent-tree-tracker.ts";
import {
  emitLifecycleLog,
  errorClass,
  evictSpan,
  evictSubagentSpawnState,
  evictToolCallState,
  evictWaitJoinState,
  isRecord,
  metricLabels,
  normalizeMetricValue,
  readBoolean,
  readString,
  readUnknown,
  recordTelemetryDrop,
  stringifyAttributes,
  type TelemetryDropTarget,
} from "./handler-internals.ts";
import type {
  AttributeMap,
  CompositeOtelSignalSdk,
  Handler,
  HandlerErrorRecorder,
  HandlerRegistration,
  HandlerSessionState,
  ObservMeHandlerContext,
  PiEventName,
  PiHandler,
  ObservMeMetrics,
  ObservMePiApi,
  ObservMeTelemetrySession,
  RuntimeHandler,
  SpanRegistry,
  StartSessionTelemetryOptions,
  TelemetryMeter,
  ToolCallState,
  TurnSequenceRegistry,
} from "./handler-types.ts";
import type { AgentWaitJoinState, SubagentSpawnState } from "./subagent-types.ts";

export const OBSERVME_SEMCONV_VERSION = "0.1.0";

const piApiCompatibilityErrorMessage =
  "ObservMe/Pi API compatibility error: expected Pi ExtensionAPI with on(eventName, handler) before registering ObservMe handlers.";
const eventRegistrationOrder = [
  "session_start",
  "session_info_changed",
  "agent_start",
  "turn_start",
  "before_provider_request",
  "after_provider_response",
  "message_end",
  "tool_execution_start",
  "tool_call",
  "tool_result",
  "tool_execution_end",
  "user_bash",
  "model_select",
  "thinking_level_select",
  "session_before_tree",
  "session_tree",
  "session_compact",
  "turn_end",
  "agent_end",
  "session_shutdown",
] as const satisfies readonly PiEventName[];
const eventRegistrationIndexes = createEventRegistrationIndexes();

let defaultHandlerErrorRecorder: HandlerErrorRecorder = recordInternalErrorFallback;

export class HandlerRegistrar {
  readonly #api: ObservMePiApi;
  readonly #state: HandlerSessionState;
  readonly #errorRecorder: HandlerErrorRecorder;
  readonly #registrations: HandlerRegistration[] = [];

  constructor(api: ObservMePiApi, state: HandlerSessionState, errorRecorder: HandlerErrorRecorder) {
    this.#api = api;
    this.#state = state;
    this.#errorRecorder = errorRecorder;
  }

  add<Name extends PiEventName>(eventName: Name, handler: PiHandler<Name>): void {
    this.#registrations.push({ eventName, handler: handler as unknown as RuntimeHandler });
  }

  commit(): void {
    this.#registrations.sort(compareHandlerRegistrations);
    for (const registration of this.#registrations) {
      registerObservedHandler(
        this.#api,
        registration.eventName,
        registration.handler,
        this.#state,
        this.#errorRecorder,
      );
    }
  }
}

export class SerializedLifecycleQueue {
  #previous = Promise.resolve();

  wrap<Name extends PiEventName>(fn: PiHandler<Name>): PiHandler<Name> {
    const runtimeHandler = fn as unknown as RuntimeHandler;
    return runSerializedLifecycleHandler.bind(undefined, this, runtimeHandler) as PiHandler<Name>;
  }

  run(fn: RuntimeHandler, event: unknown, ctx: Parameters<RuntimeHandler>[1]): Promise<void> {
    // Pi docs guarantee /new, /resume, and /fork emit session_shutdown before session_start;
    // ctx.reload() emits session_shutdown then session_start while the old command call frame can
    // continue. ObservMe queues both lifecycle handlers together so async startup, shutdown,
    // reload, and replacement state transitions cannot clear or replace shared runtime state out of order.
    const current = this.#previous.then(invokeHandler.bind(undefined, fn, event, ctx));
    this.#previous = current.catch(ignoreLifecycleQueueError);
    return current;
  }
}

export function resolveObservMePiApi(pi: unknown): ObservMePiApi {
  if (!isRecord(pi)) throw new TypeError(piApiCompatibilityErrorMessage);

  const on = pi.on;
  if (typeof on !== "function") throw new TypeError(piApiCompatibilityErrorMessage);

  const appendEntry = typeof pi.appendEntry === "function"
    ? (pi.appendEntry.bind(pi) as NonNullable<ObservMePiApi["appendEntry"]>)
    : undefined;
  const getThinkingLevel = typeof pi.getThinkingLevel === "function"
    ? (pi.getThinkingLevel.bind(pi) as NonNullable<ObservMePiApi["getThinkingLevel"]>)
    : undefined;

  return {
    on: on.bind(pi) as ObservMePiApi["on"],
    appendEntry,
    getThinkingLevel,
  };
}

export function setDefaultHandlerErrorRecorder(recorder: HandlerErrorRecorder): void {
  defaultHandlerErrorRecorder = recorder;
}

export function safeHandler<Event = unknown, Context = ObservMeHandlerContext>(
  name: string,
  fn: Handler<Event, Context>,
  recorder: HandlerErrorRecorder = defaultHandlerErrorRecorder,
): Handler<Event, Context> {
  return (runSafeHandler<Event, Context>).bind(undefined, name, fn, recorder);
}

export function createStatefulHandlerErrorRecorder(
  state: HandlerSessionState,
  fallback?: HandlerErrorRecorder,
): HandlerErrorRecorder {
  return recordStatefulHandlerError.bind(undefined, state, fallback);
}

export async function startSessionTelemetry(options: StartSessionTelemetryOptions): Promise<ObservMeTelemetrySession> {
  if (!options.config.enabled) throw new Error("ObservMe telemetry cannot start while ObservMe is disabled.");

  const config = withTelemetrySessionResourceAttributes(options.config, options.lineage);
  const traceSdk = createTraceSessionScopedOtelSdk({ config, agent: options.lineage });
  const metricSdk = createMetricSessionScopedOtelSdk({ config, agent: options.lineage });
  const logSdk = createLogSessionScopedOtelSdk({ config, agent: options.lineage });
  const signalSdk = createCompositeOtelSignalSdk(
    traceSdk,
    metricSdk,
    logSdk,
    config.shutdown.flushTimeoutMs,
  );
  const controller = await startOtelSdk({
    config,
    agent: options.lineage,
    sdkFactory: returnCompositeSignalSdk.bind(undefined, signalSdk),
  });
  const tracer = traceSdk.tracer;
  const metrics = createObservMeMetrics(metricSdk.meter);
  const sessionReference: HandlerSessionState = {};
  const getTelemetryDropTarget = resolveSessionTelemetryDropTarget.bind(undefined, sessionReference, metrics);
  const spans = createSpanRegistry(config, metrics, getTelemetryDropTarget);
  const agentTree = createAgentTreeTracker(config, options.lineage, metrics, getTelemetryDropTarget);
  const turnSequences = createTurnSequenceRegistry(config, metrics, getTelemetryDropTarget);
  const activeAgentLease = createActiveAgentLease({
    instrument: metrics.agentLeaseExpiresUnixTimeSeconds,
    leaseDurationMillis: config.metrics.activeAgentLeaseDurationMillis,
    attributes: metricLabels(config, options.lineage),
    wallClockNow: options.wallClockNow,
    enabled: config.metrics.enabled,
  });
  const session: ObservMeTelemetrySession = {
    config,
    lineage: options.lineage,
    controller,
    tracer,
    meter: metricSdk.meter,
    logger: logSdk.logger,
    metrics,
    spans,
    activeAgentLease,
    agentTree,
    now: options.now ?? monotonicNowMs,
    activeAgentRecorded: false,
    agentRunSequence: 0,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences,
  };

  sessionReference.session = session;
  return session;
}

export function createCompositeOtelSignalSdk(
  traceSdk: ObservMeTraceSdk,
  metricSdk: ObservMeMetricSdk,
  logSdk: ObservMeLogSdk,
  cleanupTimeoutMs = 3_000,
): CompositeOtelSignalSdk {
  return new ObservMeCompositeOtelSignalSdk(traceSdk, metricSdk, logSdk, cleanupTimeoutMs);
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
    agentLeaseExpiresUnixTimeSeconds: meter.createObservableGauge(
      OBSERVME_GAUGE_METRIC_NAMES.AGENT_LEASE_EXPIRES_UNIXTIME_SECONDS,
      OBSERVME_AGENT_LEASE_METRIC_OPTIONS,
    ),
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
  const noopHistogram = { record: recordNoopHistogram };
  return typeof maybeMeter.createHistogram === "function" ? maybeMeter.createHistogram(name) : noopHistogram;
}

export function createTurnSequenceRegistry(
  config: ObservMeConfig,
  metrics: ObservMeMetrics,
  getTelemetryDropTarget?: () => TelemetryDropTarget,
): BoundedMap<string, number> {
  return new BoundedMap({
    maxSize: config.limits.maxActiveAgentRuns,
    onEvict: recordTurnSequenceEviction.bind(undefined, metrics, getTelemetryDropTarget),
  });
}

export function createAgentTreeTracker(
  config: ObservMeConfig,
  lineage: AgentLineageContext,
  metrics: ObservMeMetrics,
  getTelemetryDropTarget?: () => TelemetryDropTarget,
): AgentTreeTracker {
  const tracker = new AgentTreeTracker({
    maxAgents: Math.max(2, config.limits.maxActiveSubagentSpawns + 1),
    onEvict: recordAgentTreeEviction.bind(undefined, metrics, getTelemetryDropTarget),
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
      onEvict: handleAgentRunEviction.bind(undefined, metrics, getTelemetryDropTarget),
    }),
    activeTurns: new BoundedMap({
      maxSize: config.limits.maxActiveTurns,
      onEvict: handleSpanEviction.bind(undefined, metrics, getTelemetryDropTarget),
    }),
    activeLlmRequests: new BoundedMap({
      maxSize: config.limits.maxActiveLlmRequests,
      onEvict: handleSpanEviction.bind(undefined, metrics, getTelemetryDropTarget),
    }),
    activeToolCalls: new BoundedMap({
      maxSize: config.limits.maxActiveToolCalls,
      onEvict: handleToolCallEviction.bind(undefined, metrics, getTelemetryDropTarget),
    }),
    activeSubagentSpawns: new BoundedMap({
      maxSize: config.limits.maxActiveSubagentSpawns,
      onEvict: handleSubagentSpawnEviction.bind(undefined, metrics, getTelemetryDropTarget),
    }),
    activeAgentWaits: new BoundedMap({
      maxSize: config.limits.maxActiveAgentWaits,
      onEvict: handleWaitJoinEviction.bind(undefined, metrics, getTelemetryDropTarget),
    }),
    activeAgentJoins: new BoundedMap({
      maxSize: config.limits.maxActiveAgentJoins,
      onEvict: handleWaitJoinEviction.bind(undefined, metrics, getTelemetryDropTarget),
    }),
  };
}

export function isRootWorkflow(lineage: AgentLineageContext): boolean {
  return lineage.role === "root" || lineage.role === "orchestrator";
}

export function workflowFailed(event: unknown): boolean {
  const status = readString(event, "status") ?? readString(event, "outcome");
  return readBoolean(event, "failed") === true || Boolean(readUnknown(event, "error")) || status === "failed" || status === "error";
}

export function monotonicNowMs(): number {
  return performance.now();
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
  return inheritTenantSaltEnvironment(merged, config);
}

export function buildTelemetryInstanceResourceAttributes(instanceId: string): Record<string, string> {
  return {
    [RESOURCE_ATTRIBUTES.SERVICE_INSTANCE_ID]: instanceId,
    [RESOURCE_ATTRIBUTES.OBSERVME_INSTANCE_ID]: instanceId,
  };
}

function createEventRegistrationIndexes(): Map<PiEventName, number> {
  const indexes = new Map<PiEventName, number>();
  for (const [index, name] of eventRegistrationOrder.entries()) indexes.set(name, index);
  return indexes;
}

function recordNoopHistogram(_value: number, _attributes?: Record<string, unknown>): void {
  return undefined;
}

function compareHandlerRegistrations(left: HandlerRegistration, right: HandlerRegistration): number {
  return registrationIndex(left.eventName) - registrationIndex(right.eventName);
}

function registrationIndex(eventName: PiEventName): number {
  return eventRegistrationIndexes.get(eventName) ?? eventRegistrationOrder.length;
}

function registerObservedHandler(
  api: ObservMePiApi,
  name: PiEventName,
  handler: RuntimeHandler,
  state: HandlerSessionState,
  errorRecorder: HandlerErrorRecorder,
): void {
  api.on(name, safeHandler(name, observeHandler(name, handler, state), errorRecorder));
}

function observeHandler(name: string, fn: RuntimeHandler, state: HandlerSessionState): RuntimeHandler {
  return runObservedHandler.bind(undefined, name, fn, state);
}

async function runObservedHandler(
  name: string,
  fn: RuntimeHandler,
  state: HandlerSessionState,
  event: unknown,
  ctx: Parameters<RuntimeHandler>[1],
): Promise<void> {
  const startedAtMs = Date.now();
  const sessionBefore = state.session;
  let status = "ok";

  try {
    await fn(event, ctx);
  } catch (error) {
    status = "error";
    throw error;
  } finally {
    recordHandlerObservation(resolveObservationSession(name, sessionBefore, state.session), name, startedAtMs, status);
  }
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

async function runSafeHandler<Event, Context>(
  name: string,
  fn: Handler<Event, Context>,
  recorder: HandlerErrorRecorder,
  event: Event,
  ctx: Context,
): Promise<void> {
  try {
    await fn(event, ctx);
  } catch (error) {
    recorder(name, error);
  }
}

async function runSerializedLifecycleHandler(
  queue: SerializedLifecycleQueue,
  fn: RuntimeHandler,
  event: unknown,
  ctx: Parameters<RuntimeHandler>[1],
): Promise<void> {
  await queue.run(fn, event, ctx);
}

async function invokeHandler(
  fn: RuntimeHandler,
  event: unknown,
  ctx: Parameters<RuntimeHandler>[1],
): Promise<void> {
  await fn(event, ctx);
}

function ignoreLifecycleQueueError(): undefined {
  return undefined;
}

function returnCompositeSignalSdk(signalSdk: CompositeOtelSignalSdk): CompositeOtelSignalSdk {
  return signalSdk;
}

function resolveSessionTelemetryDropTarget(
  state: HandlerSessionState,
  metrics: ObservMeMetrics,
): TelemetryDropTarget {
  return state.session ?? metrics;
}

function recordTurnSequenceEviction(
  metrics: ObservMeMetrics,
  getTelemetryDropTarget: (() => TelemetryDropTarget) | undefined,
  _eviction: BoundedMapEviction<string, number>,
): void {
  recordTelemetryDrop(resolveTelemetryDropTarget(metrics, getTelemetryDropTarget), "turn_sequence_full", {
    operation: "turn_sequence",
  });
}

function recordAgentTreeEviction(
  metrics: ObservMeMetrics,
  getTelemetryDropTarget: (() => TelemetryDropTarget) | undefined,
  _node: AgentTreeNode,
): void {
  recordTelemetryDrop(resolveTelemetryDropTarget(metrics, getTelemetryDropTarget), "agent_tree_full", {
    operation: "agent_tree",
  });
}

function handleAgentRunEviction(
  metrics: ObservMeMetrics,
  getTelemetryDropTarget: (() => TelemetryDropTarget) | undefined,
  eviction: BoundedMapEviction<string, Span>,
): void {
  evictAgentRunState(
    eviction.key,
    eviction.value,
    resolveTelemetryDropTarget(metrics, getTelemetryDropTarget),
  );
}

function handleSpanEviction(
  metrics: ObservMeMetrics,
  getTelemetryDropTarget: (() => TelemetryDropTarget) | undefined,
  eviction: BoundedMapEviction<string, Span>,
): void {
  evictSpan(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget));
}

function handleToolCallEviction(
  metrics: ObservMeMetrics,
  getTelemetryDropTarget: (() => TelemetryDropTarget) | undefined,
  eviction: BoundedMapEviction<string, ToolCallState>,
): void {
  evictToolCallState(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget));
}

function handleSubagentSpawnEviction(
  metrics: ObservMeMetrics,
  getTelemetryDropTarget: (() => TelemetryDropTarget) | undefined,
  eviction: BoundedMapEviction<string, SubagentSpawnState>,
): void {
  evictSubagentSpawnState(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget));
}

function handleWaitJoinEviction(
  metrics: ObservMeMetrics,
  getTelemetryDropTarget: (() => TelemetryDropTarget) | undefined,
  eviction: BoundedMapEviction<string, AgentWaitJoinState>,
): void {
  evictWaitJoinState(eviction.value, resolveTelemetryDropTarget(metrics, getTelemetryDropTarget));
}

function evictAgentRunState(runId: string, span: Span, target: TelemetryDropTarget): void {
  evictSpan(span, target);

  const turnSequences = readTurnSequenceRegistry(target);
  if (!turnSequences?.delete(runId)) return;
  recordTelemetryDrop(target, "turn_sequence_full", { operation: "turn_sequence" });
}

function readTurnSequenceRegistry(target: TelemetryDropTarget): TurnSequenceRegistry | undefined {
  if (!("turnSequences" in target)) return undefined;
  return target.turnSequences as TurnSequenceRegistry;
}

function resolveTelemetryDropTarget(
  metrics: ObservMeMetrics,
  getTelemetryDropTarget: (() => TelemetryDropTarget) | undefined,
): TelemetryDropTarget {
  return getTelemetryDropTarget?.() ?? metrics;
}

function recordStatefulHandlerError(
  state: HandlerSessionState,
  fallback: HandlerErrorRecorder | undefined,
  name: string,
  error: unknown,
): void {
  const session = state.session;
  session?.metrics.handlerErrors.add(1, { operation: normalizeMetricValue(name, "handler") });
  if (session) emitLifecycleLog(session.logger, LOG_EVENT_NAMES.HANDLER_FAILED, handlerErrorAttributes(name, error), "ERROR");
  if (!session) fallback?.(name, error);
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

class ObservMeCompositeOtelSignalSdk implements CompositeOtelSignalSdk {
  readonly traceSdk: ObservMeTraceSdk;
  readonly metricSdk: ObservMeMetricSdk;
  readonly logSdk: ObservMeLogSdk;
  readonly #cleanupTimeoutMs: number;
  readonly #startedSignalSdks: SessionScopedOtelSdk[] = [];
  #startingSignalSdk?: SessionScopedOtelSdk;
  #state: CompositeOtelSignalSdk["state"] = "idle";

  constructor(
    traceSdk: ObservMeTraceSdk,
    metricSdk: ObservMeMetricSdk,
    logSdk: ObservMeLogSdk,
    cleanupTimeoutMs: number,
  ) {
    this.traceSdk = traceSdk;
    this.metricSdk = metricSdk;
    this.logSdk = logSdk;
    this.#cleanupTimeoutMs = cleanupTimeoutMs;
  }

  get state(): CompositeOtelSignalSdk["state"] {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state === "started") return;
    if (this.#state !== "idle") throw new Error(`ObservMe OTEL signal SDK cannot start from ${this.#state}.`);

    this.#state = "starting";
    try {
      await this.startSignalSdk(this.traceSdk);
      await this.startSignalSdk(this.metricSdk);
      await this.startSignalSdk(this.logSdk);
      this.#state = "started";
    } catch (error) {
      const cleanup = await runBoundedOtelOperation(
        "shutdown",
        this.shutdownStartedSignalSdks.bind(this),
        this.#cleanupTimeoutMs,
      );
      this.#state = "failed";
      throw toOtelStartupError(error, cleanup);
    }
  }

  async forceFlush(): Promise<void> {
    await Promise.all([this.traceSdk.forceFlush(), this.metricSdk.forceFlush(), this.logSdk.forceFlush()]);
  }

  async shutdown(): Promise<void> {
    if (this.#state === "shutdown") return;

    try {
      await this.shutdownStartedSignalSdks();
    } finally {
      this.#state = "shutdown";
    }
  }

  private async startSignalSdk(sdk: SessionScopedOtelSdk): Promise<void> {
    this.#startingSignalSdk = sdk;
    await sdk.start?.();
    this.#startedSignalSdks.push(sdk);
    this.#startingSignalSdk = undefined;
  }

  private async shutdownStartedSignalSdks(): Promise<void> {
    const signalSdks = this.takeStartedSignalSdks();
    const results = await Promise.allSettled(signalSdks.map(shutdownCompositeSignalSdk));

    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  private takeStartedSignalSdks(): SessionScopedOtelSdk[] {
    const signalSdks = [...this.#startedSignalSdks];
    if (this.#startingSignalSdk && !signalSdks.includes(this.#startingSignalSdk)) {
      signalSdks.push(this.#startingSignalSdk);
    }

    this.#startedSignalSdks.length = 0;
    this.#startingSignalSdk = undefined;
    return signalSdks.reverse();
  }
}

async function shutdownCompositeSignalSdk(sdk: SessionScopedOtelSdk): Promise<void> {
  await sdk.shutdown?.();
}
