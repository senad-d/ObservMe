import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  LOG_EVENT_NAMES,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_GAUGE_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
  OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES,
} from "../src/semconv/metrics.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";
import {
  createObservMeMetrics,
  createSpanRegistry,
  readSessionHeaderFromFile,
  registerHandlers,
  safeHandler,
} from "../src/pi/handlers.ts";

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
      const span = createFakeSpan(name, options.attributes ?? {}, parentContext ? trace.getSpan(parentContext) : undefined);
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

function createFakeController() {
  return {
    flushCalls: [],
    shutdownCalls: [],
    async flush(timeoutMs) {
      this.flushCalls.push(timeoutMs);
      return { operation: "flush", completed: true, timedOut: false };
    },
    async shutdown(timeoutMs) {
      this.shutdownCalls.push(timeoutMs);
      return { operation: "shutdown", completed: true, timedOut: false };
    },
  };
}

function createFakeTelemetry(lineage) {
  const meter = createFakeMeter();
  const tracer = createFakeTracer();
  const logger = createFakeLogger();
  const controller = createFakeController();
  const metrics = createObservMeMetrics(meter);
  return {
    config: defaultObservMeConfig,
    lineage,
    controller,
    tracer,
    meter,
    logger,
    metrics,
    spans: createSpanRegistry(defaultObservMeConfig, metrics),
    activeAgentRecorded: false,
    agentRunSequence: 0,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences: new Map(),
  };
}

function loadConfig() {
  return Promise.resolve(defaultObservMeConfig);
}

test("safeHandler catches throwing handlers and records observme_handler_errors_total without propagating", async () => {
  const meter = createFakeMeter();
  const metrics = createObservMeMetrics(meter);
  const handler = safeHandler(
    "throwing.handler",
    () => {
      throw new Error("boom");
    },
    name => metrics.handlerErrors.add(1, { operation: name }),
  );

  await assert.doesNotReject(() => handler({}, {}));

  assert.deepEqual(meter.records, [
    {
      type: "counter",
      name: OBSERVME_COUNTER_METRIC_NAMES.HANDLER_ERRORS_TOTAL,
      value: 1,
      attributes: { operation: "throwing.handler" },
    },
  ]);
});

test("session_start creates a root pi.session span with documented session and workflow attributes", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")(
    {
      sessionId: "session-1",
      sessionName: "Demo Session",
      persisted: true,
      sessionFile: "/tmp/pi/session.jsonl",
      sessionVersion: "2",
      modelProvider: "anthropic",
      modelId: "claude-test",
      thinkingLevel: "medium",
    },
    { cwd: "/workspace/demo" },
  );

  const span = telemetry.tracer.spans[0];
  assert.equal(span.name, SPAN_NAMES.PI_SESSION);
  assert.equal(span.attributes["pi.session.id"], "session-1");
  assert.equal(span.attributes["pi.session.name"], "Demo Session");
  assert.match(span.attributes["pi.session.cwd_hash"], /^[a-f0-9]{64}$/u);
  assert.equal(span.attributes["pi.session.persisted"], true);
  assert.match(span.attributes["pi.session.file_hash"], /^[a-f0-9]{64}$/u);
  assert.equal(span.attributes["pi.session.version"], "2");
  assert.equal(span.attributes["pi.model.provider.current"], "anthropic");
  assert.equal(span.attributes["pi.model.id.current"], "claude-test");
  assert.equal(span.attributes["pi.thinking.level.current"], "medium");
  assert.equal(span.attributes["pi.workflow.id"], telemetry.lineage.workflowId);
  assert.equal(span.attributes["pi.workflow.root_agent_id"], telemetry.lineage.workflowRootAgentId);
  assert.equal(span.attributes["pi.agent.id"], telemetry.lineage.agentId);
  assert.equal(span.attributes["observme.capture.prompts"], false);
  assert.equal(span.attributes["observme.capture.responses"], false);
  assert.equal(span.attributes["observme.capture.tool_arguments"], false);
  assert.equal(span.attributes["observme.redaction.enabled"], true);
  assert.ok(span.events.some(event => event.name === LOG_EVENT_NAMES.SESSION_STARTED));
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.WORKFLOW_STARTED));
});

test("session_start resume reads only startup header and emits no replayed telemetry by default", async () => {
  const pi = createFakePi();
  let telemetry;
  const readCalls = [];
  registerHandlers(pi, {
    loadConfig,
    readSessionHeader: async sessionFile => {
      readCalls.push(sessionFile);
      return {
        type: "session",
        id: "header-session",
        version: 3,
        cwd: "/workspace/from-header",
        parentSession: "/sessions/parent.jsonl",
      };
    },
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ reason: "resume", sessionFile: "/sessions/resumed.jsonl" }, { cwd: "/ignored" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});

  assert.deepEqual(readCalls, ["/sessions/resumed.jsonl"]);
  assert.equal(telemetry.tracer.spans[0].attributes["pi.session.id"], "header-session");
  assert.equal(telemetry.tracer.spans[0].attributes["pi.session.persisted"], true);
  assert.equal(telemetry.tracer.spans[0].attributes["observme.replayed"], false);
  assert.equal(hasReplayedTelemetry(telemetry), false);
});

test("session_start marks replayed startup telemetry only when replayOnStart is explicitly enabled", async () => {
  const pi = createFakePi();
  let telemetry;
  const replayConfig = structuredClone(defaultObservMeConfig);
  replayConfig.replayOnStart = true;

  registerHandlers(pi, {
    loadConfig: () => Promise.resolve(replayConfig),
    readSessionHeader: async () => ({ type: "session", id: "replay-session", version: 3, cwd: "/workspace/demo" }),
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      telemetry.config = replayConfig;
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ reason: "resume", sessionFile: "/sessions/replayed.jsonl" }, { cwd: "/workspace/demo" });

  assert.equal(hasReplayedTelemetry(telemetry), true);
});

test("session header reader parses the first JSONL line and ignores historical entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observme-session-"));
  const sessionFile = join(directory, "session.jsonl");

  try {
    await writeFile(
      sessionFile,
      '{"type":"session","version":3,"id":"file-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/workspace/demo"}\nnot-json-history\n',
      "utf8",
    );

    const header = await readSessionHeaderFromFile(sessionFile);

    assert.equal(header.id, "file-session");
    assert.equal(header.cwd, "/workspace/demo");
    assert.equal(header.version, "3");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session_shutdown ends root span, updates active workflow metrics, emits lifecycle logs, and flushes with timeout", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-2" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});

  assert.equal(telemetry.tracer.spans[0].ended, true);
  assert.equal(telemetry.controller.flushCalls[0], defaultObservMeConfig.shutdown.flushTimeoutMs);
  assert.equal(telemetry.controller.shutdownCalls[0], defaultObservMeConfig.shutdown.flushTimeoutMs);
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.SESSION_SHUTDOWN));
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.WORKFLOW_COMPLETED));
  assert.ok(
    telemetry.meter.records.some(
      record => record.name === OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_AGENTS && record.value === -1,
    ),
  );
  assert.ok(
    telemetry.meter.records.some(
      record => record.name === OBSERVME_COUNTER_METRIC_NAMES.WORKFLOWS_COMPLETED_TOTAL && record.value === 1,
    ),
  );
});

test("active traces can contain ended child spans before the pi.session root is exported", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-active-trace" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("agent_end")({ agentRunId: "agent-run-000001", status: "ok" }, {});

  const [sessionSpan, agentRunSpan] = telemetry.tracer.spans;
  assert.equal(sessionSpan.name, SPAN_NAMES.PI_SESSION);
  assert.equal(sessionSpan.attributes["pi.session.id"], "session-active-trace");
  assert.equal(sessionSpan.attributes["pi.workflow.id"], telemetry.lineage.workflowId);
  assert.equal(agentRunSpan.name, SPAN_NAMES.PI_AGENT_RUN);
  assert.equal(agentRunSpan.parentSpan, sessionSpan);
  assert.equal(agentRunSpan.ended, true);
  assert.equal(sessionSpan.ended, false);
  assert.deepEqual(telemetry.controller.flushCalls, []);
  assert.deepEqual(telemetry.controller.shutdownCalls, []);

  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});

  assert.equal(sessionSpan.ended, true);
  assert.ok(sessionSpan.events.some(event => event.name === LOG_EVENT_NAMES.SESSION_SHUTDOWN));
  assert.deepEqual(telemetry.controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(telemetry.controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
});

test("agent-run and turn handlers create canonical child spans with derived turn ids", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-agent-turn" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user", prompt: "hello" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1, message: "hello", modelProvider: "anthropic", modelId: "claude-test" }, {});

  const [sessionSpan, agentRunSpan, turnSpan] = telemetry.tracer.spans;
  assert.equal(agentRunSpan.name, SPAN_NAMES.PI_AGENT_RUN);
  assert.equal(agentRunSpan.parentSpan, sessionSpan);
  assert.equal(agentRunSpan.attributes["pi.agent.run.id"], "agent-run-000001");
  assert.equal(agentRunSpan.attributes["pi.agent.run.index"], 1);
  assert.equal(turnSpan.name, SPAN_NAMES.PI_TURN);
  assert.equal(turnSpan.parentSpan, agentRunSpan);
  assert.equal(turnSpan.attributes["pi.turn.id"], "agent-run-000001-turn-000001");
  assert.equal(turnSpan.attributes["pi.turn.index"], 1);
  assert.equal(turnSpan.attributes["pi.agent.run.id"], "agent-run-000001");
  assert.equal(turnSpan.attributes["pi.workflow.id"], telemetry.lineage.workflowId);
});

test("LLM handlers finalize usage and cost metrics from assistant message_end", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-llm" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("before_provider_request")(
    {
      payload: {
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "read" }],
        temperature: 0.2,
        maxTokens: 4096,
      },
    },
    { model: { provider: "anthropic", model: "claude-test", api: "messages" }, thinking: { level: "medium" } },
  );
  await pi.handlers.get("after_provider_response")({ status: 200, headers: { "content-type": "application/json" } }, {});

  assertNoMetricRecord(telemetry.meter.records, OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_INPUT_TOKENS_TOTAL);

  await pi.handlers.get("message_end")(
    {
      message: {
        role: "assistant",
        api: "messages",
        provider: "anthropic",
        model: "claude-test",
        responseModel: "claude-test-20260101",
        responseId: "msg_123",
        stopReason: "stop",
        usage: {
          input: 11,
          output: 22,
          cacheRead: 3,
          cacheWrite: 4,
          cacheWrite1h: 5,
          reasoning: 6,
          totalTokens: 51,
          cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
        },
        content: [{ type: "text", text: "done" }],
      },
    },
    {},
  );

  const llmSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_LLM_REQUEST);
  const turnSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TURN);
  assert.equal(llmSpan.parentSpan, turnSpan);
  assert.equal(llmSpan.ended, true);
  assert.equal(llmSpan.attributes["gen_ai.provider.name"], "anthropic");
  assert.equal(llmSpan.attributes["gen_ai.request.model"], "claude-test");
  assert.deepEqual(llmSpan.attributes["gen_ai.response.finish_reasons"], ["stop"]);
  assert.equal(llmSpan.attributes["gen_ai.usage.input_tokens"], 11);
  assert.equal(llmSpan.attributes["pi.llm.stop_reason"], "stop");
  assert.equal(llmSpan.attributes["pi.llm.cost.total_usd"], 0.037);
  assert.equal(llmSpan.attributes["http.response.status_code"], 200);
  assert.equal(llmSpan.attributes["pi.llm.prompt.redacted"], undefined);
  assert.equal(llmSpan.attributes["pi.llm.response.redacted"], undefined);
  assert.equal(llmSpan.attributes["pi.llm.thinking.redacted"], undefined);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.LLM_REQUESTS_TOTAL, 1);
  assertMetricValue(telemetry.meter.records, OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_INPUT_TOKENS_TOTAL, 11);
  assertMetricValue(telemetry.meter.records, OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_OUTPUT_TOKENS_TOTAL, 22);
  assertMetricValue(telemetry.meter.records, OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_READ_TOKENS_TOTAL, 3);
  assertMetricValue(telemetry.meter.records, OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_WRITE_TOKENS_TOTAL, 4);
  assertMetricValue(telemetry.meter.records, OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_CACHE_WRITE_1H_TOKENS_TOTAL, 5);
  assertMetricValue(telemetry.meter.records, OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_REASONING_TOKENS_TOTAL, 6);
  assertMetricValue(telemetry.meter.records, OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_TOTAL_TOKENS_TOTAL, 51);
  assertMetricValue(telemetry.meter.records, OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_COST_USD_TOTAL, 0.037);
  assertLlmMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES.LLM_INPUT_TOKENS_TOTAL);
});

test("LLM content is absent by default and redacted when capture is explicitly enabled", async () => {
  const pi = createFakePi();
  let telemetry;
  const captureConfig = structuredClone(defaultObservMeConfig);
  captureConfig.capture.prompts = true;
  captureConfig.capture.responses = true;
  captureConfig.capture.thinking = true;

  registerHandlers(pi, {
    loadConfig: () => Promise.resolve(captureConfig),
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      telemetry.config = captureConfig;
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-llm-capture" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("before_provider_request")(
    { payload: { messages: [{ role: "user", content: "password=secret123" }] } },
    { model: { provider: "anthropic", model: "claude-test" } },
  );
  await pi.handlers.get("message_end")(
    {
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-test",
        stopReason: "stop",
        usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } },
        content: [
          { type: "thinking", thinking: "api_key=super-secret" },
          { type: "text", text: "api_key=response-secret" },
        ],
      },
    },
    {},
  );

  const llmSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_LLM_REQUEST);
  assert.match(llmSpan.attributes["pi.llm.prompt.redacted"], /\[REDACTED:/u);
  assert.match(llmSpan.attributes["pi.llm.response.redacted"], /\[REDACTED:/u);
  assert.match(llmSpan.attributes["pi.llm.thinking.redacted"], /\[REDACTED:/u);
  assert.doesNotMatch(llmSpan.attributes["pi.llm.prompt.redacted"], /secret123/u);
  assert.doesNotMatch(llmSpan.attributes["pi.llm.response.redacted"], /response-secret/u);
  assert.doesNotMatch(llmSpan.attributes["pi.llm.thinking.redacted"], /super-secret/u);
});

test("tool handlers create pi.tool.call spans, close success/error status, and keep metric labels low-cardinality", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-tools" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("tool_execution_start")(
    { toolCallId: "tool-1", toolName: "read", arguments: { path: "/workspace/demo/README.md", password: "secret123" } },
    {},
  );
  await pi.handlers.get("tool_call")({ toolCallId: "tool-1", toolName: "read", arguments: { path: "/workspace/demo/README.md" } }, {});
  await pi.handlers.get("tool_result")({ toolCallId: "tool-1", result: "file contents" }, {});
  await pi.handlers.get("tool_execution_end")({ toolCallId: "tool-1", success: true, result: "file contents" }, {});

  await pi.handlers.get("tool_execution_start")({ toolCallId: "tool-2", toolName: "fetch", toolCategory: "network" }, {});
  await pi.handlers.get("tool_execution_end")(
    { toolCallId: "tool-2", toolName: "fetch", toolCategory: "network", success: false, errorClass: "TimeoutError" },
    {},
  );

  const turnSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TURN);
  const toolSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_TOOL_CALL);
  const successSpan = toolSpans.find(span => span.attributes["pi.tool.call.id"] === "tool-1");
  const failureSpan = toolSpans.find(span => span.attributes["pi.tool.call.id"] === "tool-2");

  assert.equal(successSpan.parentSpan, turnSpan);
  assert.equal(successSpan.ended, true);
  assert.equal(successSpan.status.code, 1);
  assert.equal(successSpan.attributes["pi.tool.name"], "read");
  assert.equal(successSpan.attributes["pi.tool.category"], "filesystem");
  assert.match(successSpan.attributes["pi.tool.arguments.hash"], /^[a-f0-9]{64}$/u);
  assert.ok(successSpan.attributes["pi.tool.arguments.size"] > 0);
  assert.match(successSpan.attributes["pi.tool.result.hash"], /^[a-f0-9]{64}$/u);
  assert.equal(successSpan.attributes["pi.tool.result.size"], "file contents".length);
  assert.equal(successSpan.attributes["pi.tool.success"], true);
  assert.equal(successSpan.attributes["pi.tool.error"], false);
  assert.equal(successSpan.attributes["pi.tool.arguments.redacted"], undefined);
  assert.equal(successSpan.attributes["pi.tool.result.redacted"], undefined);
  assert.equal(successSpan.attributes["gen_ai.tool.call.id"], "tool-1");
  assert.equal(successSpan.attributes["gen_ai.tool.name"], "read");
  assert.equal(failureSpan.ended, true);
  assert.equal(failureSpan.status.code, 2);
  assert.equal(failureSpan.attributes["pi.tool.success"], false);
  assert.equal(failureSpan.attributes["pi.tool.error"], true);
  assert.equal(failureSpan.attributes["pi.tool.error_class"], "TimeoutError");
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_CALLS_TOTAL, 1);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_FAILURES_TOTAL, 1);
  assertToolMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_CALLS_TOTAL);
  assertToolMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_FAILURES_TOTAL);
});

test("tool arguments and results are absent by default and redacted when capture is explicitly enabled", async () => {
  const pi = createFakePi();
  let telemetry;
  const captureConfig = structuredClone(defaultObservMeConfig);
  captureConfig.capture.toolArguments = true;
  captureConfig.capture.toolResults = true;

  registerHandlers(pi, {
    loadConfig: () => Promise.resolve(captureConfig),
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      telemetry.config = captureConfig;
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-tool-capture" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("tool_execution_start")({ toolCallId: "tool-capture", toolName: "write", arguments: "password=secret123" }, {});
  await pi.handlers.get("tool_execution_end")({ toolCallId: "tool-capture", success: true, result: "api_key=result-secret" }, {});

  const toolSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TOOL_CALL);
  assert.match(toolSpan.attributes["pi.tool.arguments.redacted"], /\[REDACTED:/u);
  assert.match(toolSpan.attributes["pi.tool.result.redacted"], /\[REDACTED:/u);
  assert.equal(toolSpan.attributes["gen_ai.tool.call.arguments"], toolSpan.attributes["pi.tool.arguments.redacted"]);
  assert.equal(toolSpan.attributes["gen_ai.tool.call.result"], toolSpan.attributes["pi.tool.result.redacted"]);
  assert.doesNotMatch(toolSpan.attributes["pi.tool.arguments.redacted"], /secret123/u);
  assert.doesNotMatch(toolSpan.attributes["pi.tool.result.redacted"], /result-secret/u);
});

test("bash handlers create pi.bash.execution spans with exit/cancel/truncation attributes and counters", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-bash" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("user_bash")(
    {
      command: "echo ok",
      output: "hello",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      fullOutputPath: "/tmp/pi-bash-output.txt",
      excludeFromContext: true,
    },
    {},
  );
  await pi.handlers.get("bashExecution")({ role: "bashExecution", command: "false", output: "error", exitCode: 1, cancelled: false, truncated: true }, {});

  const turnSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TURN);
  const bashSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION);
  const successSpan = bashSpans.find(span => span.attributes["pi.bash.exit_code"] === 0);
  const failureSpan = bashSpans.find(span => span.attributes["pi.bash.exit_code"] === 1);

  assert.equal(bashSpans.length, 2);
  assert.equal(successSpan.parentSpan, turnSpan);
  assert.equal(successSpan.ended, true);
  assert.equal(successSpan.status.code, 1);
  assert.match(successSpan.attributes["pi.bash.command.hash"], /^[a-f0-9]{64}$/u);
  assert.equal(successSpan.attributes["pi.bash.exit_code"], 0);
  assert.equal(successSpan.attributes["pi.bash.cancelled"], false);
  assert.equal(successSpan.attributes["pi.bash.truncated"], false);
  assert.equal(successSpan.attributes["pi.bash.output.size"], "hello".length);
  assert.match(successSpan.attributes["pi.bash.output.hash"], /^[a-f0-9]{64}$/u);
  assert.equal(successSpan.attributes["pi.bash.full_output_path_present"], true);
  assert.equal(successSpan.attributes["pi.bash.exclude_from_context"], true);
  assert.equal(successSpan.attributes["pi.bash.command.redacted"], undefined);
  assert.equal(successSpan.attributes["pi.bash.output.redacted"], undefined);
  assert.equal(failureSpan.ended, true);
  assert.equal(failureSpan.status.code, 2);
  assert.equal(failureSpan.attributes["pi.bash.exit_code"], 1);
  assert.equal(failureSpan.attributes["pi.bash.cancelled"], false);
  assert.equal(failureSpan.attributes["pi.bash.truncated"], true);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL, 2);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_FAILURES_TOTAL, 1);
  assertBashMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL);
  assertBashMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_FAILURES_TOTAL);
});

test("bash command and output are absent by default and redacted when capture is explicitly enabled", async () => {
  const pi = createFakePi();
  let telemetry;
  const captureConfig = structuredClone(defaultObservMeConfig);
  captureConfig.capture.bashCommands = true;
  captureConfig.capture.bashOutput = true;

  registerHandlers(pi, {
    loadConfig: () => Promise.resolve(captureConfig),
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      telemetry.config = captureConfig;
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-bash-capture" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("message_end")(
    {
      message: {
        role: "bashExecution",
        command: "echo password=secret123",
        output: "api_key=result-secret",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
    },
    {},
  );

  const bashSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION);
  assert.match(bashSpan.attributes["pi.bash.command.redacted"], /\[REDACTED:/u);
  assert.match(bashSpan.attributes["pi.bash.output.redacted"], /\[REDACTED:/u);
  assert.doesNotMatch(bashSpan.attributes["pi.bash.command.redacted"], /secret123/u);
  assert.doesNotMatch(bashSpan.attributes["pi.bash.output.redacted"], /result-secret/u);
});

test("model and thinking handlers emit change logs and counters without unrelated content", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")(
    { sessionId: "session-model-thinking", modelProvider: "anthropic", modelId: "claude-start", thinkingLevel: "low" },
    { cwd: "/workspace/demo" },
  );
  await pi.handlers.get("model_select")(
    { provider: "openai", modelId: "gpt-4o", prompt: "do not leak model secret" },
    {},
  );
  await pi.handlers.get("model_change")(
    {
      entry: {
        type: "model_change",
        id: "model-entry-1",
        parentId: "parent-entry-1",
        provider: "anthropic",
        modelId: "claude-opus",
        content: "do not leak model entry secret",
      },
    },
    {},
  );
  await pi.handlers.get("thinking_level_select")({ thinkingLevel: "high", message: "do not leak thinking secret" }, {});
  await pi.handlers.get("thinking_level_change")(
    {
      entry: {
        type: "thinking_level_change",
        id: "thinking-entry-1",
        parentId: "model-entry-1",
        thinkingLevel: "medium",
        content: "do not leak thinking entry secret",
      },
    },
    {},
  );

  const modelLogs = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.MODEL_CHANGED);
  const thinkingLogs = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.THINKING_CHANGED);

  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.MODEL_CHANGES_TOTAL, 2);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.THINKING_LEVEL_CHANGES_TOTAL, 2);
  assertModelChangeMetricLabelsAreLowCardinality(telemetry.meter.records);
  assertMetricIncrementedWithoutIds(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.THINKING_LEVEL_CHANGES_TOTAL);
  assert.equal(modelLogs.length, 2);
  assert.equal(modelLogs[0].attributes["event.category"], "model");
  assert.equal(modelLogs[0].attributes["pi.model.provider.current"], "openai");
  assert.equal(modelLogs[0].attributes["pi.model.id.current"], "gpt-4o");
  assert.equal(modelLogs[1].attributes["pi.entry.id"], "model-entry-1");
  assert.equal(modelLogs[1].attributes["pi.model.provider.current"], "anthropic");
  assert.equal(modelLogs[1].attributes["pi.model.id.current"], "claude-opus");
  assert.equal(thinkingLogs.length, 2);
  assert.equal(thinkingLogs[0].attributes["event.category"], "thinking");
  assert.equal(thinkingLogs[0].attributes["pi.thinking.level.current"], "high");
  assert.equal(thinkingLogs[1].attributes["pi.entry.id"], "thinking-entry-1");
  assert.equal(thinkingLogs[1].attributes["pi.thinking.level.current"], "medium");
  assert.equal(telemetry.tracer.spans[0].attributes["pi.model.provider.current"], "anthropic");
  assert.equal(telemetry.tracer.spans[0].attributes["pi.model.id.current"], "claude-opus");
  assert.equal(telemetry.tracer.spans[0].attributes["pi.thinking.level.current"], "medium");
  assertNoRawChangeContent(modelLogs, thinkingLogs);
});

test("session_compact emits compaction span, log, counter, and tokens-before histogram from compactionEntry", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-compaction" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("session_compact")(
    {
      reason: "token_limit",
      willRetry: true,
      compactionEntry: {
        type: "compaction",
        id: "compaction-entry-1",
        parentId: "turn-entry-9",
        summary: "User discussed a long implementation plan.",
        firstKeptEntryId: "entry-kept-123",
        tokensBefore: 50_000,
        fromHook: true,
        details: {
          readFiles: ["src/pi/handlers.ts", "test/pi-handlers.test.mjs"],
          modifiedFiles: ["src/pi/handlers.ts"],
        },
      },
    },
    {},
  );

  const turnSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TURN);
  const compactionSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_COMPACTION);
  const compactionLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.COMPACTION_CREATED);

  assert.ok(compactionSpan);
  assert.ok(compactionLog);
  assert.equal(compactionSpan.parentSpan, turnSpan);
  assert.equal(compactionSpan.ended, true);
  assert.equal(compactionSpan.status.code, 1);
  assert.equal(compactionSpan.attributes["pi.compaction.first_kept_entry_id"], "entry-kept-123");
  assert.equal(compactionSpan.attributes["pi.compaction.tokens_before"], 50_000);
  assert.match(compactionSpan.attributes["pi.compaction.summary.hash"], /^[a-f0-9]{64}$/u);
  assert.equal(compactionSpan.attributes["pi.compaction.summary.length"], "User discussed a long implementation plan.".length);
  assert.equal(compactionSpan.attributes["pi.compaction.from_hook"], true);
  assert.equal(compactionSpan.attributes["pi.compaction.reason"], "token_limit");
  assert.equal(compactionSpan.attributes["pi.compaction.will_retry"], true);
  assert.equal(compactionSpan.attributes["pi.compaction.read_files_count"], 2);
  assert.equal(compactionSpan.attributes["pi.compaction.modified_files_count"], 1);
  assert.equal(compactionSpan.attributes["pi.entry.id"], "compaction-entry-1");
  assert.ok(compactionSpan.events.some(event => event.name === LOG_EVENT_NAMES.COMPACTION_CREATED));
  assert.equal(compactionLog.attributes["event.category"], "compaction");
  assert.equal(compactionLog.attributes["pi.compaction.first_kept_entry_id"], "entry-kept-123");
  assertMetricIncrementedWithoutIds(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.COMPACTIONS_TOTAL);
  assertHistogramRecordedWithoutIds(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.COMPACTION_TOKENS_BEFORE, 50_000);
});

test("session_tree emits basic branch span, log, and counter", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-branch-basic" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("session_tree")(
    {
      oldLeafId: "entry-old-1",
      newLeafId: "entry-new-1",
      branchPath: ["entry-root", "entry-new-1"],
    },
    {},
  );

  const turnSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TURN);
  const branchSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_BRANCH);
  const branchLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.BRANCH_CREATED);

  assert.ok(branchSpan);
  assert.ok(branchLog);
  assert.equal(branchSpan.parentSpan, turnSpan);
  assert.equal(branchSpan.ended, true);
  assert.equal(branchSpan.status.code, 1);
  assert.equal(branchSpan.attributes["pi.branch.from_id"], "entry-old-1");
  assert.equal(branchSpan.attributes["pi.branch.to_id"], "entry-new-1");
  assert.equal(branchSpan.attributes["pi.leaf.id"], "entry-new-1");
  assert.match(branchSpan.attributes["pi.branch.path_hash"], /^[a-f0-9]{64}$/u);
  assert.equal(branchSpan.attributes["pi.entry.id"], "entry-new-1");
  assert.equal(branchSpan.attributes["pi.entry.type"], "session_tree");
  assert.ok(branchSpan.events.some(event => event.name === LOG_EVENT_NAMES.BRANCH_CREATED));
  assert.equal(branchLog.attributes["event.category"], "branch");
  assert.equal(branchLog.attributes["pi.branch.from_id"], "entry-old-1");
  assertMetricIncrementedWithoutIds(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BRANCHES_TOTAL);
});

test("session_tree includes branch summaryEntry and prior tree-preparation fields", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-branch-summary" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("session_before_tree")(
    {
      preparation: {
        targetId: "entry-target-1",
        oldLeafId: "entry-old-2",
        commonAncestorId: "entry-common-1",
        entriesToSummarize: [{ id: "entry-old-child" }, { id: "entry-old-2" }],
      },
    },
    {},
  );
  await pi.handlers.get("session_tree")(
    {
      oldLeafId: "entry-old-2",
      newLeafId: "branch-summary-1",
      summaryEntry: {
        type: "branch_summary",
        id: "branch-summary-1",
        parentId: "entry-target-1",
        fromId: "entry-old-2",
        summary: "Branch explored an alternate implementation path.",
        fromHook: true,
        details: {
          readFiles: ["src/pi/handlers.ts"],
          modifiedFiles: ["src/pi/handlers.ts", "test/pi-handlers.test.mjs"],
        },
      },
      fromExtension: true,
    },
    {},
  );

  const branchSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_BRANCH);
  const branchLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.BRANCH_CREATED);

  assert.ok(branchSpan);
  assert.ok(branchLog);
  assert.equal(branchSpan.attributes["pi.branch.from_id"], "entry-old-2");
  assert.equal(branchSpan.attributes["pi.branch.to_id"], "branch-summary-1");
  assert.equal(branchSpan.attributes["pi.branch.common_ancestor_id"], "entry-common-1");
  assert.equal(branchSpan.attributes["pi.leaf.id"], "branch-summary-1");
  assert.match(branchSpan.attributes["pi.branch.path_hash"], /^[a-f0-9]{64}$/u);
  assert.match(branchSpan.attributes["pi.branch.summary.hash"], /^[a-f0-9]{64}$/u);
  assert.equal(branchSpan.attributes["pi.branch.summary.length"], "Branch explored an alternate implementation path.".length);
  assert.equal(branchSpan.attributes["pi.branch.from_hook"], true);
  assert.equal(branchSpan.attributes["pi.branch.read_files_count"], 1);
  assert.equal(branchSpan.attributes["pi.branch.modified_files_count"], 2);
  assert.equal(branchSpan.attributes["pi.entry.id"], "branch-summary-1");
  assert.equal(branchSpan.attributes["pi.entry.parent_id"], "entry-target-1");
  assert.equal(branchSpan.attributes["pi.entry.type"], "branch_summary");
  assert.equal(branchLog.attributes["pi.branch.common_ancestor_id"], "entry-common-1");
  assert.equal(branchLog.attributes["pi.branch.summary.hash"], branchSpan.attributes["pi.branch.summary.hash"]);
  assert.equal(Object.values(branchSpan.attributes).includes("Branch explored an alternate implementation path."), false);
  assert.equal(Object.values(branchSpan.attributes).includes("src/pi/handlers.ts"), false);
  assertMetricIncrementedWithoutIds(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BRANCHES_TOTAL);
});

test("agent-run and turn metrics increment without high-cardinality ids as labels", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-metrics" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("turn_end")({ turnIndex: 1 }, {});
  await pi.handlers.get("agent_end")({}, {});

  assertMetricIncrementedWithoutIds(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.AGENT_RUNS_TOTAL);
  assertMetricIncrementedWithoutIds(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TURNS_STARTED_TOTAL);
  assertMetricIncrementedWithoutIds(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TURNS_COMPLETED_TOTAL);
  assert.equal(telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TURN).ended, true);
  assert.equal(telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_AGENT_RUN).ended, true);
});

function assertMetricIncrementedWithoutIds(records, metricName) {
  const record = records.find(candidate => candidate.name === metricName && candidate.value === 1);
  assert.ok(record, `${metricName} should increment`);
  assert.deepEqual(Object.keys(record.attributes).sort(), ["agent_role", "environment"]);
}

function assertHistogramRecordedWithoutIds(records, metricName, value) {
  const record = records.find(candidate => candidate.name === metricName && candidate.value === value);
  assert.ok(record, `${metricName} should record ${value}`);
  assert.deepEqual(Object.keys(record.attributes).sort(), ["agent_role", "environment"]);
}

function assertModelChangeMetricLabelsAreLowCardinality(records) {
  const record = records.find(candidate => candidate.name === OBSERVME_COUNTER_METRIC_NAMES.MODEL_CHANGES_TOTAL);
  assert.ok(record, `${OBSERVME_COUNTER_METRIC_NAMES.MODEL_CHANGES_TOTAL} should be recorded`);
  assert.deepEqual(Object.keys(record.attributes).sort(), ["agent_role", "environment", "model", "provider"]);
  for (const forbiddenLabel of ["agent_id", "session_id", "workflow_id"]) {
    assert.equal(record.attributes[forbiddenLabel], undefined, `${record.name} must not include ${forbiddenLabel}`);
  }
}

function assertNoRawChangeContent(...logGroups) {
  const attributes = logGroups.flatMap(group => group.map(record => JSON.stringify(record.attributes)));
  for (const serializedAttributes of attributes) {
    assert.doesNotMatch(serializedAttributes, /do not leak/u);
    assert.doesNotMatch(serializedAttributes, /secret/u);
  }
}

function assertMetricValue(records, metricName, value) {
  const record = records.find(candidate => candidate.name === metricName && candidate.value === value);
  assert.ok(record, `${metricName} should record ${value}`);
}

function assertMetricRecordCount(records, metricName, count) {
  const matchingRecords = records.filter(candidate => candidate.name === metricName);
  assert.equal(matchingRecords.length, count, `${metricName} should record ${count} increments`);
}

function assertNoMetricRecord(records, metricName) {
  assert.equal(records.some(record => record.name === metricName), false, `${metricName} should not be recorded yet`);
}

function assertLlmMetricLabelsAreLowCardinality(records, metricName) {
  const record = records.find(candidate => candidate.name === metricName);
  assert.ok(record, `${metricName} should be recorded`);
  assert.deepEqual(Object.keys(record.attributes).sort(), ["agent_role", "environment", "model", "provider"]);
}

function assertToolMetricLabelsAreLowCardinality(records, metricName) {
  const record = records.find(candidate => candidate.name === metricName);
  assert.ok(record, `${metricName} should be recorded`);
  assert.deepEqual(Object.keys(record.attributes).sort(), ["tool_category", "tool_name"]);
  for (const forbiddenLabel of ["agent_id", "session_id", "tool_call_id", "workflow_id"]) {
    assert.equal(record.attributes[forbiddenLabel], undefined, `${metricName} must not include ${forbiddenLabel}`);
  }
}

function assertBashMetricLabelsAreLowCardinality(records, metricName) {
  const record = records.find(candidate => candidate.name === metricName);
  const allowedLabels = new Set(["agent_role", "environment", "error_class", "status"]);
  assert.ok(record, `${metricName} should be recorded`);
  for (const label of Object.keys(record.attributes)) assert.equal(allowedLabels.has(label), true, `${metricName} has unexpected label ${label}`);
  for (const forbiddenLabel of ["agent_id", "raw_command", "session_id", "workflow_id"]) {
    assert.equal(record.attributes[forbiddenLabel], undefined, `${metricName} must not include ${forbiddenLabel}`);
  }
}

function hasReplayedTelemetry(telemetry) {
  return (
    telemetry.tracer.spans.some(span => span.events.some(event => event.attributes?.["observme.replayed"] === true)) ||
    telemetry.logger.records.some(record => record.attributes?.["observme.replayed"] === true)
  );
}

test("failed root workflow shutdown records workflow failure telemetry", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-3" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("session_shutdown")({ status: "failed", error: "boom" }, {});

  assert.equal(telemetry.tracer.spans[0].ended, true);
  assert.equal(telemetry.tracer.spans[0].status.code, 2);
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.WORKFLOW_FAILED));
  assert.ok(
    telemetry.meter.records.some(
      record => record.name === OBSERVME_COUNTER_METRIC_NAMES.WORKFLOW_ERRORS_TOTAL && record.value === 1,
    ),
  );
});
