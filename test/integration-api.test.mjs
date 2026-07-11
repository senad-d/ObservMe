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
  return {
    createCounter: () => ({ add() {} }),
    createUpDownCounter: () => ({ add() {} }),
    createHistogram: () => ({ record() {} }),
  };
}

function createFakeTracer() {
  return {
    startSpan(name, options = {}, parentContext) {
      return createFakeSpan(name, options.attributes ?? {}, parentContext ? trace.getSpan(parentContext) : undefined);
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
    setStatus() {},
    spanContext() {
      return validSpanContext;
    },
    end() {},
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

  assert.deepEqual(api.completeSubagent(started.spawnId, { childStatus: "active" }), { ok: true });

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
      childStatus: "completed",
      joinStatus: "completed",
      reason: "dependency",
      failurePropagated: false,
    }),
    { ok: true },
  );
});
