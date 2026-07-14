import assert from "node:assert/strict";
import test from "node:test";
import type { Attributes, MetricOptions, ObservableCallback, ObservableResult } from "@opentelemetry/api";
import { createObservMeMetrics } from "../src/pi/handlers.ts";
import type { TestAttributes, TestMetricRecord } from "./support/telemetry-types.ts";
import {
  ALL_METRIC_NAMES,
  OBSERVME_AGENT_LEASE_METRIC_OPTIONS,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_GAUGE_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
  OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES,
  OFFICIAL_GENAI_METRIC_NAMES,
} from "../src/semconv/metrics.ts";

type ObservMeMetrics = ReturnType<typeof createObservMeMetrics>;

type MetricMethod = "add" | "observe" | "record";

interface MetricExercise {
  readonly name: string;
  readonly instrument: keyof ObservMeMetrics;
  readonly method: MetricMethod;
  readonly type: string;
  readonly value: number;
}

interface TestMetricInstrument {
  readonly add?: (value: number, attributes: TestAttributes) => void;
  readonly addCallback?: (callback: ObservableCallback) => void;
  readonly record?: (value: number, attributes: TestAttributes) => void;
  readonly removeCallback?: (callback: ObservableCallback) => void;
}

class RecordingObservableGauge {
  readonly name: string;
  readonly options: MetricOptions;
  readonly #records: TestMetricRecord[];
  readonly #callbacks = new Set<ObservableCallback>();

  constructor(name: string, options: MetricOptions, records: TestMetricRecord[]) {
    this.name = name;
    this.options = options;
    this.#records = records;
  }

  get callbackCount(): number {
    return this.#callbacks.size;
  }

  addCallback(callback: ObservableCallback): void {
    this.#callbacks.add(callback);
  }

  removeCallback(callback: ObservableCallback): void {
    this.#callbacks.delete(callback);
  }

  async collect(): Promise<void> {
    const result: ObservableResult = { observe: this.observe.bind(this) };
    for (const callback of [...this.#callbacks]) await callback(result);
  }

  private observe(value: number, attributes: Attributes = {}): void {
    this.#records.push({
      type: "observableGauge",
      name: this.name,
      value,
      attributes: { ...attributes },
    });
  }
}

const exerciseLabels = { environment: "test", agent_role: "root" };
const metricExercises = [
  { name: OBSERVME_COUNTER_METRIC_NAMES.SESSIONS_STARTED_TOTAL, instrument: "sessionsStarted", method: "add", type: "counter", value: 1 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.SESSIONS_SHUTDOWN_TOTAL, instrument: "sessionsShutdown", method: "add", type: "counter", value: 2 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.WORKFLOWS_STARTED_TOTAL, instrument: "workflowsStarted", method: "add", type: "counter", value: 3 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.WORKFLOWS_COMPLETED_TOTAL, instrument: "workflowsCompleted", method: "add", type: "counter", value: 4 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.WORKFLOW_ERRORS_TOTAL, instrument: "workflowErrors", method: "add", type: "counter", value: 5 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.AGENT_RUNS_TOTAL, instrument: "agentRuns", method: "add", type: "counter", value: 6 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.AGENT_RUN_ERRORS_TOTAL, instrument: "agentRunErrors", method: "add", type: "counter", value: 7 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL, instrument: "subagentsSpawned", method: "add", type: "counter", value: 8 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL, instrument: "subagentSpawnFailures", method: "add", type: "counter", value: 9 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL, instrument: "orphanAgents", method: "add", type: "counter", value: 10 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL, instrument: "traceContextPropagationFailures", method: "add", type: "counter", value: 11 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.CHILD_AGENT_FAILURES_TOTAL, instrument: "childAgentFailures", method: "add", type: "counter", value: 12 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.PARENT_RECOVERED_FROM_CHILD_FAILURE_TOTAL, instrument: "parentRecoveredFromChildFailure", method: "add", type: "counter", value: 13 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.TURNS_STARTED_TOTAL, instrument: "turnsStarted", method: "add", type: "counter", value: 14 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.TURNS_COMPLETED_TOTAL, instrument: "turnsCompleted", method: "add", type: "counter", value: 15 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.LLM_REQUESTS_TOTAL, instrument: "llmRequests", method: "add", type: "counter", value: 16 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.LLM_ERRORS_TOTAL, instrument: "llmErrors", method: "add", type: "counter", value: 17 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.TOOL_CALLS_TOTAL, instrument: "toolCalls", method: "add", type: "counter", value: 18 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.TOOL_FAILURES_TOTAL, instrument: "toolFailures", method: "add", type: "counter", value: 19 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL, instrument: "bashExecutions", method: "add", type: "counter", value: 20 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.BASH_FAILURES_TOTAL, instrument: "bashFailures", method: "add", type: "counter", value: 21 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.MODEL_CHANGES_TOTAL, instrument: "modelChanges", method: "add", type: "counter", value: 22 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.THINKING_LEVEL_CHANGES_TOTAL, instrument: "thinkingLevelChanges", method: "add", type: "counter", value: 23 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.COMPACTIONS_TOTAL, instrument: "compactions", method: "add", type: "counter", value: 24 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.BRANCHES_TOTAL, instrument: "branches", method: "add", type: "counter", value: 25 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL, instrument: "telemetryDropped", method: "add", type: "counter", value: 26 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.EXPORT_ERRORS_TOTAL, instrument: "exportErrors", method: "add", type: "counter", value: 27 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.REDACTION_FAILURES_TOTAL, instrument: "redactionFailures", method: "add", type: "counter", value: 28 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.EVENTS_OBSERVED_TOTAL, instrument: "eventsObserved", method: "add", type: "counter", value: 29 },
  { name: OBSERVME_COUNTER_METRIC_NAMES.HANDLER_ERRORS_TOTAL, instrument: "handlerErrors", method: "add", type: "counter", value: 30 },
  { name: OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_INPUT_TOKENS_TOTAL, instrument: "llmInputTokens", method: "add", type: "counter", value: 31 },
  { name: OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_OUTPUT_TOKENS_TOTAL, instrument: "llmOutputTokens", method: "add", type: "counter", value: 32 },
  { name: OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_READ_TOKENS_TOTAL, instrument: "llmCacheReadTokens", method: "add", type: "counter", value: 33 },
  { name: OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_WRITE_TOKENS_TOTAL, instrument: "llmCacheWriteTokens", method: "add", type: "counter", value: 34 },
  { name: OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_WRITE_1H_TOKENS_TOTAL, instrument: "llmCacheWrite1hTokens", method: "add", type: "counter", value: 35 },
  { name: OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_REASONING_TOKENS_TOTAL, instrument: "llmReasoningTokens", method: "add", type: "counter", value: 36 },
  { name: OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_TOTAL_TOKENS_TOTAL, instrument: "llmTotalTokens", method: "add", type: "counter", value: 37 },
  { name: OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_COST_USD_TOTAL, instrument: "llmCostUsd", method: "add", type: "counter", value: 38 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.WORKFLOW_DURATION_MS, instrument: "workflowDurationMs", method: "record", type: "histogram", value: 39 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_RUN_DURATION_MS, instrument: "agentRunDurationMs", method: "record", type: "histogram", value: 40 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_LIFETIME_DURATION_MS, instrument: "agentLifetimeDurationMs", method: "record", type: "histogram", value: 41 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.SUBAGENT_SPAWN_DURATION_MS, instrument: "subagentSpawnDurationMs", method: "record", type: "histogram", value: 42 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS, instrument: "agentWaitDurationMs", method: "record", type: "histogram", value: 43 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_JOIN_DURATION_MS, instrument: "agentJoinDurationMs", method: "record", type: "histogram", value: 44 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_DEPTH, instrument: "agentTreeDepth", method: "record", type: "histogram", value: 45 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_WIDTH, instrument: "agentTreeWidth", method: "record", type: "histogram", value: 46 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_FANOUT_COUNT, instrument: "agentFanoutCount", method: "record", type: "histogram", value: 47 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.TURN_DURATION_MS, instrument: "turnDurationMs", method: "record", type: "histogram", value: 48 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.LLM_REQUEST_DURATION_MS, instrument: "llmRequestDurationMs", method: "record", type: "histogram", value: 49 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.TOOL_DURATION_MS, instrument: "toolDurationMs", method: "record", type: "histogram", value: 50 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS, instrument: "bashDurationMs", method: "record", type: "histogram", value: 51 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.COMPACTION_TOKENS_BEFORE, instrument: "compactionTokensBefore", method: "record", type: "histogram", value: 52 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.PROMPT_SIZE_CHARS, instrument: "promptSizeChars", method: "record", type: "histogram", value: 53 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.RESPONSE_SIZE_CHARS, instrument: "responseSizeChars", method: "record", type: "histogram", value: 54 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.TOOL_RESULT_SIZE_CHARS, instrument: "toolResultSizeChars", method: "record", type: "histogram", value: 55 },
  { name: OBSERVME_HISTOGRAM_METRIC_NAMES.HANDLER_DURATION_MS, instrument: "handlerDurationMs", method: "record", type: "histogram", value: 56 },
  { name: OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_SPANS, instrument: "activeSpans", method: "add", type: "upDownCounter", value: 57 },
  { name: OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_AGENTS, instrument: "activeAgents", method: "add", type: "upDownCounter", value: 58 },
  {
    name: OBSERVME_GAUGE_METRIC_NAMES.AGENT_LEASE_EXPIRES_UNIXTIME_SECONDS,
    instrument: "agentLeaseExpiresUnixTimeSeconds",
    method: "observe",
    type: "observableGauge",
    value: 59,
  },
  { name: OFFICIAL_GENAI_METRIC_NAMES.CLIENT_TOKEN_USAGE, instrument: "genAiClientTokenUsage", method: "record", type: "histogram", value: 60 },
  { name: OFFICIAL_GENAI_METRIC_NAMES.CLIENT_OPERATION_DURATION, instrument: "genAiClientOperationDuration", method: "record", type: "histogram", value: 61 },
] satisfies readonly MetricExercise[];

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function createRecordingMeter() {
  const records: TestMetricRecord[] = [];
  const observableGauges = new Map<string, RecordingObservableGauge>();

  return {
    records,
    observableGauges,
    createCounter: (name: string) => ({
      add: (value: number, attributes: TestAttributes = {}) => records.push({ type: "counter", name, value, attributes }),
    }),
    createUpDownCounter: (name: string) => ({
      add: (value: number, attributes: TestAttributes = {}) => records.push({ type: "upDownCounter", name, value, attributes }),
    }),
    createHistogram: (name: string) => ({
      record: (value: number, attributes: TestAttributes = {}) => records.push({ type: "histogram", name, value, attributes }),
    }),
    createObservableGauge: (name: string, options: MetricOptions = {}) => {
      const gauge = new RecordingObservableGauge(name, options, records);
      observableGauges.set(name, gauge);
      return gauge;
    },
  };
}

async function exerciseMetric(
  metrics: ObservMeMetrics,
  exercise: MetricExercise,
  meter: ReturnType<typeof createRecordingMeter>,
): Promise<void> {
  const instrument = metrics[exercise.instrument] as TestMetricInstrument | undefined;
  if (!instrument) assert.fail(`${exercise.instrument} should exist for ${exercise.name}`);

  if (exercise.method === "observe") {
    await exerciseObservableGauge(instrument, exercise, meter);
    return;
  }

  const recordMetric = instrument[exercise.method];
  if (typeof recordMetric !== "function") assert.fail(`${exercise.instrument} should record ${exercise.name}`);
  recordMetric(exercise.value, exerciseLabels);
}

async function exerciseObservableGauge(
  instrument: TestMetricInstrument,
  exercise: MetricExercise,
  meter: ReturnType<typeof createRecordingMeter>,
): Promise<void> {
  const gauge = meter.observableGauges.get(exercise.name);
  if (!gauge || !instrument.addCallback || !instrument.removeCallback) {
    assert.fail(`${exercise.instrument} should expose an observable callback API`);
  }

  const callback = observeExerciseValue.bind(undefined, exercise.value, exerciseLabels);
  instrument.addCallback(callback);
  assert.equal(gauge.callbackCount, 1);
  await gauge.collect();
  const recordCount = meter.records.length;
  instrument.removeCallback(callback);
  assert.equal(gauge.callbackCount, 0);
  await gauge.collect();
  assert.equal(meter.records.length, recordCount, "removed callbacks must not observe again");
}

function observeExerciseValue(value: number, attributes: Attributes, result: ObservableResult): void {
  result.observe(value, attributes);
}

function findMetricRecord(records: readonly TestMetricRecord[], exercise: MetricExercise): TestMetricRecord | undefined {
  return records.find(record => record.name === exercise.name && record.type === exercise.type && record.value === exercise.value);
}

function metricExerciseNames() {
  return metricExercises.map(exercise => exercise.name).sort(compareStrings);
}

function assertEveryMetricConstantHasAnExercise() {
  const exerciseNames = metricExerciseNames();
  const uniqueExerciseNames = [...new Set(exerciseNames)];

  assert.deepEqual(uniqueExerciseNames, ALL_METRIC_NAMES);
  assert.equal(exerciseNames.length, uniqueExerciseNames.length, "metric exercises must not duplicate metric names");
}

test("metric helper records every documented metric constant", async () => {
  const meter = createRecordingMeter();
  const metrics = createObservMeMetrics(meter);

  assertEveryMetricConstantHasAnExercise();
  for (const exercise of metricExercises) await exerciseMetric(metrics, exercise, meter);

  const leaseGauge = meter.observableGauges.get(
    OBSERVME_GAUGE_METRIC_NAMES.AGENT_LEASE_EXPIRES_UNIXTIME_SECONDS,
  );
  assert.deepEqual(leaseGauge?.options, OBSERVME_AGENT_LEASE_METRIC_OPTIONS);

  for (const exercise of metricExercises) {
    const record = findMetricRecord(meter.records, exercise);

    assert.ok(record, `${exercise.name} should record ${exercise.value}`);
    assert.deepEqual(record.attributes, exerciseLabels, `${exercise.name} should keep metric labels low-cardinality`);
  }
});
