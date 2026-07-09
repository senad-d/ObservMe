import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { buildLineageAttributes, createAgentLineageContext } from "../src/pi/agent-lineage.ts";
import { AgentTreeTracker, assertNoHighCardinalityMetricLabels } from "../src/pi/agent-tree-tracker.ts";
import type { AgentWaitJoinState, SubagentSpawnState } from "../src/pi/subagent-spawn.ts";
import {
  completeSubagentSpawn,
  endAgentJoin,
  endAgentWait,
  observeTrustedSubagentLineage,
  startAgentJoin,
  startAgentWait,
  startSubagentSpawn,
} from "../src/pi/subagent-spawn.ts";
import { AGENT_SPAWN_ATTRIBUTES, AGENT_WAIT_JOIN_ATTRIBUTES } from "../src/semconv/attributes.ts";
import {
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_GAUGE_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
} from "../src/semconv/metrics.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";
import { BoundedMap } from "../src/util/bounded-map.ts";
import { isPlainRecord, mergeRecordConfig } from "./support/telemetry-types.ts";
import type { TestAttributes, TestLogger, TestMetricRecord, TestSpan, TestSpanContext } from "./support/telemetry-types.ts";

const validSpanContext: TestSpanContext = {
  traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  spanId: "bbbbbbbbbbbbbbbb",
  traceFlags: 1,
};
const sensitiveIdentityInputs = [
  "alice",
  "/Users/alice/customer-secret/project",
  "summarize private customer incident",
  "pi subagent --prompt private customer incident",
  "host-prod-17",
];
const forbiddenMetricLabelValues = ["workflow-unit", "agent-root", "agent-parent", "agent-child", "spawn-unit"];
const staleTraceparent = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01";
const expectedTraceparent = `00-${validSpanContext.traceId}-${validSpanContext.spanId}-01`;

function cloneConfig(overrides: Record<string, unknown> = {}) {
  return mergeConfig(structuredClone(defaultObservMeConfig), overrides);
}

function mergeConfig<T extends Record<string, unknown>>(base: T, overlay: Record<string, unknown>): T {
  return mergeRecordConfig(base, overlay);
}

function generatedIdFactory() {
  let nextId = 0;

  return () => {
    nextId += 1;
    return `generated-${nextId}`;
  };
}

function makeRootLineage(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: "workflow-unit",
    workflowRootAgentId: "agent-root",
    agentId: "agent-root",
    rootAgentId: "agent-root",
    depth: 0,
    role: "root" as const,
    orphaned: false,
    ...overrides,
  };
}

function createRecordingMetrics(records: TestMetricRecord[]) {
  return {
    subagentsSpawned: createCounter(records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL),
    subagentSpawnFailures: createCounter(records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL),
    orphanAgents: createCounter(records, OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL),
    traceContextPropagationFailures: createCounter(
      records,
      OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL,
    ),
    activeSpans: createUpDownCounter(records, OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_SPANS),
    agentFanoutCount: createHistogram(records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_FANOUT_COUNT),
    agentTreeDepth: createHistogram(records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_DEPTH),
    agentTreeWidth: createHistogram(records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_WIDTH),
    agentWaitDurationMs: createHistogram(records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS),
    agentJoinDurationMs: createHistogram(records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_JOIN_DURATION_MS),
  };
}

function createCounter(records: TestMetricRecord[], name: string) {
  return {
    add: (value: number, attributes: TestAttributes = {}) => records.push({ type: "counter", name, value, attributes }),
  };
}

function createUpDownCounter(records: TestMetricRecord[], name: string) {
  return {
    add: (value: number, attributes: TestAttributes = {}) => records.push({ type: "upDownCounter", name, value, attributes }),
  };
}

function createHistogram(records: TestMetricRecord[], name: string) {
  return {
    record: (value: number, attributes: TestAttributes = {}) => records.push({ type: "histogram", name, value, attributes }),
  };
}

function createFakeTracer(spanContext: TestSpanContext = validSpanContext) {
  const spans: TestSpan[] = [];

  return {
    spans,
    startSpan: (name: string, options: { attributes?: TestAttributes } = {}) => {
      const span = createFakeSpan(name, options.attributes ?? {}, spanContext);
      spans.push(span);
      return span;
    },
  };
}

function createFakeSpan(name: string, attributes: TestAttributes, spanContext: TestSpanContext = validSpanContext): TestSpan {
  const span: TestSpan = {
    name,
    attributes: { ...attributes },
    events: [],
    status: undefined,
    ended: false,
    addEvent(eventName: string, eventAttributes: unknown = {}) {
      span.events.push({ name: eventName, attributes: isPlainRecord(eventAttributes) ? eventAttributes : {} });
      return span;
    },
    setAttribute(key: string, value: unknown) {
      span.attributes[key] = value;
      return span;
    },
    setAttributes(values: TestAttributes) {
      Object.assign(span.attributes, values);
      return span;
    },
    setStatus(status: unknown) {
      span.status = status;
      return span;
    },
    spanContext() {
      return spanContext;
    },
    addLink() {
      return span;
    },
    addLinks() {
      return span;
    },
    updateName() {
      return span;
    },
    isRecording() {
      return true;
    },
    recordException() {
      return undefined;
    },
    end() {
      span.ended = true;
    },
  };

  return span;
}

function createFakeLogger(): TestLogger {
  const records: TestLogger["records"] = [];

  return {
    records,
    emit: record => {
      records.push(record as TestLogger["records"][number]);
    },
  };
}

function createSpanRegistry() {
  return {
    activeAgentRuns: new BoundedMap<string, ReturnType<typeof createFakeSpan>>({ maxSize: 8 }),
    activeTurns: new BoundedMap<string, ReturnType<typeof createFakeSpan>>({ maxSize: 8 }),
    activeSubagentSpawns: new BoundedMap<string, SubagentSpawnState>({ maxSize: 8 }),
    activeAgentWaits: new BoundedMap<string, AgentWaitJoinState>({ maxSize: 8 }),
    activeAgentJoins: new BoundedMap<string, AgentWaitJoinState>({ maxSize: 8 }),
  };
}

interface SubagentSessionOptions {
  readonly config?: ReturnType<typeof cloneConfig>;
  readonly lineage?: ReturnType<typeof makeRootLineage> | ReturnType<typeof createAgentLineageContext>;
  readonly spanContext?: typeof validSpanContext;
}

function createSubagentSession(options: SubagentSessionOptions = {}) {
  const config = options.config ?? cloneConfig();
  const lineage = options.lineage ?? makeRootLineage();
  const metricRecords: TestMetricRecord[] = [];
  const agentTree = new AgentTreeTracker({ maxAgents: 16 });
  const sessionSpan = createFakeSpan(SPAN_NAMES.PI_SESSION, {}, options.spanContext ?? validSpanContext);

  agentTree.registerAgent(lineage);

  return {
    config,
    lineage,
    tracer: createFakeTracer(options.spanContext ?? validSpanContext),
    logger: createFakeLogger(),
    metrics: createRecordingMetrics(metricRecords),
    spans: createSpanRegistry(),
    sessionSpan,
    sessionAttributes: { "pi.session.id": "session-lineage-unit" },
    agentTree,
    metricRecords,
  };
}

function metricSum(records: readonly TestMetricRecord[], metricName: string, predicate?: (record: TestMetricRecord) => boolean): number {
  let total = 0;

  for (const record of records) {
    if (record.name !== metricName) continue;
    if (predicate && !predicate(record)) continue;
    total += record.value;
  }

  return total;
}

function metricValues(records: readonly TestMetricRecord[], metricName: string): number[] {
  return records.filter(record => record.name === metricName).map(record => record.value);
}

function findSpan(session: ReturnType<typeof createSubagentSession>, spanName: string): TestSpan | undefined {
  return session.tracer.spans.find(span => span.name === spanName);
}

function assertNoUnsafeMetricLabels(records: readonly TestMetricRecord[]): void {
  for (const record of records) {
    assertNoHighCardinalityMetricLabels(stringMetricAttributes(record.attributes));
    assertNoForbiddenLineageLabelValues(record);
  }
}

function stringMetricAttributes(attributes: TestAttributes): Record<string, string> {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
}

function assertNoForbiddenLineageLabelValues(record: TestMetricRecord): void {
  for (const value of Object.values(record.attributes ?? {})) {
    assert.equal(forbiddenMetricLabelValues.includes(String(value)), false, `${record.name} leaked lineage label ${value}`);
  }
}

function stalePropagationEnvironment(): NodeJS.ProcessEnv {
  return {
    OBSERVME_WORKFLOW_ID: "workflow-stale",
    OBSERVME_AGENT_ID: "agent-stale",
    OBSERVME_PARENT_AGENT_ID: "parent-stale",
    OBSERVME_ROOT_AGENT_ID: "root-stale",
    OBSERVME_PARENT_SESSION_ID: "session-stale",
    OBSERVME_PARENT_TRACE_ID: "cccccccccccccccccccccccccccccccc",
    OBSERVME_PARENT_SPAN_ID: "dddddddddddddddd",
    OBSERVME_AGENT_DEPTH: "41",
    OBSERVME_SPAWN_ID: "spawn-stale",
    OBSERVME_AGENT_CAPABILITY: "capability-stale",
    traceparent: staleTraceparent,
    tracestate: "stale=state",
    TRACEPARENT: staleTraceparent,
    TRACESTATE: "upper=stale",
    SAFE_ENV: "kept",
  };
}

test("workflow and agent IDs are generated and never derived from sensitive local identity inputs", () => {
  const lineage = createAgentLineageContext({
    config: defaultObservMeConfig,
    env: {
      USER: "alice",
      PWD: "/Users/alice/customer-secret/project",
      OBSERVME_WORKFLOW_ID: "workflow-from-untrusted-parent",
      OBSERVME_AGENT_ID: "agent-from-untrusted-parent",
      PROMPT: "summarize private customer incident",
      COMMAND_LINE: "pi subagent --prompt private customer incident",
      HOSTNAME: "host-prod-17",
    },
    trustedParentContext: false,
    generateId: generatedIdFactory(),
  });

  assert.equal(lineage.agentId, "agent-generated-1");
  assert.equal(lineage.workflowId, "workflow-generated-2");
  assert.equal(lineage.rootAgentId, lineage.agentId);
  assert.equal(lineage.workflowRootAgentId, lineage.agentId);

  const exportedIdentity = JSON.stringify(buildLineageAttributes(lineage));
  for (const sensitiveInput of sensitiveIdentityInputs) assert.equal(exportedIdentity.includes(sensitiveInput), false);
});

test("subagent without W3C trace context still propagates safe workflow, parent, and root lineage", () => {
  const session = createSubagentSession({ config: cloneConfig({ agent: { propagateTraceContext: false } }) });
  const started = startSubagentSpawn(session, { spawnId: "spawn-unit-no-context", spawnType: "command" });
  const observed = observeTrustedSubagentLineage(session, started.env, { generateId: () => "observed-child" });

  assert.equal(started.traceContextPropagated, false);
  assert.equal(started.env.traceparent, undefined);
  assert.equal(started.env.OBSERVME_WORKFLOW_ID, "workflow-unit");
  assert.equal(started.env.OBSERVME_PARENT_AGENT_ID, "agent-root");
  assert.equal(started.env.OBSERVME_ROOT_AGENT_ID, "agent-root");
  assert.equal(observed?.workflowId, "workflow-unit");
  assert.equal(observed?.parentAgentId, "agent-root");
  assert.equal(observed?.rootAgentId, "agent-root");
  assert.equal(observed?.orphaned, false);
  assert.equal(metricSum(session.metricRecords, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL), 1);
  assertNoUnsafeMetricLabels(session.metricRecords);
});

test("subagent propagation clears stale ObservMe and W3C context when trace propagation is disabled", () => {
  const session = createSubagentSession({ config: cloneConfig({ agent: { propagateTraceContext: false } }) });
  const started = startSubagentSpawn(session, {
    spawnId: "spawn-current-disabled-context",
    spawnType: "command",
    env: stalePropagationEnvironment(),
  });
  const observedLineage = createAgentLineageContext({
    config: session.config,
    env: started.env,
    trustedParentContext: true,
    generateId: () => "observed-child",
  });
  const observed = observeTrustedSubagentLineage(session, started.env, { generateId: () => "observed-child" });

  assert.equal(started.traceContextPropagated, false);
  assert.equal(started.env.SAFE_ENV, "kept");
  assert.equal(started.env.OBSERVME_WORKFLOW_ID, "workflow-unit");
  assert.equal(started.env.OBSERVME_PARENT_AGENT_ID, "agent-root");
  assert.equal(started.env.OBSERVME_ROOT_AGENT_ID, "agent-root");
  assert.equal(started.env.OBSERVME_PARENT_SESSION_ID, "session-lineage-unit");
  assert.equal(started.env.OBSERVME_SPAWN_ID, "spawn-current-disabled-context");
  assert.equal(started.env.OBSERVME_AGENT_ID, undefined);
  assert.equal(started.env.OBSERVME_PARENT_TRACE_ID, undefined);
  assert.equal(started.env.OBSERVME_PARENT_SPAN_ID, undefined);
  assert.equal(started.env.traceparent, undefined);
  assert.equal(started.env.tracestate, undefined);
  assert.equal(started.env.TRACEPARENT, undefined);
  assert.equal(started.env.TRACESTATE, undefined);
  assert.equal(observedLineage.agentId, "agent-observed-child");
  assert.equal(observedLineage.parentAgentId, "agent-root");
  assert.equal(observedLineage.rootAgentId, "agent-root");
  assert.equal(observedLineage.spawnId, "spawn-current-disabled-context");
  assert.equal(observedLineage.parentTraceId, undefined);
  assert.equal(observedLineage.parentSpanId, undefined);
  assert.equal(observed?.agentId, observedLineage.agentId);
  assertNoUnsafeMetricLabels(session.metricRecords);
});

test("nested subagent propagation replaces stale inherited context with current lineage", () => {
  const config = cloneConfig();
  const rootSession = createSubagentSession({ config });
  const childStarted = startSubagentSpawn(rootSession, { spawnId: "spawn-child-current", env: stalePropagationEnvironment() });
  const childLineage = createAgentLineageContext({
    config,
    env: childStarted.env,
    trustedParentContext: true,
    generateId: () => "child-generated",
  });
  const childSession = createSubagentSession({ config, lineage: childLineage });
  const grandchildStarted = startSubagentSpawn(childSession, {
    spawnId: "spawn-grandchild-current",
    env: { ...childStarted.env, ...stalePropagationEnvironment() },
  });
  const grandchildLineage = observeTrustedSubagentLineage(childSession, grandchildStarted.env, {
    generateId: () => "grandchild-generated",
  });

  assert.equal(childStarted.env.OBSERVME_AGENT_ID, undefined);
  assert.equal(childStarted.env.traceparent, expectedTraceparent);
  assert.equal(childStarted.env.TRACEPARENT, undefined);
  assert.equal(childLineage.agentId, "agent-child-generated");
  assert.equal(grandchildStarted.env.OBSERVME_WORKFLOW_ID, childLineage.workflowId);
  assert.equal(grandchildStarted.env.OBSERVME_PARENT_AGENT_ID, childLineage.agentId);
  assert.equal(grandchildStarted.env.OBSERVME_ROOT_AGENT_ID, childLineage.rootAgentId);
  assert.equal(grandchildStarted.env.OBSERVME_AGENT_DEPTH, String(childLineage.depth));
  assert.equal(grandchildStarted.env.OBSERVME_SPAWN_ID, "spawn-grandchild-current");
  assert.equal(grandchildStarted.env.OBSERVME_AGENT_ID, undefined);
  assert.equal(grandchildStarted.env.OBSERVME_PARENT_TRACE_ID, validSpanContext.traceId);
  assert.equal(grandchildStarted.env.OBSERVME_PARENT_SPAN_ID, validSpanContext.spanId);
  assert.equal(grandchildStarted.env.traceparent, expectedTraceparent);
  assert.equal(grandchildStarted.env.tracestate, undefined);
  assert.equal(grandchildStarted.env.TRACEPARENT, undefined);
  assert.equal(grandchildStarted.env.TRACESTATE, undefined);
  assert.equal(grandchildLineage?.agentId, "agent-grandchild-generated");
  assert.equal(grandchildLineage?.parentAgentId, childLineage.agentId);
  assert.equal(grandchildLineage?.rootAgentId, childLineage.rootAgentId);
  assert.equal(grandchildLineage?.depth, childLineage.depth + 1);
  assertNoUnsafeMetricLabels(rootSession.metricRecords);
  assertNoUnsafeMetricLabels(childSession.metricRecords);
});

test("malformed propagated lineage records failure telemetry without raw inherited environment values", () => {
  const session = createSubagentSession();
  const observed = observeTrustedSubagentLineage(session, {
    OBSERVME_WORKFLOW_ID: "bad/workflow",
    OBSERVME_AGENT_ID: "agent-stale-secret",
    COMMAND_LINE: "pi subagent --prompt private customer incident",
  });
  const serializedLogs = JSON.stringify(session.logger.records);

  assert.equal(observed, undefined);
  assert.equal(metricSum(session.metricRecords, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL), 1);
  assert.equal(serializedLogs.includes("bad/workflow"), false);
  assert.equal(serializedLogs.includes("agent-stale-secret"), false);
  assert.equal(serializedLogs.includes("private customer incident"), false);
  assertNoUnsafeMetricLabels(session.metricRecords);
});

test("missing lineage context is classified as root-like, while partial parent context is classified as orphan", () => {
  const session = createSubagentSession();
  const rootLike = observeTrustedSubagentLineage(session, {}, { generateId: generatedIdFactory() });
  const orphan = observeTrustedSubagentLineage(
    session,
    {
      OBSERVME_WORKFLOW_ID: "workflow-unit",
      OBSERVME_PARENT_AGENT_ID: "agent-parent-missing",
      OBSERVME_AGENT_DEPTH: "0",
    },
    { generateId: () => "agent-orphan" },
  );

  assert.equal(rootLike?.parentAgentId, undefined);
  assert.equal(rootLike?.rootAgentId, rootLike?.agentId);
  assert.equal(rootLike?.depth, 0);
  assert.equal(rootLike?.orphaned, false);
  assert.equal(orphan?.parentAgentId, "agent-parent-missing");
  assert.equal(orphan?.rootAgentId, "agent-agent-orphan");
  assert.equal(orphan?.status, "orphaned");
  assert.equal(orphan?.orphaned, true);
  assert.equal(metricSum(session.metricRecords, OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL), 1);
  assertNoUnsafeMetricLabels(session.metricRecords);
});

test("fan-out, depth, active-child, wait/join, child-status, and propagation metrics stay low-cardinality", () => {
  const session = createSubagentSession();
  const first = startSubagentSpawn(session, { spawnId: "spawn-unit-a", spawnType: "command", spawnReason: "review" });
  const second = startSubagentSpawn(session, { spawnId: "spawn-unit-b", spawnType: "tool", spawnReason: "analysis" });
  const wait = startAgentWait(session, {
    spawnId: second.spawnId,
    childAgentId: second.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
    now: () => 100,
  });

  endAgentWait(session, wait.id, {
    spawnId: second.spawnId,
    childAgentId: second.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
    durationMs: 42,
  });
  completeSubagentSpawn(session, first.spawnId, { childAgentId: first.childAgentId, childStatus: "completed" });

  const join = startAgentJoin(session, {
    spawnId: second.spawnId,
    childAgentId: second.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
    now: () => 200,
  });

  endAgentJoin(session, join.id, {
    spawnId: second.spawnId,
    childAgentId: second.childAgentId,
    childStatus: "failed",
    joinStatus: "failed",
    failurePropagated: true,
    durationMs: 55,
  });

  const summary = session.agentTree.summarize(session.lineage.rootAgentId);
  const waitSpan = findSpan(session, SPAN_NAMES.PI_AGENT_WAIT);
  const joinSpan = findSpan(session, SPAN_NAMES.PI_AGENT_JOIN);

  assert.equal(metricSum(session.metricRecords, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL), 2);
  assert.deepEqual(metricValues(session.metricRecords, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS), [42]);
  assert.deepEqual(metricValues(session.metricRecords, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_JOIN_DURATION_MS), [55]);
  assert.ok(metricValues(session.metricRecords, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_FANOUT_COUNT).some(value => value >= 2));
  assert.ok(metricValues(session.metricRecords, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_DEPTH).some(value => value >= 1));
  assert.equal(summary.fanoutCount, 2);
  assert.equal(summary.treeDepth, 1);
  assert.equal(summary.childStatuses.completed, 1);
  assert.equal(summary.childStatuses.failed, 1);
  assert.equal(summary.activeChildren, 0);
  assert.equal(waitSpan?.attributes[AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILDREN_ACTIVE], 2);
  assert.equal(waitSpan?.attributes[AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILD_COUNT], 2);
  assert.equal(joinSpan?.attributes[AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILDREN_ACTIVE], 0);
  assert.equal(joinSpan?.attributes[AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILD_STATUS], "failed");
  assert.equal(joinSpan?.attributes[AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_FAILURE_PROPAGATED], true);
  assert.equal(first.span.attributes?.[AGENT_SPAWN_ATTRIBUTES.PI_AGENT_CHILDREN_ACTIVE], 2);
  assertNoUnsafeMetricLabels(session.metricRecords);
});
