import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { getObsStatusRuntimeState, resetObsStatusRuntimeState } from "../src/commands/obs-status.ts";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { runBoundedOtelOperation } from "../src/otel/shutdown.ts";
import { COMMON_SPAN_ATTRIBUTES } from "../src/semconv/attributes.ts";
import {
  LOG_EVENT_NAMES,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
} from "../src/semconv/metrics.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";
import {
  createAgentTreeTracker,
  createObservMeMetrics,
  createSpanRegistry,
  registerHandlers,
} from "../src/pi/handlers.ts";
import { observeTrustedSubagentLineage, startSubagentSpawn } from "../src/pi/subagent-spawn.ts";

const validSpanContext = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: 1,
};

const forbiddenMetricLabelKeys = [
  "session_id",
  "workflow_id",
  "workflow_root_agent_id",
  "agent_id",
  "parent_agent_id",
  "child_agent_id",
  "agent_run_id",
  "spawn_id",
  "spawn_tool_call_id",
  "trace_id",
  "span_id",
  "entry_id",
  "tool_call_id",
];

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

function makeLineage(overrides = {}) {
  return {
    workflowId: "workflow-chaos",
    workflowRootAgentId: "agent-root",
    agentId: "agent-root",
    rootAgentId: "agent-root",
    depth: 0,
    role: "root",
    orphaned: false,
    ...overrides,
  };
}

function createFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on: (eventName, handler) => {
      handlers.set(eventName, handler);
    },
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

function createCompletedController() {
  return {
    flush: async () => ({ operation: "flush", completed: true, timedOut: false }),
    shutdown: async () => ({ operation: "shutdown", completed: true, timedOut: false }),
  };
}

function createCollectorDownController() {
  return {
    flush: async () => ({
      operation: "flush",
      completed: false,
      timedOut: false,
      error: new Error("connect ECONNREFUSED"),
    }),
    shutdown: async () => ({ operation: "shutdown", completed: true, timedOut: false }),
  };
}

function createCollectorSlowController() {
  return {
    flush: timeoutMs => runBoundedOtelOperation("flush", neverResolve, timeoutMs),
    shutdown: async () => ({ operation: "shutdown", completed: true, timedOut: false }),
  };
}

function neverResolve() {
  return new Promise(() => undefined);
}

function createFakeTelemetry(options = {}) {
  const config = options.config ?? cloneConfig();
  const lineage = options.lineage ?? makeLineage();
  const meter = createFakeMeter();
  const tracer = createFakeTracer(options.spanContext ?? validSpanContext);
  const logger = createFakeLogger();
  const metrics = createObservMeMetrics(meter);

  return {
    config,
    lineage,
    controller: options.controller ?? createCompletedController(),
    tracer,
    meter,
    logger,
    metrics,
    spans: createSpanRegistry(config, metrics),
    agentTree: createAgentTreeTracker(config, lineage, metrics),
    sessionAttributes: options.sessionAttributes,
    sessionSpan: options.sessionSpan,
    activeAgentRecorded: false,
    agentRunSequence: 0,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences: new Map(),
  };
}

function createHandlerHarness(config, controller) {
  const pi = createFakePi();
  const harness = { pi, telemetry: undefined };

  registerHandlers(pi, {
    loadConfig: async () => config,
    startTelemetry: async options => {
      harness.telemetry = createFakeTelemetry({
        config: options.config,
        lineage: options.lineage,
        controller,
      });
      return harness.telemetry;
    },
  });

  return harness;
}

async function runStartAndShutdown(harness, shutdownEvent = {}) {
  await harness.pi.handlers.get("session_start")({ sessionId: "session-chaos" }, { cwd: "/workspace/chaos" });
  await harness.pi.handlers.get("session_shutdown")(shutdownEvent, {});
}

function requireTelemetry(harness) {
  assert.ok(harness.telemetry, "expected telemetry session to be created");
  return harness.telemetry;
}

function metricSum(records, metricName, predicate) {
  let total = 0;
  for (const record of records) {
    if (record.name !== metricName) continue;
    if (predicate && !predicate(record)) continue;
    total += record.value;
  }
  return total;
}

function metricRecords(records, metricName) {
  return records.filter(record => record.name === metricName);
}

function assertMetricValue(records, metricName, expectedValue, predicate) {
  assert.equal(metricSum(records, metricName, predicate), expectedValue);
}

function assertMetricAtLeast(records, metricName, expectedMinimum, predicate) {
  assert.ok(metricSum(records, metricName, predicate) >= expectedMinimum);
}

function assertHistogramAtLeast(records, metricName, expectedMinimum) {
  assert.ok(metricRecords(records, metricName).some(record => record.value >= expectedMinimum));
}

function assertNoForbiddenMetricLabels(records) {
  for (const record of records) {
    for (const key of Object.keys(record.attributes ?? {})) {
      assert.equal(forbiddenMetricLabelKeys.includes(key), false, `${record.name} used forbidden metric label ${key}`);
    }
  }
}

function serializableSpanTelemetry(spans) {
  return spans.map(span => ({
    name: span.name,
    attributes: span.attributes,
    events: span.events,
    status: span.status,
    ended: span.ended,
  }));
}

test("chaos: Collector down records export failure telemetry and Pi keeps running", async () => {
  resetObsStatusRuntimeState();
  const config = cloneConfig();
  const harness = createHandlerHarness(config, createCollectorDownController());

  await assert.doesNotReject(() => runStartAndShutdown(harness));

  const telemetry = requireTelemetry(harness);
  assertMetricValue(
    telemetry.meter.records,
    OBSERVME_COUNTER_METRIC_NAMES.EXPORT_ERRORS_TOTAL,
    1,
    record => record.attributes.operation === "flush" && record.attributes.reason === "export_error",
  );
  assert.equal(getObsStatusRuntimeState().lastExportError, "flush failed: connect ECONNREFUSED");
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.EXPORT_FAILED));
});

test("chaos: Collector slow times out export without blocking Pi", async () => {
  resetObsStatusRuntimeState();
  const config = cloneConfig({ shutdown: { flushTimeoutMs: 5 } });
  const harness = createHandlerHarness(config, createCollectorSlowController());

  const startedAt = performance.now();
  await assert.doesNotReject(() => runStartAndShutdown(harness));
  const durationMs = performance.now() - startedAt;

  const telemetry = requireTelemetry(harness);
  assert.ok(durationMs < 100, `slow collector shutdown should stay bounded, got ${durationMs}ms`);
  assertMetricValue(
    telemetry.meter.records,
    OBSERVME_COUNTER_METRIC_NAMES.EXPORT_ERRORS_TOTAL,
    1,
    record => record.attributes.operation === "flush" && record.attributes.reason === "export_timeout",
  );
  assert.equal(getObsStatusRuntimeState().lastExportError, "flush timed out");
});

test("chaos: subagent without propagated trace context still carries lineage and records propagation failure", () => {
  const config = cloneConfig({ agent: { propagateTraceContext: false } });
  const telemetry = createFakeTelemetry({ config });
  let started;
  let node;

  assert.doesNotThrow(() => {
    started = startSubagentSpawn(telemetry, { spawnId: "spawn-no-context", spawnType: "command" });
    node = observeTrustedSubagentLineage(telemetry, started.env, { generateId: () => "child-no-context" });
  });

  assert.equal(started.traceContextPropagated, false);
  assert.equal(started.env.OBSERVME_WORKFLOW_ID, "workflow-chaos");
  assert.equal(started.env.OBSERVME_PARENT_AGENT_ID, "agent-root");
  assert.equal(started.env.OBSERVME_ROOT_AGENT_ID, "agent-root");
  assert.equal(node.workflowId, "workflow-chaos");
  assert.equal(node.parentAgentId, "agent-root");
  assert.equal(node.rootAgentId, "agent-root");
  assert.equal(node.orphaned, false);
  assertMetricValue(
    telemetry.meter.records,
    OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL,
    1,
  );
  assertNoForbiddenMetricLabels(telemetry.meter.records);
});

test("chaos: orphan agent increments orphan metric without throwing", () => {
  const telemetry = createFakeTelemetry();
  let node;

  assert.doesNotThrow(() => {
    node = observeTrustedSubagentLineage(
      telemetry,
      {
        OBSERVME_WORKFLOW_ID: "workflow-chaos",
        OBSERVME_PARENT_AGENT_ID: "missing-parent",
        OBSERVME_ROOT_AGENT_ID: "agent-root",
        OBSERVME_AGENT_DEPTH: "0",
      },
      { generateId: () => "orphan-agent" },
    );
  });

  assert.equal(node.orphaned, true);
  assert.equal(node.status, "orphaned");
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL, 1);
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.AGENT_ORPHANED));
  assertNoForbiddenMetricLabels(telemetry.meter.records);
});

test("chaos: runaway fan-out and depth update bounded agent-tree metrics without high-cardinality labels", () => {
  const config = cloneConfig({ workflow: { maxDepthWarning: 1, maxFanoutWarning: 1 } });
  const telemetry = createFakeTelemetry({ config });
  let deepNode;

  assert.doesNotThrow(() => {
    startSubagentSpawn(telemetry, { spawnId: "spawn-fanout-1", spawnType: "command" });
    startSubagentSpawn(telemetry, { spawnId: "spawn-fanout-2", spawnType: "command" });
    startSubagentSpawn(telemetry, { spawnId: "spawn-fanout-3", spawnType: "command" });
    deepNode = observeTrustedSubagentLineage(
      telemetry,
      {
        OBSERVME_WORKFLOW_ID: "workflow-chaos",
        OBSERVME_PARENT_AGENT_ID: "child-spawn-fanout-3",
        OBSERVME_ROOT_AGENT_ID: "agent-root",
        OBSERVME_AGENT_DEPTH: "6",
      },
      { generateId: () => "deep-agent" },
    );
  });

  assert.equal(deepNode.depth, 7);
  assertHistogramAtLeast(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_FANOUT_COUNT, 3);
  assertHistogramAtLeast(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_DEPTH, 7);
  assertNoForbiddenMetricLabels(telemetry.meter.records);
});

test("chaos: queue full evicts spans, increments drop counters, and keeps memory bounded", async () => {
  resetObsStatusRuntimeState();
  const config = cloneConfig({ limits: { maxActiveTurns: 1 } });
  const harness = createHandlerHarness(config, createCompletedController());

  await assert.doesNotReject(async () => {
    await harness.pi.handlers.get("session_start")({ sessionId: "session-queue-full" }, { cwd: "/workspace/chaos" });
    await harness.pi.handlers.get("agent_start")({ agentRunId: "agent-run-1" }, {});
    await harness.pi.handlers.get("turn_start")({ agentRunId: "agent-run-1", turnIndex: 1 }, {});
    await harness.pi.handlers.get("turn_start")({ agentRunId: "agent-run-1", turnIndex: 2 }, {});
  });

  const telemetry = requireTelemetry(harness);
  const evictedTurn = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TURN && span.attributes[COMMON_SPAN_ATTRIBUTES.OBSERVME_EVICTED] === true);

  assert.equal(telemetry.spans.activeTurns.size, 1);
  assert.ok(evictedTurn?.ended, "expected oldest turn span to be ended on eviction");
  assertMetricValue(
    telemetry.meter.records,
    OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL,
    1,
    record => record.attributes.reason === "span_registry_full",
  );
  assert.equal(getObsStatusRuntimeState().queueDrops, 1);
});

test("chaos: redaction exception drops the field, increments failure metric, and exports no raw value", async () => {
  const rawValue = "raw secret value must never export";
  const config = cloneConfig({
    capture: { toolArguments: true },
    privacy: { customRedactionPatterns: [{ name: "broken-redactor", pattern: "(" }] },
  });
  const harness = createHandlerHarness(config, createCompletedController());

  await assert.doesNotReject(async () => {
    await harness.pi.handlers.get("session_start")({ sessionId: "session-redaction" }, { cwd: "/workspace/chaos" });
    await harness.pi.handlers.get("tool_execution_start")({
      toolCallId: "tool-redaction",
      toolName: "bash",
      input: rawValue,
    }, {});
  });

  const telemetry = requireTelemetry(harness);
  assertMetricAtLeast(
    telemetry.meter.records,
    OBSERVME_COUNTER_METRIC_NAMES.REDACTION_FAILURES_TOTAL,
    1,
    record => record.attributes.operation === "tool_content_capture",
  );
  assert.doesNotMatch(JSON.stringify(serializableSpanTelemetry(telemetry.tracer.spans)), /raw secret value/u);
});
