import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { OBSERVME_CHILD_ROLES } from "../src/integration.ts";
import type { AgentLineageContext } from "../src/pi/agent-lineage.ts";
import {
  createAgentTreeTracker,
  createObservMeMetrics,
  createSpanRegistry,
  registerHandlers,
  type Handler,
  type ObservMeTelemetrySession,
} from "../src/pi/handlers.ts";
import { metricLabels } from "../src/pi/handler-internals.ts";
import {
  completeSubagentSpawn,
  failSubagentSpawn,
  observeTrustedSubagentLineage,
  recordAgentJoin,
  recordAgentWait,
  startSubagentSpawn,
  type AgentWaitJoinOptions,
  type StartSubagentSpawnOptions,
  type SubagentTelemetrySession,
} from "../src/pi/subagent-spawn.ts";
import { isPlainRecord } from "./support/telemetry-types.ts";
import type { TestAttributes, TestMetricRecord, TestSpan, TestSpanContext } from "./support/telemetry-types.ts";
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
  "display_name",
  "agent_display_name",
  "child_display_name",
  "pi.agent.display_name",
  "pi.agent.child.display_name",
  "capability",
  "agent_capability",
  "child_capability",
  "pi.agent.capability",
  "pi.agent.child.capability",
]);
const documentedAgentRoleLabels = new Set([
  "root",
  ...OBSERVME_CHILD_ROLES,
  "subagent",
  "orchestrator",
  "reviewer",
  "unknown",
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
  "Parent Coordinator Cardinality",
  "parent-capability-cardinality",
  "Duplicate Scout Identity",
  "code-search-cardinality",
];
const validSpanContext: TestSpanContext = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: 1,
};
const invalidSpanContext: TestSpanContext = {
  traceId: "00000000000000000000000000000000",
  spanId: "0000000000000000",
  traceFlags: 0,
};
const localCollectorConfigFile = "observability-stack/config/otel/otel-collector.yaml";
const localLokiConfigFile = "observability-stack/config/loki/loki.yaml";
const collectorDroppedIdentityResourceAttributes = [
  "pi.agent.display_name",
  "pi.agent.capability",
  "pi.agent.child.display_name",
  "pi.agent.child.capability",
];

function compareStrings(left: string, right: string): number {
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
    ...recordsFor(waitJoinMetricNames(), { agent_role: "root", subagent_depth: "1", status: "failed", reason: "child_running" }),
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

function recordsFor(names: readonly string[], attributes: TestAttributes): Array<Pick<TestMetricRecord, "name" | "attributes">> {
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
    OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_AGENTS,
    OBSERVME_GAUGE_METRIC_NAMES.AGENT_LEASE_EXPIRES_UNIXTIME_SECONDS,
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
    OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_SPANS,
  ];
}

function officialGenAiMetricNames() {
  return [OFFICIAL_GENAI_METRIC_NAMES.CLIENT_TOKEN_USAGE, OFFICIAL_GENAI_METRIC_NAMES.CLIENT_OPERATION_DURATION];
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
    createObservableGauge: () => ({
      addCallback: () => undefined,
      removeCallback: () => undefined,
    }),
  };
}

function createFakeTracer(spanContext: TestSpanContext = validSpanContext, throwOnStart = false) {
  const spans: TestSpan[] = [];

  return {
    spans,
    startSpan: (name: string, options: { attributes?: TestAttributes } = {}, parentContext: unknown = undefined) => {
      if (throwOnStart) throw new Error("raw error stack should not become a metric label");
      const parentSpan = parentContext ? trace.getSpan(parentContext as Parameters<typeof trace.getSpan>[0]) : undefined;
      const span = createFakeSpan(name, options.attributes ?? {}, parentSpan, spanContext);
      spans.push(span);
      return span;
    },
  };
}

function createFakeSpan(name: string, attributes: TestAttributes, parentSpan: unknown, spanContext: TestSpanContext): TestSpan {
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

function createFakeLogger() {
  return { emit: () => undefined };
}

function makeLineage(overrides: Record<string, unknown> = {}) {
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

type FakeTelemetrySession = Omit<ObservMeTelemetrySession, "logger" | "sessionAttributes" | "sessionSpan" | "tracer"> &
  SubagentTelemetrySession & {
    readonly meter: ReturnType<typeof createFakeMeter>;
    readonly tracer: ReturnType<typeof createFakeTracer>;
  };

function createTelemetrySession(options: TelemetrySessionOptions = {}): FakeTelemetrySession {
  const config = options.config ?? structuredClone(defaultObservMeConfig);
  const lineage = options.lineage ?? makeLineage();
  const meter = createFakeMeter();
  const metrics = createObservMeMetrics(meter);
  const tracer = createFakeTracer(options.spanContext ?? validSpanContext, options.throwOnStart ?? false);

  return {
    config,
    lineage,
    controller: {
      flush: async () => ({ operation: "flush" as const, completed: true, timedOut: false }),
      shutdown: async () => ({ operation: "shutdown" as const, completed: true, timedOut: false }),
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

async function recordHandlerErrorMetric(): Promise<TestMetricRecord[]> {
  const pi = createFakePi();
  let telemetry: FakeTelemetrySession | undefined;

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

function recordSubagentMetrics(): TestMetricRecord[] {
  const telemetry = createTelemetrySession({
    spanContext: invalidSpanContext,
    lineage: makeLineage({
      displayName: "Parent Coordinator Cardinality",
      capability: "parent-capability-cardinality",
    }),
  });
  telemetry.sessionSpan = createFakeSpan("pi.session", {}, undefined, invalidSpanContext);
  const started = startSubagentSpawn(telemetry, {
    spawnId: "spawn-cardinality",
    childIdentity: {
      mode: "v2",
      descriptor: {
        displayName: "Duplicate Scout Identity",
        role: "worker",
        capability: "code-search-cardinality",
      },
    },
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

function assertInventoryCoversEveryMetric(records: ReadonlyArray<Pick<TestMetricRecord, "name" | "attributes">>): void {
  const names = records.map(record => record.name).sort(compareStrings);
  const uniqueNames = [...new Set(names)];

  assert.deepEqual(uniqueNames, ALL_METRIC_NAMES);
  assert.equal(names.length, uniqueNames.length, "metric label inventory must not duplicate metric names");
}

function assertMetricRecordsUseOnlyAllowedLabels(records: ReadonlyArray<Pick<TestMetricRecord, "name" | "attributes">>): void {
  for (const record of records) assertMetricRecordUsesOnlyAllowedLabels(record);
}

function assertMetricRecordUsesOnlyAllowedLabels(record: Pick<TestMetricRecord, "name" | "attributes">): void {
  for (const [key, value] of Object.entries(record.attributes ?? {})) {
    assert.equal(documentedAllowedLabels.has(key), true, `${record.name} used undocumented metric label ${key}`);
    assert.equal(documentedForbiddenLabels.has(key), false, `${record.name} used forbidden metric label ${key}`);
    assert.equal(forbiddenLabelPattern().test(key), false, `${record.name} used high-cardinality metric label ${key}`);
    if (key === "agent_role") {
      assert.equal(documentedAgentRoleLabels.has(String(value)), true, `${record.name} used unknown role label ${value}`);
    }
    assertMetricLabelValueIsNotForbidden(record, key, value);
  }
}

function assertMetricLabelValueIsNotForbidden(record: Pick<TestMetricRecord, "name">, key: string, value: unknown): void {
  const stringValue = String(value);

  for (const forbiddenValue of forbiddenCardinalityValues) {
    assert.equal(
      stringValue.includes(forbiddenValue),
      false,
      `${record.name} leaked forbidden value ${forbiddenValue} through label ${key}`,
    );
  }
}

function forbiddenLabelPattern(): RegExp {
  return /(?:workflow|session|trace|span|entry|spawn|tool_call)[._-]id|agent[._-](?:id|parent[._-]id|root[._-]id|child[._-]id)|(?:parent|child|root)[._-]agent[._-]id|(?:^|[._-])(?:display[._-]?name|capability)$|raw[._-](?:path|command|prompt|error)/iu;
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

test("v2 child identity stays out of parent metric labels and lifecycle correlation", () => {
  const telemetry = createTelemetrySession();
  const displayName = "Duplicate Scout Identity";
  const started = startSubagentSpawn(telemetry, {
    spawnId: "spawn-v2-cardinality",
    childAgentId: "child-v2-cardinality",
    childIdentity: {
      mode: "v2",
      descriptor: { displayName, role: "worker", capability: "code-search-cardinality" },
    },
    spawnType: "extension",
    spawnReason: "delegated_task",
  });
  const parentMetricRecords = telemetry.meter.records.filter(record => record.attributes.agent_role !== undefined);

  assert.ok(parentMetricRecords.length > 0);
  assert.deepEqual([...new Set(parentMetricRecords.map(record => record.attributes.agent_role))], ["root"]);
  assertMetricRecordsUseOnlyAllowedLabels(telemetry.meter.records);
  assert.deepEqual(completeSubagentSpawn(telemetry, started.spawnId, { childAgentId: displayName }), {
    ok: false,
    reason: "child_agent_mismatch",
  });
  assert.ok(telemetry.spans.activeSubagentSpawns.get(started.spawnId));
  assert.deepEqual(completeSubagentSpawn(telemetry, started.spawnId, { childAgentId: started.childAgentId }), { ok: true });
});

test("agent role metric labels accept only v2 catalog and explicit legacy values", () => {
  const expectedRoles = [
    "root",
    ...OBSERVME_CHILD_ROLES,
    "subagent",
    "orchestrator",
    "reviewer",
    "unknown",
  ] as const;
  const emittedRoles = new Set<string>();

  for (const role of expectedRoles) {
    const lineage = makeLineage({ role }) as AgentLineageContext;
    const telemetry = createTelemetrySession({ lineage });
    startSubagentSpawn(telemetry, { spawnId: `spawn-role-${role}`, childAgentId: `child-role-${role}` });
    for (const record of telemetry.meter.records) {
      if (record.attributes.agent_role !== undefined) emittedRoles.add(String(record.attributes.agent_role));
    }
    assert.equal(metricLabels(telemetry.config, lineage).agent_role, role);
  }

  const invalidLineage = makeLineage({ role: "launcher-defined-unbounded-role" }) as unknown as AgentLineageContext;
  const invalidTelemetry = createTelemetrySession({ lineage: invalidLineage });
  startSubagentSpawn(invalidTelemetry, { spawnId: "spawn-role-invalid", childAgentId: "child-role-invalid" });

  assert.deepEqual(emittedRoles, new Set(expectedRoles));
  assert.equal(metricLabels(invalidTelemetry.config, invalidLineage).agent_role, "unknown");
  assert.deepEqual(
    new Set(
      invalidTelemetry.meter.records
        .map(record => record.attributes.agent_role)
        .filter(role => role !== undefined),
    ),
    new Set(["unknown"]),
  );
});

test("Collector removes friendly identity only from metrics and retains it for traces and logs", async () => {
  const [text, lokiConfig] = await Promise.all([
    readFile(localCollectorConfigFile, "utf8"),
    readFile(localLokiConfigFile, "utf8"),
  ]);
  const policyStart = text.indexOf("resource/drop_high_cardinality_metric_attrs:");
  const policyEnd = text.indexOf("attributes/drop_content_attributes:", policyStart);

  assert.notEqual(policyStart, -1, `${localCollectorConfigFile}: metric resource drop processor is required`);
  assert.notEqual(policyEnd, -1, `${localCollectorConfigFile}: metric resource drop processor must be bounded`);
  const policy = text.slice(policyStart, policyEnd);
  for (const attribute of collectorDroppedIdentityResourceAttributes) {
    assert.ok(
      policy.includes(`- key: ${attribute}\n        action: delete`),
      `${localCollectorConfigFile}: ${attribute} must be deleted before Prometheus resource conversion`,
    );
  }
  assert.equal(
    policy.includes("- key: pi.agent.role\n        action: delete"),
    false,
    `${localCollectorConfigFile}: bounded exact roles must remain available to Prometheus`,
  );
  assert.match(text, /resource_to_telemetry_conversion:\n\s+enabled: true/u);
  assert.match(
    text,
    /metrics:[\s\S]*processors: \[memory_limiter, resource\/observme, resource\/drop_high_cardinality_metric_attrs, batch\]/u,
  );

  const logsPipeline = text.match(/\n {4}logs:\n(?<pipeline>[\s\S]*?)\n {4}traces:/u)?.groups?.pipeline ?? "";
  const tracesPipeline = text.match(/\n {4}traces:\n(?<pipeline>[\s\S]*?)\n {6}exporters: \[otlp\/tempo\]/u)?.groups?.pipeline ?? "";
  const lokiAttributeLabels = text.match(/key: loki[.]attribute[.]labels\n\s+value: (?<labels>[^\n]+)/u)?.groups?.labels ?? "";

  assert.ok(logsPipeline, `${localCollectorConfigFile}: logs pipeline is required`);
  assert.ok(tracesPipeline, `${localCollectorConfigFile}: traces pipeline is required`);
  assert.doesNotMatch(logsPipeline, /resource\/drop_high_cardinality_metric_attrs/u);
  assert.doesNotMatch(tracesPipeline, /resource\/drop_high_cardinality_metric_attrs/u);
  assert.match(lokiConfig, /allow_structured_metadata:\s*true/u);
  assert.match(logsPipeline, /exporters: \[otlphttp\/loki\]/u);
  assert.match(text, /otlphttp\/loki:\n\s+endpoint: http:\/\/loki:3100\/otlp/u);
  for (const attribute of collectorDroppedIdentityResourceAttributes) {
    assert.equal(
      lokiAttributeLabels.split(",").includes(attribute),
      false,
      `${localCollectorConfigFile}: ${attribute} must remain structured metadata instead of a Loki label`,
    );
    assert.equal(
      lokiConfig.includes(`- ${attribute}`),
      false,
      `${localLokiConfigFile}: ${attribute} must not be configured as an index label`,
    );
  }
});

test("hundreds of arbitrary spawn and wait reasons collapse to bounded enum labels", () => {
  const telemetry = createTelemetrySession();

  for (let index = 0; index < 300; index += 1) {
    const started = startSubagentSpawn(
      telemetry,
      {
        spawnId: `spawn-reason-${index}`,
        childAgentId: `child-reason-${index}`,
        spawnType: "command",
        spawnReason: `external_spawn_reason_${index}`,
      } as unknown as StartSubagentSpawnOptions,
    );
    recordAgentWait(
      telemetry,
      {
        id: `wait-reason-${index}`,
        childAgentId: started.childAgentId,
        childStatus: "active",
        joinStatus: `external_status_${index}`,
        reason: `external_wait_reason_${index}`,
        durationMs: index,
      } as unknown as AgentWaitJoinOptions,
    );
    completeSubagentSpawn(telemetry, started.spawnId, { childAgentId: started.childAgentId });
  }

  const spawnRecords = telemetry.meter.records.filter(
    record => record.name === OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL,
  );
  const waitRecords = telemetry.meter.records.filter(
    record => record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS,
  );
  const spawnReasons = new Set(spawnRecords.map(record => record.attributes.spawn_reason));
  const waitReasons = new Set(waitRecords.map(record => record.attributes.reason));
  const waitStatuses = new Set(waitRecords.map(record => record.attributes.status));

  assert.deepEqual([...spawnReasons], ["unknown"]);
  assert.deepEqual([...waitReasons], ["unknown"]);
  assert.deepEqual([...waitStatuses], ["unknown"]);
  assert.doesNotMatch(JSON.stringify([...spawnRecords, ...waitRecords]), /external_(?:spawn|wait)_reason_/u);
});
