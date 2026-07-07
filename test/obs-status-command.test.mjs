import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import observMeExtension from "../src/extension.ts";
import {
  getObsCommandArgumentCompletions,
  handleObsStatusCommand,
  recordObsStatusExportResult,
  registerObsStatusCommand,
  recordObsStatusQueueDrop,
  renderObsStatus,
  resetObsStatusRuntimeState,
  updateObsStatusRuntimeState,
} from "../src/commands/obs-status.ts";

function cloneDefaultConfig() {
  return structuredClone(defaultObservMeConfig);
}

function createCommandContext(notifications) {
  return {
    cwd: "/workspace/demo",
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
    },
    isProjectTrusted: () => false,
  };
}

function createFakeCommandPi() {
  const commands = new Map();
  return {
    commands,
    registerCommand: (name, options) => commands.set(name, options),
  };
}

function createFakeExtensionPi() {
  const commands = new Map();
  const events = new Map();
  const tools = [];
  return {
    commands,
    events,
    tools,
    on: (eventName, handler) => events.set(eventName, handler),
    registerCommand: (name, options) => commands.set(name, options),
    registerTool: tool => tools.push(tool),
  };
}

test("renderObsStatus reports local enablement, signals, capture flags, drops, and errors", () => {
  const config = cloneDefaultConfig();
  config.otlp.endpoint = "http://localhost:4318";
  config.metrics.enabled = false;
  config.capture.prompts = true;
  config.capture.toolArguments = true;
  config.capture.bashOutput = true;

  const output = renderObsStatus({ config, queueDrops: 2, lastExportError: "flush failed" });

  assert.equal(
    output,
    [
      "ObservMe: enabled",
      "OTLP endpoint: http://localhost:4318",
      "Traces: enabled",
      "Metrics: disabled",
      "Logs: enabled",
      "Prompt capture: enabled",
      "Response capture: disabled",
      "Thinking capture: disabled",
      "Tool argument capture: enabled",
      "Tool result capture: disabled",
      "Bash command capture: disabled",
      "Bash output capture: enabled",
      "File path capture: disabled",
      "Queue drops: 2",
      "Last export error: flush failed",
    ].join("\n"),
  );
});

test("/obs status uses local status state and makes no network call", async t => {
  resetObsStatusRuntimeState();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network should not be used");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    resetObsStatusRuntimeState();
  });

  const config = cloneDefaultConfig();
  config.otlp.endpoint = "https://otel.local:4318";
  updateObsStatusRuntimeState({ config });
  recordObsStatusQueueDrop(3);
  recordObsStatusExportResult({ operation: "flush", timedOut: true });

  const notifications = [];
  await handleObsStatusCommand("status", createCommandContext(notifications));

  assert.equal(fetchCalls, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "info");
  assert.match(notifications[0].message, /OTLP endpoint: https:\/\/otel\.local:4318/u);
  assert.match(notifications[0].message, /Queue drops: 3/u);
  assert.match(notifications[0].message, /Last export error: flush timed out/u);
});

test("obs command registers status completion and warns for unknown subcommands", async () => {
  const pi = createFakeCommandPi();
  const config = cloneDefaultConfig();

  registerObsStatusCommand(pi, { getStatus: () => ({ config, queueDrops: 0 }) });

  const command = pi.commands.get("obs");
  const notifications = [];
  await command.handler("health", createCommandContext(notifications));

  assert.deepEqual(getObsCommandArgumentCompletions("sta"), [{ value: "status", label: "status" }]);
  assert.deepEqual(command.getArgumentCompletions("sta"), [{ value: "status", label: "status" }]);
  assert.deepEqual(notifications, [{ message: "Usage: /obs status", type: "warning" }]);
});

test("extension registers the /obs command", () => {
  const pi = createFakeExtensionPi();

  observMeExtension(pi);

  assert.ok(pi.commands.has("obs"));
});
