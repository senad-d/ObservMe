import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { getObsStatusRuntimeState, resetObsStatusRuntimeState } from "../src/commands/obs-status.ts";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import type { ObservMeConfig } from "../src/config/schema.ts";
import type { AgentLineageContext } from "../src/pi/agent-lineage.ts";
import { runBoundedOtelOperation } from "../src/otel/shutdown.ts";
import { COMMON_SPAN_ATTRIBUTES, LOG_ATTRIBUTES } from "../src/semconv/attributes.ts";
import { LOG_EVENT_NAMES, OBSERVME_COUNTER_METRIC_NAMES } from "../src/semconv/metrics.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";
import {
  createAgentTreeTracker,
  createObservMeMetrics,
  createSpanRegistry,
  registerHandlers,
  type Handler,
  type ObservMeTelemetrySession,
} from "../src/pi/handlers.ts";
import { isPlainRecord, mergeRecordConfig } from "./support/telemetry-types.ts";
import type { TestAttributes, TestLogger, TestMetricRecord, TestSpan, TestSpanContext } from "./support/telemetry-types.ts";

const validSpanContext: TestSpanContext = {
  traceId: "33333333333333333333333333333333",
  spanId: "4444444444444444",
  traceFlags: 1,
};

function cloneConfig(overrides: Record<string, unknown> = {}) {
  return mergeConfig(structuredClone(defaultObservMeConfig), overrides);
}

function mergeConfig<T extends Record<string, unknown>>(base: T, overlay: Record<string, unknown>): T {
  return mergeRecordConfig(base, overlay);
}

function makeLineage() {
  return {
    workflowId: "workflow-exporter-failure",
    workflowRootAgentId: "agent-root",
    agentId: "agent-root",
    rootAgentId: "agent-root",
    depth: 0,
    role: "root" as const,
    orphaned: false,
  };
}

function createFakePi() {
  const handlers = new Map<string, Handler>() as Omit<Map<string, Handler>, "get"> & { get(eventName: string): Handler };

  return {
    handlers,
    on: (eventName: string, handler: Handler) => {
      handlers.set(eventName, handler);
    },
  };
}

function createFakeMeter() {
  const records: TestMetricRecord[] = [];

  return {
    records,
    createCounter: (name: string) => ({
      add: (value: number, attributes: TestAttributes = {}) => records.push({ type: "counter", name, value, attributes }),
    }),
    createUpDownCounter: (name: string) => ({
      add: (value: number, attributes: TestAttributes = {}) => records.push({ type: "upDownCounter", name, value, attributes }),
    }),
    createHistogram: (name: string) => ({
      record: (value: number, attributes: TestAttributes = {}) => records.push({ type: "histogram", name, value, attributes }),
    }),
  };
}

function createFakeTracer() {
  const spans: TestSpan[] = [];

  return {
    spans,
    startSpan: (name: string, options: { attributes?: TestAttributes } = {}, parentContext: unknown = undefined) => {
      const parentSpan = parentContext ? trace.getSpan(parentContext as Parameters<typeof trace.getSpan>[0]) : undefined;
      const span = createFakeSpan(name, options.attributes ?? {}, parentSpan);
      spans.push(span);
      return span;
    },
  };
}

function createFakeSpan(name: string, attributes: TestAttributes, parentSpan: unknown): TestSpan {
  const span: TestSpan = {
    name,
    attributes,
    parentSpan,
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
      return validSpanContext;
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

function createCompletedController() {
  return {
    flush: async () => ({ operation: "flush" as const, completed: true, timedOut: false }),
    shutdown: async () => ({ operation: "shutdown" as const, completed: true, timedOut: false }),
  };
}

function createCollectorDownController() {
  return {
    flush: async () => ({
      operation: "flush" as const,
      completed: false,
      timedOut: false,
      error: new Error("connect ECONNREFUSED"),
    }),
    shutdown: async () => ({ operation: "shutdown" as const, completed: true, timedOut: false }),
  };
}

function createCollectorSlowController() {
  return {
    flush: (timeoutMs = 0) => runBoundedOtelOperation("flush", neverResolve, timeoutMs),
    shutdown: async () => ({ operation: "shutdown" as const, completed: true, timedOut: false }),
  };
}

function neverResolve(): Promise<void> {
  return new Promise(() => undefined);
}

interface FakeTelemetryOptions {
  readonly config?: ObservMeConfig;
  readonly lineage?: AgentLineageContext;
  readonly controller?: ObservMeTelemetrySession["controller"];
}

type FakeTelemetrySession = ObservMeTelemetrySession & {
  readonly meter: ReturnType<typeof createFakeMeter>;
  readonly tracer: ReturnType<typeof createFakeTracer>;
  readonly logger: TestLogger;
};

interface HandlerHarness {
  readonly pi: ReturnType<typeof createFakePi>;
  telemetry?: FakeTelemetrySession;
}

function createFakeTelemetry(options: FakeTelemetryOptions = {}): FakeTelemetrySession {
  const config = options.config ?? cloneConfig();
  const lineage = options.lineage ?? makeLineage();
  const meter = createFakeMeter();
  const tracer = createFakeTracer();
  const logger = createFakeLogger();
  const metrics = createObservMeMetrics(meter);
  const telemetry: FakeTelemetrySession = {
    config,
    lineage,
    controller: options.controller ?? createCompletedController(),
    tracer,
    meter,
    logger,
    metrics,
    spans: createSpanRegistry(config, metrics, () => telemetry),
    agentTree: createAgentTreeTracker(config, lineage, metrics, () => telemetry),
    activeAgentRecorded: false,
    agentRunSequence: 0,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences: new Map(),
  };

  return telemetry;
}

function createHandlerHarness(config: ObservMeConfig, controller: FakeTelemetryOptions["controller"]): HandlerHarness {
  const pi = createFakePi();
  const harness: HandlerHarness = { pi };

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

async function runStartAndShutdown(harness: HandlerHarness): Promise<void> {
  await harness.pi.handlers.get("session_start")({ sessionId: "session-exporter-failure" }, { cwd: "/workspace/exporter" });
  await harness.pi.handlers.get("session_shutdown")({}, {});
}

function requireTelemetry(harness: HandlerHarness): FakeTelemetrySession {
  assert.ok(harness.telemetry, "expected telemetry session to be created");
  return harness.telemetry;
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

function findSpan(spans: readonly TestSpan[], name: string, predicate?: (span: TestSpan) => boolean): TestSpan | undefined {
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
  assert.ok(telemetry.logger.records.some(record => isTelemetryDroppedLog(record, "turn")));
});

function isTelemetryDroppedLog(record: TestLogger["records"][number], operation: string): boolean {
  return (
    record.body === LOG_EVENT_NAMES.TELEMETRY_DROPPED &&
    record.attributes?.[LOG_ATTRIBUTES.EVENT_CATEGORY] === "telemetry" &&
    record.attributes?.operation === operation &&
    record.attributes?.reason === "span_registry_full"
  );
}
