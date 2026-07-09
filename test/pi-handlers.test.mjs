import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import {
  clearObsSessionRuntimeState,
  getLocalObsSessionSnapshot,
  handleObsSessionCommand,
} from "../src/commands/obs-session.ts";
import {
  getObsStatusRuntimeState,
  handleObsStatusCommand,
  resetObsStatusRuntimeState,
} from "../src/commands/obs-status.ts";
import {
  clearObsAgentsRuntimeState,
  getLocalObsAgentsRuntimeSnapshot,
} from "../src/commands/obs-agents-runtime.ts";
import { handleObsTraceCommand } from "../src/commands/obs-trace.ts";
import { EXTENSION_STATUS_KEY, EXTENSION_STATUS_VALUE } from "../src/constants.ts";
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
  withTelemetrySessionResourceAttributes,
} from "../src/pi/handlers.ts";
import { completeSubagentSpawn, recordAgentJoin, recordAgentWait, startSubagentSpawn } from "../src/pi/subagent-spawn.ts";

process.env.OBSERVME_HASH_SALT = "pi-handlers-test-salt";

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
    context: { traceId: "11111111111111111111111111111111", spanId: "2222222222222222" },
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
      return this.context;
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

function createDeferred() {
  let resolve;
  const promise = new Promise(innerResolve => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

function createLifecycleStatusContext(statuses) {
  return {
    cwd: "/workspace/demo",
    ui: {
      setStatus: (key, value) => statuses.push({ key, value }),
    },
  };
}

test("registerHandlers validates Pi event API shape before registration", () => {
  const pi = { handlers: new Map(), on: "not-a-function" };

  assert.throws(
    () => registerHandlers(pi),
    /ObservMe\/Pi API compatibility error: expected Pi ExtensionAPI with on\(eventName, handler\) before registering ObservMe handlers\./u,
  );
  assert.equal(pi.handlers.size, 0);
  assert.throws(() => registerHandlers(undefined), /ObservMe\/Pi API compatibility error/u);
});

test("registerHandlers propagates Pi event registration failures", () => {
  const registrationError = new Error("Pi registration failed");

  assert.throws(
    () => registerHandlers({ on: () => { throw registrationError; } }),
    registrationError,
  );
});

test("registerHandlers registers expected lifecycle handlers with valid Pi event API", () => {
  const pi = createFakePi();

  registerHandlers(pi, { loadConfig });

  assert.deepEqual([...pi.handlers.keys()], [
    "session_start",
    "agent_start",
    "turn_start",
    "before_provider_request",
    "after_provider_response",
    "message_end",
    "tool_execution_start",
    "tool_call",
    "tool_result",
    "tool_execution_end",
    "user_bash",
    "bashExecution",
    "model_select",
    "model_change",
    "thinking_level_select",
    "thinking_level_change",
    "session_before_tree",
    "session_tree",
    "session_compact",
    "turn_end",
    "agent_end",
    "session_shutdown",
  ]);
  assert.equal([...pi.handlers.values()].every(handler => typeof handler === "function"), true);
});

test("telemetry session resource attributes include a unique instance id without mutating config", () => {
  const config = structuredClone(defaultObservMeConfig);
  const lineage = {
    workflowId: "workflow-resource-test",
    workflowRootAgentId: "agent-root-resource-test",
    agentId: "agent-resource-test",
    rootAgentId: "agent-root-resource-test",
    depth: 0,
    role: "root",
    orphaned: false,
  };

  config.resource.attributes["service.instance.id"] = "stale-instance";
  const merged = withTelemetrySessionResourceAttributes(config, lineage, "session-instance-test");

  assert.equal(config.resource.attributes["service.instance.id"], "stale-instance");
  assert.equal(merged.resource.attributes["service.instance.id"], "session-instance-test");
  assert.equal(merged.resource.attributes["observme.instance.id"], "session-instance-test");
  assert.equal(merged.resource.attributes["pi.agent.id"], "agent-resource-test");
});

function createNotificationContext(notifications) {
  return {
    cwd: "/workspace/demo",
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
    },
    isProjectTrusted: () => false,
  };
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

test("session lifecycle handlers tolerate missing trust and partial UI capabilities", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await assert.doesNotReject(() => pi.handlers.get("session_start")({ sessionId: "session-no-ui" }, { cwd: "/workspace/demo" }));
  await assert.doesNotReject(() => pi.handlers.get("session_shutdown")({ status: "ok" }, { ui: {} }));

  assert.equal(telemetry.tracer.spans[0].attributes["pi.session.id"], "session-no-ui");
  assert.equal(telemetry.tracer.spans[0].ended, true);
  assert.deepEqual(telemetry.controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(telemetry.controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
});

test("session_start creates a root pi.session span with documented session and workflow attributes", async () => {
  const pi = createFakePi();
  const statuses = [];
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
    {
      cwd: "/workspace/demo",
      ui: {
        setStatus: (key, value) => statuses.push({ key, value }),
      },
    },
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
  assert.deepEqual(statuses, [{ key: EXTENSION_STATUS_KEY, value: EXTENSION_STATUS_VALUE }]);
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

test("shared lifecycle queue drains delayed startup before interleaved shutdown", async t => {
  clearObsSessionRuntimeState();
  resetObsStatusRuntimeState();
  clearObsAgentsRuntimeState();
  t.after(() => {
    clearObsSessionRuntimeState();
    resetObsStatusRuntimeState();
    clearObsAgentsRuntimeState();
  });

  const pi = createFakePi();
  const statuses = [];
  const errors = [];
  const ensureEntered = createDeferred();
  const ensureRelease = createDeferred();
  const loadEntered = createDeferred();
  const loadRelease = createDeferred();
  const telemetryEntered = createDeferred();
  const telemetryRelease = createDeferred();
  let telemetry;
  let shutdownSettled = false;

  registerHandlers(pi, {
    ensureProjectConfig: async () => {
      ensureEntered.resolve();
      await ensureRelease.promise;
      return { path: "/workspace/demo/.pi/observme.yaml", status: "exists" };
    },
    loadConfig: async () => {
      loadEntered.resolve();
      await loadRelease.promise;
      return defaultObservMeConfig;
    },
    startTelemetry: async ({ lineage }) => {
      telemetryEntered.resolve();
      await telemetryRelease.promise;
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
    onHandlerError: (name, error) => errors.push({ name, error }),
  });

  const ctx = createLifecycleStatusContext(statuses);
  const start = pi.handlers.get("session_start")({ sessionId: "session-delayed-start", reason: "startup" }, ctx);
  await ensureEntered.promise;
  const shutdown = pi.handlers.get("session_shutdown")({ reason: "quit", status: "ok" }, ctx).then(() => {
    shutdownSettled = true;
  });

  await Promise.resolve();
  assert.equal(shutdownSettled, false);
  assert.equal(statuses.length, 0);
  assert.equal(telemetry, undefined);

  ensureRelease.resolve();
  await loadEntered.promise;
  assert.equal(shutdownSettled, false);
  loadRelease.resolve();
  await telemetryEntered.promise;
  assert.equal(shutdownSettled, false);
  telemetryRelease.resolve();
  await Promise.all([start, shutdown]);

  const sessionSnapshot = getLocalObsSessionSnapshot();
  const agentsSnapshot = getLocalObsAgentsRuntimeSnapshot();
  const statusState = getObsStatusRuntimeState();

  assert.equal(telemetry.tracer.spans.every(span => span.ended), true);
  assert.deepEqual(telemetry.controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(telemetry.controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(statuses, [
    { key: EXTENSION_STATUS_KEY, value: EXTENSION_STATUS_VALUE },
    { key: EXTENSION_STATUS_KEY, value: undefined },
  ]);
  assert.equal(sessionSnapshot.sessionId, undefined);
  assert.equal(sessionSnapshot.traceId, undefined);
  assert.equal(sessionSnapshot.turns, 0);
  assert.equal(sessionSnapshot.llmCalls, 0);
  assert.equal(sessionSnapshot.toolCalls, 0);
  assert.equal(agentsSnapshot.sessionId, undefined);
  assert.equal(agentsSnapshot.traceId, undefined);
  assert.equal(agentsSnapshot.lineage, undefined);
  assert.deepEqual(agentsSnapshot.children, []);
  assert.equal(statusState.config?.enabled, defaultObservMeConfig.enabled);
  assert.equal(statusState.lastExportError, undefined);
  assert.equal(statusState.queueDrops, 0);

  await assert.doesNotReject(() => pi.handlers.get("agent_start")({ source: "user" }, {}));
  await assert.doesNotReject(() => pi.handlers.get("turn_start")({ turnIndex: 1 }, {}));
  assert.deepEqual(errors, []);
});

test("shared lifecycle queue preserves shutdown then reload start ordering", async t => {
  clearObsSessionRuntimeState();
  resetObsStatusRuntimeState();
  clearObsAgentsRuntimeState();
  t.after(() => {
    clearObsSessionRuntimeState();
    resetObsStatusRuntimeState();
    clearObsAgentsRuntimeState();
  });

  const pi = createFakePi();
  const statuses = [];
  const sessions = [];
  const firstTelemetryEntered = createDeferred();
  const firstTelemetryRelease = createDeferred();
  let reloadShutdownSettled = false;
  let reloadStartSettled = false;

  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      if (sessions.length === 0) {
        firstTelemetryEntered.resolve();
        await firstTelemetryRelease.promise;
      }
      const telemetry = createFakeTelemetry(lineage);
      sessions.push(telemetry);
      return telemetry;
    },
  });

  const ctx = createLifecycleStatusContext(statuses);
  const startup = pi.handlers.get("session_start")({ sessionId: "session-before-reload", reason: "startup" }, ctx);
  await firstTelemetryEntered.promise;
  const reloadShutdown = pi.handlers.get("session_shutdown")({ reason: "reload", status: "ok" }, ctx).then(() => {
    reloadShutdownSettled = true;
  });
  const reloadStart = pi.handlers.get("session_start")({ sessionId: "session-after-reload", reason: "reload" }, ctx).then(() => {
    reloadStartSettled = true;
  });

  await Promise.resolve();
  assert.equal(reloadShutdownSettled, false);
  assert.equal(reloadStartSettled, false);
  assert.equal(sessions.length, 0);

  firstTelemetryRelease.resolve();
  await Promise.all([startup, reloadShutdown, reloadStart]);

  const [firstSession, secondSession] = sessions;
  const sessionSnapshot = getLocalObsSessionSnapshot();
  const agentsSnapshot = getLocalObsAgentsRuntimeSnapshot();
  const statusState = getObsStatusRuntimeState();

  assert.equal(sessions.length, 2);
  assert.equal(firstSession.tracer.spans.every(span => span.ended), true);
  assert.deepEqual(firstSession.controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(firstSession.controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.equal(secondSession.tracer.spans.length, 1);
  assert.equal(secondSession.tracer.spans[0].ended, false);
  assert.deepEqual(secondSession.controller.flushCalls, []);
  assert.deepEqual(secondSession.controller.shutdownCalls, []);
  assert.deepEqual(statuses, [
    { key: EXTENSION_STATUS_KEY, value: EXTENSION_STATUS_VALUE },
    { key: EXTENSION_STATUS_KEY, value: undefined },
    { key: EXTENSION_STATUS_KEY, value: EXTENSION_STATUS_VALUE },
  ]);
  assert.equal(sessionSnapshot.sessionId, "session-after-reload");
  assert.equal(sessionSnapshot.traceId, "11111111111111111111111111111111");
  assert.equal(sessionSnapshot.turns, 0);
  assert.equal(sessionSnapshot.llmCalls, 0);
  assert.equal(sessionSnapshot.toolCalls, 0);
  assert.equal(agentsSnapshot.sessionId, "session-after-reload");
  assert.equal(agentsSnapshot.traceId, "11111111111111111111111111111111");
  assert.equal(agentsSnapshot.lineage?.agentId, secondSession.lineage.agentId);
  assert.notEqual(agentsSnapshot.lineage?.agentId, firstSession.lineage.agentId);
  assert.deepEqual(agentsSnapshot.children, []);
  assert.equal(statusState.config?.enabled, defaultObservMeConfig.enabled);
  assert.equal(statusState.lastExportError, undefined);
  assert.equal(statusState.queueDrops, 0);
});

test("duplicate session_start flushes and shuts down the previous telemetry session before replacement", async () => {
  const pi = createFakePi();
  const sessions = [];
  let resolveFirstStartEntered;
  let unblockFirstStart;
  const firstStartEntered = new Promise(resolve => {
    resolveFirstStartEntered = resolve;
  });
  const firstStartBlocked = new Promise(resolve => {
    unblockFirstStart = resolve;
  });
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      const telemetry = createFakeTelemetry(lineage);
      sessions.push(telemetry);
      if (sessions.length === 1) {
        resolveFirstStartEntered();
        await firstStartBlocked;
      }
      return telemetry;
    },
  });

  const firstStart = pi.handlers.get("session_start")({ sessionId: "session-first" }, { cwd: "/workspace/demo" });
  await firstStartEntered;
  const secondStart = pi.handlers.get("session_start")({ sessionId: "session-second" }, { cwd: "/workspace/demo" });
  await Promise.resolve();
  assert.equal(sessions.length, 1);
  unblockFirstStart();
  await Promise.all([firstStart, secondStart]);

  const [firstSession, secondSession] = sessions;
  assert.equal(firstSession.tracer.spans[0].ended, true);
  assert.deepEqual(firstSession.controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(firstSession.controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.ok(firstSession.logger.records.some(record => record.body === "session.duplicate_start"));
  assert.ok(firstSession.logger.records.some(record => record.body === LOG_EVENT_NAMES.SESSION_SHUTDOWN));
  assert.deepEqual(secondSession.controller.flushCalls, []);
  assert.deepEqual(secondSession.controller.shutdownCalls, []);

  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});

  assert.deepEqual(secondSession.controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(secondSession.controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
});

test("final lifecycle regression keeps runtime state consistent after duplicate session_start cleanup", async t => {
  clearObsSessionRuntimeState();
  resetObsStatusRuntimeState();
  clearObsAgentsRuntimeState();
  t.after(() => {
    clearObsSessionRuntimeState();
    resetObsStatusRuntimeState();
    clearObsAgentsRuntimeState();
  });

  const pi = createFakePi();
  const sessions = [];
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      const telemetry = createFakeTelemetry(lineage);
      sessions.push(telemetry);
      return telemetry;
    },
  });

  // Regression for specs/spec-review-pi-extension-first-pass-tasks-3.md:
  // duplicate starts must clean up the prior controller before replacing public runtime state.
  await pi.handlers.get("session_start")({ sessionId: "session-final-first" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});

  const firstSession = sessions[0];
  firstSession.controller.flush = async timeoutMs => {
    firstSession.controller.flushCalls.push(timeoutMs);
    return { operation: "flush", completed: false, timedOut: true };
  };

  assert.equal(getLocalObsSessionSnapshot().sessionId, "session-final-first");
  assert.equal(getLocalObsSessionSnapshot().turns, 1);
  assert.equal(getLocalObsAgentsRuntimeSnapshot().sessionId, "session-final-first");

  await pi.handlers.get("session_start")({ sessionId: "session-final-second" }, { cwd: "/workspace/demo" });

  const secondSession = sessions[1];
  const sessionSnapshot = getLocalObsSessionSnapshot();
  const agentsSnapshot = getLocalObsAgentsRuntimeSnapshot();
  const statusState = getObsStatusRuntimeState();

  assert.equal(sessions.length, 2);
  assert.equal(firstSession.tracer.spans.every(span => span.ended), true);
  assert.deepEqual(firstSession.controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(firstSession.controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.equal(secondSession.tracer.spans[0].ended, false);
  assert.deepEqual(secondSession.controller.flushCalls, []);
  assert.deepEqual(secondSession.controller.shutdownCalls, []);
  assert.equal(sessionSnapshot.sessionId, "session-final-second");
  assert.equal(sessionSnapshot.traceId, "11111111111111111111111111111111");
  assert.equal(sessionSnapshot.turns, 0);
  assert.equal(sessionSnapshot.llmCalls, 0);
  assert.equal(sessionSnapshot.toolCalls, 0);
  assert.equal(sessionSnapshot.costUsd, 0);
  assert.equal(agentsSnapshot.sessionId, "session-final-second");
  assert.equal(agentsSnapshot.traceId, "11111111111111111111111111111111");
  assert.equal(agentsSnapshot.lineage?.agentId, secondSession.lineage.agentId);
  assert.notEqual(agentsSnapshot.lineage?.agentId, firstSession.lineage.agentId);
  assert.deepEqual(agentsSnapshot.children, []);
  assert.deepEqual(agentsSnapshot.waitJoinHints, []);
  assert.equal(statusState.config?.enabled, defaultObservMeConfig.enabled);
  assert.equal(statusState.lastExportError, undefined);
  assert.equal(statusState.queueDrops, 0);
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

test("deterministic active-session command flow aligns with post-shutdown export state", async t => {
  clearObsSessionRuntimeState();
  resetObsStatusRuntimeState();
  t.after(() => {
    clearObsSessionRuntimeState();
    resetObsStatusRuntimeState();
  });

  const pi = createFakePi();
  let telemetry;
  const config = structuredClone(defaultObservMeConfig);
  config.query.links.traceUrlTemplate = "https://grafana.local/explore?trace={traceId}";
  registerHandlers(pi, {
    loadConfig: () => Promise.resolve(config),
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      telemetry.config = config;
      telemetry.spans = createSpanRegistry(config, telemetry.metrics);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-flow" }, { cwd: "/workspace/demo" });
  telemetry.controller.flush = async timeoutMs => {
    telemetry.controller.flushCalls.push(timeoutMs);
    return { operation: "flush", completed: false, timedOut: true };
  };

  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("before_provider_request")(
    { payload: { messages: [{ role: "user", content: "api_key=prompt-secret" }] } },
    { model: { provider: "anthropic", model: "claude-test" } },
  );
  await pi.handlers.get("message_end")(
    {
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-test",
        stopReason: "stop",
        usage: { input: 11, output: 22, totalTokens: 33, cost: { total: 0.037 } },
        content: [{ type: "text", text: "api_key=response-secret" }],
      },
    },
    {},
  );
  await pi.handlers.get("tool_execution_start")({ toolCallId: "tool-flow", toolName: "read", arguments: "password=tool-secret" }, {});
  await pi.handlers.get("tool_execution_end")({ toolCallId: "tool-flow", toolName: "read", success: true, result: "api_key=tool-result-secret" }, {});
  await pi.handlers.get("bashExecution")({ role: "bashExecution", command: "echo bash-secret", output: "bash-output-secret", exitCode: 0 }, {});
  const subagent = startSubagentSpawn(telemetry, { spawnId: "spawn-flow", childAgentId: "agent-child-flow", command: "pi", args: ["--print"] });
  completeSubagentSpawn(telemetry, subagent.spawnId, { childAgentId: subagent.childAgentId, childStatus: "completed" });

  const activeSessionNotifications = [];
  await handleObsSessionCommand("session", createNotificationContext(activeSessionNotifications));
  assert.match(activeSessionNotifications[0].message, /Session: session-flow/u);
  assert.match(activeSessionNotifications[0].message, /Turns: 1/u);
  assert.match(activeSessionNotifications[0].message, /LLM calls: 1/u);
  assert.match(activeSessionNotifications[0].message, /Tool calls: 1/u);
  assert.match(activeSessionNotifications[0].message, /Cost: \$0\.04/u);

  const activeTraceNotifications = [];
  await handleObsTraceCommand("trace", createNotificationContext(activeTraceNotifications), { loadConfig: () => Promise.resolve(config) });
  assert.match(activeTraceNotifications[0].message, /Trace link \(current session\)/u);
  assert.match(activeTraceNotifications[0].message, /root pi\.session span; the root is exported after session_shutdown/u);

  const sessionSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_SESSION);
  const llmSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_LLM_REQUEST);
  const toolSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TOOL_CALL);
  const bashSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION);
  const subagentSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_AGENT_SPAWN);
  assert.equal(sessionSpan.ended, false);
  assert.equal(llmSpan.ended, true);
  assert.equal(toolSpan.ended, true);
  assert.equal(bashSpan.ended, true);
  assert.equal(subagentSpan.ended, true);
  assert.equal(llmSpan.attributes["pi.llm.prompt.redacted"], undefined);
  assert.equal(toolSpan.attributes["pi.tool.arguments.redacted"], undefined);
  assert.equal(bashSpan.attributes["pi.bash.command.redacted"], undefined);

  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});

  assert.equal(sessionSpan.ended, true);
  assert.deepEqual(telemetry.controller.flushCalls, [config.shutdown.flushTimeoutMs]);
  assert.deepEqual(telemetry.controller.shutdownCalls, [config.shutdown.flushTimeoutMs]);

  const postShutdownSessionNotifications = [];
  await handleObsSessionCommand("session", createNotificationContext(postShutdownSessionNotifications));
  assert.match(postShutdownSessionNotifications[0].message, /Session: unknown/u);
  assert.match(postShutdownSessionNotifications[0].message, /Trace: unavailable/u);

  const postShutdownStatusNotifications = [];
  await handleObsStatusCommand("status", createNotificationContext(postShutdownStatusNotifications));
  assert.match(postShutdownStatusNotifications[0].message, /Last export error: flush timed out/u);
  assert.doesNotMatch(
    JSON.stringify({ spans: telemetry.tracer.spans, logs: telemetry.logger.records, notifications: [
      ...activeSessionNotifications,
      ...activeTraceNotifications,
      ...postShutdownSessionNotifications,
      ...postShutdownStatusNotifications,
    ] }),
    /prompt-secret|response-secret|tool-secret|tool-result-secret|bash-secret|bash-output-secret/u,
  );
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
  assert.equal(telemetry.logger.records.some(record => record.attributes?.["event.category"] === "llm_content"), false);
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

  const promptLog = telemetry.logger.records.find(record => record.attributes?.["event.name"] === LOG_EVENT_NAMES.LLM_PROMPT_CAPTURED);
  const responseLog = telemetry.logger.records.find(record => record.attributes?.["event.name"] === LOG_EVENT_NAMES.LLM_RESPONSE_CAPTURED);
  const thinkingLog = telemetry.logger.records.find(record => record.attributes?.["event.name"] === LOG_EVENT_NAMES.LLM_THINKING_CAPTURED);
  assert.equal(promptLog.body, llmSpan.attributes["pi.llm.prompt.redacted"]);
  assert.equal(responseLog.body, llmSpan.attributes["pi.llm.response.redacted"]);
  assert.equal(thinkingLog.body, llmSpan.attributes["pi.llm.thinking.redacted"]);
  assert.equal(promptLog.attributes["event.category"], "llm_content");
  assert.equal(promptLog.attributes["pi.llm.content.kind"], "prompt");
  assert.equal(responseLog.attributes["pi.llm.content.kind"], "response");
  assert.equal(thinkingLog.attributes["pi.llm.content.kind"], "thinking");
  assert.equal(promptLog.attributes.trace_id, "11111111111111111111111111111111");
  assert.equal(promptLog.attributes.span_id, "2222222222222222");
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

test("interleaved tool lifecycle events with explicit ids only update their own spans", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-parallel-tools" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("tool_execution_start")({ toolCallId: "tool-parallel-a", toolName: "read", arguments: "a-start" }, {});
  await pi.handlers.get("tool_execution_start")({ toolCallId: "tool-parallel-b", toolName: "write", arguments: "b-start" }, {});
  await pi.handlers.get("tool_call")({ toolCallId: "tool-parallel-a", toolName: "read", arguments: "a-call" }, {});
  await pi.handlers.get("tool_result")({ toolCallId: "tool-parallel-b", toolName: "write", result: "b-result" }, {});
  await pi.handlers.get("tool_result")({ toolCallId: "tool-parallel-a", toolName: "read", result: "a-result" }, {});
  await pi.handlers.get("tool_execution_end")({ toolCallId: "tool-parallel-a", toolName: "read", success: true, result: "a-final" }, {});

  const toolSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_TOOL_CALL);
  const toolA = toolSpans.find(span => span.attributes["pi.tool.call.id"] === "tool-parallel-a");
  const toolB = toolSpans.find(span => span.attributes["pi.tool.call.id"] === "tool-parallel-b");

  assert.equal(toolSpans.length, 2);
  assert.ok(toolA);
  assert.ok(toolB);
  assert.equal(toolA.ended, true);
  assert.equal(toolB.ended, false);
  assert.equal(toolA.attributes["pi.tool.name"], "read");
  assert.equal(toolB.attributes["pi.tool.name"], "write");
  assert.equal(toolA.attributes["pi.tool.arguments.size"], "a-call".length);
  assert.equal(toolB.attributes["pi.tool.arguments.size"], "b-start".length);
  assert.equal(toolA.attributes["pi.tool.result.size"], "a-final".length);
  assert.equal(toolB.attributes["pi.tool.result.size"], "b-result".length);
  assert.equal(toolA.status.code, 1);
  assert.equal(toolB.status, undefined);

  await pi.handlers.get("tool_execution_end")({ toolCallId: "tool-parallel-b", toolName: "write", success: true, result: "b-final" }, {});

  assert.equal(toolB.ended, true);
  assert.equal(toolB.attributes["pi.tool.result.size"], "b-final".length);
  assert.equal(toolB.status.code, 1);
  assertActiveSpanValues(telemetry.meter.records, "tool_call", [1, 1, -1, -1]);
});

test("ambiguous parallel tool events without ids are dropped instead of mutating the latest active span", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-parallel-missing-tool-id" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("tool_execution_start")({ toolCallId: "tool-missing-a", toolName: "read" }, {});
  await pi.handlers.get("tool_execution_start")({ toolCallId: "tool-missing-b", toolName: "write" }, {});
  await pi.handlers.get("tool_call")({ toolName: "read", arguments: "ambiguous-args" }, {});
  await pi.handlers.get("tool_result")({ toolName: "read", result: "ambiguous-result" }, {});
  await pi.handlers.get("tool_execution_end")(
    { toolName: "read", success: false, errorClass: "AmbiguousError", result: "ambiguous-final" },
    {},
  );

  const toolSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_TOOL_CALL);
  const toolA = toolSpans.find(span => span.attributes["pi.tool.call.id"] === "tool-missing-a");
  const toolB = toolSpans.find(span => span.attributes["pi.tool.call.id"] === "tool-missing-b");
  const droppedOperations = telemetry.logger.records
    .filter(record => record.body === LOG_EVENT_NAMES.TELEMETRY_DROPPED)
    .map(record => record.attributes?.operation)
    .sort();

  assert.equal(toolSpans.length, 2);
  assert.ok(toolA);
  assert.ok(toolB);
  assert.equal(toolA.ended, false);
  assert.equal(toolB.ended, false);
  assert.equal(toolA.status, undefined);
  assert.equal(toolB.status, undefined);
  assert.equal(toolA.attributes["pi.tool.result.size"], undefined);
  assert.equal(toolB.attributes["pi.tool.arguments.size"], undefined);
  assert.equal(toolB.attributes["pi.tool.result.size"], undefined);
  assert.equal(toolB.attributes["pi.tool.name"], "write");
  assert.deepEqual(droppedOperations, ["tool_call", "tool_execution_end", "tool_result"]);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL, 3);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_FAILURES_TOTAL);

  await pi.handlers.get("tool_execution_end")({ toolCallId: "tool-missing-a", toolName: "read", success: true, result: "a-ok" }, {});
  await pi.handlers.get("tool_execution_end")({ toolCallId: "tool-missing-b", toolName: "write", success: true, result: "b-ok" }, {});

  assert.equal(toolA.ended, true);
  assert.equal(toolB.ended, true);
  assert.equal(toolA.status.code, 1);
  assert.equal(toolB.status.code, 1);
  assertActiveSpanValues(telemetry.meter.records, "tool_call", [1, 1, -1, -1]);
});

test("single active legacy tool events without ids use the current tool fallback deterministically", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-single-missing-tool-id" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("tool_execution_start")({ toolName: "read", arguments: "legacy-start" }, {});
  await pi.handlers.get("tool_result")({ result: "legacy-result" }, {});
  await pi.handlers.get("tool_execution_end")({ success: true, result: "legacy-final" }, {});

  const toolSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TOOL_CALL);

  assert.ok(toolSpan);
  assert.equal(toolSpan.attributes["pi.tool.call.id"], "tool-call-000001");
  assert.equal(toolSpan.attributes["pi.tool.result.size"], "legacy-final".length);
  assert.equal(toolSpan.ended, true);
  assert.equal(toolSpan.status.code, 1);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL);
  assertActiveSpanValues(telemetry.meter.records, "tool_call", [1, -1]);
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
  await pi.handlers.get("bashExecution")(
    {
      role: "bashExecution",
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

test("user_bash pre-execution events do not emit completed bash telemetry", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-user-bash-pre" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("user_bash")({ command: "echo ok", cwd: "/workspace/demo", excludeFromContext: false }, {});

  assert.equal(telemetry.tracer.spans.some(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION), false);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL);
  assertObservedOperation(telemetry.meter.records, "user_bash");

  await pi.handlers.get("bashExecution")({ role: "bashExecution", command: "echo ok", output: "ok", exitCode: 0, cancelled: false, truncated: false }, {});

  const bashSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION);
  assert.equal(bashSpans.length, 1);
  assert.equal(bashSpans[0].status.code, 1);
  assert.equal(bashSpans[0].attributes["pi.bash.exit_code"], 0);
  assert.equal(bashSpans[0].attributes["pi.bash.output.size"], "ok".length);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL, 1);
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

test("turn start without a prior agent start records a drop and still closes the synthetic turn", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-synthetic-turn" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("turn_start")({ message: "hello without agent" }, {});
  await pi.handlers.get("turn_end")({}, {});

  const turnSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_TURN);
  const dropLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.TELEMETRY_DROPPED);

  assert.ok(turnSpan);
  assert.equal(turnSpan.attributes["pi.agent.run.id"], "agent-run-000001");
  assert.equal(turnSpan.attributes["pi.turn.id"], "agent-run-000001-turn-000001");
  assert.equal(turnSpan.ended, true);
  assert.equal(telemetry.tracer.spans.some(span => span.name === SPAN_NAMES.PI_AGENT_RUN), false);
  assert.equal(dropLog?.attributes?.operation, "turn_start");
  assert.equal(dropLog?.attributes?.reason, "agent_run_id_missing_turn_start");
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL, 1);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TURNS_STARTED_TOTAL, 1);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TURNS_COMPLETED_TOTAL, 1);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.AGENT_RUNS_TOTAL);
  assertActiveSpanValues(telemetry.meter.records, "turn", [1, -1]);
});

test("turn end without a resolvable turn index records a drop without completion telemetry", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-missing-turn-index" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ agentRunId: "agent-run-missing-turn", source: "user" }, {});
  await pi.handlers.get("turn_end")({}, {});

  const dropLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.TELEMETRY_DROPPED);

  assert.equal(dropLog?.attributes?.operation, "turn_end");
  assert.equal(dropLog?.attributes?.reason, "turn_index_missing");
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL, 1);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TURNS_COMPLETED_TOTAL);
  assert.equal(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.TURN_COMPLETED), false);
  assertActiveSpanValues(telemetry.meter.records, "turn", []);
});

test("tool execution end without a prior start is dropped instead of creating synthetic success telemetry", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-missing-tool-start" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("tool_execution_end")({ toolCallId: "tool-end-only", success: true, result: "end-only result" }, {});

  const dropLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.TELEMETRY_DROPPED);

  assert.equal(telemetry.tracer.spans.some(span => span.name === SPAN_NAMES.PI_TOOL_CALL), false);
  assert.equal(dropLog?.attributes?.operation, "tool_execution_end");
  assert.equal(dropLog?.attributes?.reason, "tool_call_missing_end");
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL, 1);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_CALLS_TOTAL);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_FAILURES_TOTAL);
  assertActiveSpanValues(telemetry.meter.records, "tool_call", []);
});

test("active span metrics increment and decrement for normal span lifecycles", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-active-spans" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user", prompt: "hello" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1, message: "hello" }, {});
  await pi.handlers.get("before_provider_request")({ payload: { messages: [{ role: "user", content: "hello" }] } }, { model: { provider: "anthropic", model: "claude-test" } });
  await pi.handlers.get("message_end")({ message: { role: "assistant", provider: "anthropic", model: "claude-test", stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "done" }] } }, {});
  await pi.handlers.get("tool_execution_start")({ toolCallId: "tool-active", toolName: "read" }, {});
  await pi.handlers.get("tool_execution_end")({ toolCallId: "tool-active", success: true, result: "contents" }, {});
  await pi.handlers.get("bashExecution")({ role: "bashExecution", command: "npm test", exitCode: 0, output: "ok" }, {});
  await pi.handlers.get("session_tree")({ oldLeafId: "entry-old", newLeafId: "entry-new", branchPath: ["entry-old", "entry-new"] }, {});
  await pi.handlers.get("session_compact")({ reason: "manual", compactionEntry: { id: "compact-active", firstKeptEntryId: "entry-new", tokensBefore: 100, summary: "summary" } }, {});

  const startedSubagent = startSubagentSpawn(telemetry, { spawnId: "spawn-active", childAgentId: "child-active", spawnType: "command" });
  recordAgentWait(telemetry, { spawnId: startedSubagent.spawnId, childAgentId: startedSubagent.childAgentId, childStatus: "active", joinStatus: "waiting", durationMs: 5 });
  recordAgentJoin(telemetry, { spawnId: startedSubagent.spawnId, childAgentId: startedSubagent.childAgentId, childStatus: "completed", joinStatus: "completed", durationMs: 7 });
  completeSubagentSpawn(telemetry, startedSubagent.spawnId, { childAgentId: startedSubagent.childAgentId, childStatus: "completed" });

  await pi.handlers.get("turn_end")({ turnIndex: 1 }, {});
  await pi.handlers.get("agent_end")({}, {});
  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});

  const operations = [
    "session",
    "agent_run",
    "turn",
    "llm_request",
    "tool_call",
    "bash_execution",
    "branch",
    "compaction",
    "subagent_spawn",
    "agent_wait",
    "agent_join",
  ];

  for (const operation of operations) assertActiveSpanValues(telemetry.meter.records, operation, [1, -1]);
});

test("export health dashboard-driving lifecycle signals are emitted by session handlers", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-export-health" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});

  assertMetricIncrementedWithoutIds(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SESSIONS_STARTED_TOTAL);
  assertMetricIncrementedWithoutIds(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SESSIONS_SHUTDOWN_TOTAL);
  assertObservedOperation(telemetry.meter.records, "session_start");
  assertObservedOperation(telemetry.meter.records, "session_shutdown");
  assertHandlerDuration(telemetry.meter.records, "session_start", "ok");
  assertHandlerDuration(telemetry.meter.records, "session_shutdown", "ok");
  assertActiveSpanValues(telemetry.meter.records, "session", [1, -1]);
});

test("registered Pi handlers emit observation and duration metrics with bounded labels", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-observed" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user", prompt: "hello" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1, message: "hello" }, {});
  await pi.handlers.get("before_provider_request")({ payload: { messages: [{ role: "user", content: "hello" }] } }, { model: { provider: "anthropic", model: "claude-test" } });
  await pi.handlers.get("after_provider_response")({ status: 200 }, {});
  await pi.handlers.get("message_end")({ message: { role: "assistant", provider: "anthropic", model: "claude-test", stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "done" }] } }, {});
  await pi.handlers.get("tool_execution_start")({ toolCallId: "tool-observed", toolName: "read" }, {});
  await pi.handlers.get("tool_call")({ toolCallId: "tool-observed", toolName: "read" }, {});
  await pi.handlers.get("tool_result")({ toolCallId: "tool-observed", result: "contents" }, {});
  await pi.handlers.get("tool_execution_end")({ toolCallId: "tool-observed", success: true, result: "contents" }, {});
  await pi.handlers.get("user_bash")({ command: "npm test", cwd: "/workspace/demo" }, {});
  await pi.handlers.get("bashExecution")({ role: "bashExecution", command: "npm test", exitCode: 0, output: "ok" }, {});
  await pi.handlers.get("session_before_tree")({ oldLeafId: "entry-old", newLeafId: "entry-new" }, {});
  await pi.handlers.get("session_tree")({ oldLeafId: "entry-old", newLeafId: "entry-new", branchPath: ["entry-old", "entry-new"] }, {});
  await pi.handlers.get("session_compact")({ reason: "manual", compactionEntry: { id: "compact-observed", firstKeptEntryId: "entry-new", tokensBefore: 100, summary: "summary" } }, {});
  await pi.handlers.get("turn_end")({ turnIndex: 1 }, {});
  await pi.handlers.get("agent_end")({}, {});
  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});

  const expectedOperations = [
    "session_start",
    "agent_start",
    "turn_start",
    "before_provider_request",
    "after_provider_response",
    "message_end",
    "tool_execution_start",
    "tool_call",
    "tool_result",
    "tool_execution_end",
    "user_bash",
    "bashexecution",
    "session_before_tree",
    "session_tree",
    "session_compact",
    "turn_end",
    "agent_end",
    "session_shutdown",
  ];

  for (const operation of expectedOperations) {
    assertObservedOperation(telemetry.meter.records, operation);
    assertHandlerDuration(telemetry.meter.records, operation, "ok");
  }
});

test("handler observation preserves safe handler errors and records failed duration status", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-handler-error" }, { cwd: "/workspace/demo" });
  telemetry.tracer.startSpan = () => {
    throw new Error("span start failed");
  };

  await assert.doesNotReject(() => pi.handlers.get("agent_start")({ source: "user" }, {}));

  assertObservedOperation(telemetry.meter.records, "agent_start");
  assertHandlerDuration(telemetry.meter.records, "agent_start", "error");
  assert.ok(
    telemetry.meter.records.some(
      record => record.name === OBSERVME_COUNTER_METRIC_NAMES.HANDLER_ERRORS_TOTAL && record.attributes.operation === "agent_start",
    ),
  );
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.HANDLER_FAILED));
});

function assertActiveSpanValues(records, operation, expectedValues) {
  const values = records
    .filter(record => record.name === OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_SPANS && record.attributes.operation === operation)
    .map(record => record.value);
  assert.deepEqual(values, expectedValues, `${OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_SPANS} should record ${expectedValues.join(",")} for ${operation}`);
}

function assertObservedOperation(records, operation) {
  const record = records.find(
    candidate => candidate.name === OBSERVME_COUNTER_METRIC_NAMES.EVENTS_OBSERVED_TOTAL && candidate.value === 1 && candidate.attributes.operation === operation,
  );
  assert.ok(record, `${OBSERVME_COUNTER_METRIC_NAMES.EVENTS_OBSERVED_TOTAL} should increment for ${operation}`);
  assert.deepEqual(Object.keys(record.attributes).sort(), ["operation"]);
}

function assertHandlerDuration(records, operation, status) {
  const record = records.find(
    candidate => candidate.name === OBSERVME_HISTOGRAM_METRIC_NAMES.HANDLER_DURATION_MS && candidate.attributes.operation === operation && candidate.attributes.status === status,
  );
  assert.ok(record, `${OBSERVME_HISTOGRAM_METRIC_NAMES.HANDLER_DURATION_MS} should record ${status} for ${operation}`);
  assert.equal(Number.isFinite(record.value), true);
  assert.equal(record.value >= 0, true);
  assert.deepEqual(Object.keys(record.attributes).sort(), ["operation", "status"]);
}

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
