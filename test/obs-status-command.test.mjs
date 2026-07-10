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

const trustedProjectConfigYaml = `
observme:
  environment: development
  otlp:
    endpoint: https://otel.project.test:4318
  query:
    grafana:
      url: https://grafana.project.test
      token: ""
      username: smoke
      password: smoke
`;

const trustedProjectEnvText = `
OBSERVME_OTLP_ENDPOINT=https://otlp-user:otlp-password@collector.local:4318?token=otlp-query-secret
OBSERVME_OTLP_TOKEN=otlp-header-secret
OBSERVME_GRAFANA_URL=https://grafana-user:grafana-password@grafana.local:3000?token=grafana-query-secret
OBSERVME_GRAFANA_TOKEN=grafana-token-secret
OBSERVME_GRAFANA_USERNAME=admin
OBSERVME_GRAFANA_PASSWORD=grafana-basic-secret
`;

function createCommandContext(notifications, projectTrusted = false) {
  return {
    cwd: "/workspace/demo",
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
    },
    isProjectTrusted: () => projectTrusted,
  };
}

function createPrintCommandContext() {
  return {
    cwd: "/workspace/demo",
    hasUI: false,
    isProjectTrusted: () => false,
  };
}

function createReader(files, calls = []) {
  return async path => {
    calls.push(path);
    if (Object.hasOwn(files, path)) return files[path];

    const error = new Error(`Missing fixture ${path}`);
    error.code = "ENOENT";
    throw error;
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
      "Grafana URL: https://grafana.example.com/",
      "Grafana query readiness: not_ready (unresolved_grafana_token)",
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

test("renderObsStatus includes only bounded config rejection codes and counts", () => {
  const output = renderObsStatus({
    config: cloneDefaultConfig(),
    queueDrops: 0,
    configDiagnostics: {
      projectTrusted: false,
      projectConfigStatus: "skipped_untrusted",
      effectiveSource: "environment",
      globalConfigLoaded: false,
      environmentOverrides: true,
      runtimeOptionsApplied: false,
      rejection: {
        issueCodes: ["insecure_production_transport", "malformed_lineage_value"],
        issueCount: 2,
      },
    },
  });

  assert.match(
    output,
    /Config rejection: safe defaults applied \(2 issue\(s\): insecure_production_transport, malformed_lineage_value\)/u,
  );
  assert.doesNotMatch(output, /private-token|password|Authorization|\/workspace\/private|custom regex/u);
});

test("/obs status does not throw when Pi has no UI notification API", async t => {
  resetObsStatusRuntimeState();
  t.after(() => resetObsStatusRuntimeState());

  updateObsStatusRuntimeState({ config: cloneDefaultConfig() });

  await assert.doesNotReject(() => handleObsStatusCommand("status", createPrintCommandContext()));
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

test("/obs status reports trusted project config source and Grafana query readiness", async t => {
  resetObsStatusRuntimeState();
  t.after(() => resetObsStatusRuntimeState());

  const notifications = [];
  const readCalls = [];
  await handleObsStatusCommand("status", createCommandContext(notifications, true), {
    globalConfigPath: "global.yaml",
    projectConfigPath: "project.yaml",
    readText: createReader({ "/workspace/demo/project.yaml": trustedProjectConfigYaml }, readCalls),
    env: {},
  });

  assert.deepEqual(readCalls, ["global.yaml", "/workspace/demo/project.yaml", "/workspace/demo/.env"]);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /OTLP endpoint: https:\/\/otel\.project\.test:4318/u);
  assert.match(notifications[0].message, /Config source: trusted project config \(\.pi\/observme\.yaml\)/u);
  assert.match(notifications[0].message, /Project config: loaded \(trusted \.pi\/observme\.yaml\)/u);
  assert.match(notifications[0].message, /Grafana URL: https:\/\/grafana\.project\.test\//u);
  assert.match(notifications[0].message, /Grafana query readiness: ready/u);
});

test("/obs status does not render trusted project .env secret values", async t => {
  resetObsStatusRuntimeState();
  t.after(() => resetObsStatusRuntimeState());

  const notifications = [];
  await handleObsStatusCommand("status", createCommandContext(notifications, true), {
    globalConfigPath: "global.yaml",
    projectConfigPath: "project.yaml",
    readText: createReader({ "/workspace/demo/.env": trustedProjectEnvText }),
    env: {},
  });

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /OTLP endpoint: https:\/\/collector\.local:4318/u);
  assert.match(notifications[0].message, /Grafana URL: https:\/\/grafana\.local:3000\//u);
  assert.doesNotMatch(
    notifications[0].message,
    /otlp-user|otlp-password|otlp-query-secret|otlp-header-secret|grafana-user|grafana-password|grafana-query-secret|grafana-token-secret|grafana-basic-secret/u,
  );
});

test("/obs status sanitizes load and export diagnostics", async t => {
  resetObsStatusRuntimeState();
  t.after(() => resetObsStatusRuntimeState());

  const loadNotifications = [];
  await handleObsStatusCommand("status", createCommandContext(loadNotifications), {
    loadConfig: async () => {
      throw new Error("Authorization: Bearer loader-token prompt: hidden prompt /tmp/private.env OBSERVME_GRAFANA_PASSWORD=loader-secret");
    },
  });

  assert.equal(loadNotifications[0].type, "error");
  assert.doesNotMatch(loadNotifications[0].message, /loader-token|hidden prompt|private\.env|loader-secret/u);

  const config = cloneDefaultConfig();
  updateObsStatusRuntimeState({ config });
  recordObsStatusExportResult({
    operation: "flush",
    error: new Error("Authorization: Bearer export-token command: curl secret /Users/alice/private/.env OBSERVME_TOKEN=export-secret"),
  });

  const exportNotifications = [];
  await handleObsStatusCommand("status", createCommandContext(exportNotifications));

  assert.equal(exportNotifications[0].type, "info");
  assert.match(exportNotifications[0].message, /Last export error: flush failed/u);
  assert.doesNotMatch(exportNotifications[0].message, /export-token|curl secret|private\/\.env|export-secret/u);
});

test("/obs status explains untrusted project config is skipped", async t => {
  resetObsStatusRuntimeState();
  t.after(() => resetObsStatusRuntimeState());

  const notifications = [];
  const readCalls = [];
  await handleObsStatusCommand("status", createCommandContext(notifications, false), {
    globalConfigPath: "global.yaml",
    projectConfigPath: "project.yaml",
    readText: createReader({ "project.yaml": trustedProjectConfigYaml }, readCalls),
    env: {},
  });

  assert.deepEqual(readCalls, ["global.yaml"]);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /OTLP endpoint: https:\/\/otel-collector\.example\.com:4318/u);
  assert.match(notifications[0].message, /Config source: defaults/u);
  assert.match(notifications[0].message, /Project config: skipped \(project is untrusted; safe defaults\/global\/env only\)/u);
  assert.doesNotMatch(notifications[0].message, /otel\.project\.test/u);
});

test("/obs status explains missing trusted project config", async t => {
  resetObsStatusRuntimeState();
  t.after(() => resetObsStatusRuntimeState());

  const notifications = [];
  const readCalls = [];
  await handleObsStatusCommand("status", createCommandContext(notifications, true), {
    globalConfigPath: "global.yaml",
    projectConfigPath: "project.yaml",
    readText: createReader({}, readCalls),
    env: {},
  });

  assert.deepEqual(readCalls, ["global.yaml", "/workspace/demo/project.yaml", "/workspace/demo/.env"]);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /Config source: defaults/u);
  assert.match(notifications[0].message, /Project config: missing \(trusted project has no \.pi\/observme\.yaml\)/u);
  assert.match(notifications[0].message, /Grafana query readiness: not_ready \(unresolved_grafana_token\)/u);
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
