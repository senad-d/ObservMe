import assert from "node:assert/strict";
import test from "node:test";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";
import {
  clearObsSessionRuntimeState,
  handleObsSessionCommand,
  recordObsSessionCost,
  recordObsSessionLlmCall,
  recordObsSessionToolCall,
  recordObsSessionTurn,
  renderObsSession,
  startObsSessionRuntimeState,
} from "../src/commands/obs-session.ts";

const traceId = "4bf92f00000000000000000000000000";

function createCommandContext(notifications) {
  return {
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
    },
  };
}

function createFakeCommandPi() {
  const commands = new Map();
  return {
    commands,
    registerCommand: (name, options) => commands.set(name, options),
  };
}

test("renderObsSession reports current session counts, cost, and trace link", () => {
  const output = renderObsSession({
    sessionId: "session-1",
    traceId,
    turns: 12,
    llmCalls: 18,
    toolCalls: 35,
    costUsd: 1.42,
    traceLink: `https://grafana.local/explore?trace=${traceId}`,
  });

  assert.equal(
    output,
    [
      "Session: session-1",
      `Trace: ${traceId}`,
      "Turns: 12",
      "LLM calls: 18",
      "Tool calls: 35",
      "Cost: $1.42",
      `Open trace: https://grafana.local/explore?trace=${traceId}`,
    ].join("\n"),
  );
});

test("/obs session reads in-memory runtime state and makes no network call", async t => {
  clearObsSessionRuntimeState();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network should not be used");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearObsSessionRuntimeState();
  });

  startObsSessionRuntimeState({
    sessionId: "session-abc",
    traceId,
    traceUrlTemplate: "https://grafana.local/explore?trace={traceId}",
  });
  recordObsSessionTurn(2);
  recordObsSessionLlmCall(3);
  recordObsSessionToolCall(5);
  recordObsSessionCost(1.425);

  const notifications = [];
  await handleObsSessionCommand("session", createCommandContext(notifications));

  assert.equal(fetchCalls, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "info");
  assert.equal(
    notifications[0].message,
    [
      "Session: session-abc",
      `Trace: ${traceId}`,
      "Turns: 2",
      "LLM calls: 3",
      "Tool calls: 5",
      "Cost: $1.43",
      `Open trace: https://grafana.local/explore?trace=${traceId}`,
    ].join("\n"),
  );
});

test("root obs command dispatches session subcommand", async () => {
  const pi = createFakeCommandPi();
  registerObsCommand(pi, {
    session: {
      getSession: () => ({
        sessionId: "session-root",
        traceId,
        turns: 1,
        llmCalls: 2,
        toolCalls: 3,
        costUsd: 0.5,
      }),
    },
  });

  const command = pi.commands.get("obs");
  const notifications = [];
  await command.handler("session", createCommandContext(notifications));

  assert.deepEqual(getObsRootCommandArgumentCompletions("se"), [{ value: "session", label: "session" }]);
  assert.match(notifications[0].message, /Session: session-root/u);
  assert.match(notifications[0].message, /Cost: \$0\.50/u);
});
