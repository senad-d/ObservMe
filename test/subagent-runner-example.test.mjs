import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { ObservableSubagentRunner } from "../examples/integrations/subagent-runner.ts";
import { OBSERVME_INTEGRATION_CHANNEL } from "../src/integration.ts";

function createIntegrationApi(calls) {
  return {
    version: 1,
    getContext: () => ({ ok: false, reason: "session_unavailable" }),
    startSubagent(options) {
      calls.push(["startSubagent", options]);
      return {
        ok: true,
        spawnId: "spawn-example",
        childAgentId: "child-example",
        env: { CHILD_ENV: "propagated" },
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

test("generic subagent runner wraps any transport with ObservMe lifecycle", async () => {
  const calls = [];
  const events = createEventBus();
  registerIntegration(events, createIntegrationApi(calls));
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
    command: "pi",
    spawnType: "extension",
    spawnReason: "delegated_task",
    environment: { BASE_ENV: "present" },
  });

  assert.deepEqual(result, { status: "completed", value: "result" });
  assert.deepEqual(calls.map(call => call[0]), [
    "startSubagent",
    "launch",
    "completeSubagent",
    "startWait",
    "wait",
    "endWait",
    "startJoin",
    "endJoin",
  ]);
  assert.deepEqual(calls[1][2], {
    environment: { CHILD_ENV: "propagated" },
    spawnId: "spawn-example",
    childAgentId: "child-example",
    traceContextPropagated: true,
  });
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
  const result = await runner.run({ request: "work", environment: { BASE_ENV: "present" } });

  assert.deepEqual(result, { status: "completed", value: 42 });
  assert.deepEqual(launchContext, {
    environment: { BASE_ENV: "present" },
    spawnId: undefined,
    childAgentId: undefined,
    traceContextPropagated: false,
  });
});
