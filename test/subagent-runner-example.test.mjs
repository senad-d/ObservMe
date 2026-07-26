import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { ObservableSubagentRunner } from "../examples/integrations/subagent-runner.ts";
import {
  OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION,
  OBSERVME_CHILD_ROLES,
  OBSERVME_INTEGRATION_CHANNEL,
} from "../src/integration.ts";

function createChildDescriptor(overrides = {}) {
  return { displayName: "Example child", role: "worker", capability: "example.worker", ...overrides };
}

function createIntegrationApi(calls, environments = [{ CHILD_ENV: "propagated" }]) {
  let startIndex = 0;
  return {
    version: 2,
    childRoles: OBSERVME_CHILD_ROLES,
    childIdentityEnvelopeVersion: OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION,
    getContext: () => ({ ok: false, reason: "session_unavailable" }),
    startSubagent(options) {
      calls.push(["startSubagent", options]);
      const suffix = startIndex === 0 ? "" : `-${startIndex + 1}`;
      const environment = environments[startIndex] ?? environments.at(-1);
      startIndex += 1;
      return {
        ok: true,
        spawnId: `spawn-example${suffix}`,
        childAgentId: `child-example${suffix}`,
        env: environment,
        traceContextPropagated: true,
      };
    },
    completeSubagent(spawnId, options) {
      calls.push(["completeSubagent", spawnId, options]);
      return { ok: true };
    },
    failSubagent(spawnId, options) {
      calls.push(["failSubagent", spawnId, options]);
      return { ok: true };
    },
    startWait(options) {
      calls.push(["startWait", options]);
      return { ok: true, id: "wait-example" };
    },
    endWait(waitId, options) {
      calls.push(["endWait", waitId, options]);
      return { ok: true };
    },
    startJoin(options) {
      calls.push(["startJoin", options]);
      return { ok: true, id: "join-example" };
    },
    endJoin(joinId, options) {
      calls.push(["endJoin", joinId, options]);
      return { ok: true };
    },
  };
}

function registerIntegration(events, api) {
  events.on(OBSERVME_INTEGRATION_CHANNEL, request => request.respond(api));
}

test("generic subagent runner forwards child identity and returned environment unchanged", async () => {
  const calls = [];
  const events = createEventBus();
  const child = createChildDescriptor();
  const returnedEnvironment = { CHILD_ENV: "propagated", REMOVED_PARENT_VALUE: undefined };
  registerIntegration(events, createIntegrationApi(calls, [returnedEnvironment]));
  const transport = {
    async launch(request, context) {
      calls.push(["launch", request, context]);
      return { id: "transport-handle" };
    },
    async wait(handle) {
      calls.push(["wait", handle]);
      return { status: "completed", value: "result" };
    },
  };
  const runner = new ObservableSubagentRunner({ events }, transport);

  const result = await runner.run({
    request: { task: "delegated work" },
    child,
    command: "pi",
    spawnType: "extension",
    spawnReason: "delegated_task",
    environment: { BASE_ENV: "present" },
  });

  assert.deepEqual(result, { status: "completed", value: "result" });
  assert.deepEqual(calls.map(call => call[0]), [
    "startSubagent",
    "launch",
    "startWait",
    "wait",
    "endWait",
    "completeSubagent",
    "startJoin",
    "endJoin",
  ]);
  assert.equal(calls[0][1].child, child);
  assert.equal(calls[1][2].environment, returnedEnvironment);
  assert.deepEqual(calls[1][2], {
    environment: returnedEnvironment,
    spawnId: "spawn-example",
    childAgentId: "child-example",
    traceContextPropagated: true,
  });
  assert.deepEqual(calls[5], [
    "completeSubagent",
    "spawn-example",
    { childAgentId: "child-example", childStatus: "completed", outcome: "completed" },
  ]);
});

test("nested launches use fresh descriptors and the immediate parent environment", async () => {
  const calls = [];
  const events = createEventBus();
  const parentEnvironment = { OBSERVME_AGENT_CAPABILITY: "parent.helper", STALE_IDENTITY: undefined };
  const childEnvironment = { OBSERVME_AGENT_CAPABILITY: "child.validator", STALE_IDENTITY: undefined };
  registerIntegration(events, createIntegrationApi(calls, [parentEnvironment, childEnvironment]));

  const parentChild = createChildDescriptor({
    displayName: "Duplicate friendly name",
    role: "helper",
    capability: "parent.helper",
  });
  const nestedChild = createChildDescriptor({
    displayName: "Duplicate friendly name",
    role: "validator",
    capability: "child.validator",
  });
  let parentLaunchContext;
  let nestedLaunchContext;
  const nestedRunner = new ObservableSubagentRunner({ events }, {
    async launch(_request, context) {
      nestedLaunchContext = context;
      return "nested-handle";
    },
    async wait() {
      return { status: "completed" };
    },
  });
  const parentRunner = new ObservableSubagentRunner({ events }, {
    async launch(_request, context) {
      parentLaunchContext = context;
      await nestedRunner.run({ request: "nested work", child: nestedChild, environment: context.environment });
      return "parent-handle";
    },
    async wait() {
      return { status: "completed" };
    },
  });

  await parentRunner.run({ request: "parent work", child: parentChild });

  const startCalls = calls.filter(call => call[0] === "startSubagent");
  assert.equal(startCalls.length, 2);
  assert.equal(startCalls[0][1].child, parentChild);
  assert.equal(startCalls[1][1].child, nestedChild);
  assert.notEqual(startCalls[0][1].child, startCalls[1][1].child);
  assert.equal(startCalls[1][1].env, parentEnvironment);
  assert.equal(parentLaunchContext.environment, parentEnvironment);
  assert.equal(nestedLaunchContext.environment, childEnvironment);
  assert.equal(parentLaunchContext.spawnId, "spawn-example");
  assert.equal(nestedLaunchContext.spawnId, "spawn-example-2");
  assert.equal(parentChild.displayName, nestedChild.displayName);
  assert.notEqual(parentChild.capability, nestedChild.capability);
});

test("v2-unavailable runner stays fail-open without invoking a v1 lifecycle", async () => {
  const v1Calls = [];
  const events = createEventBus();
  const v1Api = { ...createIntegrationApi(v1Calls), version: 1 };
  registerIntegration(events, v1Api);
  const baseEnvironment = { BASE_ENV: "present", REMOVED_VALUE: undefined };
  let launchContext;
  const runner = new ObservableSubagentRunner({ events }, {
    async launch(_request, context) {
      launchContext = context;
      return "handle";
    },
    async wait() {
      return { status: "completed", value: "without-observme" };
    },
  });

  const result = await runner.run({
    request: "work",
    child: createChildDescriptor(),
    environment: baseEnvironment,
  });

  assert.deepEqual(result, { status: "completed", value: "without-observme" });
  assert.equal(launchContext.environment, baseEnvironment);
  assert.equal(launchContext.spawnId, undefined);
  assert.equal(launchContext.traceContextPropagated, false);
  assert.deepEqual(v1Calls, []);
});

test("generic subagent runner preserves returned child failure, cancellation, and timeout distinctions", async () => {
  const resultCases = [
    { status: "failed", childStatus: "failed", joinStatus: "failed", terminal: true },
    { status: "cancelled", childStatus: "cancelled", joinStatus: "cancelled", terminal: true },
    { status: "timeout", childStatus: "active", joinStatus: "timeout", terminal: false },
  ];

  for (const resultCase of resultCases) {
    const calls = [];
    const events = createEventBus();
    registerIntegration(events, createIntegrationApi(calls));
    const transport = {
      async launch() {
        return "handle";
      },
      async wait() {
        return { status: resultCase.status };
      },
    };
    const runner = new ObservableSubagentRunner({ events }, transport);

    assert.deepEqual(await runner.run({ request: "work", child: createChildDescriptor() }), {
      status: resultCase.status,
    });
    const endWait = calls.find(call => call[0] === "endWait");
    const endJoin = calls.find(call => call[0] === "endJoin");
    assert.equal(endWait[2].childStatus, resultCase.childStatus);
    assert.equal(endWait[2].joinStatus, resultCase.joinStatus);
    assert.equal(endJoin[2].childStatus, resultCase.childStatus);
    assert.equal(endJoin[2].joinStatus, resultCase.joinStatus);
    assert.equal(calls.some(call => call[0] === "completeSubagent"), resultCase.terminal);
  }
});

test("generic subagent runner keeps the child active after wait abort and transport failure", async () => {
  const errorCases = [
    { error: new DOMException("cancelled", "AbortError"), joinStatus: "cancelled" },
    { error: new Error("transport read failed"), joinStatus: "unknown" },
  ];

  for (const errorCase of errorCases) {
    const calls = [];
    const events = createEventBus();
    registerIntegration(events, createIntegrationApi(calls));
    const transport = {
      async launch() {
        return "handle";
      },
      async wait() {
        throw errorCase.error;
      },
    };
    const runner = new ObservableSubagentRunner({ events }, transport);

    await assert.rejects(runner.run({ request: "work", child: createChildDescriptor() }), errorCase.error);
    const endWait = calls.find(call => call[0] === "endWait");
    const endJoin = calls.find(call => call[0] === "endJoin");
    assert.equal(endWait[2].childStatus, "active");
    assert.equal(endWait[2].joinStatus, errorCase.joinStatus);
    assert.equal(endJoin[2].childStatus, "active");
    assert.equal(endJoin[2].joinStatus, errorCase.joinStatus);
    assert.equal(calls.some(call => call[0] === "completeSubagent" || call[0] === "failSubagent"), false);
  }
});

test("generic subagent execution can complete once after a timeout", async () => {
  const calls = [];
  const events = createEventBus();
  registerIntegration(events, createIntegrationApi(calls));
  const results = [{ status: "timeout" }, { status: "completed", value: "late-result" }];
  let waitIndex = 0;
  const transport = {
    async launch() {
      return "handle";
    },
    async wait() {
      const result = results[waitIndex];
      waitIndex += 1;
      return result;
    },
  };
  const runner = new ObservableSubagentRunner({ events }, transport);
  const execution = await runner.start({ request: "work", child: createChildDescriptor() });

  assert.deepEqual(await execution.wait(), { status: "timeout" });
  assert.deepEqual(await execution.wait(), { status: "completed", value: "late-result" });
  assert.deepEqual(await execution.wait(), { status: "completed", value: "late-result" });
  assert.equal(waitIndex, 2);
  assert.equal(calls.filter(call => call[0] === "completeSubagent").length, 1);
  assert.deepEqual(
    calls.filter(call => call[0] === "endWait").map(call => [call[2].childStatus, call[2].joinStatus]),
    [["active", "timeout"], ["completed", "completed"]],
  );
});

test("generic subagent runner separates launcher failure from launch cancellation", async () => {
  const launchCases = [
    { error: new Error("launch failed"), expectedMethod: "failSubagent", expectedStatus: undefined },
    { error: new DOMException("cancelled", "AbortError"), expectedMethod: "completeSubagent", expectedStatus: "cancelled" },
  ];

  for (const launchCase of launchCases) {
    const calls = [];
    const events = createEventBus();
    registerIntegration(events, createIntegrationApi(calls));
    const transport = {
      async launch() {
        throw launchCase.error;
      },
      async wait() {
        return { status: "completed" };
      },
    };
    const runner = new ObservableSubagentRunner({ events }, transport);

    await assert.rejects(runner.run({ request: "work", child: createChildDescriptor() }), launchCase.error);
    const outcomeCall = calls.find(call => call[0] === launchCase.expectedMethod);
    assert.ok(outcomeCall);
    if (launchCase.expectedStatus) assert.equal(outcomeCall[2].childStatus, launchCase.expectedStatus);
    assert.equal(calls.some(call => call[0] === "startWait"), false);
  }
});

test("generic subagent runner remains transport-functional when ObservMe is absent", async () => {
  const events = createEventBus();
  let launchContext;
  const transport = {
    async launch(_request, context) {
      launchContext = context;
      return "handle";
    },
    async wait() {
      return { status: "completed", value: 42 };
    },
  };
  const runner = new ObservableSubagentRunner({ events }, transport);
  const result = await runner.run({
    request: "work",
    child: createChildDescriptor(),
    environment: { BASE_ENV: "present" },
  });

  assert.deepEqual(result, { status: "completed", value: 42 });
  assert.deepEqual(launchContext, {
    environment: { BASE_ENV: "present" },
    spawnId: undefined,
    childAgentId: undefined,
    traceContextPropagated: false,
  });
});
