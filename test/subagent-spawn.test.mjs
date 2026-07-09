import assert from "node:assert/strict";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { createObservMeMetrics, createSpanRegistry, createAgentTreeTracker } from "../src/pi/handlers.ts";
import { createAgentLineageContext } from "../src/pi/agent-lineage.ts";
import {
  failSubagentSpawn,
  observeTrustedSubagentLineage,
  recordAgentJoin,
  recordAgentWait,
  startSubagentSpawn,
} from "../src/pi/subagent-spawn.ts";
import {
  LOG_EVENT_NAMES,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
} from "../src/semconv/metrics.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";

process.env.OBSERVME_HASH_SALT = "subagent-spawn-test-salt";

const validSpanContext = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: 1,
};

const invalidSpanContext = {
  traceId: "00000000000000000000000000000000",
  spanId: "0000000000000000",
  traceFlags: 0,
};

function makeLineage(overrides = {}) {
  return {
    workflowId: "workflow-1",
    workflowRootAgentId: "agent-root",
    agentId: "agent-parent",
    rootAgentId: "agent-root",
    depth: 0,
    role: "root",
    orphaned: false,
    ...overrides,
  };
}

function createFakeMeter() {
  const records = [];
  return {
    records,
    createCounter: name => ({
      add: (value, attributes = {}) => records.push({ type: "counter", name, value, attributes }),
    }),
    createUpDownCounter: name => ({
      add: (value, attributes = {}) => records.push({ type: "upDownCounter", name, value, attributes }),
    }),
    createHistogram: name => ({
      record: (value, attributes = {}) => records.push({ type: "histogram", name, value, attributes }),
    }),
  };
}

function createFakeTracer(spanContext = validSpanContext) {
  const spans = [];
  return {
    spans,
    startSpan: (name, options = {}, parentContext) => {
      const span = createFakeSpan(name, options.attributes ?? {}, parentContext ? trace.getSpan(parentContext) : undefined, spanContext);
      spans.push(span);
      return span;
    },
  };
}

function createFakeSpan(name, attributes, parentSpan, spanContext) {
  return {
    name,
    attributes,
    parentSpan,
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

function createFakeTelemetry(options = {}) {
  const config = options.config ?? structuredClone(defaultObservMeConfig);
  const lineage = options.lineage ?? makeLineage();
  const meter = createFakeMeter();
  const tracer = createFakeTracer(options.spanContext ?? validSpanContext);
  const logger = createFakeLogger();
  const metrics = createObservMeMetrics(meter);
  const sessionSpan = tracer.startSpan(SPAN_NAMES.PI_SESSION, { attributes: { "pi.session.id": "session-1" } });

  return {
    config,
    lineage,
    tracer,
    meter,
    logger,
    metrics,
    spans: createSpanRegistry(config, metrics),
    agentTree: createAgentTreeTracker(config, lineage, metrics),
    sessionSpan,
    sessionAttributes: { "pi.session.id": "session-1" },
    activeAgentRecorded: false,
    agentRunSequence: 0,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences: new Map(),
  };
}

test("subagent spawn propagates W3C trace context and ObservMe lineage without exporting raw command or env values", () => {
  const telemetry = createFakeTelemetry();
  const started = startSubagentSpawn(telemetry, {
    spawnId: "spawn-1",
    command: "pi --prompt super-secret",
    args: ["--unsafe-arg"],
    spawnType: "command",
    spawnReason: "delegate",
    env: { PATH: "/usr/bin", SECRET_TOKEN: "top-secret-token" },
  });

  const childLineage = createAgentLineageContext({
    config: telemetry.config,
    env: started.env,
    trustedParentContext: true,
    generateId: () => "child-generated",
  });

  assert.equal(started.traceContextPropagated, true);
  assert.equal(started.env.traceparent, "00-11111111111111111111111111111111-2222222222222222-01");
  assert.equal(started.env.OBSERVME_WORKFLOW_ID, "workflow-1");
  assert.equal(started.env.OBSERVME_PARENT_AGENT_ID, "agent-parent");
  assert.equal(started.env.OBSERVME_ROOT_AGENT_ID, "agent-root");
  assert.equal(started.env.OBSERVME_PARENT_SESSION_ID, "session-1");
  assert.equal(started.env.OBSERVME_AGENT_DEPTH, "0");
  assert.equal(started.env.OBSERVME_SPAWN_ID, "spawn-1");
  assert.equal(childLineage.workflowId, "workflow-1");
  assert.equal(childLineage.parentAgentId, "agent-parent");
  assert.equal(childLineage.rootAgentId, "agent-root");
  assert.equal(childLineage.depth, 1);
  assert.equal(started.span.name, SPAN_NAMES.PI_AGENT_SPAWN);
  assert.equal(started.span.attributes["pi.agent.spawn.trace_context_propagated"], true);
  assert.match(started.span.attributes["pi.agent.spawn.command.hash"], /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(started.span.attributes), /super-secret|unsafe-arg|top-secret-token/u);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL, 1);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_FANOUT_COUNT, 1);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_DEPTH, 1);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_WIDTH, 1);
  assertSubagentMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL);
});

test("subagent spawn records fallback telemetry when W3C trace context cannot be propagated", () => {
  const telemetry = createFakeTelemetry({ spanContext: invalidSpanContext });
  const started = startSubagentSpawn(telemetry, { spawnId: "spawn-fallback", spawnType: "command" });
  const childLineage = createAgentLineageContext({
    config: telemetry.config,
    env: started.env,
    trustedParentContext: true,
    generateId: () => "child-fallback",
  });

  assert.equal(started.traceContextPropagated, false);
  assert.equal(started.env.traceparent, undefined);
  assert.equal(started.env.OBSERVME_WORKFLOW_ID, "workflow-1");
  assert.equal(childLineage.workflowId, "workflow-1");
  assert.equal(childLineage.parentAgentId, "agent-parent");
  assert.equal(childLineage.rootAgentId, "agent-root");
  assert.equal(started.span.attributes["pi.agent.spawn.trace_context_propagated"], false);
  assert.ok(started.span.events.some(event => event.name === LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED));
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED));
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL, 1);
});

test("malformed propagated lineage records a propagation failure and missing parent lineage records an orphan", () => {
  const telemetry = createFakeTelemetry();

  const malformed = observeTrustedSubagentLineage(telemetry, { OBSERVME_WORKFLOW_ID: "bad/workflow" });
  const orphan = observeTrustedSubagentLineage(
    telemetry,
    {
      OBSERVME_WORKFLOW_ID: "workflow-1",
      OBSERVME_PARENT_AGENT_ID: "missing-parent",
      OBSERVME_AGENT_DEPTH: "0",
    },
    { generateId: () => "orphan-generated" },
  );

  assert.equal(malformed, undefined);
  assert.equal(orphan.orphaned, true);
  assert.equal(orphan.status, "orphaned");
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL, 1);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL, 1);
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.AGENT_ORPHANED));
});

test("wait and join spans record child status, counts, durations, and spawn failures without high-cardinality metric labels", () => {
  const telemetry = createFakeTelemetry();
  const started = startSubagentSpawn(telemetry, { spawnId: "spawn-wait", spawnType: "command", spawnReason: "task" });

  const wait = recordAgentWait(telemetry, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
    reason: "await_child",
    durationMs: 25,
  });
  const join = recordAgentJoin(telemetry, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "failed",
    joinStatus: "failed",
    failurePropagated: true,
    durationMs: 40,
  });
  const failingSpawn = startSubagentSpawn(telemetry, { spawnId: "spawn-fail", spawnType: "command" });
  failSubagentSpawn(telemetry, failingSpawn.spawnId, { childAgentId: failingSpawn.childAgentId, errorClass: "SpawnError" });

  assert.equal(wait.span.name, SPAN_NAMES.PI_AGENT_WAIT);
  assert.equal(wait.span.ended, true);
  assert.equal(wait.span.attributes["pi.agent.child.status"], "active");
  assert.equal(wait.span.attributes["pi.agent.join.status"], "waiting");
  assert.equal(wait.span.attributes["pi.agent.children.active"], 1);
  assert.equal(wait.span.attributes["pi.agent.child.count"], 1);
  assert.equal(join.span.name, SPAN_NAMES.PI_AGENT_JOIN);
  assert.equal(join.span.ended, true);
  assert.equal(join.span.status.code, 2);
  assert.equal(join.span.attributes["pi.agent.child.status"], "failed");
  assert.equal(join.span.attributes["pi.agent.join.status"], "failed");
  assert.equal(join.span.attributes["pi.agent.failure.propagated"], true);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS, 25);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_JOIN_DURATION_MS, 40);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL, 1);
  assertSubagentMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL);
});

function assertMetricValue(records, metricName, value) {
  const record = records.find(candidate => candidate.name === metricName && candidate.value === value);
  assert.ok(record, `${metricName} should record ${value}`);
}

function assertHistogramRecorded(records, metricName, value) {
  const record = records.find(candidate => candidate.name === metricName && candidate.value === value);
  assert.ok(record, `${metricName} should record ${value}`);
}

function assertSubagentMetricLabelsAreLowCardinality(records, metricName) {
  const record = records.find(candidate => candidate.name === metricName);
  assert.ok(record, `${metricName} should be recorded`);
  for (const forbiddenLabel of ["agent_id", "child_agent_id", "session_id", "spawn_id", "workflow_id"]) {
    assert.equal(record.attributes[forbiddenLabel], undefined, `${metricName} must not include ${forbiddenLabel}`);
  }
}
