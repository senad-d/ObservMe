import assert from "node:assert/strict";
import test from "node:test";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { clearObsAgentsRuntimeState, getLocalObsAgentsRuntimeSnapshot } from "../src/commands/obs-agents-runtime.ts";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { createObservMeMetrics, createSpanRegistry, createAgentTreeTracker } from "../src/pi/handlers.ts";
import { createAgentLineageContext } from "../src/pi/agent-lineage.ts";
import {
  completeSubagentSpawn,
  endAgentJoin,
  endAgentWait,
  failSubagentSpawn,
  observeTrustedSubagentLineage,
  recordAgentJoin,
  recordAgentWait,
  runSubagentWithObservability,
  startAgentJoin,
  startAgentWait,
  startSubagentSpawn,
} from "../src/pi/subagent-spawn.ts";
import {
  LOG_EVENT_NAMES,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
} from "../src/semconv/metrics.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";
import { AGENT_WAIT_REASON_VALUES, SUBAGENT_SPAWN_REASON_VALUES } from "../src/semconv/values.ts";

process.env.OBSERVME_HASH_SALT = "subagent-spawn-test-salt";

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

function makeLineage(overrides = {}) {
  return {
    workflowId: "workflow-1",
    workflowRootAgentId: "agent-root",
    agentId: "agent-parent",
    rootAgentId: "agent-root",
    depth: 0,
    role: "root",
    orphaned: false,
    ...overrides,
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
    createObservableGauge: () => ({
      addCallback() {},
      removeCallback() {},
    }),
  };
}

function createFakeTracer(spanContext = validSpanContext) {
  const spans = [];
  return {
    spans,
    startSpan: (name, options = {}, parentContext) => {
      const span = createFakeSpan(name, options.attributes ?? {}, parentContext ? trace.getSpan(parentContext) : undefined, spanContext);
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
      return spanContext;
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

function createFakeTelemetry(options = {}) {
  const config = options.config ?? structuredClone(defaultObservMeConfig);
  const lineage = options.lineage ?? makeLineage();
  const meter = createFakeMeter();
  const tracer = createFakeTracer(options.spanContext ?? validSpanContext);
  const logger = createFakeLogger();
  const metrics = createObservMeMetrics(meter);
  const sessionSpan = tracer.startSpan(SPAN_NAMES.PI_SESSION, { attributes: { "pi.session.id": "session-1" } });

  return {
    config,
    lineage,
    tracer,
    meter,
    logger,
    metrics,
    spans: createSpanRegistry(config, metrics),
    agentTree: createAgentTreeTracker(config, lineage, metrics),
    sessionSpan,
    sessionAttributes: { "pi.session.id": "session-1" },
    activeAgentRecorded: false,
    agentRunSequence: 0,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences: new Map(),
  };
}

test("subagent spawn propagates W3C trace context and ObservMe lineage without exporting raw command or env values", () => {
  const telemetry = createFakeTelemetry();
  const started = startSubagentSpawn(telemetry, {
    spawnId: "spawn-1",
    command: "pi --prompt super-secret",
    args: ["--unsafe-arg"],
    spawnType: "command",
    spawnReason: "delegated_task",
    env: { PATH: "/usr/bin", SECRET_TOKEN: "top-secret-token" },
  });

  const childLineage = createAgentLineageContext({
    config: telemetry.config,
    env: started.env,
    trustedParentContext: true,
    generateId: () => "child-generated",
  });

  assert.equal(started.traceContextPropagated, true);
  assert.equal(started.env.traceparent, "00-11111111111111111111111111111111-2222222222222222-01");
  assert.equal(started.env.OBSERVME_WORKFLOW_ID, "workflow-1");
  assert.equal(started.env.OBSERVME_PARENT_AGENT_ID, "agent-parent");
  assert.equal(started.env.OBSERVME_ROOT_AGENT_ID, "agent-root");
  assert.equal(started.env.OBSERVME_PARENT_SESSION_ID, "session-1");
  assert.equal(started.env.OBSERVME_AGENT_DEPTH, "0");
  assert.equal(started.env.OBSERVME_SPAWN_ID, "spawn-1");
  assert.equal(childLineage.workflowId, "workflow-1");
  assert.equal(childLineage.parentAgentId, "agent-parent");
  assert.equal(childLineage.rootAgentId, "agent-root");
  assert.equal(childLineage.depth, 1);
  assert.equal(started.span.name, SPAN_NAMES.PI_AGENT_SPAWN);
  assert.equal(started.span.attributes["pi.agent.spawn.trace_context_propagated"], true);
  assert.match(started.span.attributes["pi.agent.spawn.command.hash"], /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(started.span.attributes), /super-secret|unsafe-arg|top-secret-token/u);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL, 1);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_FANOUT_COUNT, 1);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_DEPTH, 1);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_WIDTH, 1);
  assertSubagentMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL);
});

test("subagent propagation uses the started spawn span context instead of an unrelated parent context", () => {
  const telemetry = createFakeTelemetry();
  const unrelatedContext = {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "bbbbbbbbbbbbbbbb",
    traceFlags: 1,
  };
  telemetry.sessionSpan.spanContext = () => unrelatedContext;

  const started = startSubagentSpawn(telemetry, { spawnId: "spawn-context-source", spawnType: "command" });

  assert.equal(started.span.parentSpan, telemetry.sessionSpan);
  assert.equal(started.env.traceparent, "00-11111111111111111111111111111111-2222222222222222-01");
  assert.notEqual(started.env.OBSERVME_PARENT_TRACE_ID, unrelatedContext.traceId);
  assert.notEqual(started.env.OBSERVME_PARENT_SPAN_ID, unrelatedContext.spanId);
});

test("subagent spawn records fallback telemetry when W3C trace context cannot be propagated", () => {
  const telemetry = createFakeTelemetry({ spanContext: invalidSpanContext });
  const started = startSubagentSpawn(telemetry, { spawnId: "spawn-fallback", spawnType: "command" });
  const childLineage = createAgentLineageContext({
    config: telemetry.config,
    env: started.env,
    trustedParentContext: true,
    generateId: () => "child-fallback",
  });

  assert.equal(started.traceContextPropagated, false);
  assert.equal(started.env.traceparent, undefined);
  assert.equal(started.env.OBSERVME_WORKFLOW_ID, "workflow-1");
  assert.equal(childLineage.workflowId, "workflow-1");
  assert.equal(childLineage.parentAgentId, "agent-parent");
  assert.equal(childLineage.rootAgentId, "agent-root");
  assert.equal(started.span.attributes["pi.agent.spawn.trace_context_propagated"], false);
  assert.ok(started.span.events.some(event => event.name === LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED));
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED));
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL, 1);
});

test("documented spawn and wait reason values pass through unchanged", () => {
  const telemetry = createFakeTelemetry();

  for (const reason of SUBAGENT_SPAWN_REASON_VALUES) {
    const started = startSubagentSpawn(telemetry, {
      spawnId: `spawn-${reason}`,
      childAgentId: `child-${reason}`,
      spawnType: "command",
      spawnReason: reason,
    });
    completeSubagentSpawn(telemetry, started.spawnId, { childAgentId: started.childAgentId });
  }

  for (const reason of AGENT_WAIT_REASON_VALUES) {
    recordAgentWait(telemetry, {
      id: `wait-${reason}`,
      childStatus: "active",
      joinStatus: "waiting",
      reason,
      durationMs: 1,
    });
  }

  const spawnRecords = telemetry.meter.records.filter(
    record => record.name === OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL,
  );
  const waitRecords = telemetry.meter.records.filter(
    record => record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS,
  );
  assert.deepEqual(spawnRecords.map(record => record.attributes.spawn_reason), [...SUBAGENT_SPAWN_REASON_VALUES]);
  assert.deepEqual(waitRecords.map(record => record.attributes.reason), [...AGENT_WAIT_REASON_VALUES]);
});

test("spawn and wait reasons stay consistent across spans, logs, runtime hints, and metric labels", () => {
  clearObsAgentsRuntimeState();
  const telemetry = createFakeTelemetry();
  const started = startSubagentSpawn(telemetry, {
    spawnId: "spawn-untyped-reason",
    childAgentId: "child-untyped-reason",
    spawnType: "command",
    spawnReason: "arbitrary external reason",
  });

  const wait = recordAgentWait(telemetry, {
    id: "wait-untyped-reason",
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
    reason: "arbitrary wait reason",
    durationMs: 21,
  });
  const activeChildWait = recordAgentWait(telemetry, {
    id: "wait-active-child",
    childAgentId: started.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
    durationMs: 22,
  });
  completeSubagentSpawn(telemetry, started.spawnId, { childAgentId: started.childAgentId });
  const completedChildWait = recordAgentWait(telemetry, {
    id: "wait-completed-child",
    childAgentId: started.childAgentId,
    childStatus: "completed",
    joinStatus: "completed",
    durationMs: 23,
  });

  assert.deepEqual(SUBAGENT_SPAWN_REASON_VALUES, ["delegated_task", "parallel_search", "review", "tool_wrapper", "unknown"]);
  assert.deepEqual(AGENT_WAIT_REASON_VALUES, ["dependency", "rate_limit", "child_running", "unknown"]);
  assert.equal(started.span.attributes["pi.agent.spawn.reason"], "unknown");
  assert.equal(wait.span.attributes["pi.agent.wait.reason"], "unknown");
  assert.equal(activeChildWait.span.attributes["pi.agent.wait.reason"], "child_running");
  assert.equal(completedChildWait.span.attributes["pi.agent.wait.reason"], "unknown");

  const spawnRecords = telemetry.meter.records.filter(
    record => record.name === OBSERVME_COUNTER_METRIC_NAMES.SUBAGENTS_SPAWNED_TOTAL,
  );
  const waitRecords = telemetry.meter.records.filter(
    record => record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS,
  );
  assert.deepEqual(spawnRecords.map(record => record.attributes.spawn_reason), ["unknown"]);
  assert.deepEqual(waitRecords.map(record => record.attributes.reason), ["unknown", "child_running", "unknown"]);

  const spawnLogs = telemetry.logger.records.filter(
    record =>
      record.attributes["pi.agent.spawn.id"] === started.spawnId &&
      [LOG_EVENT_NAMES.AGENT_SPAWN_STARTED, LOG_EVENT_NAMES.AGENT_SPAWN_COMPLETED].includes(record.body),
  );
  const waitLogs = telemetry.logger.records.filter(
    record =>
      record.attributes["pi.agent.spawn.id"] === started.spawnId &&
      [LOG_EVENT_NAMES.AGENT_WAIT_STARTED, LOG_EVENT_NAMES.AGENT_WAIT_COMPLETED].includes(record.body),
  );
  assert.ok(spawnLogs.length >= 2);
  assert.ok(waitLogs.length >= 2);
  assert.ok(spawnLogs.every(record => record.attributes["pi.agent.spawn.reason"] === "unknown"));
  assert.ok(waitLogs.every(record => record.attributes["pi.agent.wait.reason"] === "unknown"));

  const runtimeHint = getLocalObsAgentsRuntimeSnapshot().waitJoinHints.find(hint => hint.id === "wait-untyped-reason");
  assert.equal(runtimeHint?.reason, "unknown");
  clearObsAgentsRuntimeState();
});

test("malformed propagated lineage records a propagation failure and missing parent lineage records an orphan", () => {
  const telemetry = createFakeTelemetry();

  const malformed = observeTrustedSubagentLineage(telemetry, { OBSERVME_WORKFLOW_ID: "bad/workflow" });
  const orphan = observeTrustedSubagentLineage(
    telemetry,
    {
      OBSERVME_WORKFLOW_ID: "workflow-1",
      OBSERVME_PARENT_AGENT_ID: "missing-parent",
      OBSERVME_AGENT_DEPTH: "0",
    },
    { generateId: () => "orphan-generated" },
  );

  assert.equal(malformed, undefined);
  assert.equal(orphan.orphaned, true);
  assert.equal(orphan.status, "orphaned");
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL, 1);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.ORPHAN_AGENTS_TOTAL, 1);
  assert.ok(telemetry.logger.records.some(record => record.body === LOG_EVENT_NAMES.AGENT_ORPHANED));
});

test("subagent completion rejects non-terminal, mismatched, and contradictory transitions without mutation", () => {
  const telemetry = createFakeTelemetry();
  const started = startSubagentSpawn(telemetry, {
    spawnId: "spawn-invalid-transition",
    childAgentId: "child-invalid-transition",
    spawnType: "command",
  });
  const activeState = telemetry.spans.activeSubagentSpawns.get(started.spawnId);
  const meterRecordCount = telemetry.meter.records.length;
  const logRecordCount = telemetry.logger.records.length;

  assert.deepEqual(completeSubagentSpawn(telemetry, started.spawnId, { childStatus: "starting" }), {
    ok: false,
    reason: "invalid_terminal_transition",
  });
  assert.deepEqual(completeSubagentSpawn(telemetry, started.spawnId, { childStatus: "active" }), {
    ok: false,
    reason: "invalid_terminal_transition",
  });
  assert.deepEqual(
    completeSubagentSpawn(telemetry, started.spawnId, {
      childAgentId: "different-child",
      childStatus: "completed",
    }),
    { ok: false, reason: "child_agent_mismatch" },
  );
  assert.deepEqual(
    completeSubagentSpawn(telemetry, started.spawnId, {
      childStatus: "failed",
      outcome: "completed",
    }),
    { ok: false, reason: "invalid_terminal_transition" },
  );
  assert.equal(telemetry.spans.activeSubagentSpawns.get(started.spawnId), activeState);
  assert.equal(telemetry.agentTree.getAgent(started.childAgentId).status, "starting");
  assert.equal(started.span.ended, false);
  assert.equal(telemetry.meter.records.length, meterRecordCount);
  assert.equal(telemetry.logger.records.length, logRecordCount);
});

test("subagent terminal transitions keep spans, events, tree state, metrics, and runtime state coherent", () => {
  const terminalCases = [
    {
      status: "completed",
      eventName: LOG_EVENT_NAMES.AGENT_SPAWN_COMPLETED,
      spanStatus: SpanStatusCode.OK,
      childFailures: 0,
    },
    {
      status: "failed",
      eventName: LOG_EVENT_NAMES.AGENT_SPAWN_FAILED,
      spanStatus: SpanStatusCode.ERROR,
      childFailures: 1,
    },
    {
      status: "cancelled",
      eventName: LOG_EVENT_NAMES.AGENT_SPAWN_CANCELLED,
      spanStatus: SpanStatusCode.ERROR,
      childFailures: 0,
    },
  ];

  for (const terminalCase of terminalCases) {
    clearObsAgentsRuntimeState();
    const telemetry = createFakeTelemetry();
    const started = startSubagentSpawn(telemetry, {
      spawnId: `spawn-terminal-${terminalCase.status}`,
      childAgentId: `child-terminal-${terminalCase.status}`,
      spawnType: "command",
    });

    assert.deepEqual(
      completeSubagentSpawn(telemetry, started.spawnId, {
        childAgentId: started.childAgentId,
        childStatus: terminalCase.status,
        outcome: terminalCase.status,
      }),
      { ok: true },
    );
    assert.equal(started.span.ended, true);
    assert.equal(started.span.status.code, terminalCase.spanStatus);
    assert.equal(started.span.attributes["pi.agent.spawn.outcome"], terminalCase.status);
    assert.equal(started.span.attributes["pi.agent.children.active"], 0);
    assert.equal(telemetry.agentTree.getAgent(started.childAgentId).status, terminalCase.status);
    assert.ok(started.span.events.some(event => event.name === terminalCase.eventName));
    assert.ok(telemetry.logger.records.some(record => record.body === terminalCase.eventName));
    assert.equal(
      telemetry.meter.records.filter(record => record.name === OBSERVME_COUNTER_METRIC_NAMES.CHILD_AGENT_FAILURES_TOTAL).length,
      terminalCase.childFailures,
    );
    assert.equal(
      telemetry.meter.records.filter(record => record.name === OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL).length,
      0,
    );
    assert.equal(
      getLocalObsAgentsRuntimeSnapshot().children.find(child => child.agentId === started.childAgentId)?.status,
      terminalCase.status,
    );

    const meterRecordCount = telemetry.meter.records.length;
    const logRecordCount = telemetry.logger.records.length;
    assert.deepEqual(completeSubagentSpawn(telemetry, started.spawnId, { childStatus: terminalCase.status }), {
      ok: false,
      reason: "spawn_not_found",
    });
    assert.equal(telemetry.meter.records.length, meterRecordCount);
    assert.equal(telemetry.logger.records.length, logRecordCount);
  }
  clearObsAgentsRuntimeState();
});

test("launcher failure cannot double-count a child failure already reported by join", () => {
  const telemetry = createFakeTelemetry();
  const started = startSubagentSpawn(telemetry, {
    spawnId: "spawn-child-failed-before-launcher-failure",
    childAgentId: "child-failed-before-launcher-failure",
    spawnType: "command",
  });

  recordAgentJoin(telemetry, {
    id: "join-child-failed-before-launcher-failure",
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "failed",
    joinStatus: "failed",
    failurePropagated: true,
    durationMs: 10,
  });
  assert.deepEqual(
    failSubagentSpawn(telemetry, started.spawnId, {
      childAgentId: started.childAgentId,
      errorClass: "SpawnError",
    }),
    { ok: false, reason: "invalid_terminal_transition" },
  );
  assert.equal(telemetry.spans.activeSubagentSpawns.has(started.spawnId), true);
  assert.equal(
    telemetry.meter.records.filter(record => record.name === OBSERVME_COUNTER_METRIC_NAMES.CHILD_AGENT_FAILURES_TOTAL).length,
    1,
  );
  assert.equal(
    telemetry.meter.records.filter(record => record.name === OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL).length,
    0,
  );

  assert.deepEqual(
    completeSubagentSpawn(telemetry, started.spawnId, {
      childAgentId: started.childAgentId,
      childStatus: "failed",
      outcome: "failed",
    }),
    { ok: true },
  );
  assert.equal(
    telemetry.meter.records.filter(record => record.name === OBSERVME_COUNTER_METRIC_NAMES.CHILD_AGENT_FAILURES_TOTAL).length,
    1,
  );
  assert.equal(
    telemetry.meter.records.filter(record => record.name === OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL).length,
    0,
  );
});

test("subagent spawn completion and launcher failure record elapsed duration from injected clocks", () => {
  const telemetry = createFakeTelemetry();
  let nowMs = 100;
  const completed = startSubagentSpawn(telemetry, {
    spawnId: "spawn-duration-completed",
    childAgentId: "child-duration-completed",
    spawnType: "command",
    spawnReason: "delegated_task",
    now: () => nowMs,
  });

  nowMs = 350;
  completeSubagentSpawn(telemetry, completed.spawnId, {
    childAgentId: completed.childAgentId,
    childStatus: "completed",
    now: () => nowMs,
  });

  nowMs = 500;
  const failed = startSubagentSpawn(telemetry, {
    spawnId: "spawn-duration-failed",
    childAgentId: "child-duration-failed",
    spawnType: "tool",
    spawnReason: "tool_wrapper",
    now: () => nowMs,
  });

  nowMs = 575;
  failSubagentSpawn(telemetry, failed.spawnId, {
    childAgentId: failed.childAgentId,
    errorClass: "SpawnError",
    now: () => nowMs,
  });

  assert.equal(failed.span.status.code, SpanStatusCode.ERROR);
  assert.equal(failed.span.attributes["pi.agent.spawn.outcome"], "failed");
  assert.equal(failed.span.attributes["pi.agent.children.active"], 0);
  assert.equal(telemetry.agentTree.getAgent(failed.childAgentId).status, "failed");
  assert.ok(failed.span.events.some(event => event.name === LOG_EVENT_NAMES.AGENT_SPAWN_FAILED));
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.SUBAGENT_SPAWN_DURATION_MS, 250);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.SUBAGENT_SPAWN_DURATION_MS, 75);
  const durationRecords = telemetry.meter.records.filter(
    record => record.name === OBSERVME_HISTOGRAM_METRIC_NAMES.SUBAGENT_SPAWN_DURATION_MS,
  );
  assert.deepEqual(durationRecords.map(record => record.attributes.spawn_reason), ["delegated_task", "tool_wrapper"]);
  assert.ok(durationRecords.every(record => record.attributes.spawn_id === undefined));
});

test("child failure and parent recovery metrics deduplicate bounded child transitions", () => {
  const config = structuredClone(defaultObservMeConfig);
  config.limits.maxActiveSubagentSpawns = 2;
  const telemetry = createFakeTelemetry({ config });
  const failedChild = startSubagentSpawn(telemetry, {
    spawnId: "spawn-child-failed",
    childAgentId: "child-failed",
    spawnType: "command",
  });

  completeSubagentSpawn(telemetry, failedChild.spawnId, {
    childAgentId: failedChild.childAgentId,
    childStatus: "failed",
    outcome: "failed",
  });
  recordAgentJoin(telemetry, {
    id: "join-child-failed-recovered",
    childAgentId: failedChild.childAgentId,
    childStatus: "failed",
    joinStatus: "completed",
    failurePropagated: false,
    durationMs: 15,
  });
  recordAgentJoin(telemetry, {
    id: "join-child-failed-repeated",
    childAgentId: failedChild.childAgentId,
    childStatus: "failed",
    joinStatus: "completed",
    failurePropagated: false,
    durationMs: 16,
  });

  const launcherFailure = startSubagentSpawn(telemetry, {
    spawnId: "spawn-launcher-failed",
    childAgentId: "child-never-launched",
    spawnType: "command",
  });
  failSubagentSpawn(telemetry, launcherFailure.spawnId, {
    childAgentId: launcherFailure.childAgentId,
    errorClass: "SpawnError",
  });

  for (let index = 0; index < 5; index += 1) {
    recordAgentJoin(telemetry, {
      id: `join-failed-${index}`,
      childAgentId: `child-failed-${index}`,
      childStatus: "failed",
      joinStatus: "failed",
      failurePropagated: true,
      durationMs: index,
    });
  }

  const childFailureRecords = telemetry.meter.records.filter(
    record => record.name === OBSERVME_COUNTER_METRIC_NAMES.CHILD_AGENT_FAILURES_TOTAL,
  );
  const recoveryRecords = telemetry.meter.records.filter(
    record => record.name === OBSERVME_COUNTER_METRIC_NAMES.PARENT_RECOVERED_FROM_CHILD_FAILURE_TOTAL,
  );

  assert.equal(childFailureRecords.length, 6);
  assert.equal(recoveryRecords.length, 1);
  assert.deepEqual(Object.keys(childFailureRecords[0].attributes).sort(), ["agent_role", "subagent_depth"]);
  assert.deepEqual(Object.keys(recoveryRecords[0].attributes).sort(), ["agent_role", "subagent_depth"]);
  assert.equal(telemetry.childFailureAccounting.size, config.limits.maxActiveSubagentSpawns);
  assert.equal(
    telemetry.meter.records.filter(record => record.name === OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL).length,
    1,
  );
});

test("wait and join spans record child status, counts, durations, and spawn failures without high-cardinality metric labels", () => {
  const telemetry = createFakeTelemetry();
  const started = startSubagentSpawn(telemetry, { spawnId: "spawn-wait", spawnType: "command", spawnReason: "delegated_task" });

  const wait = recordAgentWait(telemetry, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
    reason: "child_running",
    durationMs: 25,
  });
  const join = recordAgentJoin(telemetry, {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "failed",
    joinStatus: "failed",
    failurePropagated: true,
    durationMs: 40,
  });
  const failingSpawn = startSubagentSpawn(telemetry, { spawnId: "spawn-fail", spawnType: "command" });
  failSubagentSpawn(telemetry, failingSpawn.spawnId, { childAgentId: failingSpawn.childAgentId, errorClass: "SpawnError" });

  assert.equal(wait.span.name, SPAN_NAMES.PI_AGENT_WAIT);
  assert.equal(wait.span.ended, true);
  assert.equal(wait.span.attributes["pi.agent.child.status"], "active");
  assert.equal(wait.span.attributes["pi.agent.join.status"], "waiting");
  assert.equal(wait.span.attributes["pi.agent.children.active"], 1);
  assert.equal(wait.span.attributes["pi.agent.child.count"], 1);
  assert.equal(join.span.name, SPAN_NAMES.PI_AGENT_JOIN);
  assert.equal(join.span.ended, true);
  assert.equal(join.span.status.code, 2);
  assert.equal(join.span.attributes["pi.agent.child.status"], "failed");
  assert.equal(join.span.attributes["pi.agent.join.status"], "failed");
  assert.equal(join.span.attributes["pi.agent.failure.propagated"], true);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_WAIT_DURATION_MS, 25);
  assertHistogramRecorded(telemetry.meter.records, OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_JOIN_DURATION_MS, 40);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL, 1);
  assertMetricValue(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.CHILD_AGENT_FAILURES_TOTAL, 1);
  assert.equal(
    telemetry.meter.records.some(record => record.name === OBSERVME_COUNTER_METRIC_NAMES.PARENT_RECOVERED_FROM_CHILD_FAILURE_TOTAL),
    false,
  );
  assertSubagentMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL);
  assertSubagentMetricLabelsAreLowCardinality(telemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.CHILD_AGENT_FAILURES_TOTAL);
});

test("wait and join handles reject retargeting and reuse their stored identity on completion", t => {
  clearObsAgentsRuntimeState();
  t.after(clearObsAgentsRuntimeState);
  const telemetry = createFakeTelemetry();
  const first = startSubagentSpawn(telemetry, {
    spawnId: "spawn-bound-first",
    childAgentId: "child-bound-first",
    spawnType: "command",
  });
  const second = startSubagentSpawn(telemetry, {
    spawnId: "spawn-bound-second",
    childAgentId: "child-bound-second",
    spawnType: "command",
  });
  const wait = startAgentWait(telemetry, {
    id: "wait-bound-first",
    spawnId: first.spawnId,
    childAgentId: first.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
    reason: "child_running",
  });
  const waitState = telemetry.spans.activeAgentWaits.get(wait.id);

  assert.equal(waitState.id, wait.id);
  assert.equal(waitState.kind, "wait");
  assert.equal(waitState.spawnId, first.spawnId);
  assert.equal(waitState.childAgentId, first.childAgentId);
  assert.equal(waitState.childStatus, "active");
  assert.equal(waitState.joinStatus, "waiting");
  assert.equal(telemetry.agentTree.getAgent(first.childAgentId).status, "active");

  const waitAttributesBeforeMismatch = structuredClone(wait.span.attributes);
  const waitEventsBeforeMismatch = structuredClone(wait.span.events);
  const waitMetricsBeforeMismatch = telemetry.meter.records.length;
  const waitLogsBeforeMismatch = telemetry.logger.records.length;
  const waitHintsBeforeMismatch = structuredClone(getLocalObsAgentsRuntimeSnapshot().waitJoinHints);
  const firstTreeBeforeMismatch = telemetry.agentTree.getAgent(first.childAgentId);
  const secondTreeBeforeMismatch = telemetry.agentTree.getAgent(second.childAgentId);

  assert.deepEqual(endAgentWait(telemetry, wait.id, {
    spawnId: second.spawnId,
    childAgentId: second.childAgentId,
    childStatus: "completed",
    joinStatus: "completed",
  }), { ok: false, reason: "child_agent_mismatch" });
  assert.equal(telemetry.spans.activeAgentWaits.get(wait.id), waitState);
  assert.equal(wait.span.ended, false);
  assert.deepEqual(wait.span.attributes, waitAttributesBeforeMismatch);
  assert.deepEqual(wait.span.events, waitEventsBeforeMismatch);
  assert.equal(telemetry.meter.records.length, waitMetricsBeforeMismatch);
  assert.equal(telemetry.logger.records.length, waitLogsBeforeMismatch);
  assert.deepEqual(getLocalObsAgentsRuntimeSnapshot().waitJoinHints, waitHintsBeforeMismatch);
  assert.deepEqual(telemetry.agentTree.getAgent(first.childAgentId), firstTreeBeforeMismatch);
  assert.deepEqual(telemetry.agentTree.getAgent(second.childAgentId), secondTreeBeforeMismatch);

  assert.deepEqual(endAgentWait(telemetry, wait.id, {
    childStatus: "completed",
    joinStatus: "completed",
    durationMs: 7,
  }), { ok: true });
  assert.equal(wait.span.attributes["pi.agent.spawn.id"], first.spawnId);
  assert.equal(wait.span.attributes["pi.agent.child.id"], first.childAgentId);
  assert.equal(telemetry.agentTree.getAgent(first.childAgentId).status, "completed");
  assert.equal(telemetry.agentTree.getAgent(second.childAgentId).status, "starting");

  const join = startAgentJoin(telemetry, {
    id: "join-bound-first",
    spawnId: first.spawnId,
    childAgentId: first.childAgentId,
    childStatus: "completed",
    joinStatus: "completed",
    reason: "dependency",
  });
  const joinState = telemetry.spans.activeAgentJoins.get(join.id);

  assert.equal(joinState.id, join.id);
  assert.equal(joinState.kind, "join");
  assert.equal(joinState.spawnId, first.spawnId);
  assert.equal(joinState.childAgentId, first.childAgentId);
  const joinMetricsBeforeMismatch = telemetry.meter.records.length;
  const joinLogsBeforeMismatch = telemetry.logger.records.length;
  const joinHintsBeforeMismatch = structuredClone(getLocalObsAgentsRuntimeSnapshot().waitJoinHints);

  assert.deepEqual(endAgentJoin(telemetry, join.id, {
    spawnId: second.spawnId,
    childAgentId: second.childAgentId,
    childStatus: "failed",
    joinStatus: "failed",
  }), { ok: false, reason: "child_agent_mismatch" });
  assert.equal(telemetry.spans.activeAgentJoins.get(join.id), joinState);
  assert.equal(join.span.ended, false);
  assert.equal(telemetry.meter.records.length, joinMetricsBeforeMismatch);
  assert.equal(telemetry.logger.records.length, joinLogsBeforeMismatch);
  assert.deepEqual(getLocalObsAgentsRuntimeSnapshot().waitJoinHints, joinHintsBeforeMismatch);

  assert.deepEqual(endAgentJoin(telemetry, join.id, { durationMs: 9 }), { ok: true });
  assert.equal(join.span.attributes["pi.agent.spawn.id"], first.spawnId);
  assert.equal(join.span.attributes["pi.agent.child.id"], first.childAgentId);
  assert.equal(join.span.attributes["pi.agent.child.status"], "completed");
  assert.equal(join.span.attributes["pi.agent.join.status"], "completed");

  const lifecycleLogs = telemetry.logger.records.filter(record =>
    [
      LOG_EVENT_NAMES.AGENT_WAIT_STARTED,
      LOG_EVENT_NAMES.AGENT_WAIT_COMPLETED,
      LOG_EVENT_NAMES.AGENT_JOIN_STARTED,
      LOG_EVENT_NAMES.AGENT_JOIN_COMPLETED,
    ].includes(record.body)
  );
  assert.ok(lifecycleLogs.every(record => record.attributes["pi.agent.spawn.id"] === first.spawnId));
  assert.ok(lifecycleLogs.every(record => record.attributes["pi.agent.child.id"] === first.childAgentId));
  const hints = getLocalObsAgentsRuntimeSnapshot().waitJoinHints.filter(hint => hint.id === wait.id || hint.id === join.id);
  assert.deepEqual(hints.map(hint => ({
    id: hint.id,
    active: hint.active,
    spawnId: hint.spawnId,
    childAgentId: hint.childAgentId,
  })), [
    { id: wait.id, active: false, spawnId: first.spawnId, childAgentId: first.childAgentId },
    { id: join.id, active: false, spawnId: first.spawnId, childAgentId: first.childAgentId },
  ]);
});

test("core runner preserves terminal child results and non-terminal wait outcomes", async () => {
  const terminalCases = [
    { status: "completed", expected: "completed" },
    { status: "failed", expected: "failed" },
    { status: "cancelled", expected: "cancelled" },
  ];

  for (const terminalCase of terminalCases) {
    const telemetry = createFakeTelemetry();
    const result = await runSubagentWithObservability(
      telemetry,
      "pi",
      [],
      async () => ({ status: terminalCase.status }),
      {
        spawnId: `spawn-runner-${terminalCase.status}`,
        childAgentId: `child-runner-${terminalCase.status}`,
      },
    );

    assert.deepEqual(result, { status: terminalCase.status });
    assert.equal(telemetry.spans.activeSubagentSpawns.size, 0);
    assert.equal(telemetry.agentTree.getAgent(`child-runner-${terminalCase.status}`).status, terminalCase.expected);
  }

  const timeoutTelemetry = createFakeTelemetry();
  const timeoutResult = await runSubagentWithObservability(
    timeoutTelemetry,
    "pi",
    [],
    async () => ({ status: "timeout" }),
    { spawnId: "spawn-runner-timeout", childAgentId: "child-runner-timeout" },
  );

  assert.deepEqual(timeoutResult, { status: "timeout" });
  assert.equal(timeoutTelemetry.spans.activeSubagentSpawns.has("spawn-runner-timeout"), true);
  assert.equal(timeoutTelemetry.agentTree.getAgent("child-runner-timeout").status, "active");
  assert.deepEqual(
    completeSubagentSpawn(timeoutTelemetry, "spawn-runner-timeout", {
      childAgentId: "child-runner-timeout",
      childStatus: "completed",
    }),
    { ok: true },
  );
  assert.deepEqual(
    completeSubagentSpawn(timeoutTelemetry, "spawn-runner-timeout", {
      childAgentId: "child-runner-timeout",
      childStatus: "completed",
    }),
    { ok: false, reason: "spawn_not_found" },
  );
});

test("core runner distinguishes caller cancellation, transport failure, and launcher failure", async () => {
  const nonTerminalCases = [
    { id: "abort", error: new DOMException("cancelled", "AbortError") },
    { id: "transport", error: new Error("result channel closed") },
  ];

  for (const nonTerminalCase of nonTerminalCases) {
    const telemetry = createFakeTelemetry();
    await assert.rejects(
      runSubagentWithObservability(
        telemetry,
        "pi",
        [],
        async () => {
          throw nonTerminalCase.error;
        },
        {
          spawnId: `spawn-runner-${nonTerminalCase.id}`,
          childAgentId: `child-runner-${nonTerminalCase.id}`,
        },
      ),
      nonTerminalCase.error,
    );
    assert.equal(telemetry.spans.activeSubagentSpawns.has(`spawn-runner-${nonTerminalCase.id}`), true);
    assert.equal(telemetry.agentTree.getAgent(`child-runner-${nonTerminalCase.id}`).status, "active");
    assert.equal(
      telemetry.meter.records.some(record => record.name === OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL),
      false,
    );
  }

  const launchTelemetry = createFakeTelemetry();
  const launchError = new Error("spawn failed");
  await assert.rejects(
    runSubagentWithObservability(
      launchTelemetry,
      "pi",
      [],
      async () => {
        throw launchError;
      },
      {
        spawnId: "spawn-runner-launch-failure",
        childAgentId: "child-runner-launch-failure",
        runnerErrorPhase: "launch",
      },
    ),
    launchError,
  );
  assert.equal(launchTelemetry.spans.activeSubagentSpawns.size, 0);
  assert.equal(launchTelemetry.agentTree.getAgent("child-runner-launch-failure").status, "failed");
  assertMetricValue(launchTelemetry.meter.records, OBSERVME_COUNTER_METRIC_NAMES.SUBAGENT_SPAWN_FAILURES_TOTAL, 1);
});

test("bounded wait and join eviction deactivates the exact retained runtime hints", t => {
  clearObsAgentsRuntimeState();
  t.after(clearObsAgentsRuntimeState);
  const config = structuredClone(defaultObservMeConfig);
  config.limits.maxActiveAgentWaits = 1;
  config.limits.maxActiveAgentJoins = 1;
  const telemetry = createFakeTelemetry({ config });
  const first = startSubagentSpawn(telemetry, {
    spawnId: "spawn-evicted-first",
    childAgentId: "child-evicted-first",
    spawnType: "command",
  });
  const second = startSubagentSpawn(telemetry, {
    spawnId: "spawn-evicted-second",
    childAgentId: "child-evicted-second",
    spawnType: "command",
  });
  const evictedWait = startAgentWait(telemetry, {
    id: "wait-evicted-first",
    spawnId: first.spawnId,
    childAgentId: first.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
  });
  const retainedWait = startAgentWait(telemetry, {
    id: "wait-retained-second",
    spawnId: second.spawnId,
    childAgentId: second.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
  });
  const evictedJoin = startAgentJoin(telemetry, {
    id: "join-evicted-first",
    spawnId: first.spawnId,
    childAgentId: first.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
  });
  const retainedJoin = startAgentJoin(telemetry, {
    id: "join-retained-second",
    spawnId: second.spawnId,
    childAgentId: second.childAgentId,
    childStatus: "active",
    joinStatus: "waiting",
  });

  assert.equal(evictedWait.span.ended, true);
  assert.equal(evictedJoin.span.ended, true);
  assert.equal(evictedWait.span.attributes["observme.evicted"], true);
  assert.equal(evictedJoin.span.attributes["observme.evicted"], true);
  assert.deepEqual([...telemetry.spans.activeAgentWaits.keys()], [retainedWait.id]);
  assert.deepEqual([...telemetry.spans.activeAgentJoins.keys()], [retainedJoin.id]);

  const hints = getLocalObsAgentsRuntimeSnapshot().waitJoinHints;
  const evictedWaitHint = hints.find(hint => hint.id === evictedWait.id);
  const evictedJoinHint = hints.find(hint => hint.id === evictedJoin.id);
  assert.deepEqual(evictedWaitHint, {
    kind: "wait",
    id: evictedWait.id,
    active: false,
    spawnId: first.spawnId,
    childAgentId: first.childAgentId,
    childStatus: "active",
    joinStatus: "unknown",
    reason: "child_running",
    durationMs: undefined,
  });
  assert.deepEqual(evictedJoinHint, {
    kind: "join",
    id: evictedJoin.id,
    active: false,
    spawnId: first.spawnId,
    childAgentId: first.childAgentId,
    childStatus: "active",
    joinStatus: "unknown",
    reason: "child_running",
    durationMs: undefined,
  });
  assert.deepEqual(hints.filter(hint => hint.active).map(hint => hint.id), [retainedWait.id, retainedJoin.id]);
  assert.equal(telemetry.agentTree.getAgent(first.childAgentId).status, "active");
  assert.equal(telemetry.agentTree.getAgent(second.childAgentId).status, "active");
});

function assertMetricValue(records, metricName, value) {
  const record = records.find(candidate => candidate.name === metricName && candidate.value === value);
  assert.ok(record, `${metricName} should record ${value}`);
}

function assertHistogramRecorded(records, metricName, value) {
  const record = records.find(candidate => candidate.name === metricName && candidate.value === value);
  assert.ok(record, `${metricName} should record ${value}`);
}

function assertSubagentMetricLabelsAreLowCardinality(records, metricName) {
  const record = records.find(candidate => candidate.name === metricName);
  assert.ok(record, `${metricName} should be recorded`);
  for (const forbiddenLabel of ["agent_id", "child_agent_id", "session_id", "spawn_id", "workflow_id"]) {
    assert.equal(record.attributes[forbiddenLabel], undefined, `${metricName} must not include ${forbiddenLabel}`);
  }
}
