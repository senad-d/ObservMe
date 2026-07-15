import { randomUUID } from "node:crypto";
import type { Counter, Histogram, Span, SpanContext, UpDownCounter } from "@opentelemetry/api";
import { context as otelContext, isSpanContextValid, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  recordObsAgentWaitJoinHint,
  updateObsAgentsRuntimeStateFromTree,
} from "../commands/obs-agents-runtime.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import { trySha256 } from "../privacy/hash.ts";
import {
  AGENT_SPAWN_ATTRIBUTES,
  AGENT_WAIT_JOIN_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  LOG_ATTRIBUTES,
  SESSION_ATTRIBUTES,
} from "../semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../semconv/metrics.ts";
import { SPAN_NAMES } from "../semconv/spans.ts";
import {
  AGENT_WAIT_REASON_VALUES,
  SUBAGENT_SPAWN_REASON_VALUES,
  type AgentWaitReason,
  type SubagentSpawnReason,
} from "../semconv/values.ts";
import { BoundedMap } from "../util/bounded-map.ts";
import type { AgentChildStatus, AgentTreeNode, AgentTreeSummary } from "./agent-tree-tracker.ts";
import { AgentTreeTracker, isAgentStatusTransitionAllowed } from "./agent-tree-tracker.ts";
import type { AgentLineageContext, AgentRole } from "./agent-lineage.ts";
import { createAgentLineageContext, createPropagationEnvironment, sanitizePropagationEnvironment } from "./agent-lineage.ts";
import { recordActiveSpanEnd, recordActiveSpanStart } from "./handler-internals.ts";
import type { TelemetryLogger, TelemetryTracer } from "./handler-types.ts";
import type {
  AgentWaitJoinState,
  ChildFailureAccountingState,
  SubagentSpawnState,
  TestableSpan,
} from "./subagent-types.ts";
export type {
  AgentWaitJoinState,
  ChildFailureAccountingState,
  SubagentSpawnState,
  TestableSpan,
} from "./subagent-types.ts";

export type SubagentSpawnType = "command" | "tool" | "extension" | "unknown";
export type AgentJoinStatus = "completed" | "failed" | "cancelled" | "timeout" | "unknown" | "waiting";
export type AgentTerminalStatus = Extract<AgentChildStatus, "completed" | "failed" | "cancelled">;
export type AttributePrimitive = boolean | number | string | string[];
export type AttributeMap = Record<string, AttributePrimitive>;

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
  readonly subagentSpawnDurationMs: Histogram;
  readonly childAgentFailures: Counter;
  readonly parentRecoveredFromChildFailure: Counter;
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
  childFailureAccounting?: BoundedMap<string, ChildFailureAccountingState>;
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
  readonly spawnReason?: SubagentSpawnReason;
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

export interface SubagentSpawnIdentity {
  readonly spawnId: string;
  readonly childAgentId: string;
}

export interface CompleteSubagentSpawnOptions {
  readonly childAgentId?: string;
  readonly childStatus?: AgentTerminalStatus;
  readonly outcome?: AgentTerminalStatus;
  readonly now?: () => number;
}

export type SubagentTransitionFailureReason =
  | "spawn_not_found"
  | "child_agent_mismatch"
  | "invalid_terminal_transition";

export type SubagentTransitionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SubagentTransitionFailureReason };

interface ResolvedCompletionTransition {
  readonly ok: true;
  readonly childAgentId: string;
  readonly status: AgentTerminalStatus;
}

type CompletionTransitionResult = ResolvedCompletionTransition | Extract<SubagentTransitionResult, { readonly ok: false }>;

export interface FailSubagentSpawnOptions {
  readonly childAgentId?: string;
  readonly errorClass?: string;
  readonly now?: () => number;
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
  readonly reason?: AgentWaitReason;
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

const waitJoinMetricStatusValues = [
  "starting",
  "active",
  "completed",
  "failed",
  "cancelled",
  "orphaned",
  "timeout",
  "unknown",
  "waiting",
] as const satisfies readonly (AgentChildStatus | AgentJoinStatus)[];

type WaitJoinMetricStatus = (typeof waitJoinMetricStatusValues)[number];

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
    completeSubagentSpawn(session, started.spawnId, {
      childAgentId: started.childAgentId,
      childStatus: "completed",
      now: options.now,
    });
    return result;
  } catch (error) {
    failSubagentSpawn(session, started.spawnId, {
      childAgentId: started.childAgentId,
      errorClass: errorClass(error),
      now: options.now,
    });
    throw error;
  }
}

export function resolveSubagentSpawnIdentity(
  options: Pick<StartSubagentSpawnOptions, "spawnId" | "childAgentId"> = {},
): SubagentSpawnIdentity {
  const spawnId = options.spawnId ?? `spawn-${randomUUID()}`;
  return { spawnId, childAgentId: options.childAgentId ?? `child-${spawnId}` };
}

export function startSubagentSpawn(
  session: SubagentTelemetrySession,
  options: StartSubagentSpawnOptions = {},
): StartedSubagentSpawn {
  const { spawnId, childAgentId } = resolveSubagentSpawnIdentity(options);
  const spawnReason = normalizeSpawnReason(options.spawnReason);
  const labels = subagentSpawnMetricLabels(session, options, spawnReason);
  const parentSpan = resolveSubagentParentSpan(session);
  const initialAttributes = buildSubagentSpawnAttributes(session, spawnId, childAgentId, options, spawnReason);
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
    spawnReason,
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
): SubagentTransitionResult {
  const state = session.spans.activeSubagentSpawns.get(spawnId);
  if (!state) return subagentTransitionFailure("spawn_not_found");

  const transition = resolveCompletionTransition(session, state, options);
  if (!transition.ok) return transition;

  updateChildStatus(session, transition.childAgentId, transition.status);
  recordChildFailureCompletion(session, transition.childAgentId, transition.status);
  recordObsAgentsTreeState(session);
  const attributes = buildSubagentCompletionAttributes(
    session,
    spawnId,
    transition.childAgentId,
    transition.status,
    state.spawnReason,
  );
  const eventName = terminalSpawnEventName(transition.status);
  const severityText = transition.status === "completed" ? "INFO" : "ERROR";

  recordSubagentSpawnDuration(session, state, options);
  state.span.setAttributes(attributes);
  setTerminalSpawnStatus(state.span, transition.status);
  state.span.addEvent(eventName, attributes);
  endSubagentSpan(session, state.span);
  session.spans.activeSubagentSpawns.delete(spawnId);
  emitSubagentLog(session, eventName, attributes, severityText);
  return subagentTransitionSuccess();
}

export function failSubagentSpawn(
  session: SubagentTelemetrySession,
  spawnId: string,
  options: FailSubagentSpawnOptions = {},
): SubagentTransitionResult {
  const state = session.spans.activeSubagentSpawns.get(spawnId);
  if (!state) return subagentTransitionFailure("spawn_not_found");

  const childAgentId = options.childAgentId ?? state.childAgentId;
  const transitionFailure = validateLauncherFailureTransition(session, state, childAgentId);
  if (transitionFailure) return transitionFailure;

  updateChildStatus(session, childAgentId, "failed");
  recordObsAgentsTreeState(session);
  const attributes = {
    ...buildSubagentCompletionAttributes(session, spawnId, childAgentId, "failed", state.spawnReason),
    [LOG_ATTRIBUTES.ERROR_TYPE]: normalizeMetricLabel(options.errorClass ?? "subagent_spawn_error", "subagent_spawn_error"),
  };

  recordSubagentSpawnDuration(session, state, options);
  state.span.setAttributes(attributes);
  state.span.setStatus({ code: SpanStatusCode.ERROR, message: String(attributes[LOG_ATTRIBUTES.ERROR_TYPE]) });
  state.span.addEvent(LOG_EVENT_NAMES.AGENT_SPAWN_FAILED, attributes);
  endSubagentSpan(session, state.span);
  session.spans.activeSubagentSpawns.delete(spawnId);
  session.metrics.subagentSpawnFailures.add(1, subagentFailureMetricLabels(state.labels, attributes));
  emitSubagentLog(session, LOG_EVENT_NAMES.AGENT_SPAWN_FAILED, attributes, "ERROR");
  return subagentTransitionSuccess();
}

export function buildSubagentPropagationEnvironment(
  options: BuildSubagentPropagationEnvironmentOptions,
): SubagentPropagationEnvironment {
  const baseEnv = options.env ?? process.env;
  const sanitizedBaseEnv = sanitizePropagationEnvironment(options.config, baseEnv);

  if (!options.config.workflow.enabled || !options.config.agent.propagateToSubagents) {
    return { env: sanitizedBaseEnv, traceContextPropagated: false };
  }

  const parentTraceId = options.spanContext?.traceId;
  const parentSpanId = options.spanContext?.spanId;
  const traceparent = buildTraceparent(options.config, options.spanContext);
  const tracestate = traceparent ? serializeTraceState(options.spanContext) : undefined;
  const propagatedParentTraceId = traceparent ? parentTraceId : undefined;
  const propagatedParentSpanId = traceparent ? parentSpanId : undefined;
  const env = sanitizeTraceContextEnvironment(
    {
      ...createPropagationEnvironment(options.lineage, options.config, sanitizedBaseEnv),
      ...definedEnvValue(options.config.agent.parentSessionIdEnv, options.parentSessionId),
      ...definedEnvValue(options.config.agent.parentTraceIdEnv, propagatedParentTraceId),
      ...definedEnvValue(options.config.agent.parentSpanIdEnv, propagatedParentSpanId),
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
    parentTraceId: propagatedParentTraceId,
    parentSpanId: propagatedParentSpanId,
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
): SubagentTransitionResult {
  return endWaitJoinSpan(session, waitId, options, "wait");
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
): SubagentTransitionResult {
  return endWaitJoinSpan(session, joinId, options, "join");
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
  const reason = normalizeWaitReason(options.reason, options, kind);
  const attributes = buildWaitJoinAttributes(session, options, reason);
  const spanName = kind === "wait" ? SPAN_NAMES.PI_AGENT_WAIT : SPAN_NAMES.PI_AGENT_JOIN;
  const eventName = kind === "wait" ? LOG_EVENT_NAMES.AGENT_WAIT_STARTED : LOG_EVENT_NAMES.AGENT_JOIN_STARTED;
  const operation = kind === "wait" ? "agent_wait" : "agent_join";
  const span = startActiveSubagentSpan(session, spanName, resolveSubagentParentSpan(session), attributes, operation);
  const labels = waitJoinMetricLabels(session, options, reason);
  const state = { span, startedAtMs: now(options), labels, reason };

  waitJoinRegistry(session, kind).set(id, state);
  recordObsAgentWaitJoinHint(createWaitJoinRuntimeHint(id, options, kind, reason, true));
  span.addEvent(eventName, attributes);
  emitSubagentLog(session, eventName, attributes);

  return { id, span, attributes };
}

function endWaitJoinSpan(
  session: SubagentTelemetrySession,
  id: string,
  options: AgentWaitJoinOptions,
  kind: "wait" | "join",
): SubagentTransitionResult {
  const registry = waitJoinRegistry(session, kind);
  const state = registry.get(id);
  if (!state) return subagentTransitionFailure("spawn_not_found");

  const transition = validateWaitJoinTransition(session, options, kind);
  if (!transition.ok) return transition;
  if (kind === "join" && options.childAgentId && options.childStatus) updateChildStatus(session, options.childAgentId, options.childStatus);

  const attributes = buildWaitJoinAttributes(session, options, state.reason);
  const eventName = kind === "wait" ? LOG_EVENT_NAMES.AGENT_WAIT_COMPLETED : LOG_EVENT_NAMES.AGENT_JOIN_COMPLETED;
  const durationMs = resolveDurationMs(state, options);

  state.span.setAttributes(attributes);
  if (waitJoinFailed(options)) state.span.setStatus({ code: SpanStatusCode.ERROR, message: options.joinStatus ?? options.childStatus });
  state.span.addEvent(eventName, attributes);
  endSubagentSpan(session, state.span);
  registry.delete(id);
  recordObsAgentWaitJoinHint(createWaitJoinRuntimeHint(id, options, kind, state.reason, false, durationMs));
  recordObsAgentsTreeState(session);
  recordWaitJoinDuration(session, durationMs, state.labels, kind);
  if (kind === "join") recordChildJoinAccounting(session, options);
  emitSubagentLog(session, eventName, attributes, waitJoinFailed(options) ? "ERROR" : "INFO");
  return subagentTransitionSuccess();
}

function validateWaitJoinTransition(
  session: SubagentTelemetrySession,
  options: AgentWaitJoinOptions,
  kind: "wait" | "join",
): SubagentTransitionResult {
  if (kind === "wait" || !options.childAgentId || !options.childStatus) return subagentTransitionSuccess();

  if (options.spawnId) {
    const spawn = session.spans.activeSubagentSpawns.get(options.spawnId);
    if (spawn && spawn.childAgentId !== options.childAgentId) {
      return subagentTransitionFailure("child_agent_mismatch");
    }
  }

  const child = ensureAgentTree(session).getAgent(options.childAgentId);
  if (child && !isAgentStatusTransitionAllowed(child.status, options.childStatus)) {
    return subagentTransitionFailure("invalid_terminal_transition");
  }
  return subagentTransitionSuccess();
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

function recordSubagentSpawnDuration(
  session: SubagentTelemetrySession,
  state: SubagentSpawnState,
  options: { readonly now?: () => number },
): void {
  session.metrics.subagentSpawnDurationMs.record(Math.max(0, now(options) - state.startedAtMs), state.labels);
}

function recordChildFailureCompletion(
  session: SubagentTelemetrySession,
  childAgentId: string,
  childStatus: AgentTerminalStatus,
): void {
  if (childStatus !== "failed") return;
  recordChildFailureAccounting(session, childAgentId, false);
}

function recordChildJoinAccounting(
  session: SubagentTelemetrySession,
  options: AgentWaitJoinOptions,
): void {
  if (!options.childAgentId || options.childStatus !== "failed") return;

  const recoveryConfirmed = options.failurePropagated === false && options.joinStatus === "completed";
  recordChildFailureAccounting(session, options.childAgentId, recoveryConfirmed);
}

function recordChildFailureAccounting(
  session: SubagentTelemetrySession,
  childAgentId: string,
  recoveryConfirmed: boolean,
): void {
  const registry = ensureChildFailureAccounting(session);
  const current = registry.get(childAgentId);
  const labels = childFailureMetricLabels(session);
  const failureRecorded = current?.failureRecorded === true;
  const recoveryRecorded = current?.recoveryRecorded === true;

  if (!failureRecorded) session.metrics.childAgentFailures.add(1, labels);
  if (recoveryConfirmed && !recoveryRecorded) session.metrics.parentRecoveredFromChildFailure.add(1, labels);

  registry.set(childAgentId, {
    failureRecorded: true,
    recoveryRecorded: recoveryRecorded || recoveryConfirmed,
  });
}

function ensureChildFailureAccounting(
  session: SubagentTelemetrySession,
): BoundedMap<string, ChildFailureAccountingState> {
  if (session.childFailureAccounting) return session.childFailureAccounting;

  session.childFailureAccounting = new BoundedMap({
    maxSize: Math.max(1, session.config.limits.maxActiveSubagentSpawns),
  });
  return session.childFailureAccounting;
}

function childFailureMetricLabels(session: SubagentTelemetrySession): Record<string, string> {
  return {
    agent_role: session.lineage.role,
    subagent_depth: subagentDepthLabel(session),
  };
}

function buildWaitJoinAttributes(
  session: SubagentTelemetrySession,
  options: AgentWaitJoinOptions,
  reason: AgentWaitReason,
): AttributeMap {
  const summary = ensureAgentTree(session).summarize(session.lineage.rootAgentId);

  return withoutUndefinedAttributes({
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILD_ID]: options.childAgentId,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_SPAWN_ID]: options.spawnId,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_WAIT_REASON]: reason,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_JOIN_STATUS]: options.joinStatus ?? "waiting",
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILD_STATUS]: options.childStatus ?? "active",
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_FAILURE_PROPAGATED]: options.failurePropagated ?? false,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILDREN_ACTIVE]: summary.activeChildren,
    [AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILD_COUNT]: summary.fanoutCount,
  });
}

function waitJoinMetricLabels(
  session: SubagentTelemetrySession,
  options: AgentWaitJoinOptions,
  reason: AgentWaitReason,
): Record<string, string> {
  return {
    agent_role: session.lineage.role,
    subagent_depth: subagentDepthLabel(session),
    status: normalizeWaitJoinStatus(options.joinStatus ?? options.childStatus ?? "waiting"),
    reason,
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
  spawnReason: SubagentSpawnReason,
): AttributeMap {
  return withoutUndefinedAttributes({
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_ID]: spawnId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_TYPE]: normalizeSpawnType(options.spawnType),
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_REASON]: spawnReason,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_TOOL_CALL_ID]: options.toolCallId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_COMMAND_HASH]: hashCommand(options.command, options.args, session.config),
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

function resolveCompletionTransition(
  session: SubagentTelemetrySession,
  state: SubagentSpawnState,
  options: CompleteSubagentSpawnOptions,
): CompletionTransitionResult {
  const childAgentId = options.childAgentId ?? state.childAgentId;
  const requestedStatus: unknown = options.childStatus ?? options.outcome ?? "completed";
  if (!isAgentTerminalStatus(requestedStatus)) return subagentTransitionFailure("invalid_terminal_transition");
  if (options.childStatus !== undefined && options.outcome !== undefined && options.childStatus !== options.outcome) {
    return subagentTransitionFailure("invalid_terminal_transition");
  }

  const transitionFailure = validateSpawnChildTransition(session, state, childAgentId, requestedStatus);
  if (transitionFailure) return transitionFailure;
  return { ok: true, childAgentId, status: requestedStatus };
}

function validateSpawnChildTransition(
  session: SubagentTelemetrySession,
  state: SubagentSpawnState,
  childAgentId: string,
  status: AgentTerminalStatus,
): Extract<SubagentTransitionResult, { readonly ok: false }> | undefined {
  if (childAgentId !== state.childAgentId) return subagentTransitionFailure("child_agent_mismatch");

  const child = ensureAgentTree(session).getAgent(childAgentId);
  if (!child || !isAgentStatusTransitionAllowed(child.status, status)) {
    return subagentTransitionFailure("invalid_terminal_transition");
  }
  return undefined;
}

function validateLauncherFailureTransition(
  session: SubagentTelemetrySession,
  state: SubagentSpawnState,
  childAgentId: string,
): Extract<SubagentTransitionResult, { readonly ok: false }> | undefined {
  if (childAgentId !== state.childAgentId) return subagentTransitionFailure("child_agent_mismatch");

  const child = ensureAgentTree(session).getAgent(childAgentId);
  if (child?.status !== "starting") return subagentTransitionFailure("invalid_terminal_transition");
  return undefined;
}

function isAgentTerminalStatus(value: unknown): value is AgentTerminalStatus {
  return value === "completed" || value === "failed" || value === "cancelled";
}

function terminalSpawnEventName(status: AgentTerminalStatus): string {
  if (status === "completed") return LOG_EVENT_NAMES.AGENT_SPAWN_COMPLETED;
  if (status === "failed") return LOG_EVENT_NAMES.AGENT_SPAWN_FAILED;
  return LOG_EVENT_NAMES.AGENT_SPAWN_CANCELLED;
}

function setTerminalSpawnStatus(span: Span, status: AgentTerminalStatus): void {
  if (status === "completed") {
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message: status });
}

function subagentTransitionSuccess(): SubagentTransitionResult {
  return { ok: true };
}

function subagentTransitionFailure(
  reason: SubagentTransitionFailureReason,
): Extract<SubagentTransitionResult, { readonly ok: false }> {
  return { ok: false, reason };
}

function buildSubagentCompletionAttributes(
  session: SubagentTelemetrySession,
  spawnId: string,
  childAgentId: string,
  outcome: AgentTerminalStatus,
  spawnReason: SubagentSpawnReason,
): AttributeMap {
  const summary = ensureAgentTree(session).summarize(session.lineage.rootAgentId);

  return withoutUndefinedAttributes({
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_ID]: spawnId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_CHILD_ID]: childAgentId,
    [AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_REASON]: spawnReason,
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
  reason: AgentWaitReason,
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
    reason,
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
): AgentTreeNode | undefined {
  return ensureAgentTree(session).updateStatus(childAgentId, status);
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
  spawnReason: SubagentSpawnReason,
): Record<string, string> {
  return {
    agent_role: session.lineage.role,
    subagent_depth: subagentDepthLabel(session),
    spawn_type: normalizeSpawnType(options.spawnType),
    spawn_reason: spawnReason,
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

function normalizeSpawnReason(value: unknown): SubagentSpawnReason {
  if (SUBAGENT_SPAWN_REASON_VALUES.includes(value as SubagentSpawnReason)) return value as SubagentSpawnReason;
  return "unknown";
}

function normalizeWaitReason(
  value: unknown,
  options: AgentWaitJoinOptions,
  kind: "wait" | "join",
): AgentWaitReason {
  if (AGENT_WAIT_REASON_VALUES.includes(value as AgentWaitReason)) return value as AgentWaitReason;
  if (value === undefined && isWaitingForActiveChild(options, kind)) return "child_running";
  return "unknown";
}

function isWaitingForActiveChild(options: AgentWaitJoinOptions, kind: "wait" | "join"): boolean {
  if (options.childStatus !== "active") return false;
  return kind === "wait" || options.joinStatus === "waiting";
}

function normalizeWaitJoinStatus(value: unknown): WaitJoinMetricStatus {
  if (waitJoinMetricStatusValues.includes(value as WaitJoinMetricStatus)) return value as WaitJoinMetricStatus;
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
  } catch {
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
  return session.sessionAttributes?.[SESSION_ATTRIBUTES.PI_SESSION_ID]?.toString() ?? `session-${session.lineage.workflowId}`;
}

function hashCommand(command: string | undefined, args: readonly string[] | undefined, config: ObservMeConfig): string | undefined {
  if (command === undefined) return undefined;
  return trySha256(`${command}\0${(args ?? []).join("\0")}`, config);
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

  delete sanitized.traceparent;
  delete sanitized.tracestate;
  delete sanitized.TRACEPARENT;
  delete sanitized.TRACESTATE;

  if (!traceparent) return sanitized;

  sanitized.traceparent = traceparent;
  if (tracestate) sanitized.tracestate = tracestate;
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
