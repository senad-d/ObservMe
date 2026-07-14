import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { COMMON_SPAN_ATTRIBUTES, LOG_ATTRIBUTES, TOOL_ATTRIBUTES } from "../src/semconv/attributes.ts";
import type {
  Handler,
  ObservMeHandlerContext,
  ObservMeTelemetrySession,
  StartSessionTelemetryOptions,
} from "../src/pi/handlers.ts";
import {
  createAgentTreeTracker,
  createObservMeMetrics,
  createSpanRegistry,
  registerHandlers,
} from "../src/pi/handlers.ts";
import {
  completeSubagentSpawn,
  observeTrustedSubagentLineage,
  recordAgentJoin,
  recordAgentWait,
  startSubagentSpawn,
  type AgentWaitJoinOptions,
  type SubagentTelemetrySession,
} from "../src/pi/subagent-spawn.ts";
import {
  LOG_EVENT_NAMES,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
} from "../src/semconv/metrics.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";
import { isPlainRecord, mergeRecordConfig } from "./support/telemetry-types.ts";
import type { TestAttributes, TestLogger, TestMetricRecord, TestSpan, TestSpanContext } from "./support/telemetry-types.ts";

const requiredFixtureFiles = [
  "session-user-message.json",
  "session-assistant-usage.json",
  "session-assistant-usage-reasoning-cache.json",
  "tool-result-error.json",
  "bash-execution.json",
  "compaction.json",
  "branch-summary.json",
  "events/session-start.json",
  "events/agent-start-end.json",
  "events/turn-start-end.json",
  "events/message-end-assistant.json",
  "events/tool-execution-start-end.json",
  "events/session-compact.json",
  "events/session-tree.json",
  "events/subagent-spawn.json",
  "events/agent-wait-join.json",
  "events/orphan-agent.json",
];
const forbiddenMetricLabelKeys = [
  "workflow_id",
  "session_id",
  "agent_id",
  "parent_agent_id",
  "child_agent_id",
  "agent_run_id",
  "spawn_id",
  "spawn_tool_call_id",
  "tool_call_id",
  "turn_id",
  "trace_id",
  "span_id",
  "entry_id",
  "raw_path",
  "raw_command",
  "raw_prompt",
  "raw_error",
];
const hiddenContentPattern = /hidden-|private-repo|do not export/u;
process.env.OBSERVME_HASH_SALT = "event-mapping-test-salt";

const validSpanContext: TestSpanContext = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: 1,
};

function fixtureUrl(relativePath: string): URL {
  return new URL(`./fixtures/${relativePath}`, import.meta.url);
}

async function loadFixture(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixtureUrl(relativePath), "utf8")) as Record<string, unknown>;
}

async function loadEventFixtures() {
  const [sessionStart, agentRun, turn, llm, toolCall, bashExecution, compaction, branch, modelThinking] = await Promise.all([
    loadFixture("events/session-start.json"),
    loadFixture("events/agent-start-end.json"),
    loadFixture("events/turn-start-end.json"),
    loadFixture("events/message-end-assistant.json"),
    loadFixture("events/tool-execution-start-end.json"),
    loadFixture("bash-execution.json"),
    loadFixture("events/session-compact.json"),
    loadFixture("events/session-tree.json"),
    loadFixture("events/model-thinking-change.json"),
  ]);

  return { sessionStart, agentRun, turn, llm, toolCall, bashExecution, compaction, branch, modelThinking };
}

function cloneConfig(overrides: Record<string, unknown> = {}) {
  return mergeConfig(structuredClone(defaultObservMeConfig), overrides);
}

function mergeConfig<T extends Record<string, unknown>>(base: T, overlay: Record<string, unknown>): T {
  return mergeRecordConfig(base, overlay);
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

function createFakeTracer(spanContext: TestSpanContext = validSpanContext) {
  const spans: TestSpan[] = [];
  return {
    spans,
    startSpan: (name: string, options: { attributes?: TestAttributes } = {}, parentContext: unknown = undefined) => {
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

function createFakeLogger(): TestLogger {
  const records: TestLogger["records"] = [];
  return {
    records,
    emit: record => {
      records.push(record as TestLogger["records"][number]);
    },
  };
}

function createFakeController() {
  return {
    async flush() {
      return { operation: "flush" as const, completed: true, timedOut: false };
    },
    async shutdown() {
      return { operation: "shutdown" as const, completed: true, timedOut: false };
    },
  };
}

function makeLineage(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: "workflow-fixture",
    workflowRootAgentId: "agent-root",
    agentId: "agent-parent",
    rootAgentId: "agent-root",
    depth: 0,
    role: "root" as const,
    orphaned: false,
    ...overrides,
  };
}

interface FakeTelemetryOptions {
  readonly spanContext?: typeof validSpanContext;
  readonly startSessionSpan?: boolean;
}

type FakeTelemetrySession = Omit<ObservMeTelemetrySession, "logger" | "sessionAttributes" | "sessionSpan" | "tracer"> &
  SubagentTelemetrySession & {
    readonly meter: ReturnType<typeof createFakeMeter>;
    readonly tracer: ReturnType<typeof createFakeTracer>;
    readonly logger: ReturnType<typeof createFakeLogger>;
    sessionAttributes?: Record<string, string>;
    sessionSpan?: ReturnType<typeof createFakeSpan>;
  };

function createFakeTelemetry(config: ReturnType<typeof cloneConfig>, lineage: StartSessionTelemetryOptions["lineage"], options: FakeTelemetryOptions = {}): FakeTelemetrySession {
  const meter = createFakeMeter();
  const tracer = createFakeTracer(options.spanContext ?? validSpanContext);
  const logger = createFakeLogger();
  const metrics = createObservMeMetrics(meter);
  const telemetry: FakeTelemetrySession = {
    config,
    lineage,
    controller: createFakeController(),
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

  if (options.startSessionSpan) {
    telemetry.sessionAttributes = { "pi.session.id": "fixture-session" };
    telemetry.sessionSpan = tracer.startSpan(SPAN_NAMES.PI_SESSION, { attributes: telemetry.sessionAttributes });
  }

  return telemetry;
}

interface HandlerHarness {
  readonly pi: ReturnType<typeof createFakePi>;
  telemetry?: FakeTelemetrySession;
}

function createHandlerHarness(config = cloneConfig()): HandlerHarness {
  const pi = createFakePi();
  const harness: HandlerHarness = { pi };

  registerHandlers(pi, {
    loadConfig: async () => config,
    startTelemetry: async ({ lineage }) => {
      harness.telemetry = createFakeTelemetry(config, lineage);
      return harness.telemetry;
    },
  });

  return harness;
}

function requireTelemetry(harness: HandlerHarness): FakeTelemetrySession {
  assert.ok(harness.telemetry, "expected telemetry session to be active");
  return harness.telemetry;
}

async function emitFixtureHandlerTrace(harness: HandlerHarness, fixtures: Awaited<ReturnType<typeof loadEventFixtures>>): Promise<void> {
  const handlers = harness.pi.handlers;
  const ctx: ObservMeHandlerContext = {
    cwd: "/workspace/event-mapping",
    model: { provider: "anthropic", model: "claude-fixture", api: "messages" },
    thinking: { level: "medium" },
  };

  await handlers.get("session_start")(fixtures.sessionStart, ctx);
  await handlers.get("agent_start")(fixtures.agentRun.start, {});
  await handlers.get("turn_start")(fixtures.turn.start, ctx);
  await handlers.get("before_provider_request")(fixtures.llm.beforeProviderRequest, ctx);
  await handlers.get("after_provider_response")(fixtures.llm.afterProviderResponse, {});
  await handlers.get("message_end")(fixtures.llm.messageEnd, {});
  await handlers.get("tool_execution_start")(fixtures.toolCall.start, {});
  await handlers.get("tool_call")(fixtures.toolCall.call, {});
  await handlers.get("tool_result")(fixtures.toolCall.result, {});
  await handlers.get("tool_execution_end")(fixtures.toolCall.end, {});
  await handlers.get("bashExecution")(fixtures.bashExecution, {});
  await handlers.get("model_select")(fixtures.modelThinking.modelSelect, {});
  await handlers.get("model_change")(fixtures.modelThinking.modelChange, {});
  await handlers.get("thinking_level_select")(fixtures.modelThinking.thinkingSelect, {});
  await handlers.get("thinking_level_change")(fixtures.modelThinking.thinkingChange, {});
  await handlers.get("session_compact")(fixtures.compaction, {});
  await handlers.get("session_tree")(fixtures.branch, {});
  await handlers.get("turn_end")(fixtures.turn.end, {});
  await handlers.get("agent_end")(fixtures.agentRun.end, {});
  await handlers.get("session_shutdown")({ status: "ok" }, {});
}

function findSpan(telemetry: FakeTelemetrySession, spanName: string): TestSpan {
  const span = telemetry.tracer.spans.find(candidate => candidate.name === spanName);
  assert.ok(span, `expected ${spanName} span`);
  return span;
}

function metricSum(records: readonly TestMetricRecord[], metricName: string): number {
  return records.filter(record => record.name === metricName).reduce((sum, record) => sum + record.value, 0);
}

function assertNoForbiddenMetricLabels(records: readonly TestMetricRecord[]): void {
  for (const record of records) {
    for (const key of Object.keys(record.attributes ?? {})) {
      assert.equal(forbiddenMetricLabelKeys.includes(key), false, `${record.name} used forbidden metric label ${key}`);
    }
  }
}

function assertNoHiddenContentExported(telemetry: FakeTelemetrySession): void {
  const exported = JSON.stringify({ spans: telemetry.tracer.spans, logs: telemetry.logger.records });
  assert.doesNotMatch(exported, hiddenContentPattern);
}

function assertDefaultContentAbsent(telemetry: FakeTelemetrySession): void {
  const llmSpan = findSpan(telemetry, SPAN_NAMES.PI_LLM_REQUEST);
  const toolSpan = findSpan(telemetry, SPAN_NAMES.PI_TOOL_CALL);
  const bashSpan = findSpan(telemetry, SPAN_NAMES.PI_BASH_EXECUTION);

  assert.equal(llmSpan.attributes["pi.llm.prompt.redacted"], undefined);
  assert.equal(llmSpan.attributes["pi.llm.response.redacted"], undefined);
  assert.equal(llmSpan.attributes["pi.llm.thinking.redacted"], undefined);
  assert.equal(toolSpan.attributes["pi.tool.arguments.redacted"], undefined);
  assert.equal(toolSpan.attributes["pi.tool.result.redacted"], undefined);
  assert.equal(bashSpan.attributes["pi.bash.command.redacted"], undefined);
  assert.equal(bashSpan.attributes["pi.bash.output.redacted"], undefined);
}

function assertCanonicalHandlerSpans(telemetry: FakeTelemetrySession): void {
  const sessionSpan = findSpan(telemetry, SPAN_NAMES.PI_SESSION);
  const agentSpan = findSpan(telemetry, SPAN_NAMES.PI_AGENT_RUN);
  const turnSpan = findSpan(telemetry, SPAN_NAMES.PI_TURN);
  const llmSpan = findSpan(telemetry, SPAN_NAMES.PI_LLM_REQUEST);
  const toolSpan = findSpan(telemetry, SPAN_NAMES.PI_TOOL_CALL);
  const bashSpan = findSpan(telemetry, SPAN_NAMES.PI_BASH_EXECUTION);
  const compactionSpan = findSpan(telemetry, SPAN_NAMES.PI_COMPACTION);
  const branchSpan = findSpan(telemetry, SPAN_NAMES.PI_BRANCH);

  assert.equal(agentSpan.parentSpan, sessionSpan);
  assert.equal(turnSpan.parentSpan, agentSpan);
  assert.equal(llmSpan.parentSpan, turnSpan);
  assert.equal(toolSpan.parentSpan, turnSpan);
  assert.equal(bashSpan.parentSpan, turnSpan);
  assert.equal(compactionSpan.parentSpan, turnSpan);
  assert.equal(branchSpan.parentSpan, turnSpan);
  assert.equal(sessionSpan.attributes["pi.session.id"], "fixture-session");
  assert.equal(sessionSpan.attributes["pi.workflow.id"], telemetry.lineage.workflowId);
  assert.equal(agentSpan.attributes["pi.agent.run.id"], "fixture-agent-run");
  assert.equal(turnSpan.attributes["pi.turn.id"], "fixture-agent-run-turn-000001");
  assert.equal(llmSpan.attributes["gen_ai.provider.name"], "anthropic");
  assert.equal(llmSpan.attributes["gen_ai.request.model"], "claude-fixture");
  assert.equal(llmSpan.attributes["gen_ai.usage.input_tokens"], 21);
  assert.equal(llmSpan.attributes["pi.llm.cost.total_usd"], 0.062);
  assert.equal(toolSpan.attributes["pi.tool.name"], "read");
  assert.equal(toolSpan.attributes["pi.tool.error_class"], "ToolError");
  assert.equal(bashSpan.attributes["pi.bash.exit_code"], 1);
  assert.equal(
    telemetry.meter.records.find(record => record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS)?.value,
    250,
  );
  assert.equal(compactionSpan.attributes["pi.compaction.first_kept_entry_id"], "entry-kept-123");
  assert.equal(compactionSpan.attributes["pi.compaction.tokens_before"], 50000);
  assert.equal(branchSpan.attributes["pi.branch.from_id"], "leaf-prev");
  assert.equal(branchSpan.attributes["pi.branch.to_id"], "leaf-next");
  assert.equal(branchSpan.attributes["pi.branch.common_ancestor_id"], "leaf-root");
  assert.equal(sessionSpan.ended, true);
  assert.equal(agentSpan.ended, true);
  assert.equal(turnSpan.ended, true);
}

function assertModelThinkingLogs(telemetry: FakeTelemetrySession): void {
  const modelLogs = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.MODEL_CHANGED);
  const thinkingLogs = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.THINKING_CHANGED);

  assert.equal(modelLogs.length, 2);
  assert.equal(thinkingLogs.length, 2);
  assert.equal(modelLogs[0]?.attributes?.["pi.model.provider.current"], "openai");
  assert.equal(modelLogs[1]?.attributes?.["pi.model.id.current"], "claude-updated");
  assert.equal(thinkingLogs[0]?.attributes?.["pi.thinking.level.current"], "high");
  assert.equal(thinkingLogs[1]?.attributes?.["pi.thinking.level.current"], "medium");
}

function assertToolCompletionLog(telemetry: FakeTelemetrySession): void {
  const toolSpan = findSpan(telemetry, SPAN_NAMES.PI_TOOL_CALL);
  const record = telemetry.logger.records.find(log => log.body === LOG_EVENT_NAMES.TOOL_CALL_FAILED);

  assert.ok(record, "expected failed tool completion log");
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.EVENT_NAME], LOG_EVENT_NAMES.TOOL_CALL_FAILED);
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.EVENT_CATEGORY], "lifecycle");
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.PI_SESSION_ID], toolSpan.attributes[COMMON_SPAN_ATTRIBUTES.PI_SESSION_ID]);
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.PI_WORKFLOW_ID], toolSpan.attributes[COMMON_SPAN_ATTRIBUTES.PI_WORKFLOW_ID]);
  assert.equal(
    record.attributes?.[LOG_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID],
    toolSpan.attributes[COMMON_SPAN_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID],
  );
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.PI_AGENT_ID], toolSpan.attributes[COMMON_SPAN_ATTRIBUTES.PI_AGENT_ID]);
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.PI_AGENT_PARENT_ID], toolSpan.attributes[COMMON_SPAN_ATTRIBUTES.PI_AGENT_PARENT_ID]);
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.PI_AGENT_ROOT_ID], toolSpan.attributes[COMMON_SPAN_ATTRIBUTES.PI_AGENT_ROOT_ID]);
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.PI_AGENT_RUN_ID], toolSpan.attributes[COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]);
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.PI_TURN_ID], toolSpan.attributes[LOG_ATTRIBUTES.PI_TURN_ID]);
  assert.equal(record.attributes?.[TOOL_ATTRIBUTES.PI_TOOL_CALL_ID], toolSpan.attributes[TOOL_ATTRIBUTES.PI_TOOL_CALL_ID]);
  assert.equal(record.attributes?.[TOOL_ATTRIBUTES.PI_TOOL_NAME], toolSpan.attributes[TOOL_ATTRIBUTES.PI_TOOL_NAME]);
  assert.equal(record.attributes?.[TOOL_ATTRIBUTES.PI_TOOL_CATEGORY], toolSpan.attributes[TOOL_ATTRIBUTES.PI_TOOL_CATEGORY]);
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.TRACE_ID], toolSpan.spanContext().traceId);
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.SPAN_ID], toolSpan.spanContext().spanId);
  assert.equal(record.attributes?.[TOOL_ATTRIBUTES.PI_TOOL_SUCCESS], false);
  assert.equal(record.attributes?.[LOG_ATTRIBUTES.ERROR_TYPE], "ToolError");

  for (const contentAttribute of [
    TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_HASH,
    TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_SIZE,
    TOOL_ATTRIBUTES.PI_TOOL_RESULT_HASH,
    TOOL_ATTRIBUTES.PI_TOOL_RESULT_SIZE,
    TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_REDACTED,
    TOOL_ATTRIBUTES.PI_TOOL_RESULT_REDACTED,
    TOOL_ATTRIBUTES.GEN_AI_TOOL_CALL_ARGUMENTS,
    TOOL_ATTRIBUTES.GEN_AI_TOOL_CALL_RESULT,
  ]) {
    assert.equal(record.attributes?.[contentAttribute], undefined);
  }
}

function assertRedactedContentPresent(telemetry: FakeTelemetrySession): void {
  const llmSpan = findSpan(telemetry, SPAN_NAMES.PI_LLM_REQUEST);
  const toolSpan = findSpan(telemetry, SPAN_NAMES.PI_TOOL_CALL);
  const bashSpan = findSpan(telemetry, SPAN_NAMES.PI_BASH_EXECUTION);

  assert.match(String(llmSpan.attributes["pi.llm.prompt.redacted"]), /\[REDACTED:/u);
  assert.match(String(llmSpan.attributes["pi.llm.response.redacted"]), /\[REDACTED:/u);
  assert.match(String(llmSpan.attributes["pi.llm.thinking.redacted"]), /\[REDACTED:/u);
  assertCapturedContentLog(telemetry, LOG_EVENT_NAMES.LLM_PROMPT_CAPTURED, "prompt", llmSpan.attributes["pi.llm.prompt.redacted"]);
  assertCapturedContentLog(telemetry, LOG_EVENT_NAMES.LLM_RESPONSE_CAPTURED, "response", llmSpan.attributes["pi.llm.response.redacted"]);
  assertCapturedContentLog(telemetry, LOG_EVENT_NAMES.LLM_THINKING_CAPTURED, "thinking", llmSpan.attributes["pi.llm.thinking.redacted"]);
  assert.match(String(toolSpan.attributes["pi.tool.arguments.redacted"]), /\[REDACTED:/u);
  assert.match(String(toolSpan.attributes["pi.tool.result.redacted"]), /\[REDACTED:/u);
  assert.match(String(bashSpan.attributes["pi.bash.command.redacted"]), /\[REDACTED:/u);
  assert.match(String(bashSpan.attributes["pi.bash.output.redacted"]), /\[REDACTED:/u);
}

function assertCapturedContentLog(telemetry: FakeTelemetrySession, eventName: string, kind: string, body: unknown): void {
  const record = telemetry.logger.records.find(log => log.attributes?.["event.name"] === eventName);
  assert.equal(record?.body, body);
  assert.equal(record?.attributes?.["event.category"], "llm_content");
  assert.equal(record?.attributes?.["pi.llm.content.kind"], kind);
  assert.equal(record?.attributes?.trace_id, validSpanContext.traceId);
  assert.equal(record?.attributes?.span_id, validSpanContext.spanId);
}

function createSubagentTelemetry(): FakeTelemetrySession {
  return createFakeTelemetry(cloneConfig(), makeLineage(), { startSessionSpan: true });
}

function assertMetricValue(records: readonly TestMetricRecord[], metricName: string, expectedValue: number): void {
  assert.equal(metricSum(records, metricName), expectedValue);
}

function assertHistogramRecorded(records: readonly TestMetricRecord[], metricName: string): void {
  assert.ok(records.some(record => record.name === metricName), `expected ${metricName} histogram`);
}

test("event mapping fixtures exist and are valid JSON", async () => {
  for (const fixtureFile of requiredFixtureFiles) {
    const fixture = await loadFixture(fixtureFile);
    assert.equal(typeof fixture, "object", `${fixtureFile} should parse to an object fixture`);
  }
});

test("handler fixtures map Pi events to canonical spans, attributes, parenting, and safe labels", async () => {
  const fixtures = await loadEventFixtures();
  const harness = createHandlerHarness();

  await emitFixtureHandlerTrace(harness, fixtures);

  const telemetry = requireTelemetry(harness);
  assertCanonicalHandlerSpans(telemetry);
  assertModelThinkingLogs(telemetry);
  assertToolCompletionLog(telemetry);
  assertDefaultContentAbsent(telemetry);
  assertNoForbiddenMetricLabels(telemetry.meter.records);
  assertNoHiddenContentExported(telemetry);
});

test("handler fixtures export redacted content only when capture is explicitly enabled", async () => {
  const fixtures = await loadEventFixtures();
  const config = cloneConfig({
    capture: {
      prompts: true,
      responses: true,
      thinking: true,
      toolArguments: true,
      toolResults: true,
      bashCommands: true,
      bashOutput: true,
    },
  });
  const harness = createHandlerHarness(config);

  await emitFixtureHandlerTrace(harness, fixtures);

  const telemetry = requireTelemetry(harness);
  assertRedactedContentPresent(telemetry);
  assertToolCompletionLog(telemetry);
  assertNoHiddenContentExported(telemetry);
  assertNoForbiddenMetricLabels(telemetry.meter.records);
});

test("subagent fixtures map spawn, wait, join, orphan, and propagation failures", async () => {
  const [spawnFixture, waitJoinFixture, orphanFixture] = await Promise.all([
    loadFixture("events/subagent-spawn.json") as Promise<Parameters<typeof startSubagentSpawn>[1]>,
    loadFixture("events/agent-wait-join.json") as Promise<{ readonly wait: AgentWaitJoinOptions; readonly join: AgentWaitJoinOptions }>,
    loadFixture("events/orphan-agent.json") as Promise<{ readonly env: NodeJS.ProcessEnv }>,
  ]);
  const telemetry = createSubagentTelemetry();
  const started = startSubagentSpawn(telemetry, spawnFixture);
  const wait = recordAgentWait(telemetry, waitJoinFixture.wait);
  const join = recordAgentJoin(telemetry, waitJoinFixture.join);
  const malformed = observeTrustedSubagentLineage(telemetry, { OBSERVME_WORKFLOW_ID: "bad/workflow" });
  const orphan = observeTrustedSubagentLineage(telemetry, orphanFixture.env, { generateId: () => "fixture-orphan-agent" });

  completeSubagentSpawn(telemetry, started.spawnId, {
    childAgentId: started.childAgentId,
    childStatus: "completed",
  });

  assert.equal(started.span.name, SPAN_NAMES.PI_AGENT_SPAWN);
  assert.equal(started.span.parentSpan, telemetry.sessionSpan);
  assert.equal(started.traceContextPropagated, true);
  assert.equal(started.env.traceparent, "00-11111111111111111111111111111111-2222222222222222-01");
  assert.equal(started.env.OBSERVME_WORKFLOW_ID, telemetry.lineage.workflowId);
  assert.equal(started.span.attributes?.["pi.agent.parent_id"], telemetry.lineage.agentId);
  assert.equal(started.span.attributes?.["pi.agent.root_id"], telemetry.lineage.rootAgentId);
  assert.equal(started.span.attributes?.["pi.agent.depth"], 1);
  assert.equal(wait.span.name, SPAN_NAMES.PI_AGENT_WAIT);
  assert.equal(wait.span.attributes?.["pi.agent.child.status"], "completed");
  assert.equal(join.span.name, SPAN_NAMES.PI_AGENT_JOIN);
  assert.equal(join.span.attributes?.["pi.agent.join.status"], "completed");
  assert.equal(malformed, undefined);
  assert.ok(orphan, "expected orphan lineage to be observed");
  assert.equal(orphan.orphaned, true);
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.AGENT_ORPHANED));
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED));
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL, 1);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL, 1);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL, 1);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_JOIN_DURATION_MS);
  assertNoForbiddenMetricLabels(telemetry.meter.records);
  assertNoHiddenContentExported(telemetry);
});
