import assert from "node:assert/strict";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { requestObservMeIntegration } from "../src/integration.ts";
import { createAgentTreeTracker, createObservMeMetrics, createSpanRegistry } from "../src/pi/handlers.ts";
import { registerObservMeIntegration } from "../src/pi/integration-api.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";

process.env.OBSERVME_HASH_SALT = "integration-api-test-salt";

const validSpanContext = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: 1,
};

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
    createObservableGauge: () => ({ addCallback() {}, removeCallback() {} }),
  };
}

function createFakeTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name, options = {}, parentContext) {
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

function createFakeTelemetry() {
  const config = structuredClone(defaultObservMeConfig);
  const lineage = {
    workflowId: "workflow-integration",
    workflowRootAgentId: "agent-root",
    agentId: "agent-parent",
    rootAgentId: "agent-root",
    depth: 0,
    role: "root",
    orphaned: false,
  };
  const tracer = createFakeTracer();
  const meter = createFakeMeter();
  const metrics = createObservMeMetrics(meter);

  return {
    config,
    lineage,
    tracer,
    meter,
    logger: { emit() {} },
    metrics,
    spans: createSpanRegistry(config, metrics),
    agentTree: createAgentTreeTracker(config, lineage, metrics),
    sessionSpan: tracer.startSpan(SPAN_NAMES.PI_SESSION),
    sessionAttributes: { "pi.session.id": "session-integration" },
    activeAgentRecorded: false,
    agentRunSequence: 0,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences: new Map(),
  };
}

test("integration API is discovered through Pi events and reports inactive sessions safely", () => {
  const events = createEventBus();
  const state = {};
  const unsubscribe = registerObservMeIntegration({ events }, state);
  const api = requestObservMeIntegration({ events });

  assert.ok(unsubscribe);
  assert.ok(api);
  assert.deepEqual(api.getContext(), { ok: false, reason: "session_unavailable" });

  unsubscribe();
  assert.equal(requestObservMeIntegration({ events }), undefined);
});

test("integration discovery ignores malformed providers and event-bus failures", () => {
  const events = createEventBus();
  events.on("observme:integration:request", request => request.respond({ version: 1 }));

  assert.equal(requestObservMeIntegration({ events }), undefined);
  const unsubscribe = registerObservMeIntegration({ events }, {});
  assert.ok(requestObservMeIntegration({ events }));
  unsubscribe();

  assert.equal(requestObservMeIntegration({}), undefined);
  assert.equal(
    requestObservMeIntegration(Object.defineProperty({}, "events", { get() { throw new Error("events unavailable"); } })),
    undefined,
  );
  assert.equal(
    registerObservMeIntegration({ events: { on() { throw new Error("registration unavailable"); } } }, {}),
    undefined,
  );
  assert.equal(
    requestObservMeIntegration({
      events: {
        emit() {
          throw new Error("event bus unavailable");
        },
      },
    }),
    undefined,
  );
});

test("integration API rejects unsafe requests and duplicate active lifecycle identifiers", () => {
  const events = createEventBus();
  const session = createFakeTelemetry();
  registerObservMeIntegration({ events }, { session });
  const api = requestObservMeIntegration({ events });

  assert.ok(api);
  assert.deepEqual(api.startSubagent(null), { ok: false, reason: "invalid_request" });
  assert.deepEqual(api.startSubagent({ spawnId: "unsafe spawn id" }), { ok: false, reason: "invalid_request" });

  const started = api.startSubagent({ spawnId: "spawn-duplicate", env: {} });
  assert.equal(started.ok, true);
  const activeSpawn = session.spans.activeSubagentSpawns.get("spawn-duplicate");
  assert.deepEqual(api.startSubagent({ spawnId: "spawn-duplicate", env: {} }), {
    ok: false,
    reason: "spawn_already_exists",
  });
  assert.equal(session.spans.activeSubagentSpawns.size, 1);
  assert.equal(session.spans.activeSubagentSpawns.get("spawn-duplicate"), activeSpawn);
  assert.deepEqual(api.completeSubagent("", {}), { ok: false, reason: "invalid_request" });
  assert.deepEqual(api.completeSubagent(started.spawnId, { childStatus: "starting" }), {
    ok: false,
    reason: "invalid_request",
  });
  assert.deepEqual(api.completeSubagent(started.spawnId, { childStatus: "active" }), {
    ok: false,
    reason: "invalid_request",
  });
  assert.deepEqual(api.completeSubagent(started.spawnId, { childAgentId: "different-child", childStatus: "completed" }), {
    ok: false,
    reason: "child_agent_mismatch",
  });
  assert.deepEqual(api.completeSubagent(started.spawnId, { childStatus: "failed", outcome: "completed" }), {
    ok: false,
    reason: "invalid_terminal_transition",
  });
  assert.equal(session.spans.activeSubagentSpawns.get(started.spawnId), activeSpawn);
  assert.equal(session.agentTree.getAgent(started.childAgentId).status, "starting");
  assert.deepEqual(api.completeSubagent(started.spawnId, { childStatus: "completed", outcome: "completed" }), { ok: true });
  assert.deepEqual(api.completeSubagent(started.spawnId, { childStatus: "completed" }), {
    ok: false,
    reason: "spawn_not_found",
  });

  const launcherFailure = api.startSubagent({ spawnId: "spawn-launcher-failure", env: {} });
  assert.equal(launcherFailure.ok, true);
  assert.deepEqual(api.failSubagent(launcherFailure.spawnId, { childAgentId: "different-child" }), {
    ok: false,
    reason: "child_agent_mismatch",
  });
  assert.equal(session.agentTree.getAgent(launcherFailure.childAgentId).status, "starting");
  assert.deepEqual(api.failSubagent(launcherFailure.spawnId, { childAgentId: launcherFailure.childAgentId }), { ok: true });

  assert.deepEqual(api.startWait({ durationMs: Number.POSITIVE_INFINITY }), {
    ok: false,
    reason: "invalid_request",
  });
  const wait = api.startWait({ id: "wait-duplicate", childStatus: "active" });
  assert.equal(wait.ok, true);
  const activeWait = session.spans.activeAgentWaits.get("wait-duplicate");
  assert.deepEqual(api.startWait({ id: "wait-duplicate", childStatus: "active" }), {
    ok: false,
    reason: "wait_already_exists",
  });
  assert.equal(session.spans.activeAgentWaits.size, 1);
  assert.equal(session.spans.activeAgentWaits.get("wait-duplicate"), activeWait);
  assert.deepEqual(api.endWait(wait.id, { childStatus: "completed" }), { ok: true });

  const join = api.startJoin({ spawnId: "spawn-duplicate", joinStatus: "waiting" });
  assert.equal(join.ok, true);
  const activeJoin = session.spans.activeAgentJoins.get(join.id);
  assert.deepEqual(api.startJoin({ spawnId: "spawn-duplicate", joinStatus: "waiting" }), {
    ok: false,
    reason: "join_already_exists",
  });
  assert.equal(session.spans.activeAgentJoins.size, 1);
  assert.equal(session.spans.activeAgentJoins.get(join.id), activeJoin);
  assert.deepEqual(api.endJoin(join.id, { joinStatus: "completed" }), { ok: true });
});

test("integration API rejects active and retained child placeholder collisions before mutation", () => {
  const events = createEventBus();
  const session = createFakeTelemetry();
  registerObservMeIntegration({ events }, { session });
  const api = requestObservMeIntegration({ events });

  assert.ok(api);
  const started = api.startSubagent({
    spawnId: "spawn-collision-source",
    childAgentId: "child-spawn-generated-collision",
    env: {},
  });
  assert.equal(started.ok, true);

  const activeSpawn = session.spans.activeSubagentSpawns.get(started.spawnId);
  const activeChild = session.agentTree.getAgent(started.childAgentId);
  const activeSpanCount = session.tracer.spans.length;
  const activeMetricCount = session.meter.records.length;
  assert.deepEqual(api.startSubagent({ spawnId: "spawn-generated-collision", env: {} }), {
    ok: false,
    reason: "child_agent_already_exists",
  });
  assert.equal(session.spans.activeSubagentSpawns.size, 1);
  assert.equal(session.spans.activeSubagentSpawns.get(started.spawnId), activeSpawn);
  assert.deepEqual(session.agentTree.getAgent(started.childAgentId), activeChild);
  assert.equal(session.tracer.spans.length, activeSpanCount);
  assert.equal(session.meter.records.length, activeMetricCount);

  assert.deepEqual(api.completeSubagent(started.spawnId, { childAgentId: started.childAgentId }), { ok: true });
  const terminalChild = session.agentTree.getAgent(started.childAgentId);
  const terminalSpanCount = session.tracer.spans.length;
  const terminalMetricCount = session.meter.records.length;
  assert.equal(terminalChild.status, "completed");
  assert.deepEqual(
    api.startSubagent({
      spawnId: "spawn-terminal-reuse",
      childAgentId: started.childAgentId,
      env: {},
    }),
    { ok: false, reason: "child_agent_already_exists" },
  );
  assert.equal(session.spans.activeSubagentSpawns.size, 0);
  assert.deepEqual(session.agentTree.getAgent(started.childAgentId), terminalChild);
  assert.equal(session.tracer.spans.length, terminalSpanCount);
  assert.equal(session.meter.records.length, terminalMetricCount);

  const unique = api.startSubagent({
    spawnId: "spawn-unique-child",
    childAgentId: "child-unique",
    env: {},
  });
  assert.equal(unique.ok, true);
  assert.deepEqual(api.completeSubagent(unique.spawnId, { childAgentId: unique.childAgentId }), { ok: true });
});

test("integration API propagates child context and records spawn, wait, and join lifecycle", () => {
  const events = createEventBus();
  const state = { session: createFakeTelemetry() };
  registerObservMeIntegration({ events }, state);
  const api = requestObservMeIntegration({ events });

  assert.ok(api);
  const context = api.getContext();
  assert.equal(context.ok, true);
  assert.equal(context.context.workflowId, "workflow-integration");
  assert.equal(context.context.sessionId, "session-integration");
  assert.equal(context.context.traceId, validSpanContext.traceId);

  const started = api.startSubagent({
    spawnId: "spawn-integration",
    command: "pi",
    spawnType: "extension",
    spawnReason: "delegated_task",
    env: { PATH: process.env.PATH },
  });
  assert.equal(started.ok, true);
  assert.equal(started.env.OBSERVME_WORKFLOW_ID, "workflow-integration");
  assert.equal(started.env.OBSERVME_PARENT_AGENT_ID, "agent-parent");
  assert.equal(started.env.OBSERVME_ROOT_AGENT_ID, "agent-root");
  assert.equal(started.env.OBSERVME_SPAWN_ID, "spawn-integration");
  assert.equal(started.env.traceparent, `00-${validSpanContext.traceId}-${validSpanContext.spanId}-01`);

  assert.deepEqual(api.completeSubagent(started.spawnId, { childStatus: "active" }), {
    ok: false,
    reason: "invalid_request",
  });

  const wait = api.startWait({
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "active",
    reason: "child_running",
  });
  assert.equal(wait.ok, true);
  assert.deepEqual(
    api.endWait(wait.id, {
      spawnId: started.spawnId,
      childAgentId: started.childAgentId,
      childStatus: "completed",
      joinStatus: "completed",
      reason: "child_running",
    }),
    { ok: true },
  );
  assert.deepEqual(
    api.completeSubagent(started.spawnId, {
      childAgentId: started.childAgentId,
      childStatus: "completed",
      outcome: "completed",
    }),
    { ok: true },
  );

  const join = api.startJoin({
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "completed",
    joinStatus: "completed",
    reason: "dependency",
  });
  assert.equal(join.ok, true);
  assert.deepEqual(
    api.endJoin(join.id, {
      spawnId: started.spawnId,
      childAgentId: started.childAgentId,
      childStatus: "failed",
      joinStatus: "failed",
      reason: "dependency",
      failurePropagated: true,
    }),
    { ok: false, reason: "invalid_terminal_transition" },
  );
  assert.equal(state.session.spans.activeAgentJoins.has(join.id), true);
  assert.equal(state.session.agentTree.getAgent(started.childAgentId).status, "completed");
  assert.deepEqual(
    api.endJoin(join.id, {
      spawnId: started.spawnId,
      childAgentId: started.childAgentId,
      childStatus: "completed",
      joinStatus: "completed",
      reason: "dependency",
      failurePropagated: false,
    }),
    { ok: true },
  );
});
