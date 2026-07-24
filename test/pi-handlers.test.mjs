import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  clearObsSessionRuntimeState,
  getLocalObsSessionSnapshot,
  handleObsSessionCommand,
  startObsSessionRuntimeState,
} from "../src/commands/obs-session.ts";
import {
  getObsStatusRuntimeState,
  handleObsStatusCommand,
  resetObsStatusRuntimeState,
} from "../src/commands/obs-status.ts";
import {
  clearObsAgentsRuntimeState,
  getLocalObsAgentsRuntimeSnapshot,
  startObsAgentsRuntimeState,
} from "../src/commands/obs-agents-runtime.ts";
import { runObsBackfill } from "../src/commands/obs-backfill.ts";
import { getObsLogsSnapshot } from "../src/commands/obs-logs.ts";
import { getObsTraceSnapshot, handleObsTraceCommand } from "../src/commands/obs-trace.ts";
import { EXTENSION_STATUS_KEY, EXTENSION_STATUS_VALUE } from "../src/constants.ts";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { loadSessionConfig } from "../src/config/load-config.ts";
import { OBSERVME_INTEGRATION_CHANNEL, requestObservMeIntegration } from "../src/integration.ts";
import { toOtelStartupError } from "../src/otel/sdk.ts";
import { applyContentCapturePolicy } from "../src/privacy/content-capture.ts";
import { registerTenantSaltEnvironment, sha256 } from "../src/privacy/hash.ts";
import {
  AGENT_SPAWN_ATTRIBUTES,
  AGENT_WAIT_JOIN_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  CONFIG_ATTRIBUTES,
  LOG_ATTRIBUTES,
  TOOL_ATTRIBUTES,
  TURN_ATTRIBUTES,
} from "../src/semconv/attributes.ts";
import {
  LOG_EVENT_NAMES,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_GAUGE_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
  OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES,
} from "../src/semconv/metrics.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";
import {
  createAgentTreeTracker,
  createObservMeMetrics,
  createOtelOperationOwnership,
  createSpanRegistry,
  createTurnSequenceRegistry,
  readSessionHeaderFromFile,
  registerHandlers as registerProductionHandlers,
  safeHandler,
  startSessionTelemetry,
  withTelemetrySessionResourceAttributes,
} from "../src/pi/handlers.ts";
import { completeSubagentSpawn, recordAgentJoin, recordAgentWait, startSubagentSpawn } from "../src/pi/subagent-spawn.ts";
import {
  OBSERVME_CORRELATION_ENTRY_SCHEMA_VERSION,
  OBSERVME_CORRELATION_ENTRY_TYPE,
  readLatestSessionCorrelation,
} from "../src/pi/session-correlation.ts";
import {
  emitUnrelatedGlobalTelemetry,
  installSentinelGlobalProviders,
  resetGlobalProviders,
} from "./otel-global-isolation-helpers.mjs";

process.env.OBSERVME_HASH_SALT = "pi-handlers-test-salt";

function registerHandlers(pi, options = {}) {
  registerProductionHandlers(pi, {
    otelOperationOwnership: createOtelOperationOwnership(),
    ...options,
  });
}

function createFakePi(events) {
  const handlers = new Map();
  return {
    handlers,
    events,
    getThinkingLevel: () => "medium",
    on: registerFakePiHandler.bind(undefined, handlers),
  };
}

function registerFakePiHandler(handlers, eventName, handler) {
  const previous = handlers.get(eventName);
  handlers.set(eventName, previous ? runFakePiHandlers.bind(undefined, previous, handler) : handler);
}

function createTrackedEventBus(unsubscribeError) {
  const eventBus = {
    listeners: new Map(),
    unsubscribeCalls: 0,
    unsubscribeError,
  };
  eventBus.on = addTrackedEventListener.bind(undefined, eventBus);
  eventBus.emit = emitTrackedEvent.bind(undefined, eventBus);
  eventBus.listenerCount = trackedEventListenerCount.bind(undefined, eventBus);
  return eventBus;
}

function addTrackedEventListener(eventBus, channel, handler) {
  const channelListeners = eventBus.listeners.get(channel) ?? new Set();
  channelListeners.add(handler);
  eventBus.listeners.set(channel, channelListeners);
  return removeTrackedEventListener.bind(undefined, eventBus, channel, handler);
}

function removeTrackedEventListener(eventBus, channel, handler) {
  eventBus.unsubscribeCalls += 1;
  eventBus.listeners.get(channel)?.delete(handler);
  if (eventBus.unsubscribeError) throw eventBus.unsubscribeError;
}

function emitTrackedEvent(eventBus, channel, data) {
  for (const handler of eventBus.listeners.get(channel) ?? []) handler(data);
}

function trackedEventListenerCount(eventBus, channel) {
  return eventBus.listeners.get(channel)?.size ?? 0;
}

async function runFakePiHandlers(first, second, event, ctx) {
  await first(event, ctx);
  await second(event, ctx);
}

async function emitBashExecution(pi, message, ctx = {}) {
  await pi.handlers.get("message_end")({ type: "message_end", message }, ctx);
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
    createObservableGauge: () => ({
      addCallback() {},
      removeCallback() {},
    }),
  };
}

function createFakeTracer() {
  const spans = [];
  return {
    spans,
    startSpan: (name, options = {}, parentContext) => {
      const span = createFakeSpan(
        name,
        options.attributes ?? {},
        parentContext ? trace.getSpan(parentContext) : undefined,
        parentContext ? trace.getSpanContext(parentContext) : undefined,
        options.links ?? [],
      );
      spans.push(span);
      return span;
    },
  };
}

function createFakeSpan(name, attributes, parentSpan, parentSpanContext, links) {
  return {
    name,
    attributes,
    parentSpan,
    parentSpanContext,
    links,
    events: [],
    status: undefined,
    ended: false,
    endCalls: 0,
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
      this.endCalls += 1;
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

function createFakeActiveAgentLease() {
  return {
    active: false,
    disposed: false,
    callbackRegistered: true,
    transitions: [],
    activate() {
      this.transitions.push("activate");
      if (!this.disposed) this.active = true;
    },
    deactivate() {
      this.transitions.push("deactivate");
      this.active = false;
    },
    dispose() {
      if (this.disposed) return;
      this.transitions.push("dispose");
      this.active = false;
      this.disposed = true;
      this.callbackRegistered = false;
    },
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

function createFakeTelemetry(lineage, tracerOverride) {
  const meter = createFakeMeter();
  const tracer = tracerOverride ?? createFakeTracer();
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
    agentTree: createAgentTreeTracker(defaultObservMeConfig, lineage, metrics),
    activeAgentLease: createFakeActiveAgentLease(),
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

const successfulAssistantMessage = {
  role: "assistant",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-test",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  content: [{ type: "text", text: "done" }],
  timestamp: 1_750_000_000_000,
};
const failedAssistantMessage = {
  ...successfulAssistantMessage,
  stopReason: "error",
  errorMessage: "provider unavailable",
  content: [{ type: "text", text: "provider failed" }],
};

async function createUserBashRuntimeHarness() {
  const cwd = "/workspace/user-bash-runtime";
  const eventBus = createEventBus();
  const runtime = createExtensionRuntime();
  const sessionManager = SessionManager.inMemory(cwd);
  const participantCalls = [];
  let telemetry;

  const observmePi = createFakePi(eventBus);
  registerHandlers(observmePi, {
    loadConfig,
    ensureProjectConfig: async () => ({ path: `${cwd}/.pi/observme.yaml`, status: "exists" }),
    appendEntry: () => undefined,
    getThinkingLevel: () => "medium",
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });
  const observmeExtension = createRunnerExtension(
    "<observme-user-bash-runtime>",
    new Map([...observmePi.handlers].map(([name, handler]) => [name, [handler]])),
  );
  const participantExtension = createRunnerExtension(
    "<later-user-bash-participant>",
    new Map([
      ["user_bash", [event => {
        participantCalls.push(event);
        if (event.command !== "extension-result") return undefined;
        return {
          result: {
            output: "provided by extension",
            exitCode: 0,
            cancelled: false,
            truncated: false,
          },
        };
      }]],
    ]),
  );
  const runner = new ExtensionRunner(
    [observmeExtension, participantExtension],
    runtime,
    cwd,
    sessionManager,
    {},
  );

  await runner.emit({ type: "session_start", reason: "startup" });
  assert.ok(telemetry);
  return { participantCalls, runner, sessionManager, telemetry };
}

function mutateToolInputAfterObservMe(event) {
  event.input.value = event.toolCallId === "tool-middleware-a" ? "after-a" : "after-b";
  delete event.input.password;
}

async function createToolMiddlewareRuntimeHarness(config) {
  const cwd = "/workspace/tool-middleware-runtime";
  const eventBus = createEventBus();
  const runtime = createExtensionRuntime();
  const sessionManager = SessionManager.inMemory(cwd);
  let telemetry;

  const observmePi = createFakePi(eventBus);
  registerHandlers(observmePi, {
    loadConfig: () => Promise.resolve(config),
    ensureProjectConfig: async () => ({ path: `${cwd}/.pi/observme.yaml`, status: "exists" }),
    appendEntry: () => undefined,
    getThinkingLevel: () => "medium",
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      telemetry.config = config;
      return telemetry;
    },
  });
  const observmeExtension = createRunnerExtension(
    "<observme-tool-middleware-runtime>",
    new Map([...observmePi.handlers].map(([name, handler]) => [name, [handler]])),
  );
  const mutatingExtension = createRunnerExtension(
    "<later-tool-input-mutator>",
    new Map([["tool_call", [mutateToolInputAfterObservMe]]]),
  );
  const runner = new ExtensionRunner(
    [observmeExtension, mutatingExtension],
    runtime,
    cwd,
    sessionManager,
    {},
  );

  await runner.emit({ type: "session_start", reason: "startup" });
  assert.ok(telemetry);
  return { runner, telemetry };
}

function createRunnerExtension(path, handlers) {
  return {
    path,
    resolvedPath: path,
    sourceInfo: { path, source: path, scope: "temporary", origin: "top-level" },
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

function appendPiBashResult(sessionManager, event, result) {
  sessionManager.appendMessage({
    role: "bashExecution",
    command: event.command,
    output: result.output,
    exitCode: result.exitCode,
    cancelled: result.cancelled,
    truncated: result.truncated,
    fullOutputPath: result.fullOutputPath,
    timestamp: Date.now(),
    excludeFromContext: event.excludeFromContext,
  });
}

async function waitForObservedBashCompletion(telemetry) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!telemetry.pendingUserBash) return;
    await delay(5);
  }

  assert.fail("Timed out waiting for the recorded Pi BashExecutionMessage to complete telemetry.");
}

function createTopLevelDisabledConfig() {
  const config = structuredClone(defaultObservMeConfig);
  config.enabled = false;
  config.traces.enabled = true;
  config.metrics.enabled = true;
  config.logs.enabled = true;
  return config;
}

function createRejectedConfigLoadResult(config, issueCodes = ["unsafe_capture_without_redaction"]) {
  return {
    config,
    diagnostics: {
      projectTrusted: false,
      projectConfigStatus: "skipped_untrusted",
      effectiveSource: "environment",
      globalConfigLoaded: false,
      environmentOverrides: true,
      runtimeOptionsApplied: false,
      rejection: {
        issueCodes,
        issueCount: issueCodes.length,
      },
    },
  };
}

function completePropagationEnvironment(overrides = {}) {
  return {
    OBSERVME_HASH_SALT: "pi-handlers-test-salt",
    OBSERVME_WORKFLOW_ID: "workflow-propagated",
    OBSERVME_PARENT_AGENT_ID: "agent-parent-propagated",
    OBSERVME_ROOT_AGENT_ID: "agent-root-propagated",
    OBSERVME_PARENT_SESSION_ID: "session-parent-propagated",
    OBSERVME_PARENT_TRACE_ID: "4bf92f3577b34da6a3ce929d0e0e4736",
    OBSERVME_PARENT_SPAN_ID: "00f067aa0ba902b7",
    OBSERVME_AGENT_DEPTH: "2",
    OBSERVME_SPAWN_ID: "spawn-propagated",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    tracestate: "vendor=value",
    ...overrides,
  };
}

function metricTotal(records, name) {
  return records
    .filter(record => record.name === name)
    .reduce((total, record) => total + record.value, 0);
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

function createSessionLifecycleContext(sessionId, sessionFile) {
  return {
    cwd: "/workspace/demo",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getHeader: () => ({
        type: "session",
        id: sessionId,
        version: 3,
        timestamp: "2026-07-14T00:00:00.000Z",
        cwd: "/workspace/demo",
      }),
      getCwd: () => "/workspace/demo",
      getSessionName: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
    },
    model: undefined,
    ui: { setStatus: () => undefined },
  };
}

function createCorrelationData(overrides = {}) {
  return {
    schemaVersion: OBSERVME_CORRELATION_ENTRY_SCHEMA_VERSION,
    workflowId: "workflow-recovered",
    agentId: "agent-recovered",
    rootAgentId: "agent-recovered",
    depth: 0,
    ...overrides,
  };
}

function createCorrelationEntry(id, data, parentId = null) {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: "2026-07-14T00:00:00.000Z",
    customType: OBSERVME_CORRELATION_ENTRY_TYPE,
    data,
  };
}

test("correlation normalization enforces root, parent, agent, and depth invariants", () => {
  const validCases = [
    {
      reason: "reload",
      data: createCorrelationData(),
    },
    {
      reason: "resume",
      data: createCorrelationData({
        agentId: "agent-child",
        parentAgentId: "agent-root",
        rootAgentId: "agent-root",
        depth: 1,
      }),
    },
    {
      reason: "fork",
      data: createCorrelationData({
        agentId: "agent-grandchild",
        parentAgentId: "agent-child",
        rootAgentId: "agent-root",
        depth: 2,
      }),
    },
  ];

  for (const validCase of validCases) {
    assert.deepEqual(
      readLatestSessionCorrelation([createCorrelationEntry(`valid-${validCase.reason}`, validCase.data)]),
      validCase.data,
      `${validCase.reason} must recover a consistent lineage tuple`,
    );
  }

  const contradictoryCases = [
    createCorrelationData({ parentAgentId: "agent-parent" }),
    createCorrelationData({ rootAgentId: "agent-other-root" }),
    createCorrelationData({ agentId: "agent-child", rootAgentId: "agent-root", depth: 1 }),
    createCorrelationData({
      agentId: "agent-child",
      parentAgentId: "agent-child",
      rootAgentId: "agent-root",
      depth: 1,
    }),
    createCorrelationData({
      agentId: "agent-child",
      parentAgentId: "agent-parent",
      rootAgentId: "agent-child",
      depth: 1,
    }),
    createCorrelationData({
      agentId: "agent-child",
      parentAgentId: "agent-parent",
      rootAgentId: "agent-root",
      depth: 1,
    }),
    createCorrelationData({
      agentId: "agent-grandchild",
      parentAgentId: "agent-root",
      rootAgentId: "agent-root",
      depth: 2,
    }),
  ];

  for (const [index, data] of contradictoryCases.entries()) {
    assert.equal(
      readLatestSessionCorrelation([createCorrelationEntry(`contradictory-${index}`, data)]),
      undefined,
      `contradictory lineage tuple ${index + 1} must be ignored`,
    );
  }
});

test("registerHandlers validates Pi event API shape before registration", () => {
  const pi = { handlers: new Map(), on: "not-a-function" };

  assert.throws(
    () => registerHandlers(pi),
    /ObservMe\/Pi API capability error: expected Pi ExtensionAPI with on\(eventName, handler\) before registering ObservMe handlers\./u,
  );
  assert.equal(pi.handlers.size, 0);
  assert.throws(() => registerHandlers(undefined), /ObservMe\/Pi API capability error/u);
});

test("registerHandlers propagates Pi event registration failures", () => {
  const registrationError = new Error("Pi registration failed");

  assert.throws(
    () => registerHandlers({ on: () => { throw registrationError; } }),
    registrationError,
  );
});

test("registerHandlers rolls back the integration listener at every handler registration failure", () => {
  const successfulEvents = createTrackedEventBus();
  let registrationCount = 0;
  registerHandlers({ events: successfulEvents, on: () => { registrationCount += 1; } });
  assert.equal(registrationCount, 22);
  assert.equal(successfulEvents.listenerCount(OBSERVME_INTEGRATION_CHANNEL), 1);

  for (let failureIndex = 0; failureIndex < registrationCount; failureIndex += 1) {
    const registrationError = new Error(`Pi registration failed at ${failureIndex}`);
    const events = createTrackedEventBus();
    let currentIndex = 0;
    const pi = {
      events,
      on() {
        const index = currentIndex;
        currentIndex += 1;
        if (index === failureIndex) throw registrationError;
      },
    };

    assert.throws(() => registerHandlers(pi), registrationError);
    assert.equal(events.listenerCount(OBSERVME_INTEGRATION_CHANNEL), 0);
    assert.equal(events.unsubscribeCalls, 1);
    assert.equal(requestObservMeIntegration({ events }), undefined);
  }
});

test("registerHandlers preserves registration failures when integration rollback throws", () => {
  const registrationError = new Error("Pi registration failed");
  const events = createTrackedEventBus(new Error("integration unsubscribe failed"));

  assert.throws(
    () => registerHandlers({ events, on: () => { throw registrationError; } }),
    registrationError,
  );
  assert.equal(events.listenerCount(OBSERVME_INTEGRATION_CHANNEL), 0);
  assert.equal(events.unsubscribeCalls, 1);
});

test("successful handler registration owns one integration listener and unsubscribes once", async () => {
  const events = createTrackedEventBus();
  const pi = createFakePi(events);

  registerHandlers(pi);

  assert.equal(events.listenerCount(OBSERVME_INTEGRATION_CHANNEL), 1);
  assert.ok(requestObservMeIntegration({ events }));

  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});

  assert.equal(events.listenerCount(OBSERVME_INTEGRATION_CHANNEL), 0);
  assert.equal(events.unsubscribeCalls, 1);
  assert.equal(requestObservMeIntegration({ events }), undefined);
});

test("registerHandlers registers expected lifecycle handlers with valid Pi event API", () => {
  const pi = createFakePi();

  registerHandlers(pi, { loadConfig });

  assert.deepEqual([...pi.handlers.keys()], [
    "session_start",
    "session_info_changed",
    "before_agent_start",
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
    "model_select",
    "thinking_level_select",
    "session_before_tree",
    "session_tree",
    "session_compact",
    "turn_end",
    "agent_end",
    "session_shutdown",
  ]);
  assert.equal([...pi.handlers.values()].every(handler => typeof handler === "function"), true);
});

test("live session replacement keeps direct providers fresh and process-global providers untouched", { concurrency: false }, async t => {
  const sentinel = installSentinelGlobalProviders();
  const config = structuredClone(defaultObservMeConfig);
  config.otlp.timeoutMs = 10;
  config.shutdown.flushTimeoutMs = 100;
  const lineage = {
    workflowId: "workflow-global-isolation",
    workflowRootAgentId: "agent-global-isolation",
    agentId: "agent-global-isolation",
    rootAgentId: "agent-global-isolation",
    depth: 0,
    role: "root",
    orphaned: false,
  };
  const sessions = [];

  t.after(async () => {
    for (const session of sessions) session.activeAgentLease.dispose();
    await Promise.all(sessions.map(session => session.controller.shutdown()));
    resetGlobalProviders();
  });

  const first = await startSessionTelemetry({ config, lineage });
  sessions.push(first);

  assert.notEqual(first.tracer, sentinel.tracer);
  assert.notEqual(first.meter, sentinel.meter);
  assert.notEqual(first.logger, sentinel.logger);
  assert.equal(trace.getTracer("unrelated-before-replacement"), sentinel.tracer);
  assert.equal(metrics.getMeter("unrelated-before-replacement"), sentinel.meter);
  assert.equal(logs.getLogger("unrelated-before-replacement"), sentinel.logger);

  first.activeAgentLease.dispose();
  await first.controller.shutdown();

  const second = await startSessionTelemetry({ config, lineage });
  sessions.push(second);

  assert.notEqual(second.tracer, first.tracer);
  assert.notEqual(second.meter, first.meter);
  assert.notEqual(second.logger, first.logger);
  assert.equal(trace.getTracer("unrelated-after-replacement"), sentinel.tracer);
  assert.equal(metrics.getMeter("unrelated-after-replacement"), sentinel.meter);
  assert.equal(logs.getLogger("unrelated-after-replacement"), sentinel.logger);

  emitUnrelatedGlobalTelemetry();
  assert.deepEqual(sentinel.records, {
    spans: [{ name: "unrelated.span" }],
    metrics: [{ name: "unrelated.counter", value: 1 }],
    logs: [{ body: "unrelated.log" }],
  });
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

test("telemetry session resource config preserves trusted .env tenant salt across cloning", () => {
  const previousSalt = process.env.OBSERVME_HASH_SALT;
  delete process.env.OBSERVME_HASH_SALT;

  try {
    const config = structuredClone(defaultObservMeConfig);
    config.capture.prompts = true;
    registerTenantSaltEnvironment(config, { OBSERVME_HASH_SALT: "session-clone-salt" });
    const lineage = {
      workflowId: "workflow-resource-salt-test",
      workflowRootAgentId: "agent-root-resource-salt-test",
      agentId: "agent-resource-salt-test",
      rootAgentId: "agent-root-resource-salt-test",
      depth: 0,
      role: "root",
      orphaned: false,
    };
    const merged = withTelemetrySessionResourceAttributes(config, lineage, "session-instance-salt-test");
    const result = applyContentCapturePolicy({
      captureEnabled: merged.capture.prompts,
      value: "password=prompt-secret",
      kind: "prompt",
      config: merged,
    });

    assert.equal(result.mode, "redacted");
    assert.equal(result.captured, true);
  } finally {
    if (previousSalt === undefined) delete process.env.OBSERVME_HASH_SALT;
    else process.env.OBSERVME_HASH_SALT = previousSalt;
  }
});

test("top-level disablement keeps every lifecycle path telemetry-free and clears public runtime state", async t => {
  clearObsSessionRuntimeState();
  clearObsAgentsRuntimeState();
  resetObsStatusRuntimeState();
  t.after(() => {
    clearObsSessionRuntimeState();
    clearObsAgentsRuntimeState();
    resetObsStatusRuntimeState();
  });

  const config = createTopLevelDisabledConfig();
  const lineage = {
    workflowId: "workflow-disabled",
    workflowRootAgentId: "agent-disabled",
    agentId: "agent-disabled",
    rootAgentId: "agent-disabled",
    depth: 0,
    role: "root",
    orphaned: false,
  };
  await assert.rejects(
    () => startSessionTelemetry({ config, lineage }),
    /cannot start while ObservMe is disabled/u,
  );

  startObsSessionRuntimeState({
    sessionId: "stale-session",
    traceId: "11111111111111111111111111111111",
  });
  startObsAgentsRuntimeState({
    lineage,
    sessionId: "stale-session",
    traceId: "11111111111111111111111111111111",
  });

  const events = createEventBus();
  const pi = createFakePi(events);
  const statuses = [];
  let startTelemetryCalls = 0;
  registerHandlers(pi, {
    loadConfig: () => Promise.resolve(config),
    startTelemetry: async () => {
      startTelemetryCalls += 1;
      throw new Error("disabled startup must not construct telemetry");
    },
  });

  const integration = requestObservMeIntegration({ events });
  assert.ok(integration);
  const ctx = createLifecycleStatusContext(statuses);
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    await pi.handlers.get("session_start")({ reason, sessionId: `session-${reason}` }, ctx);
  }

  for (const [eventName, handler] of pi.handlers) {
    if (eventName === "session_start" || eventName === "session_shutdown") continue;
    await handler({}, ctx);
  }

  const statusNotifications = [];
  await handleObsStatusCommand("status", createNotificationContext(statusNotifications));
  const sessionSnapshot = getLocalObsSessionSnapshot();
  const agentsSnapshot = getLocalObsAgentsRuntimeSnapshot();
  const statusState = getObsStatusRuntimeState();

  assert.equal(startTelemetryCalls, 0);
  assert.equal(statuses.length, 5);
  assert.equal(statuses.every(status => status.key === EXTENSION_STATUS_KEY && status.value === undefined), true);
  assert.deepEqual(sessionSnapshot, {
    sessionId: undefined,
    traceId: undefined,
    turns: 0,
    llmCalls: 0,
    toolCalls: 0,
    costUsd: 0,
    traceLink: undefined,
    traceLinkError: undefined,
  });
  assert.equal(agentsSnapshot.lineage, undefined);
  assert.equal(agentsSnapshot.sessionId, undefined);
  assert.equal(agentsSnapshot.traceId, undefined);
  assert.deepEqual(agentsSnapshot.children, []);
  assert.deepEqual(agentsSnapshot.waitJoinHints, []);
  assert.equal(statusState.config?.enabled, false);
  assert.equal(statusState.config?.traces.enabled, true);
  assert.equal(statusState.config?.metrics.enabled, true);
  assert.equal(statusState.config?.logs.enabled, true);
  assert.equal(statusState.lastExportError, undefined);
  assert.deepEqual(integration.getContext(), { ok: false, reason: "session_unavailable" });
  assert.match(statusNotifications[0].message, /ObservMe: disabled/u);
  assert.match(statusNotifications[0].message, /Traces: disabled/u);
  assert.match(statusNotifications[0].message, /Metrics: disabled/u);
  assert.match(statusNotifications[0].message, /Logs: disabled/u);

  await pi.handlers.get("session_shutdown")({ status: "ok" }, ctx);
  assert.equal(requestObservMeIntegration({ events }), undefined);
  assert.equal(getLocalObsSessionSnapshot().sessionId, undefined);
  assert.equal(getLocalObsAgentsRuntimeSnapshot().lineage, undefined);
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
      delete telemetry.activeAgentLease;
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

test("OTEL startup failure clears runtime state, surfaces a sanitized UI diagnostic, and allows a later session", async t => {
  clearObsSessionRuntimeState();
  clearObsAgentsRuntimeState();
  resetObsStatusRuntimeState();
  t.after(() => {
    clearObsSessionRuntimeState();
    clearObsAgentsRuntimeState();
    resetObsStatusRuntimeState();
  });

  const staleLineage = {
    workflowId: "workflow-stale-startup",
    workflowRootAgentId: "agent-stale-startup",
    agentId: "agent-stale-startup",
    rootAgentId: "agent-stale-startup",
    depth: 0,
    role: "root",
    orphaned: false,
  };
  startObsSessionRuntimeState({
    sessionId: "stale-startup-session",
    traceId: "33333333333333333333333333333333",
  });
  startObsAgentsRuntimeState({
    lineage: staleLineage,
    sessionId: "stale-startup-session",
    traceId: "33333333333333333333333333333333",
  });

  const pi = createFakePi();
  const statuses = [];
  const notifications = [];
  let startCalls = 0;
  let laterTelemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      startCalls += 1;
      if (startCalls === 1) {
        throw toOtelStartupError(
          new Error("log startup failed Authorization: Bearer startup-token password=startup-password /tmp/private.env"),
        );
      }
      laterTelemetry = createFakeTelemetry(lineage);
      return laterTelemetry;
    },
  });
  const ctx = {
    cwd: "/workspace/demo",
    hasUI: true,
    ui: {
      setStatus: (key, value) => statuses.push({ key, value }),
      notify: (message, type) => notifications.push({ message, type }),
    },
  };

  await assert.doesNotReject(() =>
    pi.handlers.get("session_start")({ sessionId: "session-failed-otel", reason: "startup" }, ctx),
  );

  assert.equal(startCalls, 1);
  assert.deepEqual(statuses, [{ key: EXTENSION_STATUS_KEY, value: undefined }]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /ObservMe OTEL startup failed/u);
  assert.match(notifications[0].message, /Check OTLP settings and Collector availability before retrying/u);
  assert.doesNotMatch(notifications[0].message, /startup-token|startup-password|private\.env/u);
  assert.equal(getLocalObsSessionSnapshot().sessionId, undefined);
  assert.equal(getLocalObsAgentsRuntimeSnapshot().lineage, undefined);
  assert.match(getObsStatusRuntimeState().lastExportError, /startup failed: ObservMe OTEL startup failed/u);
  assert.doesNotMatch(getObsStatusRuntimeState().lastExportError, /startup-token|startup-password|private\.env/u);

  await assert.doesNotReject(() =>
    pi.handlers.get("session_start")({ sessionId: "session-after-failed-otel", reason: "reload" }, ctx),
  );

  assert.equal(startCalls, 2);
  assert.equal(getLocalObsSessionSnapshot().sessionId, "session-after-failed-otel");
  assert.equal(getLocalObsAgentsRuntimeSnapshot().lineage?.agentId, laterTelemetry.lineage.agentId);
  assert.equal(statuses.at(-1).value, EXTENSION_STATUS_VALUE);
  assert.equal(getObsStatusRuntimeState().lastExportError, undefined);

  await pi.handlers.get("session_shutdown")({ status: "ok" }, ctx);
});

test("OTEL startup failure remains fail-open and silent through headless UI methods", async t => {
  clearObsSessionRuntimeState();
  clearObsAgentsRuntimeState();
  resetObsStatusRuntimeState();
  t.after(() => {
    clearObsSessionRuntimeState();
    clearObsAgentsRuntimeState();
    resetObsStatusRuntimeState();
  });

  const pi = createFakePi();
  const notifications = [];
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async () => {
      throw toOtelStartupError(new Error("metric startup failed Authorization: Bearer headless-token"));
    },
  });

  await assert.doesNotReject(() =>
    pi.handlers.get("session_start")(
      { sessionId: "session-headless-otel-failure" },
      {
        cwd: "/workspace/demo",
        hasUI: false,
        ui: { notify: (message, type) => notifications.push({ message, type }) },
      },
    ),
  );

  assert.deepEqual(notifications, []);
  assert.equal(getLocalObsSessionSnapshot().sessionId, undefined);
  assert.equal(getLocalObsAgentsRuntimeSnapshot().lineage, undefined);
  assert.doesNotMatch(getObsStatusRuntimeState().lastExportError, /headless-token/u);
});

test("failed session startup disposes the inactive lease callback and bounded telemetry controller", async () => {
  const pi = createFakePi();
  const errors = [];
  const statuses = [];
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
    onHandlerError: (name, error) => errors.push({ name, error }),
  });

  await assert.doesNotReject(() =>
    pi.handlers.get("session_start")(
      { sessionId: "session-failed-start" },
      {
        cwd: "/workspace/demo",
        ui: {
          setStatus: (key, value) => {
            statuses.push({ key, value });
            if (value === EXTENSION_STATUS_VALUE) throw new Error("status unavailable");
          },
        },
      },
    ),
  );

  assert.deepEqual(telemetry.activeAgentLease.transitions, ["deactivate", "dispose"]);
  assert.equal(telemetry.activeAgentLease.active, false);
  assert.equal(telemetry.activeAgentLease.disposed, true);
  assert.equal(telemetry.activeAgentLease.callbackRegistered, false);
  assert.equal(telemetry.activeAgentRecorded, false);
  assert.equal(metricTotal(telemetry.meter.records, OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_AGENTS), 0);
  assert.equal(telemetry.tracer.spans.every(span => span.ended), true);
  assert.deepEqual(telemetry.controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(telemetry.controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(statuses, [
    { key: EXTENSION_STATUS_KEY, value: EXTENSION_STATUS_VALUE },
    { key: EXTENSION_STATUS_KEY, value: undefined },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "session_start");

  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});
  assert.equal(telemetry.controller.flushCalls.length, 1);
  assert.equal(telemetry.controller.shutdownCalls.length, 1);
});

test("session_start emits one sanitized structured config rejection diagnostic", async () => {
  const pi = createFakePi();
  const notifications = [];
  let telemetry;
  registerHandlers(pi, {
    loadConfig: () => Promise.resolve(createRejectedConfigLoadResult(defaultObservMeConfig, [
      "unsafe_capture_without_redaction",
      "high_cardinality_metric_label",
    ])),
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")(
    { sessionId: "session-config-rejected" },
    createNotificationContext(notifications),
  );

  const records = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.CONFIG_REJECTED);
  assert.equal(records.length, 1);
  assert.equal(records[0].attributes[LOG_ATTRIBUTES.EVENT_CATEGORY], "config");
  assert.equal(records[0].attributes[CONFIG_ATTRIBUTES.OBSERVME_CONFIG_SOURCE], "environment");
  assert.deepEqual(records[0].attributes[CONFIG_ATTRIBUTES.OBSERVME_CONFIG_REJECTION_ISSUE_CODES], [
    "unsafe_capture_without_redaction",
    "high_cardinality_metric_label",
  ]);
  assert.equal(records[0].attributes[CONFIG_ATTRIBUTES.OBSERVME_CONFIG_REJECTION_ISSUE_COUNT], 2);
  assert.equal(records[0].attributes[LOG_ATTRIBUTES.TRACE_ID], "11111111111111111111111111111111");
  assert.equal(records[0].attributes[LOG_ATTRIBUTES.SPAN_ID], "2222222222222222");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
  assert.match(notifications[0].message, /safe defaults/u);
  assert.deepEqual(getObsStatusRuntimeState().configDiagnostics?.rejection?.issueCodes, [
    "unsafe_capture_without_redaction",
    "high_cardinality_metric_label",
  ]);
  assert.doesNotMatch(JSON.stringify({ records, notifications }), /token|password|header|\/workspace\/demo|private regex/iu);
});

test("config rejection diagnostics use UI fallback when logs are disabled and remain fail-open headlessly", async () => {
  const disabledLogsConfig = structuredClone(defaultObservMeConfig);
  disabledLogsConfig.logs.enabled = false;
  const notifications = [];
  const piWithUi = createFakePi();
  let uiTelemetry;
  registerHandlers(piWithUi, {
    loadConfig: () => Promise.resolve(createRejectedConfigLoadResult(disabledLogsConfig)),
    startTelemetry: async ({ lineage }) => {
      uiTelemetry = createFakeTelemetry(lineage);
      uiTelemetry.config = disabledLogsConfig;
      uiTelemetry.logger.emit = () => undefined;
      return uiTelemetry;
    },
  });

  await assert.doesNotReject(() =>
    piWithUi.handlers.get("session_start")(
      { sessionId: "session-config-rejected-no-logs" },
      createNotificationContext(notifications),
    ),
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
  assert.equal(uiTelemetry.logger.records.length, 0);
  assert.equal(uiTelemetry.tracer.spans.some(span => span.name === SPAN_NAMES.PI_SESSION), true);

  const headlessPi = createFakePi();
  let headlessTelemetry;
  registerHandlers(headlessPi, {
    loadConfig: () => Promise.resolve(createRejectedConfigLoadResult(disabledLogsConfig)),
    startTelemetry: async ({ lineage }) => {
      headlessTelemetry = createFakeTelemetry(lineage);
      headlessTelemetry.config = disabledLogsConfig;
      headlessTelemetry.logger.emit = record => {
        if (record.body === LOG_EVENT_NAMES.CONFIG_REJECTED) throw new Error("disabled diagnostic logger");
        headlessTelemetry.logger.records.push(record);
      };
      return headlessTelemetry;
    },
  });

  await assert.doesNotReject(() =>
    headlessPi.handlers.get("session_start")(
      { sessionId: "session-config-rejected-headless" },
      { cwd: "/workspace/demo", hasUI: false },
    ),
  );
  assert.equal(headlessTelemetry.tracer.spans.some(span => span.name === SPAN_NAMES.PI_SESSION), true);
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

  const sessionManager = {
    getSessionId: () => "session-1",
    getSessionFile: () => "/tmp/pi/session.jsonl",
    getHeader: () => ({
      type: "session",
      id: "session-1",
      version: 3,
      timestamp: "2026-07-14T00:00:00.000Z",
      cwd: "/workspace/demo",
    }),
    getCwd: () => "/workspace/demo",
    getSessionName: () => "Demo Session",
  };
  const ctx = {
    cwd: "/workspace/demo",
    sessionManager,
    model: { provider: "anthropic", id: "claude-test" },
    ui: {
      setStatus: (key, value) => statuses.push({ key, value }),
    },
  };

  await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

  const span = telemetry.tracer.spans[0];
  assert.equal(span.name, SPAN_NAMES.PI_SESSION);
  assert.equal(span.attributes["pi.session.id"], "session-1");
  assert.equal(span.attributes["pi.session.name"], "Demo Session");
  assert.match(span.attributes["pi.session.cwd_hash"], /^[a-f0-9]{64}$/u);
  assert.equal(span.attributes["pi.session.persisted"], true);
  assert.match(span.attributes["pi.session.file_hash"], /^[a-f0-9]{64}$/u);
  assert.equal(span.attributes["pi.session.version"], "3");
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
  assert.equal(telemetry.activeAgentRecorded, true);
  assert.equal(telemetry.activeAgentLease.active, true);
  assert.deepEqual(telemetry.activeAgentLease.transitions, ["activate"]);
  assert.equal(metricTotal(telemetry.meter.records, OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_AGENTS), 1);

  await pi.handlers.get("session_info_changed")({ type: "session_info_changed", name: "Renamed Session" }, ctx);
  const renameLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.SESSION_NAMED);
  assert.equal(span.attributes["pi.session.name"], "Renamed Session");
  assert.equal(renameLog.attributes["pi.session.name"], "Renamed Session");
  assert.equal(renameLog.attributes["pi.session.id"], "session-1");
});

test("live logs, /obs logs, Tempo lookup, and /obs backfill share the active Pi session-manager id", async () => {
  clearObsSessionRuntimeState();
  clearObsAgentsRuntimeState();

  const sessionId = "pi-session-correlation";
  const sessionFile = "/tmp/pi/pi-session-correlation.jsonl";
  const entry = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-07-14T00:00:00.000Z",
    message: { role: "user", content: "hello", timestamp: Date.parse("2026-07-14T00:00:00.000Z") },
  };
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getHeader: () => ({
      type: "session",
      id: sessionId,
      version: 3,
      timestamp: "2026-07-14T00:00:00.000Z",
      cwd: "/workspace/demo",
    }),
    getCwd: () => "/workspace/demo",
    getSessionName: () => "Correlation Session",
    getBranch: () => [entry],
    getEntries: () => [entry],
  };
  const config = structuredClone(defaultObservMeConfig);
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "test-token";
  config.query.grafana.datasourceUids.loki = "loki";
  const pi = createFakePi();
  let telemetry;

  registerHandlers(pi, {
    loadConfig: async () => config,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      telemetry.config = config;
      return telemetry;
    },
  });

  const ctx = {
    cwd: "/workspace/demo",
    sessionManager,
    model: { provider: "anthropic", id: "claude-test" },
    ui: { setStatus: () => undefined },
  };
  await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

  const startedLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.SESSION_STARTED);
  assert.equal(telemetry.sessionSpan.attributes["pi.session.id"], sessionId);
  assert.equal(startedLog.attributes["pi.session.id"], sessionId);
  assert.equal(getLocalObsSessionSnapshot().sessionId, sessionId);

  let lokiQuery;
  const logsSnapshot = await getObsLogsSnapshot({ cwd: ctx.cwd, ui: { notify: () => undefined } }, {
    loadConfig: async () => config,
    fetch: async input => {
      lokiQuery = new URL(String(input)).searchParams.get("query");
      return new Response(JSON.stringify({ status: "success", data: { resultType: "streams", result: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(logsSnapshot.sessionId, sessionId);
  assert.match(lokiQuery, new RegExp(`pi_session_id="${sessionId}"`, "u"));

  let tempoSessionId;
  const traceSnapshot = await getObsTraceSnapshot(
    { cwd: ctx.cwd, ui: { notify: () => undefined } },
    { scope: "session", sessionId },
    {
      loadConfig: async () => config,
      getSession: () => ({ sessionId: undefined, traceId: undefined, turns: 0 }),
      resolveSessionTraceId: requestedSessionId => {
        tempoSessionId = requestedSessionId;
        return "11111111111111111111111111111111";
      },
    },
  );
  assert.equal(traceSnapshot.source, "tempo");
  assert.equal(tempoSessionId, sessionId);

  const exportedRecords = [];
  const backfillSummary = await runObsBackfill(
    {
      cwd: ctx.cwd,
      hasUI: true,
      ui: { notify: () => undefined, confirm: () => true },
      waitForIdle: () => undefined,
      sessionManager,
    },
    { currentSession: true },
    {
      loadConfig: async () => config,
      createExporter: () => ({ emit: record => exportedRecords.push(record) }),
    },
  );
  assert.equal(backfillSummary.sessionId, sessionId);
  assert.equal(exportedRecords.length, 1);
  assert.equal(exportedRecords[0].attributes["pi.session.id"], sessionId);

  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
});

test("reload preserves Pi identity while new, resume, and fork adopt rebound manager identities", async () => {
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

  const originalCtx = createSessionLifecycleContext("pi-session-original", "/sessions/original.jsonl");
  const newCtx = createSessionLifecycleContext("pi-session-new", "/sessions/new.jsonl");
  const resumeCtx = createSessionLifecycleContext("pi-session-resume", "/sessions/resume.jsonl");
  const forkCtx = createSessionLifecycleContext("pi-session-fork", "/sessions/fork.jsonl");

  await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, originalCtx);
  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, originalCtx);
  await pi.handlers.get("session_start")({ type: "session_start", reason: "reload" }, originalCtx);
  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new", targetSessionFile: "/sessions/new.jsonl" }, originalCtx);
  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "new", previousSessionFile: "/sessions/original.jsonl" },
    newCtx,
  );
  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "resume", targetSessionFile: "/sessions/resume.jsonl" }, newCtx);
  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "resume", previousSessionFile: "/sessions/new.jsonl" },
    resumeCtx,
  );
  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "fork", targetSessionFile: "/sessions/fork.jsonl" }, resumeCtx);
  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "fork", previousSessionFile: "/sessions/resume.jsonl" },
    forkCtx,
  );

  assert.deepEqual(
    sessions.map(session => session.sessionAttributes["pi.session.id"]),
    ["pi-session-original", "pi-session-original", "pi-session-new", "pi-session-resume", "pi-session-fork"],
  );
  const hashSource = { env: process.env, envName: defaultObservMeConfig.privacy.tenantSaltEnv };
  assert.equal(sessions[4].sessionAttributes["pi.session.file_hash"], sha256("/sessions/fork.jsonl", hashSource));
  assert.notEqual(sessions[4].sessionAttributes["pi.session.file_hash"], sha256("/sessions/resume.jsonl", hashSource));

  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, forkCtx);
});

test("child pi.session continues the validated parent spawn context with an in-memory exporter", async t => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer("observme-propagated-session-test");
  const pi = createFakePi();
  let telemetry;
  t.after(async () => provider.shutdown());

  registerHandlers(pi, {
    env: completePropagationEnvironment(),
    trustedParentContext: true,
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage, tracer);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-propagated-child" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});

  const sessionSpan = exporter.getFinishedSpans().find(span => span.name === SPAN_NAMES.PI_SESSION);
  assert.ok(sessionSpan);
  assert.equal(sessionSpan.spanContext().traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(sessionSpan.parentSpanContext?.spanId, "00f067aa0ba902b7");
  assert.equal(sessionSpan.attributes["pi.workflow.id"], "workflow-propagated");
  assert.equal(sessionSpan.attributes["pi.agent.parent_id"], "agent-parent-propagated");
  assert.equal(sessionSpan.attributes["pi.agent.root_id"], "agent-root-propagated");
  assert.equal(telemetry.lineage.depth, 3);
  assert.equal(telemetry.lineage.spawnId, "spawn-propagated");
  assert.equal(metricTotal(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL), 0);
});

test("trusted lineage without W3C continuation starts a new trace with a validated parent link", async () => {
  const pi = createFakePi();
  const env = completePropagationEnvironment();
  delete env.traceparent;
  delete env.tracestate;
  let telemetry;

  registerHandlers(pi, {
    env,
    trustedParentContext: true,
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-linked-child" }, { cwd: "/workspace/demo" });

  const sessionSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_SESSION);
  assert.equal(sessionSpan.parentSpanContext, undefined);
  assert.equal(sessionSpan.links.length, 1);
  assert.equal(sessionSpan.links[0].context.traceId, env.OBSERVME_PARENT_TRACE_ID);
  assert.equal(sessionSpan.links[0].context.spanId, env.OBSERVME_PARENT_SPAN_ID);
  assert.equal(telemetry.lineage.parentAgentId, env.OBSERVME_PARENT_AGENT_ID);
  assert.equal(telemetry.lineage.rootAgentId, env.OBSERVME_ROOT_AGENT_ID);
  assert.equal(telemetry.lineage.orphaned, false);
  assert.equal(metricTotal(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL), 1);
  assert.equal(metricTotal(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL), 0);
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED));
});

test("invalid process propagation fails open once without logging inherited values", async () => {
  const pi = createFakePi();
  const env = completePropagationEnvironment({
    OBSERVME_WORKFLOW_ID: "workflow-private-inherited",
    OBSERVME_PARENT_AGENT_ID: "agent-private-inherited",
    OBSERVME_ROOT_AGENT_ID: "root-private-inherited",
    OBSERVME_SPAWN_ID: "spawn-private-inherited",
    traceparent: "private-invalid-traceparent",
  });
  let telemetry;

  registerHandlers(pi, {
    env,
    trustedParentContext: true,
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await assert.doesNotReject(() =>
    pi.handlers.get("session_start")({ sessionId: "session-invalid-propagation" }, { cwd: "/workspace/demo" }),
  );

  const sessionSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_SESSION);
  const diagnostics = JSON.stringify(telemetry.logger.records);
  assert.equal(telemetry.lineage.parentAgentId, undefined);
  assert.equal(telemetry.lineage.propagationFailure, "malformed_envelope");
  assert.equal(telemetry.lineage.orphaned, true);
  assert.equal(sessionSpan.parentSpanContext, undefined);
  assert.equal(sessionSpan.links.length, 0);
  assert.equal(metricTotal(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL), 1);
  assert.equal(metricTotal(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL), 1);
  for (const inherited of [
    env.OBSERVME_WORKFLOW_ID,
    env.OBSERVME_PARENT_AGENT_ID,
    env.OBSERVME_ROOT_AGENT_ID,
    env.OBSERVME_PARENT_SESSION_ID,
    env.OBSERVME_PARENT_TRACE_ID,
    env.OBSERVME_PARENT_SPAN_ID,
    env.OBSERVME_SPAWN_ID,
    env.traceparent,
    env.tracestate,
  ]) {
    assert.equal(diagnostics.includes(inherited), false);
  }
});

test("trusted project .env lineage is configuration-only and cannot become process provenance", async t => {
  const directory = await mkdtemp(join(tmpdir(), "observme-project-lineage-"));
  const projectEnv = completePropagationEnvironment({
    OBSERVME_WORKFLOW_ID: "workflow-project-local",
    OBSERVME_PARENT_AGENT_ID: "agent-project-local",
    OBSERVME_ROOT_AGENT_ID: "root-project-local",
    OBSERVME_SPAWN_ID: "spawn-project-local",
  });
  await writeFile(
    join(directory, ".env"),
    Object.entries(projectEnv).map(([name, value]) => `${name}=${value}`).join("\n"),
    "utf8",
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    env: { OBSERVME_HASH_SALT: "system-only-salt" },
    trustedParentContext: true,
    loadConfig: options => loadSessionConfig({
      ...options,
      globalConfigPath: join(directory, "missing-global.yaml"),
    }),
    startTelemetry: async ({ config, lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      telemetry.config = config;
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")(
    { sessionId: "session-env-boundary" },
    { cwd: directory, isProjectTrusted: () => true },
  );

  const serialized = JSON.stringify({ lineage: telemetry.lineage, logs: telemetry.logger.records });
  assert.equal(telemetry.lineage.parentAgentId, undefined);
  assert.equal(telemetry.lineage.propagationFailure, undefined);
  assert.equal(serialized.includes("project-local"), false);
  assert.equal(metricTotal(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL), 0);
});

test("session_start resume uses the rebound session-manager header and emits no replayed telemetry by default", async () => {
  const pi = createFakePi();
  let telemetry;
  const readCalls = [];
  registerHandlers(pi, {
    loadConfig,
    readSessionHeader: async sessionFile => {
      readCalls.push(sessionFile);
      return {
        type: "session",
        id: "stale-file-session",
        version: 3,
        cwd: "/workspace/stale-file",
      };
    },
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  const ctx = createSessionLifecycleContext("header-session", "/sessions/resumed.jsonl");
  ctx.sessionManager.getHeader = () => ({
    type: "session",
    id: "header-session",
    version: 3,
    timestamp: "2026-07-14T00:00:00.000Z",
    cwd: "/workspace/from-header",
    parentSession: "/sessions/parent.jsonl",
  });
  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "resume", previousSessionFile: "/sessions/previous.jsonl" },
    ctx,
  );
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});

  assert.deepEqual(readCalls, []);
  assert.equal(telemetry.tracer.spans[0].attributes["pi.session.id"], "header-session");
  assert.equal(telemetry.tracer.spans[0].attributes["pi.session.persisted"], true);
  assert.equal(telemetry.tracer.spans[0].attributes["observme.replayed"], false);
  assert.equal(hasReplayedTelemetry(telemetry), false);
  assert.equal(telemetry.activeAgentLease.active, true);
  assert.deepEqual(telemetry.activeAgentLease.transitions, ["activate"]);
});

test("enabled correlation persistence writes one branch-local custom entry and is idempotent on reload", async () => {
  const config = structuredClone(defaultObservMeConfig);
  config.agent.writeCorrelationEntry = true;
  const activeBranch = [];
  const appendedEntries = [];
  const sentMessages = [];
  const sessions = [];
  const operations = [];
  const pi = createFakePi();
  pi.appendEntry = (customType, data) => {
    operations.push("append");
    const entry = createCorrelationEntry(`correlation-${appendedEntries.length + 1}`, data, activeBranch.at(-1)?.id ?? null);
    appendedEntries.push(entry);
    activeBranch.push(entry);
  };
  pi.sendMessage = message => sentMessages.push(message);

  registerHandlers(pi, {
    loadConfig: () => Promise.resolve(config),
    startTelemetry: async ({ lineage }) => {
      const telemetry = createFakeTelemetry(lineage);
      telemetry.config = config;
      sessions.push(telemetry);
      return telemetry;
    },
  });

  const ctx = createSessionLifecycleContext("correlation-session", "/sessions/correlation.jsonl");
  ctx.ui.setStatus = (_key, value) => operations.push(value === EXTENSION_STATUS_VALUE ? "status" : "clear");
  ctx.sessionManager.getBranch = () => activeBranch;
  ctx.sessionManager.getEntries = () => activeBranch;

  await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

  assert.equal(appendedEntries.length, 1);
  assert.equal(appendedEntries[0].type, "custom");
  assert.equal(appendedEntries[0].customType, OBSERVME_CORRELATION_ENTRY_TYPE);
  assert.deepEqual(Object.keys(appendedEntries[0].data).sort(), [
    "agentId",
    "depth",
    "rootAgentId",
    "schemaVersion",
    "workflowId",
  ]);
  assert.deepEqual(operations.slice(-2), ["status", "append"]);
  assert.equal(sentMessages.length, 0);
  assert.equal(activeBranch.some(entry => entry.type === "custom_message"), false);

  activeBranch.push(createCorrelationEntry("reload-self-rooted-child", createCorrelationData({
    workflowId: "workflow-reload-self-rooted",
    agentId: "agent-reload-self-rooted",
    parentAgentId: "agent-reload-parent",
    rootAgentId: "agent-reload-self-rooted",
    depth: 1,
  }), activeBranch.at(-1)?.id ?? null));
  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);
  await pi.handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);

  assert.equal(appendedEntries.length, 1);
  assert.equal(sessions[1].lineage.workflowId, sessions[0].lineage.workflowId);
  assert.equal(sessions[1].lineage.agentId, sessions[0].lineage.agentId);
  assert.equal(sessions[1].lineage.rootAgentId, sessions[0].lineage.rootAgentId);
  assert.equal(sessions[1].lineage.depth, sessions[0].lineage.depth);
  assert.equal(hasReplayedTelemetry(sessions[1]), false);

  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
});

test("correlation recovery uses the latest valid active-branch entry across resume and fork", async () => {
  const config = structuredClone(defaultObservMeConfig);
  config.agent.writeCorrelationEntry = true;
  const latestResume = createCorrelationData({
    workflowId: "workflow-resume-latest",
    agentId: "agent-resume-latest",
    rootAgentId: "agent-resume-latest",
  });
  const forkCorrelation = createCorrelationData({
    workflowId: "workflow-fork-active",
    agentId: "agent-fork-active",
    parentAgentId: "agent-fork-parent",
    rootAgentId: "agent-fork-root",
    parentSessionId: "session-fork-parent",
    depth: 2,
    spawnId: "spawn-fork-active",
    capability: "reviewer",
  });
  const abandonedCorrelation = createCorrelationEntry("abandoned", createCorrelationData({
    workflowId: "workflow-abandoned-private",
    agentId: "agent-abandoned-private",
    rootAgentId: "agent-abandoned-private",
  }));
  const corruptSecret = "private-correlation-value-that-must-not-be-exported";
  let activeBranch = [
    createCorrelationEntry("resume-old", createCorrelationData({
      workflowId: "workflow-resume-old",
      agentId: "agent-resume-old",
      rootAgentId: "agent-resume-old",
    })),
    createCorrelationEntry("resume-latest", latestResume, "resume-old"),
    createCorrelationEntry("resume-corrupt", {
      ...latestResume,
      workflowId: corruptSecret,
      unexpected: corruptSecret,
    }, "resume-latest"),
    createCorrelationEntry("resume-self-rooted-child", createCorrelationData({
      workflowId: corruptSecret,
      agentId: "agent-resume-self-rooted",
      parentAgentId: "agent-resume-parent",
      rootAgentId: "agent-resume-self-rooted",
      depth: 1,
    }), "resume-corrupt"),
  ];
  const appendedEntries = [];
  const sessions = [];
  const pi = createFakePi();
  pi.appendEntry = (customType, data) => appendedEntries.push({ customType, data });
  registerHandlers(pi, {
    loadConfig: () => Promise.resolve(config),
    startTelemetry: async ({ lineage }) => {
      const telemetry = createFakeTelemetry(lineage);
      telemetry.config = config;
      sessions.push(telemetry);
      return telemetry;
    },
  });

  const resumeCtx = createSessionLifecycleContext("resume-session", "/sessions/resume.jsonl");
  resumeCtx.sessionManager.getBranch = () => activeBranch;
  resumeCtx.sessionManager.getEntries = () => [...activeBranch, abandonedCorrelation];
  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "resume", previousSessionFile: "/sessions/previous.jsonl" },
    resumeCtx,
  );

  assert.equal(sessions[0].lineage.workflowId, latestResume.workflowId);
  assert.equal(sessions[0].lineage.agentId, latestResume.agentId);
  assert.equal(appendedEntries.length, 0);
  assert.doesNotMatch(JSON.stringify({ spans: sessions[0].tracer.spans, logs: sessions[0].logger.records }), /private-correlation/u);

  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "fork" }, resumeCtx);
  activeBranch = [
    createCorrelationEntry("fork-valid", forkCorrelation),
    createCorrelationEntry("fork-corrupt", {
      ...forkCorrelation,
      depth: 65,
    }, "fork-valid"),
    createCorrelationEntry("fork-self-rooted-child", createCorrelationData({
      workflowId: corruptSecret,
      agentId: "agent-fork-self-rooted",
      parentAgentId: "agent-fork-parent",
      rootAgentId: "agent-fork-self-rooted",
      depth: 1,
    }), "fork-corrupt"),
  ];
  const forkCtx = createSessionLifecycleContext("fork-session", "/sessions/fork.jsonl");
  forkCtx.sessionManager.getBranch = () => activeBranch;
  forkCtx.sessionManager.getEntries = () => [...activeBranch, abandonedCorrelation];
  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "fork", previousSessionFile: "/sessions/resume.jsonl" },
    forkCtx,
  );

  assert.equal(sessions[1].lineage.workflowId, forkCorrelation.workflowId);
  assert.equal(sessions[1].lineage.agentId, forkCorrelation.agentId);
  assert.equal(sessions[1].lineage.parentAgentId, forkCorrelation.parentAgentId);
  assert.equal(sessions[1].lineage.rootAgentId, forkCorrelation.rootAgentId);
  assert.equal(sessions[1].lineage.parentSessionId, forkCorrelation.parentSessionId);
  assert.equal(sessions[1].lineage.depth, forkCorrelation.depth);
  assert.equal(sessions[1].lineage.spawnId, forkCorrelation.spawnId);
  assert.equal(sessions[1].lineage.capability, forkCorrelation.capability);
  assert.equal(appendedEntries.length, 0);
  assert.notEqual(sessions[1].lineage.workflowId, abandonedCorrelation.data.workflowId);
  assert.doesNotMatch(
    JSON.stringify(sessions.map(session => ({ spans: session.tracer.spans, logs: session.logger.records }))),
    /private-correlation/u,
  );

  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, forkCtx);
});

test("default, disabled, and failed startup paths never append correlation entries", async () => {
  const appendedEntries = [];
  const piDefault = createFakePi();
  piDefault.appendEntry = (customType, data) => appendedEntries.push({ customType, data });
  registerHandlers(piDefault, {
    loadConfig,
    startTelemetry: async ({ lineage }) => createFakeTelemetry(lineage),
  });
  const defaultCtx = createSessionLifecycleContext("default-session", "/sessions/default.jsonl");
  defaultCtx.sessionManager.getBranch = () => {
    throw new Error("disabled persistence must not read the active branch");
  };
  await piDefault.handlers.get("session_start")({ type: "session_start", reason: "startup" }, defaultCtx);
  await piDefault.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, defaultCtx);

  const disabledConfig = createTopLevelDisabledConfig();
  disabledConfig.agent.writeCorrelationEntry = true;
  const piDisabled = createFakePi();
  piDisabled.appendEntry = (customType, data) => appendedEntries.push({ customType, data });
  registerHandlers(piDisabled, { loadConfig: () => Promise.resolve(disabledConfig) });
  await piDisabled.handlers.get("session_start")(
    { type: "session_start", reason: "startup" },
    createSessionLifecycleContext("disabled-session", "/sessions/disabled.jsonl"),
  );

  const failedConfig = structuredClone(defaultObservMeConfig);
  failedConfig.agent.writeCorrelationEntry = true;
  const piFailed = createFakePi();
  piFailed.appendEntry = (customType, data) => appendedEntries.push({ customType, data });
  registerHandlers(piFailed, {
    loadConfig: () => Promise.resolve(failedConfig),
    startTelemetry: async () => {
      throw toOtelStartupError(new Error("offline startup failure"));
    },
  });
  await piFailed.handlers.get("session_start")(
    { type: "session_start", reason: "resume" },
    createSessionLifecycleContext("failed-session", "/sessions/failed.jsonl"),
  );

  assert.deepEqual(appendedEntries, []);
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
  let nowMs = 1_000;
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    now: () => nowMs,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-2" }, { cwd: "/workspace/demo" });
  const flushSnapshots = [];
  telemetry.controller.flush = async timeoutMs => {
    telemetry.controller.flushCalls.push(timeoutMs);
    flushSnapshots.push({
      leaseActive: telemetry.activeAgentLease.active,
      activeAgentRecorded: telemetry.activeAgentRecorded,
      activeTotal: metricTotal(telemetry.meter.records, OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_AGENTS),
    });
    return { operation: "flush", completed: true, timedOut: false };
  };
  await pi.handlers.get("agent_start")({ type: "agent_start" }, {});
  await pi.handlers.get("agent_end")({ type: "agent_end", messages: [successfulAssistantMessage] }, {});
  nowMs = 1_450;
  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});

  assert.equal(telemetry.tracer.spans[0].ended, true);
  assert.equal(telemetry.controller.flushCalls[0], defaultObservMeConfig.shutdown.flushTimeoutMs);
  assert.equal(telemetry.controller.shutdownCalls[0], defaultObservMeConfig.shutdown.flushTimeoutMs);
  assert.deepEqual(flushSnapshots, [{ leaseActive: false, activeAgentRecorded: false, activeTotal: 0 }]);
  assert.deepEqual(telemetry.activeAgentLease.transitions, ["activate", "deactivate", "dispose"]);
  assert.equal(telemetry.activeAgentLease.disposed, true);
  assert.equal(telemetry.activeAgentLease.callbackRegistered, false);
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
  assert.ok(
    telemetry.meter.records.some(
      record =>
        record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.WORKFLOW_DURATION_MS &&
        record.value === 450 &&
        record.attributes.status === "ok",
    ),
  );
});

test("session_shutdown isolates lease-observation and exporter shutdown failures after deactivation", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-export-failures" }, { cwd: "/workspace/demo" });
  telemetry.controller.flush = async timeoutMs => {
    telemetry.controller.flushCalls.push(timeoutMs);
    assert.equal(telemetry.activeAgentLease.active, false);
    throw new Error("lease observation failed");
  };
  telemetry.controller.shutdown = async timeoutMs => {
    telemetry.controller.shutdownCalls.push(timeoutMs);
    throw new Error("exporter shutdown failed");
  };

  await assert.doesNotReject(() => pi.handlers.get("session_shutdown")({ status: "ok" }, {}));

  assert.deepEqual(telemetry.controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(telemetry.controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.equal(metricTotal(telemetry.meter.records, OBSERVME_GAUGE_METRIC_NAMES.ACTIVE_AGENTS), 0);
  assert.equal(metricTotal(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.EXPORT_ERRORS_TOTAL), 2);
  assert.deepEqual(telemetry.activeAgentLease.transitions, ["activate", "deactivate", "dispose"]);
  assert.equal(telemetry.activeAgentLease.callbackRegistered, false);
});

test("shutdown fences cached integration mutations and cancels active orchestration before flush", async t => {
  clearObsAgentsRuntimeState();
  t.after(clearObsAgentsRuntimeState);

  const events = createEventBus();
  const pi = createFakePi(events);
  const flushEntered = createDeferred();
  const flushRelease = createDeferred();
  let telemetry;

  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")(
    { type: "session_start", reason: "startup" },
    { cwd: "/workspace/integration-shutdown" },
  );
  const integration = requestObservMeIntegration({ events });
  assert.ok(integration);

  const spawn = integration.startSubagent({
    spawnId: "spawn-shutdown-overlap",
    childAgentId: "child-shutdown-overlap",
    env: {},
  });
  assert.equal(spawn.ok, true);
  const wait = integration.startWait({
    id: "wait-shutdown-overlap",
    spawnId: spawn.spawnId,
    childAgentId: spawn.childAgentId,
    childStatus: "active",
    reason: "child_running",
  });
  const join = integration.startJoin({
    id: "join-shutdown-overlap",
    spawnId: spawn.spawnId,
    childAgentId: spawn.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
    reason: "dependency",
  });
  assert.equal(wait.ok, true);
  assert.equal(join.ok, true);

  const spawnSpan = telemetry.spans.activeSubagentSpawns.get(spawn.spawnId).span;
  const waitSpan = telemetry.spans.activeAgentWaits.get(wait.id).span;
  const joinSpan = telemetry.spans.activeAgentJoins.get(join.id).span;
  telemetry.controller.flush = async timeoutMs => {
    telemetry.controller.flushCalls.push(timeoutMs);
    flushEntered.resolve();
    await flushRelease.promise;
    return { operation: "flush", completed: true, timedOut: false };
  };

  const shutdown = pi.handlers.get("session_shutdown")(
    { type: "session_shutdown", reason: "quit" },
    {},
  );
  await flushEntered.promise;

  assert.equal(requestObservMeIntegration({ events }), undefined);
  assert.equal(telemetry.spans.activeSubagentSpawns.size, 0);
  assert.equal(telemetry.spans.activeAgentWaits.size, 0);
  assert.equal(telemetry.spans.activeAgentJoins.size, 0);
  assert.equal(telemetry.agentTree.getAgent(spawn.childAgentId).status, "cancelled");
  assert.equal(spawnSpan.attributes[AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_OUTCOME], "cancelled");
  assert.equal(waitSpan.attributes[AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_JOIN_STATUS], "cancelled");
  assert.equal(joinSpan.attributes[AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_JOIN_STATUS], "cancelled");
  assert.equal(spawnSpan.status.message, "cancelled");
  assert.equal(waitSpan.status.message, "cancelled");
  assert.equal(joinSpan.status.message, "cancelled");
  assert.equal(spawnSpan.endCalls, 1);
  assert.equal(waitSpan.endCalls, 1);
  assert.equal(joinSpan.endCalls, 1);
  assert.equal(
    spawnSpan.events.filter(event => event.name === LOG_EVENT_NAMES.AGENT_SPAWN_CANCELLED).length,
    1,
  );
  assert.equal(
    waitSpan.events.filter(event => event.name === LOG_EVENT_NAMES.AGENT_WAIT_COMPLETED).length,
    1,
  );
  assert.equal(
    joinSpan.events.filter(event => event.name === LOG_EVENT_NAMES.AGENT_JOIN_COMPLETED).length,
    1,
  );
  assert.deepEqual(
    getLocalObsAgentsRuntimeSnapshot().waitJoinHints
      .filter(hint => hint.id === wait.id || hint.id === join.id)
      .map(hint => ({ id: hint.id, active: hint.active, joinStatus: hint.joinStatus })),
    [
      { id: wait.id, active: false, joinStatus: "cancelled" },
      { id: join.id, active: false, joinStatus: "cancelled" },
    ],
  );

  const mutationSnapshot = {
    spans: telemetry.tracer.spans.length,
    metrics: telemetry.meter.records.length,
    logs: telemetry.logger.records.length,
    tree: telemetry.agentTree.getAgent(spawn.childAgentId),
    hints: getLocalObsAgentsRuntimeSnapshot().waitJoinHints,
  };
  const closingFailure = { ok: false, reason: "session_closing" };
  const racingResults = [
    integration.getContext(),
    integration.startSubagent({ spawnId: "spawn-too-late", env: {} }),
    integration.completeSubagent(spawn.spawnId, { childAgentId: spawn.childAgentId }),
    integration.failSubagent(spawn.spawnId, { childAgentId: spawn.childAgentId }),
    integration.startWait({ id: "wait-too-late" }),
    integration.endWait(wait.id, { joinStatus: "completed" }),
    integration.startJoin({ id: "join-too-late" }),
    integration.endJoin(join.id, { joinStatus: "completed" }),
  ];
  assert.deepEqual(racingResults, new Array(racingResults.length).fill(closingFailure));
  assert.deepEqual({
    spans: telemetry.tracer.spans.length,
    metrics: telemetry.meter.records.length,
    logs: telemetry.logger.records.length,
    tree: telemetry.agentTree.getAgent(spawn.childAgentId),
    hints: getLocalObsAgentsRuntimeSnapshot().waitJoinHints,
  }, mutationSnapshot);
  assert.equal(spawnSpan.endCalls, 1);
  assert.equal(waitSpan.endCalls, 1);
  assert.equal(joinSpan.endCalls, 1);

  flushRelease.resolve();
  await shutdown;
  assert.deepEqual(integration.getContext(), { ok: false, reason: "session_unavailable" });
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
  assert.deepEqual(firstSession.activeAgentLease.transitions, ["activate", "deactivate", "dispose"]);
  assert.deepEqual(secondSession.activeAgentLease.transitions, ["activate"]);
  assert.equal(sessions.filter(session => session.activeAgentLease.active).length, 1);
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
  assert.deepEqual(firstSession.activeAgentLease.transitions, ["activate", "deactivate", "dispose"]);
  assert.deepEqual(secondSession.activeAgentLease.transitions, ["activate"]);
  assert.equal(sessions.filter(session => session.activeAgentLease.active).length, 1);

  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});

  assert.deepEqual(secondSession.controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(secondSession.controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(secondSession.activeAgentLease.transitions, ["activate", "deactivate", "dispose"]);
  assert.equal(sessions.filter(session => session.activeAgentLease.active).length, 0);
});

test("rebound extension waits for timed-out flush cleanup before starting new providers", async () => {
  const ownership = createOtelOperationOwnership();
  const firstPi = createFakePi();
  const reboundPi = createFakePi();
  const sessions = [];
  const notifications = [];
  let resolveFlush;
  const flushSettlement = new Promise(resolve => {
    resolveFlush = resolve;
  });
  const startTelemetry = async ({ lineage }) => {
    const telemetry = createFakeTelemetry(lineage);
    sessions.push(telemetry);
    if (sessions.length === 1) {
      telemetry.controller.flush = async timeoutMs => {
        telemetry.controller.flushCalls.push(timeoutMs);
        return {
          operation: "flush",
          completed: false,
          timedOut: true,
          settlement: flushSettlement,
        };
      };
    }
    return telemetry;
  };
  const options = { loadConfig, otelOperationOwnership: ownership, startTelemetry };
  const ctx = {
    cwd: "/workspace/demo",
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  };

  registerHandlers(firstPi, options);
  await firstPi.handlers.get("session_start")({ sessionId: "session-cleanup-first" }, ctx);
  await firstPi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);

  registerHandlers(reboundPi, options);
  await reboundPi.handlers.get("session_start")({ sessionId: "session-cleanup-blocked", reason: "reload" }, ctx);

  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].controller.flushCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.deepEqual(sessions[0].controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.ok(notifications.some(notification => notification.message.includes("cleanup is still unresolved")));
  assert.deepEqual(sessions[0].activeAgentLease.transitions, ["activate", "deactivate", "dispose"]);

  resolveFlush({ operation: "flush", completed: true, timedOut: false });
  await flushSettlement;
  await Promise.resolve();
  await reboundPi.handlers.get("session_start")({ sessionId: "session-cleanup-retry", reason: "reload" }, ctx);

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[1].controller.flushCalls, []);
  assert.deepEqual(sessions[1].controller.shutdownCalls, []);
  assert.deepEqual(sessions[1].activeAgentLease.transitions, ["activate"]);
});

test("late shutdown rejection remains visible and retryable after extension re-registration", async () => {
  resetObsStatusRuntimeState();
  const ownership = createOtelOperationOwnership();
  const firstPi = createFakePi();
  const reboundPi = createFakePi();
  const sessions = [];
  const notifications = [];
  let rejectShutdown;
  const shutdownSettlement = new Promise((_resolve, reject) => {
    rejectShutdown = reject;
  });
  const startTelemetry = async ({ lineage }) => {
    const telemetry = createFakeTelemetry(lineage);
    sessions.push(telemetry);
    if (sessions.length === 1) {
      telemetry.controller.shutdown = async timeoutMs => {
        telemetry.controller.shutdownCalls.push(timeoutMs);
        if (telemetry.controller.shutdownCalls.length > 1) {
          return { operation: "shutdown", completed: true, timedOut: false };
        }
        return {
          operation: "shutdown",
          completed: false,
          timedOut: true,
          settlement: shutdownSettlement,
        };
      };
    }
    return telemetry;
  };
  const options = { loadConfig, otelOperationOwnership: ownership, startTelemetry };
  const ctx = {
    cwd: "/workspace/demo",
    ui: { notify: message => notifications.push(message) },
  };

  registerHandlers(firstPi, options);
  await firstPi.handlers.get("session_start")({ sessionId: "session-rejection-first" }, ctx);
  await firstPi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "resume" }, ctx);

  registerHandlers(reboundPi, options);
  await reboundPi.handlers.get("session_start")({ sessionId: "session-rejection-blocked", reason: "resume" }, ctx);
  assert.equal(sessions.length, 1);

  rejectShutdown(new Error("late exporter failure"));
  await assert.rejects(shutdownSettlement, /late exporter failure/u);
  await Promise.resolve();
  assert.match(getObsStatusRuntimeState().lastExportError, /shutdown failed: late exporter failure/u);

  await reboundPi.handlers.get("session_start")({ sessionId: "session-rejection-retry", reason: "resume" }, ctx);

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0].controller.shutdownCalls, [
    defaultObservMeConfig.shutdown.flushTimeoutMs,
    defaultObservMeConfig.shutdown.flushTimeoutMs,
  ]);
  assert.equal(notifications.filter(message => message.includes("cleanup is still unresolved")).length, 1);
});

test("never-settling cleanup blocks reload, new, resume, and fork extension registrations once", async () => {
  const ownership = createOtelOperationOwnership();
  const firstPi = createFakePi();
  const sessions = [];
  const notifications = [];
  const shutdownSettlement = new Promise(() => undefined);
  const startTelemetry = async ({ lineage }) => {
    const telemetry = createFakeTelemetry(lineage);
    sessions.push(telemetry);
    telemetry.controller.shutdown = async timeoutMs => {
      telemetry.controller.shutdownCalls.push(timeoutMs);
      return {
        operation: "shutdown",
        completed: false,
        timedOut: true,
        settlement: shutdownSettlement,
      };
    };
    return telemetry;
  };
  const options = { loadConfig, otelOperationOwnership: ownership, startTelemetry };
  const ctx = {
    cwd: "/workspace/demo",
    ui: { notify: message => notifications.push(message) },
  };

  registerHandlers(firstPi, options);
  await firstPi.handlers.get("session_start")({ sessionId: "session-never-first" }, ctx);
  await firstPi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);

  for (const reason of ["reload", "new", "resume", "fork"]) {
    const reboundPi = createFakePi();
    registerHandlers(reboundPi, options);
    await reboundPi.handlers.get("session_start")({ sessionId: `session-never-${reason}`, reason }, ctx);
  }

  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].controller.shutdownCalls, [defaultObservMeConfig.shutdown.flushTimeoutMs]);
  assert.equal(notifications.filter(message => message.includes("cleanup is still unresolved")).length, 1);
  assert.deepEqual(sessions[0].activeAgentLease.transitions, ["activate", "deactivate", "dispose"]);
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

  // Duplicate starts must clean up the prior controller before replacing public runtime state.
  await pi.handlers.get("session_start")({ sessionId: "session-final-first" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});

  const firstSession = sessions[0];

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
  await emitBashExecution(pi, { role: "bashExecution", command: "echo bash-secret", output: "bash-output-secret", exitCode: 0 });
  const subagent = startSubagentSpawn(telemetry, { spawnId: "spawn-flow", childAgentId: "agent-child-flow", command: "pi", args: ["--print"] });
  completeSubagentSpawn(telemetry, subagent.spawnId, { childAgentId: subagent.childAgentId, childStatus: "completed" });

  const activeSessionNotifications = [];
  await handleObsSessionCommand("session", createNotificationContext(activeSessionNotifications));
  assert.match(activeSessionNotifications[0].message, /Session: session-flow/u);
  assert.match(activeSessionNotifications[0].message, /Turns: 1/u);
  assert.match(activeSessionNotifications[0].message, /LLM calls: 1/u);
  assert.match(activeSessionNotifications[0].message, /Tool calls: 1/u);
  assert.match(activeSessionNotifications[0].message, /Cost: \$0\.04/u);
  const sessionTraceLink = /^Open trace: (.+)$/mu.exec(activeSessionNotifications[0].message)?.[1];

  const activeTraceNotifications = [];
  await handleObsTraceCommand("trace", createNotificationContext(activeTraceNotifications), { loadConfig: () => Promise.resolve(config) });
  assert.match(activeTraceNotifications[0].message, /Trace link \(current session\)/u);
  assert.match(activeTraceNotifications[0].message, /root pi\.session span; the root is exported after session_shutdown/u);
  const traceCommandLink = /^Open trace: (.+)$/mu.exec(activeTraceNotifications[0].message)?.[1];
  assert.ok(sessionTraceLink);
  assert.equal(sessionTraceLink, traceCommandLink);

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

test("turn image counts come from the correlated user prompt without stale carry-over", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-turn-images" }, { cwd: "/workspace/demo" });

  await pi.handlers.get("before_agent_start")({ prompt: "text only" }, {});
  await pi.handlers.get("agent_start")({ agentRunId: "agent-run-text" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 0 }, {});
  await pi.handlers.get("turn_end")({ turnIndex: 0 }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("turn_end")({ turnIndex: 1 }, {});
  await pi.handlers.get("agent_end")({ messages: [successfulAssistantMessage] }, {});

  await pi.handlers.get("before_agent_start")({ prompt: "two images", images: [{}, {}] }, {});
  await pi.handlers.get("agent_start")({ agentRunId: "agent-run-images" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 0 }, {});
  await pi.handlers.get("turn_end")({ turnIndex: 0 }, {});
  await pi.handlers.get("agent_end")({ messages: [successfulAssistantMessage] }, {});

  await pi.handlers.get("agent_start")({ agentRunId: "agent-run-without-source" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 0 }, {});

  const turnSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_TURN);
  assert.deepEqual(
    turnSpans.map(span => span.attributes[TURN_ATTRIBUTES.PI_TURN_USER_MESSAGE_IMAGE_COUNT]),
    [0, undefined, 2, undefined],
  );
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
    {
      toolCallId: "tool-2",
      toolName: "fetch",
      toolCategory: "network",
      success: false,
      errorClass: "TimeoutError",
      errorMessage: "raw timeout detail",
    },
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

  const successLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.TOOL_CALL_COMPLETED);
  const failureLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.TOOL_CALL_FAILED);
  const capturedErrorLog = telemetry.logger.records.find(
    record => record.attributes?.[LOG_ATTRIBUTES.EVENT_NAME] === LOG_EVENT_NAMES.TOOL_ERROR_CAPTURED,
  );
  assert.ok(successLog);
  assert.ok(failureLog);
  assert.equal(capturedErrorLog, undefined);
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.EVENT_NAME], LOG_EVENT_NAMES.TOOL_CALL_COMPLETED);
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.EVENT_CATEGORY], "lifecycle");
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.PI_SESSION_ID], "session-tools");
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.PI_WORKFLOW_ID], telemetry.lineage.workflowId);
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID], telemetry.lineage.workflowRootAgentId);
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.PI_AGENT_ID], telemetry.lineage.agentId);
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.PI_AGENT_PARENT_ID], telemetry.lineage.parentAgentId);
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.PI_AGENT_ROOT_ID], telemetry.lineage.rootAgentId);
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.PI_AGENT_RUN_ID], successSpan.attributes[COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID]);
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.PI_TURN_ID], successSpan.attributes[LOG_ATTRIBUTES.PI_TURN_ID]);
  assert.equal(successLog.attributes[TOOL_ATTRIBUTES.PI_TOOL_CALL_ID], "tool-1");
  assert.equal(successLog.attributes[TOOL_ATTRIBUTES.PI_TOOL_NAME], "read");
  assert.equal(successLog.attributes[TOOL_ATTRIBUTES.PI_TOOL_CATEGORY], "filesystem");
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.TRACE_ID], successSpan.spanContext().traceId);
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.SPAN_ID], successSpan.spanContext().spanId);
  assert.equal(successLog.attributes[TOOL_ATTRIBUTES.PI_TOOL_SUCCESS], true);
  assert.equal(successLog.attributes[LOG_ATTRIBUTES.ERROR_TYPE], undefined);

  assert.equal(failureLog.attributes[LOG_ATTRIBUTES.EVENT_NAME], LOG_EVENT_NAMES.TOOL_CALL_FAILED);
  assert.equal(failureLog.attributes[TOOL_ATTRIBUTES.PI_TOOL_CALL_ID], "tool-2");
  assert.equal(failureLog.attributes[TOOL_ATTRIBUTES.PI_TOOL_NAME], "fetch");
  assert.equal(failureLog.attributes[TOOL_ATTRIBUTES.PI_TOOL_CATEGORY], "network");
  assert.equal(failureLog.attributes[LOG_ATTRIBUTES.TRACE_ID], failureSpan.spanContext().traceId);
  assert.equal(failureLog.attributes[LOG_ATTRIBUTES.SPAN_ID], failureSpan.spanContext().spanId);
  assert.equal(failureLog.attributes[TOOL_ATTRIBUTES.PI_TOOL_SUCCESS], false);
  assert.equal(failureLog.attributes[TOOL_ATTRIBUTES.PI_TOOL_ERROR_CLASS], "TimeoutError");
  assert.equal(failureLog.attributes[LOG_ATTRIBUTES.ERROR_TYPE], "TimeoutError");

  const operationalToolLogs = JSON.stringify([successLog, failureLog]);
  assert.doesNotMatch(operationalToolLogs, /secret123|\/workspace\/demo\/README\.md|file contents|raw timeout detail/u);
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
    assert.equal(successLog.attributes[contentAttribute], undefined);
    assert.equal(failureLog.attributes[contentAttribute], undefined);
  }

  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_CALLS_TOTAL, 1);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_FAILURES_TOTAL, 1);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.TOOL_RESULT_SIZE_CHARS, 2);
  assertMetricValue(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.TOOL_RESULT_SIZE_CHARS, "file contents".length);
  assertMetricValue(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.TOOL_RESULT_SIZE_CHARS, "raw timeout detail".length);
  assertToolMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_CALLS_TOTAL);
  assertToolMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_FAILURES_TOTAL);
  assertToolMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.TOOL_RESULT_SIZE_CHARS);
});

test("later tool_call middleware mutations reconcile final input telemetry without crossing parallel ids", async () => {
  const config = structuredClone(defaultObservMeConfig);
  config.capture.toolArguments = true;
  const { runner, telemetry } = await createToolMiddlewareRuntimeHarness(config);
  const toolACall = {
    type: "tool_call",
    toolCallId: "tool-middleware-a",
    toolName: "read",
    input: { value: "before-a", password: "pre-middleware-secret" },
  };
  const toolBCall = {
    type: "tool_call",
    toolCallId: "tool-middleware-b",
    toolName: "write",
    input: { value: "after-b" },
  };

  await runner.emit({
    type: "tool_execution_start",
    toolCallId: toolACall.toolCallId,
    toolName: toolACall.toolName,
    args: toolACall.input,
  });
  await runner.emit({
    type: "tool_execution_start",
    toolCallId: toolBCall.toolCallId,
    toolName: toolBCall.toolName,
    args: toolBCall.input,
  });
  await runner.emitToolCall(toolACall);
  await runner.emitToolCall(toolBCall);
  assert.deepEqual(toolACall.input, { value: "after-a" });
  assert.deepEqual(toolBCall.input, { value: "after-b" });

  await runner.emitToolResult({
    type: "tool_result",
    toolCallId: toolBCall.toolCallId,
    toolName: toolBCall.toolName,
    input: toolBCall.input,
    content: [{ type: "text", text: "b-result" }],
    details: undefined,
    isError: false,
  });
  await runner.emitToolResult({
    type: "tool_result",
    toolCallId: toolACall.toolCallId,
    toolName: toolACall.toolName,
    input: toolACall.input,
    content: [{ type: "text", text: "a-result" }],
    details: undefined,
    isError: false,
  });
  await runner.emit({
    type: "tool_execution_end",
    toolCallId: toolACall.toolCallId,
    toolName: toolACall.toolName,
    result: { content: [{ type: "text", text: "a-result" }] },
    isError: false,
  });
  await runner.emit({
    type: "tool_execution_end",
    toolCallId: toolBCall.toolCallId,
    toolName: toolBCall.toolName,
    result: { content: [{ type: "text", text: "b-result" }] },
    isError: false,
  });

  const toolSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_TOOL_CALL);
  const toolA = toolSpans.find(span => span.attributes[TOOL_ATTRIBUTES.PI_TOOL_CALL_ID] === toolACall.toolCallId);
  const toolB = toolSpans.find(span => span.attributes[TOOL_ATTRIBUTES.PI_TOOL_CALL_ID] === toolBCall.toolCallId);
  const finalA = JSON.stringify(toolACall.input);
  const finalB = JSON.stringify(toolBCall.input);
  const hashSource = { env: process.env, envName: config.privacy.tenantSaltEnv };
  assert.ok(toolA);
  assert.ok(toolB);
  assert.equal(toolA.attributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_HASH], sha256(finalA, hashSource));
  assert.equal(toolB.attributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_HASH], sha256(finalB, hashSource));
  assert.equal(toolA.attributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_SIZE], finalA.length);
  assert.equal(toolB.attributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_SIZE], finalB.length);
  assert.equal(toolA.attributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_REDACTED], finalA);
  assert.equal(toolB.attributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_REDACTED], finalB);
  assert.equal(toolA.attributes[TOOL_ATTRIBUTES.GEN_AI_TOOL_CALL_ARGUMENTS], finalA);
  assert.equal(toolB.attributes[TOOL_ATTRIBUTES.GEN_AI_TOOL_CALL_ARGUMENTS], finalB);

  const startedLogs = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.TOOL_CALL_STARTED);
  const completionLogs = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.TOOL_CALL_COMPLETED);
  assert.equal(startedLogs.length, 2);
  assert.equal(completionLogs.length, 2);
  assert.deepEqual(
    completionLogs.map(record => record.attributes[TOOL_ATTRIBUTES.PI_TOOL_CALL_ID]).sort(),
    [toolACall.toolCallId, toolBCall.toolCallId],
  );
  assert.ok(completionLogs.every(record => record.attributes[LOG_ATTRIBUTES.TRACE_ID] === toolA.spanContext().traceId));
  assert.ok(completionLogs.every(record => record.attributes[LOG_ATTRIBUTES.SPAN_ID] === toolA.spanContext().spanId));
  assert.ok(startedLogs.every(record => record.attributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_HASH] === undefined));
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_CALLS_TOTAL, 2);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.REDACTION_FAILURES_TOTAL);
  assert.doesNotMatch(JSON.stringify({ toolSpans, logs: telemetry.logger.records }), /before-a|pre-middleware-secret/u);
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
  await pi.handlers.get("tool_execution_start")({ toolCallId: "tool-capture-error", toolName: "read", arguments: { path: ".env" } }, {});
  await pi.handlers.get("tool_execution_end")(
    {
      toolCallId: "tool-capture-error",
      toolName: "read",
      success: false,
      errorClass: "GuardMeDenied",
      result: "Protected by GuardMe: denyPaths **/.env -> Environment files may contain credentials. api_key=error-secret",
    },
    {},
  );

  const toolSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_TOOL_CALL);
  const toolSpan = toolSpans.find(span => span.attributes["pi.tool.call.id"] === "tool-capture");
  const failedToolSpan = toolSpans.find(span => span.attributes["pi.tool.call.id"] === "tool-capture-error");
  assert.match(toolSpan.attributes["pi.tool.arguments.redacted"], /\[REDACTED:/u);
  assert.match(toolSpan.attributes["pi.tool.result.redacted"], /\[REDACTED:/u);
  assert.equal(toolSpan.attributes["gen_ai.tool.call.arguments"], toolSpan.attributes["pi.tool.arguments.redacted"]);
  assert.equal(toolSpan.attributes["gen_ai.tool.call.result"], toolSpan.attributes["pi.tool.result.redacted"]);
  assert.doesNotMatch(toolSpan.attributes["pi.tool.arguments.redacted"], /secret123/u);
  assert.doesNotMatch(toolSpan.attributes["pi.tool.result.redacted"], /result-secret/u);

  const capturedErrorLogs = telemetry.logger.records.filter(
    record => record.attributes?.[LOG_ATTRIBUTES.EVENT_NAME] === LOG_EVENT_NAMES.TOOL_ERROR_CAPTURED,
  );
  assert.equal(capturedErrorLogs.length, 1);
  assert.equal(capturedErrorLogs[0].body, failedToolSpan.attributes["pi.tool.result.redacted"]);
  assert.match(capturedErrorLogs[0].body, /Protected by GuardMe/u);
  assert.doesNotMatch(capturedErrorLogs[0].body, /error-secret/u);
  assert.equal(capturedErrorLogs[0].severityText, "ERROR");
  assert.equal(capturedErrorLogs[0].attributes[LOG_ATTRIBUTES.EVENT_CATEGORY], "tool_content");
  assert.equal(capturedErrorLogs[0].attributes[TOOL_ATTRIBUTES.PI_TOOL_NAME], "read");
  assert.equal(capturedErrorLogs[0].attributes[LOG_ATTRIBUTES.ERROR_TYPE], "GuardMeDenied");
  assert.equal(capturedErrorLogs[0].attributes[LOG_ATTRIBUTES.TRACE_ID], failedToolSpan.spanContext().traceId);
  assert.equal(capturedErrorLogs[0].attributes[LOG_ATTRIBUTES.SPAN_ID], failedToolSpan.spanContext().spanId);
});

test("real Pi user_bash/session-record boundary completes ! and !! telemetry without blocking later extensions", async () => {
  const { participantCalls, runner, sessionManager, telemetry } = await createUserBashRuntimeHarness();
  const cases = [
    {
      event: { type: "user_bash", command: "printf normal", cwd: sessionManager.getCwd(), excludeFromContext: false },
      result: { output: "normal", exitCode: 0, cancelled: false, truncated: false },
    },
    {
      event: { type: "user_bash", command: "printf excluded", cwd: sessionManager.getCwd(), excludeFromContext: true },
      result: { output: "excluded", exitCode: 0, cancelled: false, truncated: false },
    },
    {
      event: { type: "user_bash", command: "false", cwd: sessionManager.getCwd(), excludeFromContext: false },
      result: { output: "failed", exitCode: 1, cancelled: false, truncated: false },
    },
    {
      event: { type: "user_bash", command: "sleep 10", cwd: sessionManager.getCwd(), excludeFromContext: false },
      result: { output: "", exitCode: undefined, cancelled: true, truncated: false },
    },
    {
      event: { type: "user_bash", command: "printf lots", cwd: sessionManager.getCwd(), excludeFromContext: false },
      result: { output: "partial", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/tmp/pi-output" },
    },
  ];

  for (const runtimeCase of cases) {
    const interception = await runner.emitUserBash(runtimeCase.event);
    assert.equal(interception, undefined);
    appendPiBashResult(sessionManager, runtimeCase.event, runtimeCase.result);
    await waitForObservedBashCompletion(telemetry);
  }

  const deferredEvent = {
    type: "user_bash",
    command: "printf deferred",
    cwd: sessionManager.getCwd(),
    excludeFromContext: false,
  };
  assert.equal(await runner.emitUserBash(deferredEvent), undefined);
  sessionManager.appendMessage({ role: "user", content: "streaming continued", timestamp: Date.now() });
  await delay(20);
  appendPiBashResult(
    sessionManager,
    deferredEvent,
    { output: "deferred", exitCode: 0, cancelled: false, truncated: false },
  );
  await waitForObservedBashCompletion(telemetry);

  const extensionEvent = {
    type: "user_bash",
    command: "extension-result",
    cwd: sessionManager.getCwd(),
    excludeFromContext: true,
  };
  const extensionInterception = await runner.emitUserBash(extensionEvent);
  assert.deepEqual(extensionInterception, {
    result: {
      output: "provided by extension",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    },
  });
  appendPiBashResult(sessionManager, extensionEvent, extensionInterception.result);
  await waitForObservedBashCompletion(telemetry);

  const bashSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION);
  const completionLogs = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.BASH_COMPLETED);
  const completionMetrics = telemetry.meter.records.filter(
    record => record.name === OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL,
  );
  const durationMetrics = telemetry.meter.records.filter(
    record => record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS,
  );

  assert.equal(participantCalls.length, 7);
  assert.equal(bashSpans.length, 7);
  assert.ok(bashSpans.every(span => span.ended));
  assert.ok(bashSpans.every(span => span.events.filter(event => event.name === LOG_EVENT_NAMES.BASH_COMPLETED).length === 1));
  assert.equal(completionMetrics.length, 7);
  assert.equal(completionLogs.length, 7);
  assert.equal(durationMetrics.length, 7);
  assert.equal(bashSpans[0].attributes["pi.bash.exclude_from_context"], false);
  assert.equal(bashSpans[1].attributes["pi.bash.exclude_from_context"], true);
  assert.equal(bashSpans[2].status.code, 2);
  assert.equal(bashSpans[3].status.message, "cancelled");
  assert.equal(bashSpans[4].attributes["pi.bash.truncated"], true);
  assert.equal(bashSpans[6].attributes["pi.bash.output.size"], "provided by extension".length);
  assert.equal(telemetry.pendingUserBash, undefined);

  await runner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(
    telemetry.logger.records.some(
      record => record.body === LOG_EVENT_NAMES.TELEMETRY_DROPPED && record.attributes?.reason === "bash_session_shutdown",
    ),
    false,
  );
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
  await emitBashExecution(pi, {
    role: "bashExecution",
    command: "echo ok",
    output: "hello",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    fullOutputPath: "/tmp/pi-bash-output.txt",
    excludeFromContext: true,
  });
  await emitBashExecution(pi, { role: "bashExecution", command: "false", output: "error", exitCode: 1, cancelled: false, truncated: true });

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

test("user_bash spans record elapsed execution time from the injected clock", async () => {
  const pi = createFakePi();
  let telemetry;
  let nowMs = 1_000;
  registerHandlers(pi, {
    loadConfig,
    now: () => nowMs,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-user-bash-pre" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ source: "user" }, {});
  await pi.handlers.get("turn_start")({ turnIndex: 1 }, {});
  await pi.handlers.get("user_bash")({ command: "echo ok", cwd: "/workspace/demo", excludeFromContext: false }, {});

  const pendingSpan = telemetry.tracer.spans.find(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION);
  assert.ok(pendingSpan);
  assert.equal(pendingSpan.ended, false);
  assert.ok(telemetry.pendingUserBash);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS);
  assertObservedOperation(telemetry.meter.records, "user_bash");

  nowMs += 250;
  await emitBashExecution(pi, { role: "bashExecution", command: "echo ok", output: "ok", exitCode: 0, cancelled: false, truncated: false });

  const bashSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION);
  const durationRecords = telemetry.meter.records.filter(record => record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS);
  assert.equal(bashSpans.length, 1);
  assert.equal(bashSpans[0], pendingSpan);
  assert.equal(bashSpans[0].ended, true);
  assert.equal(bashSpans[0].status.code, 1);
  assert.equal(bashSpans[0].attributes["pi.bash.exit_code"], 0);
  assert.equal(bashSpans[0].attributes["pi.bash.output.size"], "ok".length);
  assert.equal(durationRecords.length, 1);
  assert.equal(durationRecords[0].value, 250);
  assert.equal(telemetry.pendingUserBash, undefined);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL, 1);
});

test("correlated failed, cancelled, and truncated user bash completions retain outcomes and durations", async () => {
  const pi = createFakePi();
  let telemetry;
  let nowMs = 2_000;
  registerHandlers(pi, {
    loadConfig,
    now: () => nowMs,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-user-bash-outcomes" }, { cwd: "/workspace/demo" });

  await pi.handlers.get("user_bash")({ command: "false", cwd: "/workspace/demo", excludeFromContext: false }, {});
  nowMs += 40;
  await emitBashExecution(pi, { role: "bashExecution", command: "false", output: "failed", exitCode: 1, cancelled: false, truncated: false });

  await pi.handlers.get("user_bash")({ command: "sleep 10", cwd: "/workspace/demo", excludeFromContext: false }, {});
  nowMs += 60;
  await emitBashExecution(pi, { role: "bashExecution", command: "sleep 10", output: "", cancelled: true, truncated: false });

  await pi.handlers.get("user_bash")({ command: "printf lots", cwd: "/workspace/demo", excludeFromContext: true }, {});
  nowMs += 80;
  await emitBashExecution(pi, { role: "bashExecution", command: "printf lots", output: "partial", exitCode: 0, cancelled: false, truncated: true });

  const bashSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION);
  const durations = telemetry.meter.records
    .filter(record => record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS)
    .map(record => record.value);

  assert.deepEqual(durations, [40, 60, 80]);
  assert.equal(bashSpans[0].status.code, 2);
  assert.equal(bashSpans[0].status.message, "non_zero_exit");
  assert.equal(bashSpans[1].status.code, 2);
  assert.equal(bashSpans[1].status.message, "cancelled");
  assert.equal(bashSpans[2].status.code, 1);
  assert.equal(bashSpans[2].attributes["pi.bash.truncated"], true);
  assert.equal(telemetry.pendingUserBash, undefined);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_FAILURES_TOTAL, 2);
});

test("unmatched bash completions omit duration unless explicit event timestamps are valid", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-unmatched-bash" }, { cwd: "/workspace/demo" });
  await emitBashExecution(pi, { role: "bashExecution", command: "echo unmatched", output: "ok", exitCode: 0, timestamp: 5_000 });
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS);

  await emitBashExecution(pi, { role: "bashExecution", command: "echo timestamped", output: "ok", exitCode: 0, startedAtMs: 5_000, timestamp: 5_250 });
  await emitBashExecution(pi, { role: "bashExecution", command: "echo backwards", output: "ok", exitCode: 0, startedAtMs: 6_000, timestamp: 5_500 });

  const durations = telemetry.meter.records
    .filter(record => record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS)
    .map(record => record.value);
  assert.deepEqual(durations, [250]);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL, 3);
});

test("overlapping user_bash pre-events evict ambiguous state without retaining raw commands or miscorrelating completion", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-overlapping-bash" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("user_bash")({ command: "echo password=first-secret", cwd: "/workspace/demo", excludeFromContext: false }, {});
  const firstSpan = telemetry.pendingUserBash.span;
  assert.doesNotMatch(JSON.stringify(telemetry.pendingUserBash), /first-secret/u);

  await pi.handlers.get("user_bash")({ command: "echo token=second-secret", cwd: "/workspace/demo", excludeFromContext: false }, {});

  assert.equal(firstSpan.ended, true);
  assert.equal(firstSpan.status.code, 2);
  assert.equal(firstSpan.status.message, "bash_execution_incomplete");
  assert.equal(firstSpan.attributes[COMMON_SPAN_ATTRIBUTES.OBSERVME_EVICTED], true);
  assert.equal(telemetry.pendingUserBash, undefined);
  const dropLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.TELEMETRY_DROPPED && record.attributes?.reason === "bash_overlap_ambiguous");
  assert.equal(dropLog?.attributes?.operation, "bash_execution");

  await emitBashExecution(pi, { role: "bashExecution", command: "echo password=first-secret", output: "ok", exitCode: 0 });

  const bashSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION);
  assert.equal(bashSpans.length, 2);
  assert.equal(bashSpans[1].ended, true);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.BASH_DURATION_MS);
  assert.doesNotMatch(JSON.stringify({ spans: bashSpans, logs: telemetry.logger.records }), /first-secret|second-secret/u);
});

test("session shutdown closes an incomplete pending user bash span and clears bounded state", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-pending-bash-shutdown" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("user_bash")({ command: "sleep 10", cwd: "/workspace/demo", excludeFromContext: false }, {});
  const pendingSpan = telemetry.pendingUserBash.span;

  await pi.handlers.get("session_shutdown")({ status: "ok" }, {});

  assert.equal(pendingSpan.ended, true);
  assert.equal(pendingSpan.status.code, 2);
  assert.equal(pendingSpan.status.message, "bash_execution_incomplete");
  assert.equal(pendingSpan.attributes[COMMON_SPAN_ATTRIBUTES.OBSERVME_EVICTED], false);
  assert.equal(telemetry.pendingUserBash, undefined);
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.TELEMETRY_DROPPED && record.attributes?.reason === "bash_session_shutdown"));
  assertActiveSpanValues(telemetry.meter.records, "bash_execution", [1, -1]);
});

test("tool-driven bash remains a tool span and is not counted as user bash", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-tool-user-bash" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("tool_execution_start")({ toolCallId: "bash-tool", toolName: "bash", args: { command: "pwd" } }, {});
  await pi.handlers.get("tool_execution_end")({ toolCallId: "bash-tool", toolName: "bash", success: true, result: "ok" }, {});

  assert.equal(telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_TOOL_CALL).length, 1);
  assert.equal(telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_BASH_EXECUTION).length, 0);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TOOL_CALLS_TOTAL, 1);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.BASH_EXECUTIONS_TOTAL);
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
    {
      type: "model_select",
      model: {
        id: "gpt-4o",
        name: "GPT-4o",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://example.invalid/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      previousModel: undefined,
      source: "set",
    },
    {},
  );
  await pi.handlers.get("thinking_level_select")({
    type: "thinking_level_select",
    level: "high",
    previousLevel: "low",
  }, {});

  const modelLogs = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.MODEL_CHANGED);
  const thinkingLogs = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.THINKING_CHANGED);

  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.MODEL_CHANGES_TOTAL, 1);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.THINKING_LEVEL_CHANGES_TOTAL, 1);
  assertModelChangeMetricLabelsAreLowCardinality(telemetry.meter.records);
  assertMetricIncrementedWithoutIds(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.THINKING_LEVEL_CHANGES_TOTAL);
  assert.equal(modelLogs.length, 1);
  assert.equal(modelLogs[0].attributes["event.category"], "model");
  assert.equal(modelLogs[0].attributes["pi.model.provider.current"], "openai");
  assert.equal(modelLogs[0].attributes["pi.model.id.current"], "gpt-4o");
  assert.equal(thinkingLogs.length, 1);
  assert.equal(thinkingLogs[0].attributes["event.category"], "thinking");
  assert.equal(thinkingLogs[0].attributes["pi.thinking.level.current"], "high");
  assert.equal(telemetry.tracer.spans[0].attributes["pi.model.provider.current"], "openai");
  assert.equal(telemetry.tracer.spans[0].attributes["pi.model.id.current"], "gpt-4o");
  assert.equal(telemetry.tracer.spans[0].attributes["pi.thinking.level.current"], "high");
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
  assert.equal(compactionLog.attributes[LOG_ATTRIBUTES.TRACE_ID], compactionSpan.spanContext().traceId);
  assert.equal(compactionLog.attributes[LOG_ATTRIBUTES.SPAN_ID], compactionSpan.spanContext().spanId);
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
  assert.equal(branchLog.attributes[LOG_ATTRIBUTES.TRACE_ID], branchSpan.spanContext().traceId);
  assert.equal(branchLog.attributes[LOG_ATTRIBUTES.SPAN_ID], branchSpan.spanContext().spanId);
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

test("failed agent runs increment the bounded error metric once while successful runs do not", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-agent-run-errors" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ type: "agent_start" }, {});
  await pi.handlers.get("agent_end")({ type: "agent_end", messages: [failedAssistantMessage] }, {});
  await pi.handlers.get("agent_end")({ type: "agent_end", messages: [failedAssistantMessage] }, {});
  await pi.handlers.get("agent_start")({ type: "agent_start" }, {});
  await pi.handlers.get("agent_end")({ type: "agent_end", messages: [successfulAssistantMessage] }, {});

  const errorRecords = telemetry.meter.records.filter(
    record => record.name === OBSERVME_COUNTER_METRIC_NAMES.AGENT_RUN_ERRORS_TOTAL,
  );
  assert.equal(errorRecords.length, 1);
  assert.equal(errorRecords[0].value, 1);
  assert.deepEqual(Object.keys(errorRecords[0].attributes).sort(), ["agent_role", "environment"]);

  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
});

test("zero-based Pi turns and legacy missing-index turns complete with stable correlation", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  const agentRunId = "agent-run-zero-based";
  const firstTurnId = `${agentRunId}-turn-000000`;
  const laterTurnId = `${agentRunId}-turn-000001`;
  const fallbackTurnId = `${agentRunId}-turn-000002`;

  await pi.handlers.get("session_start")({ sessionId: "session-zero-based-turns" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ type: "agent_start", agentRunId, source: "user" }, {});
  await pi.handlers.get("turn_start")({ type: "turn_start", turnIndex: 0 }, {});
  await pi.handlers.get("turn_start")({ type: "turn_start", turnIndex: 1 }, {});

  const turnSpans = telemetry.tracer.spans.filter(span => span.name === SPAN_NAMES.PI_TURN);
  const firstTurnSpan = turnSpans.find(span => span.attributes["pi.turn.id"] === firstTurnId);
  const laterTurnSpan = turnSpans.find(span => span.attributes["pi.turn.id"] === laterTurnId);
  assert.ok(firstTurnSpan);
  assert.ok(laterTurnSpan);
  assert.equal(telemetry.currentTurnId, laterTurnId);

  await pi.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0 }, {});

  assert.equal(firstTurnSpan.ended, true);
  assert.equal(laterTurnSpan.ended, false);
  assert.equal(telemetry.spans.activeTurns.has(firstTurnId), false);
  assert.equal(telemetry.spans.activeTurns.has(laterTurnId), true);
  assert.equal(telemetry.currentTurnId, laterTurnId);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TURNS_COMPLETED_TOTAL, 1);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.TURN_DURATION_MS, 1);

  await pi.handlers.get("turn_end")({ type: "turn_end", turnIndex: 1 }, {});
  await pi.handlers.get("turn_start")({ type: "turn_start" }, {});
  await pi.handlers.get("turn_end")({ type: "turn_end" }, {});

  const fallbackTurnSpan = telemetry.tracer.spans.find(
    span => span.name === SPAN_NAMES.PI_TURN && span.attributes["pi.turn.id"] === fallbackTurnId,
  );
  const completionLogs = telemetry.logger.records.filter(record => record.body === LOG_EVENT_NAMES.TURN_UNKNOWN);
  assert.ok(fallbackTurnSpan);
  assert.equal(laterTurnSpan.ended, true);
  assert.equal(fallbackTurnSpan.ended, true);
  assert.equal(telemetry.currentTurnId, undefined);
  assert.equal(telemetry.spans.activeTurns.size, 0);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TURNS_COMPLETED_TOTAL, 3);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.TURN_DURATION_MS, 3);
  assert.deepEqual(completionLogs.map(record => record.attributes?.["pi.turn.id"]), [firstTurnId, laterTurnId, fallbackTurnId]);
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

test("turn sequences stay bounded and clean up on normal and out-of-order agent completion", async () => {
  const pi = createFakePi();
  const config = structuredClone(defaultObservMeConfig);
  config.limits.maxActiveAgentRuns = 2;
  config.limits.maxActiveTurns = 2;
  let telemetry;

  registerHandlers(pi, {
    loadConfig: () => Promise.resolve(config),
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      telemetry.config = config;
      telemetry.spans = createSpanRegistry(config, telemetry.metrics, () => telemetry);
      telemetry.turnSequences = createTurnSequenceRegistry(config, telemetry.metrics, () => telemetry);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-bounded-turn-sequences" }, { cwd: "/workspace/demo" });
  for (let index = 1; index <= 2; index += 1) {
    const agentRunId = `agent-run-stress-${index}`;
    await pi.handlers.get("agent_start")({ agentRunId, source: "user" }, {});
    await pi.handlers.get("turn_start")({ agentRunId }, {});
  }

  await pi.handlers.get("agent_start")({ agentRunId: "agent-run-stress-3", source: "user" }, {});
  assert.equal(telemetry.turnSequences.size, 1);
  assert.equal(telemetry.turnSequences.get("agent-run-stress-1"), undefined);
  assertMetricRecordCountByReason(
    telemetry.meter.records,
    OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL,
    "turn_sequence_full",
    1,
  );
  await pi.handlers.get("turn_start")({ agentRunId: "agent-run-stress-3" }, {});

  for (let index = 4; index <= 10; index += 1) {
    const agentRunId = `agent-run-stress-${index}`;
    await pi.handlers.get("agent_start")({ agentRunId, source: "user" }, {});
    await pi.handlers.get("turn_start")({ agentRunId }, {});
  }

  const sequenceDrops = telemetry.meter.records.filter(
    record => record.name === OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL && record.attributes.reason === "turn_sequence_full",
  );

  assert.equal(telemetry.spans.activeAgentRuns.size, config.limits.maxActiveAgentRuns);
  assert.equal(telemetry.spans.activeTurns.size, config.limits.maxActiveTurns);
  assert.equal(telemetry.turnSequences.size, config.limits.maxActiveAgentRuns);
  assert.equal(sequenceDrops.length, 8);
  assert.equal(sequenceDrops.every(record => Object.keys(record.attributes).join(",") === "reason"), true);

  await pi.handlers.get("agent_end")({ agentRunId: "agent-run-stress-9", status: "ok" }, {});
  assert.equal(telemetry.turnSequences.size, 1);
  assert.equal(telemetry.turnSequences.get("agent-run-stress-9"), undefined);

  await pi.handlers.get("agent_end")({ agentRunId: "agent-run-stress-1", status: "ok" }, {});
  assert.equal(telemetry.turnSequences.size, 1);
  assertMetricRecordCountByReason(
    telemetry.meter.records,
    OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL,
    "turn_sequence_full",
    8,
  );

  await pi.handlers.get("agent_end")({ agentRunId: "agent-run-stress-10", status: "ok" }, {});
  assert.equal(telemetry.turnSequences.size, 0);
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

test("turn end without a resolvable index drops without cross-correlating another run", async () => {
  const pi = createFakePi();
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  const activeAgentRunId = "agent-run-active-turn";
  const activeTurnId = `${activeAgentRunId}-turn-000001`;
  await pi.handlers.get("session_start")({ sessionId: "session-missing-turn-index" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ agentRunId: activeAgentRunId, source: "user" }, {});
  await pi.handlers.get("turn_start")({ agentRunId: activeAgentRunId }, {});
  await pi.handlers.get("agent_start")({ agentRunId: "agent-run-missing-turn", source: "user" }, {});
  await pi.handlers.get("turn_end")({ agentRunId: "agent-run-missing-turn" }, {});

  const activeTurnSpan = telemetry.tracer.spans.find(
    span => span.name === SPAN_NAMES.PI_TURN && span.attributes["pi.turn.id"] === activeTurnId,
  );
  const dropLog = telemetry.logger.records.find(record => record.body === LOG_EVENT_NAMES.TELEMETRY_DROPPED);

  assert.ok(activeTurnSpan);
  assert.equal(activeTurnSpan.ended, false);
  assert.equal(telemetry.spans.activeTurns.has(activeTurnId), true);
  assert.equal(dropLog?.attributes?.operation, "turn_end");
  assert.equal(dropLog?.attributes?.reason, "turn_index_missing");
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TELEMETRY_DROPPED_TOTAL, 1);
  assertNoMetricRecord(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TURNS_COMPLETED_TOTAL);
  assert.equal(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.TURN_COMPLETED), false);
  assertActiveSpanValues(telemetry.meter.records, "turn", [1]);

  await pi.handlers.get("turn_end")({ agentRunId: activeAgentRunId, turnIndex: 1 }, {});
  assert.equal(activeTurnSpan.ended, true);
  assertMetricRecordCount(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TURNS_COMPLETED_TOTAL, 1);
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
  await emitBashExecution(pi, { role: "bashExecution", command: "npm test", exitCode: 0, output: "ok" });
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
  await emitBashExecution(pi, { role: "bashExecution", command: "npm test", exitCode: 0, output: "ok" });
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

function assertMetricRecordCountByReason(records, metricName, reason, count) {
  const matchingRecords = records.filter(candidate => candidate.name === metricName && candidate.attributes.reason === reason);
  assert.equal(matchingRecords.length, count, `${metricName} should record ${count} ${reason} increments`);
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
  let nowMs = 2_000;
  let telemetry;
  registerHandlers(pi, {
    loadConfig,
    now: () => nowMs,
    startTelemetry: async ({ lineage }) => {
      telemetry = createFakeTelemetry(lineage);
      return telemetry;
    },
  });

  await pi.handlers.get("session_start")({ sessionId: "session-3" }, { cwd: "/workspace/demo" });
  await pi.handlers.get("agent_start")({ type: "agent_start" }, {});
  await pi.handlers.get("agent_end")({ type: "agent_end", messages: [failedAssistantMessage] }, {});
  nowMs = 2_325;
  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});

  assert.equal(telemetry.tracer.spans[0].ended, true);
  assert.equal(telemetry.tracer.spans[0].status.code, 2);
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.WORKFLOW_FAILED));
  assert.ok(
    telemetry.meter.records.some(
      record => record.name === OBSERVME_COUNTER_METRIC_NAMES.WORKFLOW_ERRORS_TOTAL && record.value === 1,
    ),
  );
  assert.ok(
    telemetry.meter.records.some(
      record =>
        record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.WORKFLOW_DURATION_MS &&
        record.value === 325 &&
        record.attributes.status === "error",
    ),
  );
});
