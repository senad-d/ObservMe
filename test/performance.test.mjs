import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { OBSERVME_COUNTER_METRIC_NAMES } from "../src/semconv/metrics.ts";
import {
  createAgentTreeTracker,
  createObservMeMetrics,
  createSpanRegistry,
  registerHandlers,
} from "../src/pi/handlers.ts";
import { completeSubagentSpawn, startSubagentSpawn } from "../src/pi/subagent-spawn.ts";

const SYNTHETIC_WORKLOAD = {
  sessions: 100,
  turnsPerSession: 1_000,
  toolCallsPerTurn: 5,
  llmCallsPerTurn: 2,
  subagentSpawnEveryTurns: 20,
};
const HANDLER_P95_TARGET_MS = 10;
const HANDLER_P99_TARGET_MS = 25;
const VALID_SPAN_CONTEXT = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: 1,
};

function cloneConfig() {
  return structuredClone(defaultObservMeConfig);
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

function createExportBatchRecorder(maxBatchSizes) {
  return {
    traces: createBatchState(maxBatchSizes.traces),
    logs: createBatchState(maxBatchSizes.logs),
    metrics: createBatchState(maxBatchSizes.metrics),
  };
}

function createBatchState(maxBatchSize) {
  return {
    maxBatchSize,
    currentSize: 0,
    batchSizes: [],
  };
}

function recordBatchItem(recorder, signal) {
  const state = recorder[signal];
  state.currentSize += 1;
  if (state.currentSize < state.maxBatchSize) return;

  state.batchSizes.push(state.currentSize);
  state.currentSize = 0;
}

function flushBatchState(state) {
  if (state.currentSize === 0) return;

  state.batchSizes.push(state.currentSize);
  state.currentSize = 0;
}

function flushExportBatches(recorder) {
  flushBatchState(recorder.traces);
  flushBatchState(recorder.logs);
  flushBatchState(recorder.metrics);
}

function summarizeExportBatches(recorder) {
  return {
    traces: summarizeBatchState(recorder.traces),
    logs: summarizeBatchState(recorder.logs),
    metrics: summarizeBatchState(recorder.metrics),
  };
}

function summarizeBatchState(state) {
  const sorted = [...state.batchSizes].sort((left, right) => left - right);
  return {
    configuredMaxBatchSize: state.maxBatchSize,
    batchCount: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? 0,
    sample: [...state.batchSizes.slice(0, 3), ...state.batchSizes.slice(-3)],
  };
}

function createDurationRecorder(expectedSamples) {
  return {
    samples: new Float64Array(expectedSamples),
    count: 0,
  };
}

function recordDuration(recorder, durationMs) {
  recorder.samples[recorder.count] = durationMs;
  recorder.count += 1;
}

function summarizeDurations(recorder) {
  const sorted = recorder.samples.subarray(0, recorder.count).slice().sort();
  return {
    count: recorder.count,
    p50: roundMillis(percentile(sorted, 50)),
    p95: roundMillis(percentile(sorted, 95)),
    p99: roundMillis(percentile(sorted, 99)),
    max: roundMillis(sorted.at(-1) ?? 0),
  };
}

function percentile(sortedValues, percentileRank) {
  if (sortedValues.length === 0) return 0;

  const index = Math.min(sortedValues.length - 1, Math.ceil((percentileRank / 100) * sortedValues.length) - 1);
  return sortedValues[index];
}

function roundMillis(value) {
  return Math.round(value * 1_000) / 1_000;
}

function bytesToMiB(value) {
  return Math.round((value / 1024 / 1024) * 1_000) / 1_000;
}

function createMetricTotals() {
  return {
    sums: new Map(),
    handlerErrorsByHandler: new Map(),
    handlerFailureLogs: [],
  };
}

function createFakeMeter(batchRecorder, metricTotals) {
  return {
    createCounter: name => ({
      add: (value, attributes = {}) => {
        addMetricTotal(metricTotals, name, value, attributes);
        recordBatchItem(batchRecorder, "metrics");
      },
    }),
    createUpDownCounter: name => ({
      add: (value, attributes = {}) => {
        addMetricTotal(metricTotals, name, value, attributes);
        recordBatchItem(batchRecorder, "metrics");
      },
    }),
    createHistogram: name => ({
      record: (value, attributes = {}) => {
        addMetricTotal(metricTotals, name, value, attributes);
        recordBatchItem(batchRecorder, "metrics");
      },
    }),
    createObservableGauge: () => ({
      addCallback() {},
      removeCallback() {},
    }),
  };
}

function addMetricTotal(metricTotals, name, value, attributes = {}) {
  metricTotals.sums.set(name, (metricTotals.sums.get(name) ?? 0) + value);
  if (name !== OBSERVME_COUNTER_METRIC_NAMES.HANDLER_ERRORS_TOTAL) return;

  const handler = attributes.handler ?? "unknown";
  metricTotals.handlerErrorsByHandler.set(handler, (metricTotals.handlerErrorsByHandler.get(handler) ?? 0) + value);
}

function metricTotal(metricTotals, name) {
  return metricTotals.sums.get(name) ?? 0;
}

function createFakeTracer(batchRecorder) {
  return {
    startSpan: (_name, _options, parentContext) => createFakeSpan(readParentSpan(parentContext), batchRecorder),
  };
}

function readParentSpan(parentContext) {
  return parentContext ? trace.getSpan(parentContext) : undefined;
}

function createFakeSpan(parentSpan, batchRecorder) {
  return {
    parentSpan,
    ended: false,
    addEvent: () => undefined,
    setAttribute: () => undefined,
    setAttributes: () => undefined,
    setStatus: () => undefined,
    spanContext: () => VALID_SPAN_CONTEXT,
    end() {
      if (this.ended) return;

      this.ended = true;
      recordBatchItem(batchRecorder, "traces");
    },
  };
}

function createFakeLogger(batchRecorder, metricTotals) {
  return {
    emit: record => {
      if (record.body === "handler.failed") metricTotals.handlerFailureLogs.push(record.attributes);
      recordBatchItem(batchRecorder, "logs");
    },
  };
}

function createPerformanceController(batchRecorder) {
  return {
    flush: async () => {
      flushExportBatches(batchRecorder);
      return { operation: "flush", completed: true, timedOut: false };
    },
    shutdown: async () => {
      flushExportBatches(batchRecorder);
      return { operation: "shutdown", completed: true, timedOut: false };
    },
  };
}

function createFakeTelemetry(config, lineage, batchRecorder, metricTotals) {
  const meter = createFakeMeter(batchRecorder, metricTotals);
  const metrics = createObservMeMetrics(meter);

  return {
    config,
    lineage,
    controller: createPerformanceController(batchRecorder),
    tracer: createFakeTracer(batchRecorder),
    meter,
    logger: createFakeLogger(batchRecorder, metricTotals),
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

function createHarness(config, batchRecorder, metricTotals) {
  const pi = createFakePi();
  const harness = { pi, telemetry: undefined };

  registerHandlers(pi, {
    loadConfig: async () => config,
    startTelemetry: async ({ lineage }) => {
      harness.telemetry = createFakeTelemetry(config, lineage, batchRecorder, metricTotals);
      return harness.telemetry;
    },
  });

  return harness;
}

async function measureHandlerCall(recorder, handlers, eventName, event, ctx) {
  const handler = handlers.get(eventName);
  assert.ok(handler, `expected ${eventName} handler to be registered`);

  const startedAt = performance.now();
  await handler(event, ctx);
  recordDuration(recorder, performance.now() - startedAt);
}

function measureSubagentStart(recorder, telemetry, options) {
  const startedAt = performance.now();
  const started = startSubagentSpawn(telemetry, options);
  recordDuration(recorder, performance.now() - startedAt);
  return started;
}

function measureSubagentComplete(recorder, telemetry, started) {
  const startedAt = performance.now();
  completeSubagentSpawn(telemetry, started.spawnId, {
    childAgentId: started.childAgentId,
    childStatus: "completed",
  });
  recordDuration(recorder, performance.now() - startedAt);
}

function requireTelemetry(harness) {
  assert.ok(harness.telemetry, "expected telemetry session to be active");
  return harness.telemetry;
}

async function runSyntheticWorkload(harness, workload, handlerDurations, subagentDurations) {
  for (let sessionIndex = 1; sessionIndex <= workload.sessions; sessionIndex += 1) {
    await runSyntheticSession(harness, workload, handlerDurations, subagentDurations, sessionIndex);
  }
}

async function runSyntheticSession(harness, workload, handlerDurations, subagentDurations, sessionIndex) {
  const handlers = harness.pi.handlers;
  const sessionId = `perf-session-${sessionIndex}`;
  const agentRunId = `perf-agent-run-${sessionIndex}`;
  const ctx = createSessionContext(sessionIndex);

  await measureHandlerCall(handlerDurations, handlers, "session_start", { sessionId }, ctx);
  await measureHandlerCall(handlerDurations, handlers, "agent_start", { agentRunId, source: "synthetic" }, {});

  for (let turnIndex = 1; turnIndex <= workload.turnsPerSession; turnIndex += 1) {
    await runSyntheticTurn(harness, workload, handlerDurations, subagentDurations, sessionIndex, agentRunId, turnIndex);
  }

  await measureHandlerCall(handlerDurations, handlers, "agent_end", { agentRunId, status: "ok" }, {});
  await measureHandlerCall(handlerDurations, handlers, "session_shutdown", { status: "ok" }, {});
}

function createSessionContext(sessionIndex) {
  return {
    cwd: `/workspace/observme-perf-${sessionIndex}`,
    model: { provider: "anthropic", model: "claude-synthetic", api: "messages" },
    thinking: { level: "medium" },
  };
}

async function runSyntheticTurn(
  harness,
  workload,
  handlerDurations,
  subagentDurations,
  sessionIndex,
  agentRunId,
  turnIndex,
) {
  const handlers = harness.pi.handlers;

  await measureHandlerCall(handlerDurations, handlers, "turn_start", { agentRunId, turnIndex }, {});
  await runSyntheticLlmCalls(handlers, handlerDurations, sessionIndex, turnIndex, workload.llmCallsPerTurn);
  await runSyntheticToolCalls(handlers, handlerDurations, sessionIndex, turnIndex, workload.toolCallsPerTurn);
  if (turnIndex % workload.subagentSpawnEveryTurns === 0) runSyntheticSubagentSpawn(harness, subagentDurations, sessionIndex, turnIndex);
  await measureHandlerCall(handlerDurations, handlers, "turn_end", { agentRunId, turnIndex, status: "ok" }, {});
}

async function runSyntheticLlmCalls(handlers, handlerDurations, sessionIndex, turnIndex, llmCallsPerTurn) {
  for (let llmIndex = 1; llmIndex <= llmCallsPerTurn; llmIndex += 1) {
    const llmRequestId = `perf-llm-${sessionIndex}-${turnIndex}-${llmIndex}`;

    await measureHandlerCall(handlerDurations, handlers, "before_provider_request", createLlmRequestEvent(llmRequestId), {});
    await measureHandlerCall(handlerDurations, handlers, "message_end", createAssistantMessageEvent(llmRequestId), {});
  }
}

function createLlmRequestEvent(llmRequestId) {
  return {
    llmRequestId,
    payload: {
      messages: [{ role: "user", content: "synthetic prompt" }],
      tools: [{ name: "read" }],
      maxTokens: 256,
    },
  };
}

function createAssistantMessageEvent(llmRequestId) {
  return {
    llmRequestId,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-synthetic",
      stopReason: "stop",
      usage: {
        input: 64,
        output: 128,
        totalTokens: 192,
        cost: { total: 0.001 },
      },
    },
  };
}

async function runSyntheticToolCalls(handlers, handlerDurations, sessionIndex, turnIndex, toolCallsPerTurn) {
  for (let toolIndex = 1; toolIndex <= toolCallsPerTurn; toolIndex += 1) {
    const toolCallId = `perf-tool-${sessionIndex}-${turnIndex}-${toolIndex}`;

    await measureHandlerCall(handlerDurations, handlers, "tool_execution_start", createToolStartEvent(toolCallId), {});
    await measureHandlerCall(handlerDurations, handlers, "tool_execution_end", createToolEndEvent(toolCallId), {});
  }
}

function createToolStartEvent(toolCallId) {
  return {
    toolCallId,
    toolName: "read",
    toolCategory: "filesystem",
  };
}

function createToolEndEvent(toolCallId) {
  return {
    toolCallId,
    toolName: "read",
    toolCategory: "filesystem",
    success: true,
  };
}

function runSyntheticSubagentSpawn(harness, subagentDurations, sessionIndex, turnIndex) {
  const telemetry = requireTelemetry(harness);
  const started = measureSubagentStart(subagentDurations, telemetry, {
    spawnId: `perf-spawn-${sessionIndex}-${turnIndex}`,
    spawnType: "command",
    spawnReason: "parallel_search",
  });

  measureSubagentComplete(subagentDurations, telemetry, started);
}

function expectedHandlerCalls(workload) {
  const sessionLifecycleHandlers = 4;
  const perTurnHandlers = 2 + workload.llmCallsPerTurn * 2 + workload.toolCallsPerTurn * 2;
  return workload.sessions * (sessionLifecycleHandlers + workload.turnsPerSession * perTurnHandlers);
}

function expectedSubagentOperations(workload) {
  const spawnsPerSession = Math.floor(workload.turnsPerSession / workload.subagentSpawnEveryTurns);
  return workload.sessions * spawnsPerSession * 2;
}

function activeRegistrySizes(telemetry) {
  return {
    activeAgentRuns: telemetry.spans.activeAgentRuns.size,
    activeTurns: telemetry.spans.activeTurns.size,
    activeLlmRequests: telemetry.spans.activeLlmRequests.size,
    activeToolCalls: telemetry.spans.activeToolCalls.size,
    activeSubagentSpawns: telemetry.spans.activeSubagentSpawns.size,
    activeAgentWaits: telemetry.spans.activeAgentWaits.size,
    activeAgentJoins: telemetry.spans.activeAgentJoins.size,
  };
}

function createPerformanceReport(options) {
  const memoryGrowthBytes = options.memoryAfter.heapUsed - options.memoryBefore.heapUsed;
  const totalHandlerCalls = options.handlerSummary.count;
  const cpuTotalMs = (options.cpuUsage.user + options.cpuUsage.system) / 1_000;

  return {
    workload: SYNTHETIC_WORKLOAD,
    elapsedMs: roundMillis(options.elapsedMs),
    handlerDurationMs: options.handlerSummary,
    subagentOperationDurationMs: options.subagentSummary,
    memory: {
      heapStartMiB: bytesToMiB(options.memoryBefore.heapUsed),
      heapEndMiB: bytesToMiB(options.memoryAfter.heapUsed),
      growthMiB: bytesToMiB(memoryGrowthBytes),
      growthBytes: memoryGrowthBytes,
    },
    cpu: {
      userMs: roundMillis(options.cpuUsage.user / 1_000),
      systemMs: roundMillis(options.cpuUsage.system / 1_000),
      totalMs: roundMillis(cpuTotalMs),
      totalMsPerHandler: roundMillis(cpuTotalMs / totalHandlerCalls),
    },
    droppedTelemetryCount: metricTotal(options.metricTotals, OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL),
    handlerErrorCount: metricTotal(options.metricTotals, OBSERVME_COUNTER_METRIC_NAMES.HANDLER_ERRORS_TOTAL),
    handlerErrorsByHandler: Object.fromEntries(options.metricTotals.handlerErrorsByHandler),
    handlerFailureLogs: options.metricTotals.handlerFailureLogs.slice(0, 3),
    exportBatchSizes: summarizeExportBatches(options.batchRecorder),
    activeRegistrySizes: activeRegistrySizes(options.telemetry),
  };
}

test("performance: synthetic workload stays within documented handler latency targets", { timeout: 120_000 }, async t => {
  const config = cloneConfig();
  const batchRecorder = createExportBatchRecorder({
    traces: config.traces.batch.maxExportBatchSize,
    logs: config.logs.batch.maxExportBatchSize,
    metrics: config.traces.batch.maxExportBatchSize,
  });
  const metricTotals = createMetricTotals();
  const handlerDurations = createDurationRecorder(expectedHandlerCalls(SYNTHETIC_WORKLOAD));
  const subagentDurations = createDurationRecorder(expectedSubagentOperations(SYNTHETIC_WORKLOAD));
  const harness = createHarness(config, batchRecorder, metricTotals);

  globalThis.gc?.();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();

  await runSyntheticWorkload(harness, SYNTHETIC_WORKLOAD, handlerDurations, subagentDurations);

  const elapsedMs = performance.now() - startedAt;
  const cpuUsage = process.cpuUsage(cpuBefore);
  globalThis.gc?.();
  const memoryAfter = process.memoryUsage();
  const telemetry = requireTelemetry(harness);
  const handlerSummary = summarizeDurations(handlerDurations);
  const subagentSummary = summarizeDurations(subagentDurations);
  const report = createPerformanceReport({
    batchRecorder,
    cpuUsage,
    elapsedMs,
    handlerSummary,
    memoryAfter,
    memoryBefore,
    metricTotals,
    subagentSummary,
    telemetry,
  });

  t.diagnostic(JSON.stringify(report, null, 2));

  assert.equal(handlerDurations.count, expectedHandlerCalls(SYNTHETIC_WORKLOAD));
  assert.equal(subagentDurations.count, expectedSubagentOperations(SYNTHETIC_WORKLOAD));
  assert.equal(report.droppedTelemetryCount, 0);
  assert.equal(report.handlerErrorCount, 0);
  assert.deepEqual(report.activeRegistrySizes, {
    activeAgentRuns: 0,
    activeTurns: 0,
    activeLlmRequests: 0,
    activeToolCalls: 0,
    activeSubagentSpawns: 0,
    activeAgentWaits: 0,
    activeAgentJoins: 0,
  });
  assert.ok(
    report.handlerDurationMs.p95 < HANDLER_P95_TARGET_MS,
    `expected handler p95 < ${HANDLER_P95_TARGET_MS}ms, got ${report.handlerDurationMs.p95}ms`,
  );
  assert.ok(
    report.handlerDurationMs.p99 < HANDLER_P99_TARGET_MS,
    `expected handler p99 < ${HANDLER_P99_TARGET_MS}ms, got ${report.handlerDurationMs.p99}ms`,
  );
});
