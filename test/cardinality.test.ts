import assert from "node:assert/strict";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import type { AgentLineageContext } from "../src/pi/agent-lineage.ts";
import {
  createAgentTreeTracker,
  createObservMeMetrics,
  createSpanRegistry,
  registerHandlers,
} from "../src/pi/handlers.ts";
import {
  failSubagentSpawn,
  observeTrustedSubagentLineage,
  recordAgentJoin,
  recordAgentWait,
  startSubagentSpawn,
} from "../src/pi/subagent-spawn.ts";
import {
  ALL_METRIC_NAMES,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_GAUGE_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
  OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES,
  OFFICIAL_GENAI_METRIC_NAMES,
} from "../src/semconv/metrics.ts";

const documentedAllowedLabels = new Set([
  "provider",
  "model",
  "tool_name",
  "tool_category",
  "environment",
  "operation",
  "status",
  "error_class",
  "reason",
  "agent_role",
  "agent_capability",
  "subagent_depth",
  "spawn_type",
  "spawn_reason",
  "pi_version",
  "observme_version",
  "token_type",
]);
const documentedForbiddenLabels = new Set([
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
  "raw_command",
  "raw_prompt",
  "raw_path",
  "raw_error",
  "raw_error_message",
]);
const forbiddenCardinalityValues = [
  "workflow-cardinality",
  "workflow-root-cardinality",
  "session-cardinality",
  "agent-root-cardinality",
  "agent-parent-cardinality",
  "agent-child-cardinality",
  "agent-run-cardinality",
  "spawn-cardinality",
  "tool-call-cardinality",
  "trace-cardinality",
  "span-cardinality",
  "entry-cardinality",
  "/Users/alice/private-project",
  "cat /Users/alice/private-project/secret.txt",
  "raw prompt secret",
  "raw error stack",
];
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

function compareStrings(left, right) {
  return left.localeCompare(right);
}

function metricInventoryRecords() {
  return [
    ...recordsFor(commonMetricNames(), { environment: "test", agent_role: "root" }),
    ...recordsFor(llmMetricNames(), { environment: "test", agent_role: "root", provider: "anthropic", model: "claude" }),
    ...recordsFor(toolMetricNames(), { tool_name: "bash", tool_category: "shell" }),
    ...recordsFor(bashMetricNames(), { environment: "test", agent_role: "root", status: "error", error_class: "non_zero_exit" }),
    ...recordsFor(subagentMetricNames(), {
      agent_role: "root",
      subagent_depth: "1",
      spawn_type: "command",
      spawn_reason: "delegated_task",
    }),
    ...recordsFor(waitJoinMetricNames(), { agent_role: "root", subagent_depth: "1", status: "failed", reason: "child_completion" }),
    ...recordsFor(orphanMetricNames(), { status: "orphaned", reason: "orphaned" }),
    ...recordsFor(traceContextMetricNames(), { agent_role: "root", subagent_depth: "1", reason: "trace_context_fallback" }),
    ...recordsFor(subagentFailureMetricNames(), { spawn_type: "command", error_class: "spawn_error" }),
    ...recordsFor(selfObservabilityMetricNames(), { operation: "session_start", reason: "span_registry_full", error_class: "timeout" }),
    ...recordsFor(officialGenAiMetricNames(), {
      provider: "anthropic",
      model: "claude",
      operation: "chat",
      status: "ok",
      token_type: "input",
    }),
  ];
}

function recordsFor(names, attributes) {
  return names.map(name => ({ name, attributes }));
}

function commonMetricNames() {
  return [
    OBSERVME_COUNTER_METRIC_NAMES.SESSIONS_STARTED_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.SESSIONS_SHUTDOWN_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.WORKFLOWS_STARTED_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.WORKFLOWS_COMPLETED_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.WORKFLOW_ERRORS_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.AGENT_RUNS_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.AGENT_RUN_ERRORS_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.TURNS_STARTED_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.TURNS_COMPLETED_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.THINKING_LEVEL_CHANGES_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.COMPACTIONS_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.BRANCHES_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.CHILD_AGENT_FAILURES_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.PARENT_RECOVERED_FROM_CHILD_FAILURE_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.EVENTS_OBSERVED_TOTAL,
    OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_SPANS,
    OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_AGENTS,
    OBSERVME_HISTOGRAM_METRIC_NAMES.WORKFLOW_DURATION_MS,
    OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_RUN_DURATION_MS,
    OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_LIFETIME_DURATION_MS,
    OBSERVME_HISTOGRAM_METRIC_NAMES.TURN_DURATION_MS,
    OBSERVME_HISTOGRAM_METRIC_NAMES.COMPACTION_TOKENS_BEFORE,
    OBSERVME_HISTOGRAM_METRIC_NAMES.HANDLER_DURATION_MS,
  ];
}

function llmMetricNames() {
  return [
    OBSERVME_COUNTER_METRIC_NAMES.LLM_REQUESTS_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.LLM_ERRORS_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.MODEL_CHANGES_TOTAL,
    OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_INPUT_TOKENS_TOTAL,
    OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_OUTPUT_TOKENS_TOTAL,
    OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_READ_TOKENS_TOTAL,
    OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_WRITE_TOKENS_TOTAL,
    OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_WRITE_1H_TOKENS_TOTAL,
    OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_REASONING_TOKENS_TOTAL,
    OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_TOTAL_TOKENS_TOTAL,
    OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_COST_USD_TOTAL,
    OBSERVME_HISTOGRAM_METRIC_NAMES.LLM_REQUEST_DURATION_MS,
    OBSERVME_HISTOGRAM_METRIC_NAMES.PROMPT_SIZE_CHARS,
    OBSERVME_HISTOGRAM_METRIC_NAMES.RESPONSE_SIZE_CHARS,
  ];
}

function toolMetricNames() {
  return [
    OBSERVME_COUNTER_METRIC_NAMES.TOOL_CALLS_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.TOOL_FAILURES_TOTAL,
    OBSERVME_HISTOGRAM_METRIC_NAMES.TOOL_DURATION_MS,
    OBSERVME_HISTOGRAM_METRIC_NAMES.TOOL_RESULT_SIZE_CHARS,
  ];
}

function bashMetricNames() {
  return [
    OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.BASH_FAILURES_TOTAL,
    OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS,
  ];
}

function subagentMetricNames() {
  return [
    OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL,
    OBSERVME_HISTOGRAM_METRIC_NAMES.SUBAGENT_SPAWN_DURATION_MS,
    OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_FANOUT_COUNT,
    OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_DEPTH,
    OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_WIDTH,
  ];
}

function waitJoinMetricNames() {
  return [OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_JOIN_DURATION_MS];
}

function orphanMetricNames() {
  return [OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL];
}

function traceContextMetricNames() {
  return [OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL];
}

function subagentFailureMetricNames() {
  return [OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL];
}

function selfObservabilityMetricNames() {
  return [
    OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.EXPORT_ERRORS_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.REDACTION_FAILURES_TOTAL,
    OBSERVME_COUNTER_METRIC_NAMES.HANDLER_ERRORS_TOTAL,
  ];
}

function officialGenAiMetricNames() {
  return [OFFICIAL_GENAI_METRIC_NAMES.CLIENT_TOKEN_USAGE, OFFICIAL_GENAI_METRIC_NAMES.CLIENT_OPERATION_DURATION];
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

function createFakeTracer(spanContext = validSpanContext, throwOnStart = false) {
  const spans = [];

  return {
    spans,
    startSpan: (name, options: { attributes?: Record<string, unknown> } = {}, parentContext = undefined) => {
      if (throwOnStart) throw new Error("raw error stack should not become a metric label");
      const parentSpan = parentContext ? trace.getSpan(parentContext) : undefined;
      const span = createFakeSpan(name, options.attributes ?? {}, parentSpan, spanContext);
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
      return this;
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
      return this;
    },
    setAttributes(values) {
      Object.assign(this.attributes, values);
      return this;
    },
    setStatus(status) {
      this.status = status;
      return this;
    },
    spanContext() {
      return spanContext;
    },
    addLink() {
      return this;
    },
    addLinks() {
      return this;
    },
    updateName() {
      return this;
    },
    isRecording() {
      return true;
    },
    recordException() {
      return undefined;
    },
    end() {
      this.ended = true;
    },
  };
}

function createFakeLogger() {
  return { emit: () => undefined };
}

function makeLineage(overrides = {}) {
  return {
    workflowId: "workflow-cardinality",
    workflowRootAgentId: "workflow-root-cardinality",
    agentId: "agent-parent-cardinality",
    rootAgentId: "agent-root-cardinality",
    depth: 0,
    role: "root" as const,
    orphaned: false,
    ...overrides,
  };
}

interface TelemetrySessionOptions {
  readonly config?: typeof defaultObservMeConfig;
  readonly lineage?: AgentLineageContext;
  readonly spanContext?: typeof validSpanContext;
  readonly throwOnStart?: boolean;
  readonly sessionSpan?: ReturnType<typeof createFakeSpan>;
}

function createTelemetrySession(options: TelemetrySessionOptions = {}) {
  const config = options.config ?? structuredClone(defaultObservMeConfig);
  const lineage = options.lineage ?? makeLineage();
  const meter = createFakeMeter();
  const metrics = createObservMeMetrics(meter);
  const tracer = createFakeTracer(options.spanContext ?? validSpanContext, options.throwOnStart ?? false);

  return {
    config,
    lineage,
    controller: {
      flush: async () => ({ operation: "flush", completed: true, timedOut: false }),
      shutdown: async () => ({ operation: "shutdown", completed: true, timedOut: false }),
    },
    tracer,
    meter,
    logger: createFakeLogger(),
    metrics,
    spans: createSpanRegistry(config, metrics),
    agentTree: createAgentTreeTracker(config, lineage, metrics),
    sessionSpan: options.sessionSpan,
    sessionAttributes: { "pi.session.id": "session-cardinality" },
    activeAgentRecorded: false,
    agentRunSequence: 0,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences: new Map(),
  };
}

async function recordHandlerErrorMetric() {
  const pi = createFakePi();
  let telemetry;

  registerHandlers(pi, {
    loadConfig: async () => defaultObservMeConfig,
    startTelemetry: async options => {
      telemetry = createTelemetrySession({ lineage: options.lineage, throwOnStart: true });
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-cardinality" }, { cwd: "/Users/alice/private-project" });
  assert.ok(telemetry, "expected telemetry to be created before the handler error");
  return telemetry.meter.records;
}

function recordSubagentMetrics() {
  const telemetry = createTelemetrySession({ spanContext: invalidSpanContext });
  telemetry.sessionSpan = createFakeSpan("pi.session", {}, undefined, invalidSpanContext);
  const started = startSubagentSpawn(telemetry, {
    spawnId: "spawn-cardinality",
    toolCallId: "tool-call-cardinality",
    command: "cat /Users/alice/private-project/secret.txt",
    spawnType: "command",
    spawnReason: "delegated_task",
  });

  recordAgentWait(telemetry, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
    durationMs: 5,
  });
  recordAgentJoin(telemetry, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "failed",
    joinStatus: "failed",
    failurePropagated: true,
    durationMs: 7,
  });
  failSubagentSpawn(telemetry, started.spawnId, { childAgentId: started.childAgentId, errorClass: "SpawnError" });
  observeTrustedSubagentLineage(
    telemetry,
    {
      OBSERVME_WORKFLOW_ID: "workflow-cardinality",
      OBSERVME_PARENT_AGENT_ID: "missing-parent-cardinality",
      OBSERVME_AGENT_DEPTH: "0",
    },
    { generateId: () => "agent-child-cardinality" },
  );

  return telemetry.meter.records;
}

function assertInventoryCoversEveryMetric(records) {
  const names = records.map(record => record.name).sort(compareStrings);
  const uniqueNames = [...new Set(names)];

  assert.deepEqual(uniqueNames, ALL_METRIC_NAMES);
  assert.equal(names.length, uniqueNames.length, "metric label inventory must not duplicate metric names");
}

function assertMetricRecordsUseOnlyAllowedLabels(records) {
  for (const record of records) assertMetricRecordUsesOnlyAllowedLabels(record);
}

function assertMetricRecordUsesOnlyAllowedLabels(record) {
  for (const [key, value] of Object.entries(record.attributes ?? {})) {
    assert.equal(documentedAllowedLabels.has(key), true, `${record.name} used undocumented metric label ${key}`);
    assert.equal(documentedForbiddenLabels.has(key), false, `${record.name} used forbidden metric label ${key}`);
    assert.equal(forbiddenLabelPattern().test(key), false, `${record.name} used high-cardinality metric label ${key}`);
    assertMetricLabelValueIsNotForbidden(record, key, value);
  }
}

function assertMetricLabelValueIsNotForbidden(record, key, value) {
  const stringValue = String(value);

  for (const forbiddenValue of forbiddenCardinalityValues) {
    assert.equal(
      stringValue.includes(forbiddenValue),
      false,
      `${record.name} leaked forbidden value ${forbiddenValue} through label ${key}`,
    );
  }
}

function forbiddenLabelPattern() {
  return /(?:workflow|session|trace|span|entry|spawn|tool_call)[._-]id|agent[._-](?:id|parent[._-]id|root[._-]id|child[._-]id)|(?:parent|child|root)[._-]agent[._-]id|raw[._-](?:path|command|prompt|error)/iu;
}

test("metric cardinality inventory enumerates every metric with documented allowed labels only", () => {
  const records = metricInventoryRecords();

  assertInventoryCoversEveryMetric(records);
  assertMetricRecordsUseOnlyAllowedLabels(records);
});

test("representative emitted metric labels exclude IDs, trace/span context, and raw content", async () => {
  const records = [...(await recordHandlerErrorMetric()), ...recordSubagentMetrics()];

  assertMetricRecordsUseOnlyAllowedLabels(records);
});
