import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { buildLineageAttributes, createAgentLineageContext } from "../src/pi/agent-lineage.ts";
import { AgentTreeTracker, assertNoHighCardinalityMetricLabels } from "../src/pi/agent-tree-tracker.ts";
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
  OBSERVME_HISTOGRAM_METRIC_NAMES,
} from "../src/semconv/metrics.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";
import { BoundedMap } from "../src/util/bounded-map.ts";

const validSpanContext = {
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

function cloneConfig(overrides = {}) {
  return mergeConfig(structuredClone(defaultObservMeConfig), overrides);
}

function mergeConfig(base, overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(base[key]) && isPlainObject(value)) {
      mergeConfig(base[key], value);
      continue;
    }

    base[key] = value;
  }

  return base;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generatedIdFactory() {
  let nextId = 0;

  return () => {
    nextId += 1;
    return `generated-${nextId}`;
  };
}

function makeRootLineage(overrides = {}) {
  return {
    workflowId: "workflow-unit",
    workflowRootAgentId: "agent-root",
    agentId: "agent-root",
    rootAgentId: "agent-root",
    depth: 0,
    role: "root",
    orphaned: false,
    ...overrides,
  };
}

function createRecordingMetrics(records) {
  return {
    subagentsSpawned: createCounter(records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL),
    subagentSpawnFailures: createCounter(records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL),
    orphanAgents: createCounter(records, OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL),
    traceContextPropagationFailures: createCounter(
      records,
      OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL,
    ),
    agentFanoutCount: createHistogram(records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_FANOUT_COUNT),
    agentTreeDepth: createHistogram(records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_DEPTH),
    agentTreeWidth: createHistogram(records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_WIDTH),
    agentWaitDurationMs: createHistogram(records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS),
    agentJoinDurationMs: createHistogram(records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_JOIN_DURATION_MS),
  };
}

function createCounter(records, name) {
  return {
    add: (value, attributes = {}) => records.push({ type: "counter", name, value, attributes }),
  };
}

function createHistogram(records, name) {
  return {
    record: (value, attributes = {}) => records.push({ type: "histogram", name, value, attributes }),
  };
}

function createFakeTracer(spanContext = validSpanContext) {
  const spans = [];

  return {
    spans,
    startSpan: (name, options = {}) => {
      const span = createFakeSpan(name, options.attributes ?? {}, spanContext);
      spans.push(span);
      return span;
    },
  };
}

function createFakeSpan(name, attributes, spanContext = validSpanContext) {
  return {
    name,
    attributes: { ...attributes },
    events: [],
    status: undefined,
    ended: false,
    addEvent(eventName, eventAttributes = {}) {
      this.events.push({ name: eventName, attributes: eventAttributes });
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    setAttributes(values) {
      Object.assign(this.attributes, values);
    },
    setStatus(status) {
      this.status = status;
    },
    spanContext() {
      return spanContext;
    },
    end() {
      this.ended = true;
    },
  };
}

function createFakeLogger() {
  const records = [];

  return {
    records,
    emit: record => records.push(record),
  };
}

function createSpanRegistry() {
  return {
    activeAgentRuns: new BoundedMap({ maxSize: 8 }),
    activeTurns: new BoundedMap({ maxSize: 8 }),
    activeSubagentSpawns: new BoundedMap({ maxSize: 8 }),
    activeAgentWaits: new BoundedMap({ maxSize: 8 }),
    activeAgentJoins: new BoundedMap({ maxSize: 8 }),
  };
}

function createSubagentSession(options = {}) {
  const config = options.config ?? cloneConfig();
  const lineage = options.lineage ?? makeRootLineage();
  const metricRecords = [];
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

function metricSum(records, metricName, predicate = undefined) {
  let total = 0;

  for (const record of records) {
    if (record.name !== metricName) continue;
    if (predicate && !predicate(record)) continue;
    total += record.value;
  }

  return total;
}

function metricValues(records, metricName) {
  return records.filter(record => record.name === metricName).map(record => record.value);
}

function findSpan(session, spanName) {
  return session.tracer.spans.find(span => span.name === spanName);
}

function assertNoUnsafeMetricLabels(records) {
  for (const record of records) {
    assertNoHighCardinalityMetricLabels(record.attributes ?? {});
    assertNoForbiddenLineageLabelValues(record);
  }
}

function assertNoForbiddenLineageLabelValues(record) {
  for (const value of Object.values(record.attributes ?? {})) {
    assert.equal(forbiddenMetricLabelValues.includes(String(value)), false, `${record.name} leaked lineage label ${value}`);
  }
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
  assert.equal(first.span.attributes[AGENT_SPAWN_ATTRIBUTES.PI_AGENT_CHILDREN_ACTIVE], 2);
  assertNoUnsafeMetricLabels(session.metricRecords);
});
