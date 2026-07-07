import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { getObsStatusRuntimeState, resetObsStatusRuntimeState } from "../src/commands/obs-status.ts";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { runBoundedOtelOperation } from "../src/otel/shutdown.ts";
import { COMMON_SPAN_ATTRIBUTES } from "../src/semconv/attributes.ts";
import { LOG_EVENT_NAMES, OBSERVME_COUNTER_METRIC_NAMES } from "../src/semconv/metrics.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";
import { createAgentTreeTracker, createObservMeMetrics, createSpanRegistry, registerHandlers } from "../src/pi/handlers.ts";

const validSpanContext = {
  traceId: "33333333333333333333333333333333",
  spanId: "4444444444444444",
  traceFlags: 1,
};

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

function makeLineage() {
  return {
    workflowId: "workflow-exporter-failure",
    workflowRootAgentId: "agent-root",
    agentId: "agent-root",
    rootAgentId: "agent-root",
    depth: 0,
    role: "root",
    orphaned: false,
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

function createFakeTracer() {
  const spans = [];

  return {
    spans,
    startSpan: (name, options = {}, parentContext) => {
      const parentSpan = parentContext ? trace.getSpan(parentContext) : undefined;
      const span = createFakeSpan(name, options.attributes ?? {}, parentSpan);
      spans.push(span);
      return span;
    },
  };
}

function createFakeSpan(name, attributes, parentSpan) {
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
      return validSpanContext;
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
  const tracer = createFakeTracer();
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

async function runStartAndShutdown(harness) {
  await harness.pi.handlers.get("session_start")({ sessionId: "session-exporter-failure" }, { cwd: "/workspace/exporter" });
  await harness.pi.handlers.get("session_shutdown")({}, {});
}

function requireTelemetry(harness) {
  assert.ok(harness.telemetry, "expected telemetry session to be created");
  return harness.telemetry;
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

function findSpan(spans, name, predicate = undefined) {
  return spans.find(span => span.name === name && (!predicate || predicate(span)));
}

test("exporter failure: Collector down increments export-error metrics and Pi keeps running", async () => {
  resetObsStatusRuntimeState();
  const harness = createHandlerHarness(cloneConfig(), createCollectorDownController());

  await assert.doesNotReject(() => runStartAndShutdown(harness));

  const telemetry = requireTelemetry(harness);
  const exportErrors = metricSum(
    telemetry.meter.records,
    OBSERVME_COUNTER_METRIC_NAMES.EXPORT_ERRORS_TOTAL,
    record => record.attributes.operation === "flush" && record.attributes.reason === "export_error",
  );

  assert.equal(exportErrors, 1);
  assert.equal(getObsStatusRuntimeState().lastExportError, "flush failed: connect ECONNREFUSED");
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.EXPORT_FAILED));
});

test("exporter failure: Collector slow times out and stays within the handler latency budget", async () => {
  resetObsStatusRuntimeState();
  const config = cloneConfig({ shutdown: { flushTimeoutMs: 5 } });
  const harness = createHandlerHarness(config, createCollectorSlowController());
  const startedAt = performance.now();

  await assert.doesNotReject(() => runStartAndShutdown(harness));

  const elapsedMs = performance.now() - startedAt;
  const telemetry = requireTelemetry(harness);
  const exportTimeouts = metricSum(
    telemetry.meter.records,
    OBSERVME_COUNTER_METRIC_NAMES.EXPORT_ERRORS_TOTAL,
    record => record.attributes.operation === "flush" && record.attributes.reason === "export_timeout",
  );

  assert.ok(elapsedMs < 100, `slow Collector shutdown should stay bounded, got ${elapsedMs}ms`);
  assert.equal(exportTimeouts, 1);
  assert.equal(getObsStatusRuntimeState().lastExportError, "flush timed out");
});

test("exporter failure: queue-full eviction increments drop counters and keeps active spans bounded", async () => {
  resetObsStatusRuntimeState();
  const config = cloneConfig({ limits: { maxActiveTurns: 1 } });
  const harness = createHandlerHarness(config, createCompletedController());

  await assert.doesNotReject(async () => {
    await harness.pi.handlers.get("session_start")({ sessionId: "session-queue-full-unit" }, { cwd: "/workspace/exporter" });
    await harness.pi.handlers.get("agent_start")({ agentRunId: "agent-run-1" }, {});
    await harness.pi.handlers.get("turn_start")({ agentRunId: "agent-run-1", turnIndex: 1 }, {});
    await harness.pi.handlers.get("turn_start")({ agentRunId: "agent-run-1", turnIndex: 2 }, {});
  });

  const telemetry = requireTelemetry(harness);
  const dropCount = metricSum(
    telemetry.meter.records,
    OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL,
    record => record.attributes.reason === "span_registry_full",
  );
  const evictedTurn = findSpan(
    telemetry.tracer.spans,
    SPAN_NAMES.PI_TURN,
    span => span.attributes[COMMON_SPAN_ATTRIBUTES.OBSERVME_EVICTED] === true,
  );

  assert.equal(telemetry.spans.activeTurns.size, 1);
  assert.equal(dropCount, 1);
  assert.equal(getObsStatusRuntimeState().queueDrops, 1);
  assert.ok(evictedTurn?.ended, "expected the oldest turn span to end when the bounded queue evicts it");
});
