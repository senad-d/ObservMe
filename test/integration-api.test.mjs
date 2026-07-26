import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION,
  OBSERVME_CHILD_ROLES,
  OBSERVME_INTEGRATION_CHANNEL,
  OBSERVME_INTEGRATION_VERSION,
  OBSERVME_INTEGRATION_VERSION_V2,
  requestObservMeIntegration,
  requestObservMeIntegrationV2,
} from "../src/integration.ts";
import { createAgentTreeTracker, createObservMeMetrics, createSpanRegistry } from "../src/pi/handlers.ts";
import { registerObservMeIntegration } from "../src/pi/integration-api.ts";
import { SPAN_NAMES } from "../src/semconv/spans.ts";
import {
  createFutureOrcMeManagedBaseEnvironment,
  isFutureOrcMeDefinitionName,
  mapFutureOrcMeChildDescriptor,
  requestFutureOrcMeObservMeV2,
  runFutureOrcMePiRpcLifecycle,
  simulateFutureOrcMePiRpcOverlay,
  startFutureOrcMePiRpcDelegation,
} from "./fixtures/orcme-integration-consumer.mjs";

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

function collectProviderResponses(events, supportedVersions) {
  const responses = [];
  events.emit(OBSERVME_INTEGRATION_CHANNEL, {
    supportedVersions,
    respond: responses.push.bind(responses),
  });
  return responses;
}

function recordNegotiationCall(calls, provider, method) {
  calls.push(`${provider}:${method}`);
  return { ok: false, reason: "session_unavailable" };
}

function createNegotiationApi(version, provider, calls) {
  const lifecycle = {
    version,
    getContext: recordNegotiationCall.bind(undefined, calls, provider, "getContext"),
    startSubagent: recordNegotiationCall.bind(undefined, calls, provider, "startSubagent"),
    completeSubagent: recordNegotiationCall.bind(undefined, calls, provider, "completeSubagent"),
    failSubagent: recordNegotiationCall.bind(undefined, calls, provider, "failSubagent"),
    startWait: recordNegotiationCall.bind(undefined, calls, provider, "startWait"),
    endWait: recordNegotiationCall.bind(undefined, calls, provider, "endWait"),
    startJoin: recordNegotiationCall.bind(undefined, calls, provider, "startJoin"),
    endJoin: recordNegotiationCall.bind(undefined, calls, provider, "endJoin"),
  };
  if (version === OBSERVME_INTEGRATION_VERSION) return Object.freeze(lifecycle);
  return Object.freeze({
    ...lifecycle,
    childRoles: Object.freeze(["lead", "helper", "worker", "validator"]),
    childIdentityEnvelopeVersion: OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION,
  });
}

class IntegrationResponseEventBus {
  constructor(responses) {
    this.responses = responses;
  }

  emit(_channel, request) {
    for (const response of this.responses) request.respond(response);
  }
}

class LateIntegrationResponseEventBus extends IntegrationResponseEventBus {
  emit(channel, request) {
    super.emit(channel, request);
    this.respond = request.respond;
  }

  respondLate(response) {
    this.respond(response);
  }
}

class StartCallTrackingApi {
  constructor(delegate) {
    this.delegate = delegate;
    this.startCalls = [];
  }

  startSubagent(options) {
    this.startCalls.push(options);
    return this.delegate.startSubagent(options);
  }
}

class FutureOrcMeLifecycleRecordingApi {
  constructor(calls) {
    this.calls = calls;
  }

  startSubagent(options) {
    this.calls.push("startSubagent");
    return {
      ok: true,
      spawnId: options.spawnId ?? "spawn-generated-fixture",
      childAgentId: options.childAgentId ?? "child-generated-fixture",
      env: {
        ORCME_MANAGED_TASK_ID: options.env.ORCME_MANAGED_TASK_ID,
        OBSERVME_WORKFLOW_ID: "workflow-returned-fixture",
      },
      traceContextPropagated: true,
    };
  }

  failSubagent() {
    this.calls.push("failSubagent");
    return { ok: true };
  }

  startWait() {
    this.calls.push("startWait");
    return { ok: true, id: "wait-fixture" };
  }

  endWait() {
    this.calls.push("endWait");
    return { ok: true };
  }

  completeSubagent() {
    this.calls.push("completeSubagent");
    return { ok: true };
  }

  startJoin() {
    this.calls.push("startJoin");
    return { ok: true, id: "join-fixture" };
  }

  endJoin() {
    this.calls.push("endJoin");
    return { ok: true };
  }
}

class FutureOrcMeTransportRecorder {
  constructor(calls, failLaunch = false) {
    this.calls = calls;
    this.failLaunch = failLaunch;
  }

  async launch(context) {
    this.calls.push("launch");
    this.launchContext = context;
    if (this.failLaunch) throw new Error("synthetic launcher failure");
    return { id: "rpc-handle-fixture" };
  }

  async waitForTerminal() {
    this.calls.push("waitForTerminal");
    return {
      childStatus: "completed",
      outcome: "completed",
      joinStatus: "completed",
      failurePropagated: false,
    };
  }

  async collectTerminalEvidence() {
    this.calls.push("collectTerminalEvidence");
    return { status: "completed" };
  }
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
  const logs = [];
  const metrics = createObservMeMetrics(meter);

  return {
    config,
    lineage,
    tracer,
    meter,
    logger: { records: logs, emit: logs.push.bind(logs) },
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

function captureSubagentMutationState(session) {
  return {
    activeSubagentSpawns: session.spans.activeSubagentSpawns.size,
    agentTreeSize: session.agentTree.size,
    agentTreeSummary: session.agentTree.summarize(),
    metricRecords: session.meter.records.length,
    tracerSpans: session.tracer.spans.length,
    logRecords: session.logger.records.length,
  };
}

test("v2 public child-identity constants are exact and frozen without changing v1", () => {
  assert.equal(OBSERVME_INTEGRATION_VERSION, 1);
  assert.equal(OBSERVME_INTEGRATION_VERSION_V2, 2);
  assert.equal(OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION, 1);
  assert.deepEqual(OBSERVME_CHILD_ROLES, ["lead", "helper", "worker", "validator"]);
  assert.equal(Object.isFrozen(OBSERVME_CHILD_ROLES), true);
  assert.throws(() => OBSERVME_CHILD_ROLES.push("root"), TypeError);
});

test("session-backed provider negotiation truth table selects its highest mutual version", () => {
  const events = createEventBus();
  registerObservMeIntegration({ events }, {});

  const truthTable = [
    { name: "preferred order", supportedVersions: [2, 1], expectedVersion: 2 },
    { name: "reversed order", supportedVersions: [1, 2], expectedVersion: 2 },
    { name: "v2 only", supportedVersions: [2], expectedVersion: 2 },
    { name: "v1 only", supportedVersions: [1], expectedVersion: 1 },
    { name: "unsupported before v1", supportedVersions: [3, 1], expectedVersion: 1 },
    { name: "unsupported around overlap", supportedVersions: [3, 1, 2], expectedVersion: 2 },
    { name: "duplicate versions", supportedVersions: [2, 2, 1], expectedVersion: 2 },
    { name: "no overlap", supportedVersions: [3], expectedVersion: undefined },
    { name: "empty set", supportedVersions: [], expectedVersion: undefined },
  ];
  for (const testCase of truthTable) {
    const responses = collectProviderResponses(events, testCase.supportedVersions);
    assert.equal(responses.length, testCase.expectedVersion === undefined ? 0 : 1, testCase.name);
    assert.equal(responses[0]?.version, testCase.expectedVersion, testCase.name);
  }

  const [v2Api] = collectProviderResponses(events, [2]);
  const [reorderedV2Api] = collectProviderResponses(events, [1, 2]);
  const [v1Api] = collectProviderResponses(events, [1]);
  const duplicateResponses = collectProviderResponses(events, [2, 2, 1]);

  assert.equal(reorderedV2Api, v2Api);
  assert.notEqual(v1Api, v2Api);
  assert.equal(duplicateResponses.length, 1);
  assert.equal(duplicateResponses[0], v2Api);
  assert.equal("childRoles" in v1Api, false);
  assert.equal("childIdentityEnvelopeVersion" in v1Api, false);
  assert.deepEqual(v2Api.childRoles, ["lead", "helper", "worker", "validator"]);
  assert.equal(v2Api.childRoles, OBSERVME_CHILD_ROLES);
  assert.equal(Object.isFrozen(v2Api.childRoles), true);
  assert.equal(v2Api.childIdentityEnvelopeVersion, OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION);
  assert.equal(Object.isFrozen(v1Api), true);
  assert.equal(Object.isFrozen(v2Api), true);

  const malformedResponses = [];
  const respond = malformedResponses.push.bind(malformedResponses);
  const sparseSupportedVersions = Array(2);
  sparseSupportedVersions[1] = 2;
  for (const request of [
    null,
    {},
    { supportedVersions: "2,1", respond },
    { supportedVersions: sparseSupportedVersions, respond },
    { supportedVersions: [2, "1"], respond },
    { supportedVersions: [2], respond: "not-a-function" },
  ]) {
    events.emit(OBSERVME_INTEGRATION_CHANNEL, request);
  }
  assert.deepEqual(malformedResponses, []);
  assert.doesNotThrow(() => {
    events.emit(OBSERVME_INTEGRATION_CHANNEL, {
      supportedVersions: [2, 1],
      respond() {
        throw new Error("consumer rejected response");
      },
    });
  });
});

test("package helpers select the highest synchronous structural response", () => {
  const calls = [];
  const v1Api = createNegotiationApi(OBSERVME_INTEGRATION_VERSION, "v1", calls);
  const v2Api = createNegotiationApi(OBSERVME_INTEGRATION_VERSION_V2, "v2", calls);
  const host = { events: new IntegrationResponseEventBus([v1Api, v2Api]) };

  assert.notEqual(v2Api.childRoles, OBSERVME_CHILD_ROLES);
  const selectedV2 = requestObservMeIntegrationV2(host);
  assert.equal(selectedV2, v2Api);
  assert.deepEqual(selectedV2.startSubagent({
    child: { displayName: "Scout", role: "worker", capability: "code-search" },
  }), { ok: false, reason: "session_unavailable" });
  assert.deepEqual(calls, ["v2:startSubagent"]);

  calls.length = 0;
  const selectedV1 = requestObservMeIntegration(host);
  assert.equal(selectedV1, v1Api);
  assert.deepEqual(selectedV1.getContext(), { ok: false, reason: "session_unavailable" });
  assert.deepEqual(calls, ["v1:getContext"]);
});

test("package helpers keep Pi load order for same-version providers and ignore late responses", () => {
  const calls = [];
  const firstV2Api = createNegotiationApi(OBSERVME_INTEGRATION_VERSION_V2, "first", calls);
  const secondV2Api = createNegotiationApi(OBSERVME_INTEGRATION_VERSION_V2, "second", calls);
  const loadOrderedHost = { events: new IntegrationResponseEventBus([firstV2Api, secondV2Api]) };

  const selected = requestObservMeIntegrationV2(loadOrderedHost);
  assert.equal(selected, firstV2Api);
  assert.deepEqual(selected.getContext(), { ok: false, reason: "session_unavailable" });
  assert.deepEqual(calls, ["first:getContext"]);

  calls.length = 0;
  const lateEvents = new LateIntegrationResponseEventBus([firstV2Api]);
  const selectedBeforeLateResponse = requestObservMeIntegrationV2({ events: lateEvents });
  lateEvents.respondLate(secondV2Api);
  assert.equal(selectedBeforeLateResponse, firstV2Api);
  assert.deepEqual(selectedBeforeLateResponse.getContext(), { ok: false, reason: "session_unavailable" });
  assert.deepEqual(calls, ["first:getContext"]);
});

test("v2 package helper rejects v1-only and malformed structural providers", () => {
  const calls = [];
  const v1Api = createNegotiationApi(OBSERVME_INTEGRATION_VERSION, "v1", calls);
  const v2Api = createNegotiationApi(OBSERVME_INTEGRATION_VERSION_V2, "v2", calls);
  const v1OnlyHost = { events: new IntegrationResponseEventBus([v1Api]) };

  assert.equal(requestObservMeIntegrationV2(v1OnlyHost), undefined);
  assert.equal(requestObservMeIntegration(v1OnlyHost), v1Api);

  const malformedV2Apis = [
    Object.freeze({ ...v2Api, childRoles: ["lead", "helper", "worker", "validator"] }),
    Object.freeze({ ...v2Api, childRoles: Object.freeze(["lead", "helper", "worker", "root"]) }),
    Object.freeze({ ...v2Api, childIdentityEnvelopeVersion: 2 }),
    Object.freeze({ ...v2Api, startJoin: undefined }),
  ];
  for (const malformedApi of malformedV2Apis) {
    const host = { events: new IntegrationResponseEventBus([malformedApi, v1Api]) };
    assert.equal(requestObservMeIntegrationV2(host), undefined);
  }
});

test("standalone future OrcMe consumer negotiates v2 and maps exact child identity", () => {
  const events = createEventBus();
  const session = createFakeTelemetry();
  let advertisedVersions;
  events.on(OBSERVME_INTEGRATION_CHANNEL, request => {
    advertisedVersions = [...request.supportedVersions];
  });
  registerObservMeIntegration({ events }, { session });

  const api = requestFutureOrcMeObservMeV2({ events });
  assert.ok(api);
  assert.deepEqual(advertisedVersions, [2, 1]);
  assert.equal(api.version, 2);
  assert.equal(api.childIdentityEnvelopeVersion, 1);
  assert.deepEqual(api.childRoles, ["lead", "helper", "worker", "validator"]);
  assert.equal(Object.isFrozen(api.childRoles), true);

  for (const role of ["lead", "helper", "worker", "validator"]) {
    const pinnedDefinitionName = `${role}.code-review-v2`;
    const descriptor = mapFutureOrcMeChildDescriptor({
      durableDisplayIdentity: `Managed ${role}`,
      manifestRole: role,
      pinnedDefinitionName,
    });
    assert.deepEqual(descriptor, {
      displayName: `Managed ${role}`,
      role,
      capability: pinnedDefinitionName,
    });
    assert.equal(descriptor.capability, pinnedDefinitionName);
    assert.equal(isFutureOrcMeDefinitionName(pinnedDefinitionName), true);
    assert.match(descriptor.capability, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

    const started = api.startSubagent({
      spawnId: `spawn-future-orcme-${role}`,
      childAgentId: `child-future-orcme-${role}`,
      child: descriptor,
      env: {},
    });
    assert.equal(started.ok, true);
    assert.equal(started.env.OBSERVME_AGENT_DISPLAY_NAME, descriptor.displayName);
    assert.equal(started.env.OBSERVME_AGENT_ROLE, role);
    assert.equal(started.env.OBSERVME_AGENT_CAPABILITY, pinnedDefinitionName);
    assert.deepEqual(api.completeSubagent(started.spawnId), { ok: true });
  }

  for (const alias of ["orchestrator", "reviewer", "Worker"]) {
    assert.throws(() => mapFutureOrcMeChildDescriptor({
      durableDisplayIdentity: "Managed alias",
      manifestRole: alias,
      pinnedDefinitionName: "code-review",
    }), TypeError);
  }
});

test("standalone future OrcMe consumer applies structural selection and required-v2 policy", () => {
  const calls = [];
  const v1Api = createNegotiationApi(1, "v1", calls);
  const firstV2Api = createNegotiationApi(2, "first-v2", calls);
  const secondV2Api = createNegotiationApi(2, "second-v2", calls);
  const lateEvents = new LateIntegrationResponseEventBus([v1Api, firstV2Api, secondV2Api]);

  const selected = requestFutureOrcMeObservMeV2({ events: lateEvents });
  lateEvents.respondLate(secondV2Api);
  assert.equal(selected, firstV2Api);

  const malformedV2Apis = [
    Object.freeze({ ...firstV2Api, childRoles: ["lead", "helper", "worker", "validator"] }),
    Object.freeze({ ...firstV2Api, childIdentityEnvelopeVersion: 2 }),
    Object.freeze({ ...firstV2Api, completeSubagent: undefined }),
    Object.freeze({ ...firstV2Api, version: 3 }),
  ];
  for (const malformedApi of malformedV2Apis) {
    assert.equal(requestFutureOrcMeObservMeV2({
      events: new IntegrationResponseEventBus([malformedApi, v1Api]),
    }), undefined);
  }
  assert.deepEqual(calls, [], "required identity rejects v1 before any lifecycle launch");

  let disabledRequestCount = 0;
  const disabledHost = {
    events: {
      emit() {
        disabledRequestCount += 1;
      },
    },
  };
  assert.equal(requestFutureOrcMeObservMeV2(disabledHost, "disabled"), undefined);
  assert.equal(disabledRequestCount, 0);
});

test("future OrcMe definition names remain an unchanged subset of capability values", () => {
  const acceptedDefinitionNames = [
    "lead",
    "code-search",
    "review.security-v2",
    "a".repeat(64),
  ];
  for (const definitionName of acceptedDefinitionNames) {
    assert.equal(isFutureOrcMeDefinitionName(definitionName), true);
    const descriptor = mapFutureOrcMeChildDescriptor({
      durableDisplayIdentity: "Durable Display Identity",
      manifestRole: "validator",
      pinnedDefinitionName: definitionName,
    });
    assert.equal(descriptor.capability, definitionName);
    assert.match(descriptor.capability, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
  }

  for (const invalidDefinitionName of ["Uppercase", "has_underscore", "two..dots", "-leading", "a".repeat(65)]) {
    assert.equal(isFutureOrcMeDefinitionName(invalidDefinitionName), false);
  }
});

test("standalone future OrcMe consumer bridges Pi RPC tombstones and retries only technical IDs", () => {
  const events = createEventBus();
  const session = createFakeTelemetry();
  registerObservMeIntegration({ events }, { session });
  const api = requestFutureOrcMeObservMeV2({ events });
  const trackingApi = new StartCallTrackingApi(api);
  const baseEnvironment = createFutureOrcMeManagedBaseEnvironment();
  const descriptor = mapFutureOrcMeChildDescriptor({
    durableDisplayIdentity: "Durable Retry Worker",
    manifestRole: "worker",
    pinnedDefinitionName: "worker.retry-fixture",
  });
  const duplicate = api.startSubagent({
    spawnId: "spawn-requested-fixture",
    childAgentId: "child-requested-fixture",
    child: descriptor,
    env: baseEnvironment,
  });
  assert.equal(duplicate.ok, true);

  const started = startFutureOrcMePiRpcDelegation(trackingApi, {
    requestedSpawnId: "spawn-requested-fixture",
    requestedChildAgentId: "child-requested-fixture",
    child: descriptor,
    baseEnvironment,
  });
  assert.equal(started.ok, true);
  assert.equal(started.technicalIdsRetried, true);
  assert.equal(trackingApi.startCalls.length, 2);
  const [requestedOptions, retryOptions] = trackingApi.startCalls;
  assert.equal(requestedOptions.spawnId, "spawn-requested-fixture");
  assert.equal(requestedOptions.childAgentId, "child-requested-fixture");
  assert.equal(Object.hasOwn(retryOptions, "spawnId"), false);
  assert.equal(Object.hasOwn(retryOptions, "childAgentId"), false);
  assert.equal(retryOptions.child, requestedOptions.child);
  assert.equal(retryOptions.child, descriptor);
  assert.equal(JSON.stringify(retryOptions.child), JSON.stringify(requestedOptions.child));
  assert.equal(retryOptions.env, requestedOptions.env);
  assert.equal(retryOptions.command, requestedOptions.command);
  assert.deepEqual(retryOptions.args, requestedOptions.args);
  assert.equal(retryOptions.spawnType, "extension");
  assert.equal(retryOptions.spawnReason, "delegated_task");

  for (const [key, value] of Object.entries(started.observMeEnvironment)) {
    assert.equal(Object.hasOwn(started.rpcEnvironment, key), true, key);
    assert.equal(started.rpcEnvironment[key], value, key);
  }
  for (const removedKey of ["OBSERVME_AGENT_ID", "TRACEPARENT", "TRACESTATE"]) {
    assert.equal(Object.hasOwn(started.rpcEnvironment, removedKey), true, removedKey);
    assert.equal(started.rpcEnvironment[removedKey], undefined, removedKey);
  }

  const effectiveEnvironment = simulateFutureOrcMePiRpcOverlay({
    OBSERVME_AGENT_ID: "rpc-process-stale-agent",
    TRACEPARENT: "rpc-process-stale-traceparent",
    TRACESTATE: "rpc-process-stale-tracestate",
    ORCME_RPC_SENTINEL: "synthetic-rpc-only",
  }, started.rpcEnvironment);
  assert.equal(Object.hasOwn(effectiveEnvironment, "OBSERVME_AGENT_ID"), false);
  assert.equal(Object.hasOwn(effectiveEnvironment, "TRACEPARENT"), false);
  assert.equal(Object.hasOwn(effectiveEnvironment, "TRACESTATE"), false);
  assert.equal(effectiveEnvironment.ORCME_RPC_SENTINEL, "synthetic-rpc-only");
  assert.equal(effectiveEnvironment.OBSERVME_AGENT_DISPLAY_NAME, descriptor.displayName);
  assert.equal(effectiveEnvironment.OBSERVME_AGENT_ROLE, descriptor.role);
  assert.equal(effectiveEnvironment.OBSERVME_AGENT_CAPABILITY, descriptor.capability);
  for (const staleKey of [
    "OBSERVME_WORKFLOW_ID",
    "OBSERVME_AGENT_ID",
    "OBSERVME_PARENT_AGENT_ID",
    "OBSERVME_ROOT_AGENT_ID",
    "OBSERVME_PARENT_SESSION_ID",
    "OBSERVME_PARENT_TRACE_ID",
    "OBSERVME_PARENT_SPAN_ID",
    "OBSERVME_AGENT_DEPTH",
    "OBSERVME_SPAWN_ID",
    "OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION",
    "OBSERVME_AGENT_DISPLAY_NAME",
    "OBSERVME_AGENT_ROLE",
    "OBSERVME_AGENT_CAPABILITY",
    "traceparent",
    "tracestate",
    "TRACEPARENT",
    "TRACESTATE",
  ]) {
    assert.notEqual(effectiveEnvironment[staleKey], baseEnvironment[staleKey], staleKey);
  }

  assert.deepEqual(api.completeSubagent(duplicate.spawnId), { ok: true });
  assert.deepEqual(api.completeSubagent(started.spawnId), { ok: true });
});

test("standalone future OrcMe consumer preserves lifecycle ordering and exactly-once calls", async () => {
  const calls = [];
  const api = new FutureOrcMeLifecycleRecordingApi(calls);
  const transport = new FutureOrcMeTransportRecorder(calls);
  const baseEnvironment = createFutureOrcMeManagedBaseEnvironment();
  const child = mapFutureOrcMeChildDescriptor({
    durableDisplayIdentity: "Durable Lifecycle Validator",
    manifestRole: "validator",
    pinnedDefinitionName: "validator.lifecycle-fixture",
  });
  const input = {
    requestedSpawnId: "spawn-lifecycle-fixture",
    requestedChildAgentId: "child-lifecycle-fixture",
    child,
    baseEnvironment,
    launch: transport.launch.bind(transport),
    waitForTerminal: transport.waitForTerminal.bind(transport),
    collectTerminalEvidence: transport.collectTerminalEvidence.bind(transport),
  };

  const completed = await runFutureOrcMePiRpcLifecycle(api, input);
  assert.equal(completed.ok, true);
  assert.equal(completed.terminal.childStatus, "completed");
  assert.equal(completed.evidence.status, "completed");
  assert.equal(transport.launchContext.spawnId, "spawn-lifecycle-fixture");
  assert.equal(transport.launchContext.childAgentId, "child-lifecycle-fixture");
  assert.deepEqual(calls, [
    "startSubagent",
    "launch",
    "startWait",
    "waitForTerminal",
    "endWait",
    "completeSubagent",
    "startJoin",
    "collectTerminalEvidence",
    "endJoin",
  ]);
  for (const call of [
    "startSubagent",
    "startWait",
    "endWait",
    "completeSubagent",
    "startJoin",
    "endJoin",
  ]) {
    assert.equal(calls.filter(recorded => recorded === call).length, 1, call);
  }
  assert.equal(calls.includes("failSubagent"), false);

  const failureCalls = [];
  const failureApi = new FutureOrcMeLifecycleRecordingApi(failureCalls);
  const failingTransport = new FutureOrcMeTransportRecorder(failureCalls, true);
  await assert.rejects(
    runFutureOrcMePiRpcLifecycle(failureApi, {
      ...input,
      launch: failingTransport.launch.bind(failingTransport),
    }),
    /synthetic launcher failure/u,
  );
  assert.deepEqual(failureCalls, ["startSubagent", "launch", "failSubagent"]);
  assert.equal(failureCalls.filter(call => call === "failSubagent").length, 1);
});

test("v2 adapter validates identity before observability mutation and routes v1 metadata-free", () => {
  const events = createEventBus();
  const session = createFakeTelemetry();
  registerObservMeIntegration({ events }, { session });
  const [v2Api] = collectProviderResponses(events, [2, 1]);
  const [v1Api] = collectProviderResponses(events, [1]);
  const originalState = captureSubagentMutationState(session);
  const invalidEnvironment = {
    OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION: "stale-version",
    OBSERVME_AGENT_DISPLAY_NAME: "stale-name",
    OBSERVME_AGENT_ROLE: "stale-role",
    OBSERVME_AGENT_CAPABILITY: "stale-capability",
    UNRELATED: "unchanged",
  };
  const originalEnvironment = { ...invalidEnvironment };

  for (const child of [
    undefined,
    { displayName: "", role: "worker", capability: "code-search" },
    { displayName: "Scout", role: "subagent", capability: "code-search" },
    { displayName: "Scout", role: "worker", capability: "invalid capability" },
  ]) {
    assert.deepEqual(
      v2Api.startSubagent({ spawnId: "spawn-invalid-v2", child, env: invalidEnvironment }),
      { ok: false, reason: "invalid_request" },
    );
    assert.deepEqual(captureSubagentMutationState(session), originalState);
    assert.deepEqual(invalidEnvironment, originalEnvironment);
  }

  const descriptor = { displayName: "Scout", role: "worker", capability: "code-search" };
  const startedV2 = v2Api.startSubagent({
    spawnId: "spawn-valid-v2",
    childAgentId: "child-valid-v2",
    child: descriptor,
    env: invalidEnvironment,
  });
  assert.equal(startedV2.ok, true);
  assert.equal(startedV2.env.OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION, "1");
  assert.equal(startedV2.env.OBSERVME_AGENT_DISPLAY_NAME, "Scout");
  assert.equal(startedV2.env.OBSERVME_AGENT_ROLE, "worker");
  assert.equal(startedV2.env.OBSERVME_AGENT_CAPABILITY, "code-search");
  assert.deepEqual(session.spans.activeSubagentSpawns.get(startedV2.spawnId).childDescriptor, descriptor);
  assert.equal(Object.isFrozen(session.spans.activeSubagentSpawns.get(startedV2.spawnId).childDescriptor), true);
  assert.deepEqual(v1Api.startSubagent({ spawnId: startedV2.spawnId, env: {} }), {
    ok: false,
    reason: "spawn_already_exists",
  });

  const startedV1 = v1Api.startSubagent({
    spawnId: "spawn-valid-v1",
    childAgentId: "child-valid-v1",
    env: invalidEnvironment,
  });
  assert.equal(startedV1.ok, true);
  assert.equal(startedV1.env.OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION, undefined);
  assert.equal(startedV1.env.OBSERVME_AGENT_DISPLAY_NAME, undefined);
  assert.equal(startedV1.env.OBSERVME_AGENT_ROLE, undefined);
  assert.equal(startedV1.env.OBSERVME_AGENT_CAPABILITY, undefined);
  assert.equal(session.spans.activeSubagentSpawns.get(startedV1.spawnId).childDescriptor, undefined);
});

test("rejected v2 identity values never enter diagnostics, logs, snapshots, or metric labels", () => {
  const events = createEventBus();
  const session = createFakeTelemetry();
  registerObservMeIntegration({ events }, { session });
  const [v2Api] = collectProviderResponses(events, [2]);
  const originalState = captureSubagentMutationState(session);
  const rejectedSentinels = ["private-display-value", "private-role-value", "private capability value"];
  const rejectedDescriptors = [
    { displayName: `${rejectedSentinels[0]}\n`, role: "worker", capability: "code-search" },
    { displayName: "Scout", role: rejectedSentinels[1], capability: "code-search" },
    { displayName: "Scout", role: "worker", capability: rejectedSentinels[2] },
  ];
  const diagnostics = [];

  for (const [index, child] of rejectedDescriptors.entries()) {
    diagnostics.push(v2Api.startSubagent({ spawnId: `spawn-private-rejected-${index}`, child, env: {} }));
  }

  assert.deepEqual(diagnostics, new Array(rejectedDescriptors.length).fill({ ok: false, reason: "invalid_request" }));
  assert.deepEqual(captureSubagentMutationState(session), originalState);
  const renderedSnapshot = JSON.stringify({
    diagnostics,
    logs: session.logger.records,
    metricLabels: session.meter.records.map(record => record.attributes),
    tree: session.agentTree.summarize(),
  });
  for (const sentinel of rejectedSentinels) assert.equal(renderedSnapshot.includes(sentinel), false, sentinel);
});

test("v1 and v2 adapters preserve unavailable and closing session fencing", () => {
  const events = createEventBus();
  const state = {};
  registerObservMeIntegration({ events }, state);
  const [v2Api] = collectProviderResponses(events, [2, 1]);
  const [v1Api] = collectProviderResponses(events, [1]);
  const unavailable = { ok: false, reason: "session_unavailable" };

  assert.deepEqual(v1Api.getContext(), unavailable);
  assert.deepEqual(v2Api.getContext(), unavailable);
  assert.deepEqual(v1Api.startSubagent(), unavailable);
  assert.deepEqual(v2Api.startSubagent({}), unavailable);

  state.integrationSessionPhase = "closing";
  const closing = { ok: false, reason: "session_closing" };
  assert.deepEqual(v1Api.getContext(), closing);
  assert.deepEqual(v2Api.getContext(), closing);
  assert.deepEqual(v1Api.startSubagent(), closing);
  assert.deepEqual(v2Api.startSubagent({}), closing);
});

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

test("integration API rejects child environments that Node cannot spawn without mutation", () => {
  const events = createEventBus();
  const session = createFakeTelemetry();
  registerObservMeIntegration({ events }, { session });
  const api = requestObservMeIntegration({ events });
  const originalState = captureSubagentMutationState(session);
  const invalidEnvironments = [
    { name: "NUL key", env: { "INVALID\u0000KEY": "value" } },
    { name: "NUL value", env: { VALID_KEY: "invalid\u0000value" } },
    { name: "equals-sign key", env: { "INVALID=KEY": "value" } },
    { name: "oversized key", env: { ["K".repeat(129)]: "value" } },
  ];

  assert.ok(api);
  for (const invalidEnvironment of invalidEnvironments) {
    assert.deepEqual(
      api.startSubagent({ spawnId: "spawn-invalid-environment", env: invalidEnvironment.env }),
      { ok: false, reason: "invalid_request" },
      invalidEnvironment.name,
    );
    assert.deepEqual(captureSubagentMutationState(session), originalState, invalidEnvironment.name);
  }
});

test("integration API returns a sanitized environment that round-trips through a Node child", () => {
  const events = createEventBus();
  const session = createFakeTelemetry();
  registerObservMeIntegration({ events }, { session });
  const api = requestObservMeIntegration({ events });
  const boundaryKey = "K".repeat(128);
  const roundTripValue = `round-trip-${process.platform}`;

  assert.ok(api);
  const started = api.startSubagent({
    spawnId: "spawn-environment-round-trip",
    env: {
      PATH: process.env.PATH,
      [boundaryKey]: "boundary-value",
      OBSERVME_ROUND_TRIP: roundTripValue,
      OBSERVME_WORKFLOW_ID: "workflow-stale",
      OBSERVME_AGENT_ID: "agent-stale",
      OBSERVME_PARENT_AGENT_ID: "parent-stale",
      OBSERVME_ROOT_AGENT_ID: "root-stale",
      OBSERVME_AGENT_DEPTH: "63",
    },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const launched = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env));"], {
    encoding: "utf8",
    env: started.env,
  });

  assert.equal(launched.error, undefined);
  assert.equal(launched.status, 0, launched.stderr);
  const childEnvironment = JSON.parse(launched.stdout);
  assert.equal(childEnvironment[boundaryKey], "boundary-value");
  assert.equal(childEnvironment.OBSERVME_ROUND_TRIP, roundTripValue);
  assert.equal(childEnvironment.OBSERVME_WORKFLOW_ID, "workflow-integration");
  assert.equal(childEnvironment.OBSERVME_AGENT_ID, undefined);
  assert.equal(childEnvironment.OBSERVME_PARENT_AGENT_ID, "agent-parent");
  assert.equal(childEnvironment.OBSERVME_ROOT_AGENT_ID, "agent-root");
  assert.equal(childEnvironment.OBSERVME_AGENT_DEPTH, "0");
  assert.deepEqual(api.completeSubagent(started.spawnId), { ok: true });
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
