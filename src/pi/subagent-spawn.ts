import { createHash, randomUUID } from "node:crypto";
import type { Counter, Histogram, Span, SpanContext, UpDownCounter } from "@opentelemetry/api";
import { context as otelContext, isSpanContextValid, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  recordObsAgentWaitJoinHint,
  updateObsAgentsRuntimeStateFromTree,
} from "../commands/obs-agents-runtime.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import {
  AGENT_SPAWN_ATTRIBUTES,
  AGENT_WAIT_JOIN_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  LOG_ATTRIBUTES,
} from "../semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../semconv/metrics.ts";
import { SPAN_NAMES } from "../semconv/spans.ts";
import type { BoundedMap } from "../util/bounded-map.ts";
import type { AgentChildStatus, AgentTreeNode, AgentTreeSummary } from "./agent-tree-tracker.ts";
import { AgentTreeTracker } from "./agent-tree-tracker.ts";
import type { AgentLineageContext, AgentRole } from "./agent-lineage.ts";
import { createAgentLineageContext, createPropagationEnvironment } from "./agent-lineage.ts";
import { recordActiveSpanEnd, recordActiveSpanStart } from "./handler-internals.ts";
import type { TelemetryLogger, TelemetryTracer } from "./handlers.ts";

export type SubagentSpawnType = "command" | "tool" | "extension" | "unknown";
export type AgentJoinStatus = "completed" | "failed" | "cancelled" | "timeout" | "unknown" | "waiting";
export type AttributePrimitive = boolean | number | string;
export type AttributeMap = Record<string, AttributePrimitive>;
export type TestableSpan = Span & {
  readonly name?: string;
  readonly attributes?: Record<string, unknown>;
  readonly parentSpan?: Span;
};

export interface SubagentSpawnState {
  readonly span: TestableSpan;
  readonly childAgentId: string;
  readonly startedAtMs: number;
  readonly labels: Record<string, string>;
  readonly traceContextPropagated: boolean;
}

export interface AgentWaitJoinState {
  readonly span: TestableSpan;
  readonly startedAtMs: number;
  readonly labels: Record<string, string>;
}

export interface SubagentSpanRegistry {
  readonly activeAgentRuns: Pick<BoundedMap<string, Span>, "get">;
  readonly activeTurns: Pick<BoundedMap<string, Span>, "get">;
  readonly activeSubagentSpawns: BoundedMap<string, SubagentSpawnState>;
  readonly activeAgentWaits: BoundedMap<string, AgentWaitJoinState>;
  readonly activeAgentJoins: BoundedMap<string, AgentWaitJoinState>;
}

export interface SubagentMetrics {
  readonly subagentsSpawned: Counter;
  readonly subagentSpawnFailures: Counter;
  readonly orphanAgents: Counter;
  readonly traceContextPropagationFailures: Counter;
  readonly activeSpans: UpDownCounter;
  readonly agentFanoutCount: Histogram;
  readonly agentTreeDepth: Histogram;
  readonly agentTreeWidth: Histogram;
  readonly agentWaitDurationMs: Histogram;
  readonly agentJoinDurationMs: Histogram;
}

export interface SubagentTelemetrySession {
  readonly config: ObservMeConfig;
  readonly lineage: AgentLineageContext;
  readonly tracer: TelemetryTracer;
  readonly logger: TelemetryLogger;
  readonly metrics: SubagentMetrics;
  readonly spans: SubagentSpanRegistry;
  sessionSpan?: Span;
  sessionAttributes?: AttributeMap;
  currentAgentRunId?: string;
  currentTurnId?: string;
  agentTree?: AgentTreeTracker;
}

export interface BuildSubagentPropagationEnvironmentOptions {
  readonly config: ObservMeConfig;
  readonly lineage: AgentLineageContext;
  readonly spawnId: string;
  readonly parentSessionId?: string;
  readonly spanContext?: SpanContext;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SubagentPropagationEnvironment {
  readonly env: NodeJS.ProcessEnv;
  readonly traceContextPropagated: boolean;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly parentTraceId?: string;
  readonly parentSpanId?: string;
}

export interface StartSubagentSpawnOptions {
  readonly spawnId?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly childAgentId?: string;
  readonly spawnType?: string;
  readonly spawnReason?: string;
  readonly toolCallId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

export interface StartedSubagentSpawn {
  readonly spawnId: string;
  readonly childAgentId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly span: TestableSpan;
  readonly traceContextPropagated: boolean;
  readonly attributes: AttributeMap;
}

export interface CompleteSubagentSpawnOptions {
  readonly childAgentId?: string;
  readonly childStatus?: AgentChildStatus;
  readonly outcome?: "completed" | "failed" | "cancelled";
}

export interface FailSubagentSpawnOptions {
  readonly childAgentId?: string;
  readonly errorClass?: string;
}

export interface SubagentRunnerOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export type SubagentRunner<Result> = (
  command: string,
  args: readonly string[],
  options: SubagentRunnerOptions,
) => Promise<Result>;

export interface RunSubagentOptions extends StartSubagentSpawnOptions {
  readonly signal?: AbortSignal;
}

export interface AgentWaitJoinOptions {
  readonly id?: string;
  readonly spawnId?: string;
  readonly childAgentId?: string;
  readonly childStatus?: AgentChildStatus;
  readonly joinStatus?: AgentJoinStatus;
  readonly reason?: string;
  readonly failurePropagated?: boolean;
  readonly durationMs?: number;
  readonly now?: () => number;
}

export interface StartedAgentWaitJoin {
  readonly id: string;
  readonly span: TestableSpan;
  readonly attributes: AttributeMap;
}

export interface ObserveTrustedSubagentLineageOptions {
  readonly role?: AgentRole;
  readonly capability?: string;
  readonly status?: AgentChildStatus;
  readonly generateId?: () => string;
}

const sessionIdAttributeKey = "pi.session.id";
const defaultWaitReason = "child_completion";

export async function runSubagentWithObservability<Result>(
  session: SubagentTelemetrySession,
  command: string,
  args: readonly string[],
  runner: SubagentRunner<Result>,
  options: RunSubagentOptions = {},
): Promise<Result> {
  const started = startSubagentSpawn(session, { ...options, command, args });

  try {
    const result = await runner(command, args, { env: started.env, signal: options.signal });
    completeSubagentSpawn(session, started.spawnId, { childAgentId: started.childAgentId, childStatus: "completed" });
    return result;
  } catch (error) {
    failSubagentSpawn(session, started.spawnId, { childAgentId: started.childAgentId, errorClass: errorClass(error) });
    throw error;
  }
}

export function startSubagentSpawn(
  session: SubagentTelemetrySession,
  options: StartSubagentSpawnOptions = {},
): StartedSubagentSpawn {
  const spawnId = options.spawnId ?? `spawn-${randomUUID()}`;
  const childAgentId = options.childAgentId ?? `child-${spawnId}`;
  const labels = subagentSpawnMetricLabels(session, options);
  const parentSpan = resolveSubagentParentSpan(session);
  const initialAttributes = buildSubagentSpawnAttributes(session, spawnId, childAgentId, options);
  const span = startActiveSubagentSpan(session, SPAN_NAMES.PI_AGENT_SPAWN, parentSpan, initialAttributes, "subagent_spawn");
  const propagation = buildSubagentPropagationEnvironment({
    config: session.config,
    lineage: session.lineage,
    spawnId,
    parentSessionId: resolveCurrentSessionId(session),
    spanContext: readSpanContext(span),
    env: options.env,
  });
  const treeSummary = recordAgentTreeSpawn(session, childAgentId);
  const attributes = {
    ...initialAttributes,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_TRACE_CONTEXT_PROPAGATED]: propagation.traceContextPropagated,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_CHILDREN_ACTIVE]: treeSummary.activeChildren,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_CHILD_COUNT]: treeSummary.fanoutCount,
  };

  span.setAttributes(attributes);
  session.spans.activeSubagentSpawns.set(spawnId, {
    span,
    childAgentId,
    startedAtMs: now(options),
    labels,
    traceContextPropagated: propagation.traceContextPropagated,
  });
  session.metrics.subagentsSpawned.add(1, labels);
  recordAgentTreeMetrics(session, treeSummary, labels);
  recordObsAgentsTreeState(session);
  span.addEvent(LOG_EVENT_NAMES.AGENT_SPAWN_STARTED, attributes);
  emitSubagentLog(session, LOG_EVENT_NAMES.AGENT_SPAWN_STARTED, attributes);
  recordTraceContextFallbackWhenMissing(session, span, spawnId, propagation);

  return { spawnId, childAgentId, env: propagation.env, span, traceContextPropagated: propagation.traceContextPropagated, attributes };
}

export function completeSubagentSpawn(
  session: SubagentTelemetrySession,
  spawnId: string,
  options: CompleteSubagentSpawnOptions = {},
): void {
  const state = session.spans.activeSubagentSpawns.get(spawnId);
  if (!state) return;

  const childAgentId = options.childAgentId ?? state.childAgentId;
  const childStatus = options.childStatus ?? "completed";
  const attributes = buildSubagentCompletionAttributes(session, spawnId, childAgentId, options.outcome ?? "completed");

  updateChildStatus(session, childAgentId, childStatus);
  recordObsAgentsTreeState(session);
  state.span.setAttributes(attributes);
  state.span.setStatus({ code: SpanStatusCode.OK });
  state.span.addEvent(LOG_EVENT_NAMES.AGENT_SPAWN_COMPLETED, attributes);
  endSubagentSpan(session, state.span);
  session.spans.activeSubagentSpawns.delete(spawnId);
  emitSubagentLog(session, LOG_EVENT_NAMES.AGENT_SPAWN_COMPLETED, attributes);
}

export function failSubagentSpawn(
  session: SubagentTelemetrySession,
  spawnId: string,
  options: FailSubagentSpawnOptions = {},
): void {
  const state = session.spans.activeSubagentSpawns.get(spawnId);
  if (!state) return;

  const childAgentId = options.childAgentId ?? state.childAgentId;
  const attributes = {
    ...buildSubagentCompletionAttributes(session, spawnId, childAgentId, "failed"),
    [LOG_ATTRIBUTES.ERROR_TYPE]: normalizeMetricLabel(options.errorClass ?? "subagent_spawn_error", "subagent_spawn_error"),
  };

  updateChildStatus(session, childAgentId, "failed");
  recordObsAgentsTreeState(session);
  state.span.setAttributes(attributes);
  state.span.setStatus({ code: SpanStatusCode.ERROR, message: String(attributes[LOG_ATTRIBUTES.ERROR_TYPE]) });
  state.span.addEvent(LOG_EVENT_NAMES.AGENT_SPAWN_FAILED, attributes);
  endSubagentSpan(session, state.span);
  session.spans.activeSubagentSpawns.delete(spawnId);
  session.metrics.subagentSpawnFailures.add(1, subagentFailureMetricLabels(state.labels, attributes));
  emitSubagentLog(session, LOG_EVENT_NAMES.AGENT_SPAWN_FAILED, attributes, "ERROR");
}

export function buildSubagentPropagationEnvironment(
  options: BuildSubagentPropagationEnvironmentOptions,
): SubagentPropagationEnvironment {
  const baseEnv = options.env ?? process.env;
  if (!options.config.workflow.enabled || !options.config.agent.propagateToSubagents) {
    return { env: { ...baseEnv }, traceContextPropagated: false };
  }

  const parentTraceId = options.spanContext?.traceId;
  const parentSpanId = options.spanContext?.spanId;
  const traceparent = buildTraceparent(options.config, options.spanContext);
  const tracestate = traceparent ? serializeTraceState(options.spanContext) : undefined;
  const env = sanitizeTraceContextEnvironment(
    {
      ...createPropagationEnvironment(options.lineage, options.config, baseEnv),
      ...definedEnvValue(options.config.agent.parentSessionIdEnv, options.parentSessionId),
      ...definedEnvValue(options.config.agent.parentTraceIdEnv, parentTraceId),
      ...definedEnvValue(options.config.agent.parentSpanIdEnv, parentSpanId),
      ...definedEnvValue(options.config.agent.spawnIdEnv, options.spawnId),
      ...definedEnvValue("traceparent", traceparent),
      ...definedEnvValue("tracestate", tracestate),
    },
    traceparent,
    tracestate,
  );

  return {
    env,
    traceContextPropagated: Boolean(traceparent),
    traceparent,
    tracestate,
    parentTraceId,
    parentSpanId,
  };
}

export function startAgentWait(
  session: SubagentTelemetrySession,
  options: AgentWaitJoinOptions = {},
): StartedAgentWaitJoin {
  return startWaitJoinSpan(session, options, "wait");
}

export function endAgentWait(
  session: SubagentTelemetrySession,
  waitId: string,
  options: AgentWaitJoinOptions = {},
): void {
  endWaitJoinSpan(session, waitId, options, "wait");
}

export function recordAgentWait(session: SubagentTelemetrySession, options: AgentWaitJoinOptions = {}): StartedAgentWaitJoin {
  const started = startAgentWait(session, options);
  endAgentWait(session, started.id, options);
  return started;
}

export function startAgentJoin(
  session: SubagentTelemetrySession,
  options: AgentWaitJoinOptions = {},
): StartedAgentWaitJoin {
  return startWaitJoinSpan(session, options, "join");
}

export function endAgentJoin(
  session: SubagentTelemetrySession,
  joinId: string,
  options: AgentWaitJoinOptions = {},
): void {
  endWaitJoinSpan(session, joinId, options, "join");
}

export function recordAgentJoin(session: SubagentTelemetrySession, options: AgentWaitJoinOptions = {}): StartedAgentWaitJoin {
  const started = startAgentJoin(session, options);
  endAgentJoin(session, started.id, options);
  return started;
}

export function observeTrustedSubagentLineage(
  session: SubagentTelemetrySession,
  env: NodeJS.ProcessEnv,
  options: ObserveTrustedSubagentLineageOptions = {},
): AgentTreeNode | undefined {
  try {
    const lineage = createAgentLineageContext({
      config: session.config,
      env,
      trustedParentContext: true,
      role: options.role ?? "subagent",
      capability: options.capability,
      generateId: options.generateId,
    });
    return recordSubagentLineageObservation(session, lineage, options.status ?? "active");
  } catch (error) {
    recordMalformedLineage(session, error);
    return undefined;
  }
}

export function recordSubagentLineageObservation(
  session: SubagentTelemetrySession,
  lineage: AgentLineageContext,
  status: AgentChildStatus = "active",
): AgentTreeNode {
  const tree = ensureAgentTree(session);
  const node = tree.registerAgent(lineage, status);
  const summary = tree.summarize(session.lineage.rootAgentId);
  const labels = tree.metricLabels(node.status, node.orphaned);

  recordAgentTreeMetrics(session, summary, labels);
  if (node.orphaned) recordOrphanAgent(session, node);
  recordObsAgentsTreeState(session);
  return node;
}

function startWaitJoinSpan(
  session: SubagentTelemetrySession,
  options: AgentWaitJoinOptions,
  kind: "wait" | "join",
): StartedAgentWaitJoin {
  const id = options.id ?? `${kind}-${options.spawnId ?? randomUUID()}`;
  const attributes = buildWaitJoinAttributes(session, options);
  const spanName = kind === "wait" ? SPAN_NAMES.PI_AGENT_WAIT : SPAN_NAMES.PI_AGENT_JOIN;
  const eventName = kind === "wait" ? LOG_EVENT_NAMES.AGENT_WAIT_STARTED : LOG_EVENT_NAMES.AGENT_JOIN_STARTED;
  const operation = kind === "wait" ? "agent_wait" : "agent_join";
  const span = startActiveSubagentSpan(session, spanName, resolveSubagentParentSpan(session), attributes, operation);
  const labels = waitJoinMetricLabels(session, options);
  const state = { span, startedAtMs: now(options), labels };

  waitJoinRegistry(session, kind).set(id, state);
  recordObsAgentWaitJoinHint(createWaitJoinRuntimeHint(id, options, kind, true));
  span.addEvent(eventName, attributes);
  emitSubagentLog(session, eventName, attributes);

  return { id, span, attributes };
}

function endWaitJoinSpan(
  session: SubagentTelemetrySession,
  id: string,
  options: AgentWaitJoinOptions,
  kind: "wait" | "join",
): void {
  const registry = waitJoinRegistry(session, kind);
  const state = registry.get(id);
  if (!state) return;

  if (kind === "join" && options.childAgentId && options.childStatus) updateChildStatus(session, options.childAgentId, options.childStatus);

  const attributes = buildWaitJoinAttributes(session, options);
  const eventName = kind === "wait" ? LOG_EVENT_NAMES.AGENT_WAIT_COMPLETED : LOG_EVENT_NAMES.AGENT_JOIN_COMPLETED;
  const durationMs = resolveDurationMs(state, options);

  state.span.setAttributes(attributes);
  if (waitJoinFailed(options)) state.span.setStatus({ code: SpanStatusCode.ERROR, message: options.joinStatus ?? options.childStatus });
  state.span.addEvent(eventName, attributes);
  endSubagentSpan(session, state.span);
  registry.delete(id);
  recordObsAgentWaitJoinHint(createWaitJoinRuntimeHint(id, options, kind, false, durationMs));
  recordObsAgentsTreeState(session);
  recordWaitJoinDuration(session, durationMs, state.labels, kind);
  emitSubagentLog(session, eventName, attributes, waitJoinFailed(options) ? "ERROR" : "INFO");
}

function waitJoinRegistry(
  session: SubagentTelemetrySession,
  kind: "wait" | "join",
): BoundedMap<string, AgentWaitJoinState> {
  return kind === "wait" ? session.spans.activeAgentWaits : session.spans.activeAgentJoins;
}

function recordWaitJoinDuration(
  session: SubagentTelemetrySession,
  durationMs: number,
  labels: Record<string, string>,
  kind: "wait" | "join",
): void {
  if (kind === "wait") {
    session.metrics.agentWaitDurationMs.record(durationMs, labels);
    return;
  }

  session.metrics.agentJoinDurationMs.record(durationMs, labels);
}

function buildWaitJoinAttributes(session: SubagentTelemetrySession, options: AgentWaitJoinOptions): AttributeMap {
  const summary = ensureAgentTree(session).summarize(session.lineage.rootAgentId);

  return withoutUndefinedAttributes({
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILD_ID]: options.childAgentId,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_SPAWN_ID]: options.spawnId,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_WAIT_REASON]: normalizeMetricLabel(options.reason ?? defaultWaitReason, defaultWaitReason),
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_JOIN_STATUS]: options.joinStatus ?? "waiting",
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILD_STATUS]: options.childStatus ?? "active",
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_FAILURE_PROPAGATED]: options.failurePropagated ?? false,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILDREN_ACTIVE]: summary.activeChildren,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILD_COUNT]: summary.fanoutCount,
  });
}

function waitJoinMetricLabels(session: SubagentTelemetrySession, options: AgentWaitJoinOptions): Record<string, string> {
  return {
    agent_role: session.lineage.role,
    subagent_depth: subagentDepthLabel(session),
    status: normalizeMetricLabel(options.joinStatus ?? options.childStatus ?? "waiting", "waiting"),
    reason: normalizeMetricLabel(options.reason ?? defaultWaitReason, defaultWaitReason),
  };
}

function waitJoinFailed(options: AgentWaitJoinOptions): boolean {
  return options.failurePropagated === true || options.childStatus === "failed" || options.joinStatus === "failed";
}

function resolveDurationMs(state: AgentWaitJoinState, options: AgentWaitJoinOptions): number {
  if (options.durationMs !== undefined) return Math.max(0, options.durationMs);
  return Math.max(0, now(options) - state.startedAtMs);
}

function buildSubagentSpawnAttributes(
  session: SubagentTelemetrySession,
  spawnId: string,
  childAgentId: string,
  options: StartSubagentSpawnOptions,
): AttributeMap {
  return withoutUndefinedAttributes({
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_ID]: spawnId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_TYPE]: normalizeSpawnType(options.spawnType),
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_REASON]: normalizeMetricLabel(options.spawnReason ?? "subagent", "subagent"),
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_TOOL_CALL_ID]: options.toolCallId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_COMMAND_HASH]: hashCommand(options.command, options.args),
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_CHILD_ID]: childAgentId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_PARENT_ID]: session.lineage.agentId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
    [AGENT_SPAWN_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [AGENT_SPAWN_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID]: session.lineage.workflowRootAgentId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_DEPTH]: session.lineage.depth + 1,
    [AGENT_SPAWN_ATTRIBUTES.PI_SESSION_ID]: resolveCurrentSessionId(session),
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]: session.currentAgentRunId,
  });
}

function buildSubagentCompletionAttributes(
  session: SubagentTelemetrySession,
  spawnId: string,
  childAgentId: string,
  outcome: "completed" | "failed" | "cancelled",
): AttributeMap {
  const summary = ensureAgentTree(session).summarize(session.lineage.rootAgentId);

  return withoutUndefinedAttributes({
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_ID]: spawnId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_CHILD_ID]: childAgentId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_OUTCOME]: outcome,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_CHILDREN_ACTIVE]: summary.activeChildren,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_CHILD_COUNT]: summary.fanoutCount,
    [AGENT_SPAWN_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_PARENT_ID]: session.lineage.agentId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
  });
}

function recordAgentTreeSpawn(session: SubagentTelemetrySession, childAgentId: string): AgentTreeSummary {
  const tree = ensureAgentTree(session);
  tree.registerAgent(createSyntheticChildLineage(session, childAgentId), "starting");
  return tree.summarize(session.lineage.rootAgentId);
}

function recordAgentTreeMetrics(
  session: SubagentTelemetrySession,
  summary: AgentTreeSummary,
  labels: Record<string, string>,
): void {
  session.metrics.agentFanoutCount.record(summary.fanoutCount, labels);
  session.metrics.agentTreeDepth.record(summary.treeDepth, labels);
  session.metrics.agentTreeWidth.record(summary.treeWidth, labels);
}

function recordObsAgentsTreeState(session: SubagentTelemetrySession): void {
  updateObsAgentsRuntimeStateFromTree(session.lineage, ensureAgentTree(session), { sessionId: resolveCurrentSessionId(session) });
}

function createWaitJoinRuntimeHint(
  id: string,
  options: AgentWaitJoinOptions,
  kind: "wait" | "join",
  active: boolean,
  durationMs?: number,
) {
  return {
    kind,
    id,
    active,
    spawnId: options.spawnId,
    childAgentId: options.childAgentId,
    childStatus: options.childStatus,
    joinStatus: options.joinStatus,
    reason: options.reason,
    durationMs,
  };
}

function ensureAgentTree(session: SubagentTelemetrySession): AgentTreeTracker {
  if (session.agentTree) return session.agentTree;

  session.agentTree = new AgentTreeTracker({ maxAgents: Math.max(2, session.config.limits.maxActiveSubagentSpawns + 1) });
  session.agentTree.registerAgent(session.lineage);
  return session.agentTree;
}

function createSyntheticChildLineage(session: SubagentTelemetrySession, childAgentId: string): AgentLineageContext {
  return {
    workflowId: session.lineage.workflowId,
    workflowRootAgentId: session.lineage.workflowRootAgentId,
    agentId: childAgentId,
    parentAgentId: session.lineage.agentId,
    rootAgentId: session.lineage.rootAgentId,
    depth: session.lineage.depth + 1,
    role: "subagent",
    capability: session.lineage.capability,
    parentSessionId: resolveCurrentSessionId(session),
    parentTraceId: session.lineage.parentTraceId,
    parentSpanId: session.lineage.parentSpanId,
    orphaned: false,
  };
}

function updateChildStatus(
  session: SubagentTelemetrySession,
  childAgentId: string,
  status: AgentChildStatus,
): void {
  ensureAgentTree(session).updateStatus(childAgentId, status);
}

function recordOrphanAgent(session: SubagentTelemetrySession, node: AgentTreeNode): void {
  const labels = ensureAgentTree(session).metricLabels(node.status, node.orphaned);
  const attributes = {
    [LOG_ATTRIBUTES.EVENT_NAME]: LOG_EVENT_NAMES.AGENT_ORPHANED,
    [LOG_ATTRIBUTES.EVENT_CATEGORY]: "agent-tree",
    [LOG_ATTRIBUTES.PI_WORKFLOW_ID]: node.workflowId,
    [LOG_ATTRIBUTES.PI_AGENT_ID]: node.agentId,
    [LOG_ATTRIBUTES.PI_AGENT_PARENT_ID]: node.parentAgentId ?? "unknown",
    [LOG_ATTRIBUTES.PI_AGENT_ROOT_ID]: node.rootAgentId,
  };

  session.metrics.orphanAgents.add(1, labels);
  emitSubagentLog(session, LOG_EVENT_NAMES.AGENT_ORPHANED, attributes, "ERROR");
}

function recordMalformedLineage(session: SubagentTelemetrySession, error: unknown): void {
  const attributes = {
    [LOG_ATTRIBUTES.EVENT_NAME]: LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED,
    [LOG_ATTRIBUTES.EVENT_CATEGORY]: "agent-tree",
    [LOG_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [LOG_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [LOG_ATTRIBUTES.ERROR_TYPE]: errorClass(error),
  };

  session.metrics.traceContextPropagationFailures.add(1, traceContextFailureMetricLabels(session));
  emitSubagentLog(session, LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED, attributes, "ERROR");
}

function recordTraceContextFallbackWhenMissing(
  session: SubagentTelemetrySession,
  span: Span,
  spawnId: string,
  propagation: SubagentPropagationEnvironment,
): void {
  if (propagation.traceContextPropagated) return;

  const attributes = withoutUndefinedAttributes({
    [LOG_ATTRIBUTES.EVENT_NAME]: LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED,
    [LOG_ATTRIBUTES.EVENT_CATEGORY]: "agent-tree",
    [LOG_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [LOG_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [LOG_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_ID]: spawnId,
    [LOG_ATTRIBUTES.TRACE_ID]: propagation.parentTraceId,
    [LOG_ATTRIBUTES.SPAN_ID]: propagation.parentSpanId,
  });

  session.metrics.traceContextPropagationFailures.add(1, traceContextFailureMetricLabels(session));
  span.addEvent(LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED, attributes);
  emitSubagentLog(session, LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED, attributes, "ERROR");
}

function traceContextFailureMetricLabels(session: SubagentTelemetrySession): Record<string, string> {
  return {
    agent_role: session.lineage.role,
    subagent_depth: subagentDepthLabel(session),
    reason: "trace_context_fallback",
  };
}

function subagentSpawnMetricLabels(
  session: SubagentTelemetrySession,
  options: StartSubagentSpawnOptions,
): Record<string, string> {
  return {
    agent_role: session.lineage.role,
    subagent_depth: subagentDepthLabel(session),
    spawn_type: normalizeSpawnType(options.spawnType),
    spawn_reason: normalizeMetricLabel(options.spawnReason ?? "subagent", "subagent"),
  };
}

function subagentFailureMetricLabels(labels: Record<string, string>, attributes: AttributeMap): Record<string, string> {
  return {
    spawn_type: labels.spawn_type ?? "unknown",
    error_class: String(attributes[LOG_ATTRIBUTES.ERROR_TYPE] ?? "subagent_spawn_error"),
  };
}

function subagentDepthLabel(session: SubagentTelemetrySession): string {
  return String(Math.max(0, Math.min(session.lineage.depth + 1, session.config.workflow.maxDepthWarning)));
}

function normalizeSpawnType(value: string | undefined): SubagentSpawnType {
  if (value === "command" || value === "tool" || value === "extension") return value;
  return "unknown";
}

function normalizeMetricLabel(value: string, fallback: string): string {
  const normalizedValue = value.trim().toLowerCase().replaceAll(/[^a-z0-9_.:-]/gu, "_");
  if (/^[a-z][a-z0-9_.:-]{0,63}$/u.test(normalizedValue)) return normalizedValue;
  return fallback;
}

function buildTraceparent(config: ObservMeConfig, spanContext: SpanContext | undefined): string | undefined {
  if (!config.agent.propagateTraceContext || !spanContext || !isSpanContextValid(spanContext)) return undefined;
  const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

function serializeTraceState(spanContext: SpanContext | undefined): string | undefined {
  const serialized = spanContext?.traceState?.serialize();
  return serialized && serialized.length > 0 ? serialized : undefined;
}

function readSpanContext(span: Span): SpanContext | undefined {
  try {
    const spanContext = span.spanContext();
    return isSpanContextValid(spanContext) ? spanContext : undefined;
  } catch (_error) {
    return undefined;
  }
}

function startActiveSubagentSpan(
  session: SubagentTelemetrySession,
  name: string,
  parent: Span | undefined,
  attributes: AttributeMap,
  operation: string,
): TestableSpan {
  const span = startChildSpan(session.tracer, name, parent, attributes);
  recordActiveSpanStart(session.metrics, span, operation);
  return span;
}

function startChildSpan(tracer: TelemetryTracer, name: string, parent: Span | undefined, attributes: AttributeMap): TestableSpan {
  const parentContext = parent ? trace.setSpan(otelContext.active(), parent) : otelContext.active();
  return tracer.startSpan(name, { attributes }, parentContext) as TestableSpan;
}

function endSubagentSpan(session: SubagentTelemetrySession, span: Span): void {
  recordActiveSpanEnd(session.metrics, span);
  span.end();
}

function resolveSubagentParentSpan(session: SubagentTelemetrySession): Span | undefined {
  if (session.currentTurnId) return session.spans.activeTurns.get(session.currentTurnId) ?? session.sessionSpan;
  if (session.currentAgentRunId) return session.spans.activeAgentRuns.get(session.currentAgentRunId) ?? session.sessionSpan;
  return session.sessionSpan;
}

function resolveCurrentSessionId(session: SubagentTelemetrySession): string {
  return session.sessionAttributes?.[sessionIdAttributeKey]?.toString() ?? `session-${session.lineage.workflowId}`;
}

function hashCommand(command: string | undefined, args: readonly string[] | undefined): string | undefined {
  if (command === undefined) return undefined;
  return createHash("sha256").update(command).update("\0").update((args ?? []).join("\0")).digest("hex");
}

function definedEnvValue(name: string, value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined || value === "" ? {} : { [name]: value };
}

function sanitizeTraceContextEnvironment(
  env: NodeJS.ProcessEnv,
  traceparent: string | undefined,
  tracestate: string | undefined,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };

  if (!traceparent) {
    delete sanitized.traceparent;
    delete sanitized.tracestate;
    delete sanitized.TRACEPARENT;
    delete sanitized.TRACESTATE;
    return sanitized;
  }

  sanitized.traceparent = traceparent;
  if (tracestate) sanitized.tracestate = tracestate;
  if (!tracestate) delete sanitized.tracestate;
  return sanitized;
}

function withoutUndefinedAttributes(attributes: Record<string, AttributePrimitive | undefined>): AttributeMap {
  return Object.fromEntries(Object.entries(attributes).filter(isDefinedAttributeEntry));
}

function isDefinedAttributeEntry(entry: [string, AttributePrimitive | undefined]): entry is [string, AttributePrimitive] {
  return entry[1] !== undefined;
}

function now(options: { readonly now?: () => number }): number {
  return options.now?.() ?? Date.now();
}

function emitSubagentLog(
  session: SubagentTelemetrySession,
  eventName: string,
  attributes: AttributeMap,
  severityText: "ERROR" | "INFO" = "INFO",
): void {
  session.logger.emit({
    severityText,
    body: eventName,
    attributes: {
      [LOG_ATTRIBUTES.EVENT_NAME]: eventName,
      [LOG_ATTRIBUTES.EVENT_CATEGORY]: "agent-tree",
      ...attributes,
    },
  });
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return normalizeMetricLabel(error.name, "error");
  return normalizeMetricLabel(typeof error, "error");
}
