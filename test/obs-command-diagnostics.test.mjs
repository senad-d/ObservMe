import assert from "node:assert/strict";
import test from "node:test";
import { handleObsCostCommand } from "../src/commands/obs-cost.ts";
import { handleObsErrorsCommand } from "../src/commands/obs-errors.ts";
import { handleObsLogsCommand } from "../src/commands/obs-logs.ts";
import { handleObsToolsCommand } from "../src/commands/obs-tools.ts";
import { handleObsTraceCommand } from "../src/commands/obs-trace.ts";
import { defaultObservMeConfig } from "../src/config/defaults.ts";

const fixedNow = new Date("2026-07-07T12:00:00.000Z");

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

function createQueryReadyConfig() {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.username = "";
  config.query.grafana.password = "";
  config.query.grafana.datasourceUids = {
    tempo: "tempo/main",
    loki: "loki/main",
    prometheus: "mimir/main",
  };
  return config;
}

function createJsonResponse(payload, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(payload), { status, statusText, headers: { "content-type": "application/json" } });
}

function createEmptyPrometheusResponse() {
  return createJsonResponse({ status: "success", data: { resultType: "vector", result: [] } });
}

function createEmptyLokiResponse() {
  return createJsonResponse({ status: "success", data: { resultType: "streams", result: [] } });
}

function createEmptyTempoResponse() {
  return createJsonResponse({ traces: [] });
}

function assertNoSensitiveDiagnosticText(message) {
  assert.doesNotMatch(message, /grafana-token/u);
  assert.doesNotMatch(message, /raw prompt body/u);
  assert.doesNotMatch(message, /\/Users\/senad/u);
  assert.doesNotMatch(message, /rm -rf/u);
  assert.doesNotMatch(message, /OBSERVME_TOKEN=super-secret/u);
}

test("/obs logs explains a missing current session with a concrete next action", async () => {
  const notifications = [];

  await handleObsLogsCommand("logs", createCommandContext(notifications), {
    getSession: () => ({ sessionId: undefined }),
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /ObservMe logs unavailable: Session: No current ObservMe session id is available\./u);
  assert.match(notifications[0].message, /Next: run \/obs session to confirm a current session before \/obs logs\./u);
  assertNoSensitiveDiagnosticText(notifications[0].message);
});

test("query-backed /obs commands report disabled integration consistently without network calls", async () => {
  const config = createQueryReadyConfig();
  config.query.enabled = false;
  const notifications = [];
  let fetchCalls = 0;
  const options = {
    loadConfig: async () => config,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("disabled query commands must not make network calls");
    },
  };

  await handleObsCostCommand("cost", createCommandContext(notifications), options);
  await handleObsToolsCommand("tools", createCommandContext(notifications), options);
  await handleObsErrorsCommand("errors", createCommandContext(notifications), options);
  await handleObsLogsCommand("logs", createCommandContext(notifications), {
    ...options,
    getSession: () => ({ sessionId: "session-1" }),
    now: () => fixedNow,
  });
  await handleObsTraceCommand("trace --session session-remote", createCommandContext(notifications), {
    ...options,
    getSession: () => ({ sessionId: "session-local", traceId: undefined, turns: 0 }),
    now: () => fixedNow,
  });

  assert.equal(fetchCalls, 0);
  assert.equal(notifications.length, 5);
  for (const notification of notifications) {
    assert.equal(notification.type, "error");
    assert.match(notification.message, /Grafana query integration is disabled \(query\.enabled=false\)\./u);
    assert.match(notification.message, /Next: set query\.enabled=true to enable Grafana-backed commands\./u);
    assert.doesNotMatch(notification.message, /generate|wait for telemetry|verify .* datasource/iu);
  }
});

test("/obs cost reports missing Grafana auth before fetching", async () => {
  const config = createQueryReadyConfig();
  config.query.grafana.token = "";
  const notifications = [];
  let fetchCalls = 0;

  await handleObsCostCommand("cost", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: async () => {
      fetchCalls += 1;
      return createEmptyPrometheusResponse();
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /Prometheus: Grafana query configuration is not ready/u);
  assert.match(notifications[0].message, /query\.grafana\.token is missing/u);
  assert.match(
    notifications[0].message,
    /Next: run \/obs health and verify query\.grafana\.url, Grafana credentials, and the Metrics datasource UID\./u,
  );
  assertNoSensitiveDiagnosticText(notifications[0].message);
});

test("/obs cost reports unauthorized Grafana without exposing the configured token", async () => {
  const notifications = [];

  await handleObsCostCommand("cost", createCommandContext(notifications), {
    loadConfig: async () => createQueryReadyConfig(),
    fetch: async () => new Response("{}", { status: 401, statusText: "Unauthorized" }),
  });

  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /Prometheus: Prometheus query failed: HTTP 401 Unauthorized/u);
  assert.match(
    notifications[0].message,
    /Next: run \/obs health and verify query\.grafana\.url, Grafana credentials, and the Metrics datasource UID\./u,
  );
  assertNoSensitiveDiagnosticText(notifications[0].message);
});

test("/obs cost reports timeouts with the Prometheus subsystem and recovery hint", async () => {
  const notifications = [];

  await handleObsCostCommand("cost", createCommandContext(notifications), {
    loadConfig: async () => createQueryReadyConfig(),
    fetch: async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    },
  });

  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /Prometheus: Prometheus query timed out\./u);
  assert.match(
    notifications[0].message,
    /Next: run \/obs health and verify query\.grafana\.url, Grafana credentials, and the Metrics datasource UID\./u,
  );
  assertNoSensitiveDiagnosticText(notifications[0].message);
});

test("/obs cost redacts raw diagnostic content before rendering errors", async () => {
  const notifications = [];

  await handleObsCostCommand("cost", createCommandContext(notifications), {
    loadConfig: async () => createQueryReadyConfig(),
    fetch: async () => {
      throw new Error(
        "Authorization: Bearer grafana-token Prompt: raw prompt body /Users/senad/project rm -rf /tmp/demo OBSERVME_TOKEN=super-secret.",
      );
    },
  });

  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /Prometheus:/u);
  assert.match(
    notifications[0].message,
    /Next: run \/obs health and verify query\.grafana\.url, Grafana credentials, and the Metrics datasource UID\./u,
  );
  assertNoSensitiveDiagnosticText(notifications[0].message);
});

test("/obs cost adds a metrics recovery hint when no metrics are found", async () => {
  const notifications = [];

  await handleObsCostCommand("cost", createCommandContext(notifications), {
    loadConfig: async () => createQueryReadyConfig(),
    fetch: async () => createEmptyPrometheusResponse(),
  });

  assert.equal(notifications[0].type, "info");
  assert.match(notifications[0].message, /No cost metrics found\./u);
  assert.match(notifications[0].message, /Next: generate LLM usage, then verify the Metrics datasource with \/obs health\./u);
  assertNoSensitiveDiagnosticText(notifications[0].message);
});

test("/obs logs adds a Loki recovery hint when no logs are found", async () => {
  const notifications = [];

  await handleObsLogsCommand("logs", createCommandContext(notifications), {
    loadConfig: async () => createQueryReadyConfig(),
    fetch: async () => createEmptyLokiResponse(),
    getSession: () => ({ sessionId: "session-1" }),
    now: () => fixedNow,
  });

  assert.equal(notifications[0].type, "info");
  assert.match(notifications[0].message, /No session logs found\./u);
  assert.match(notifications[0].message, /Next: wait for telemetry export, then verify Loki labels and datasource with \/obs health\./u);
  assertNoSensitiveDiagnosticText(notifications[0].message);
});

test("/obs trace reports no remote trace with a Tempo recovery hint", async () => {
  const notifications = [];

  await handleObsTraceCommand("trace --session session-remote", createCommandContext(notifications), {
    loadConfig: async () => createQueryReadyConfig(),
    fetch: async () => createEmptyTempoResponse(),
    getSession: () => ({ sessionId: "session-local", traceId: undefined, turns: 0 }),
    now: () => fixedNow,
  });

  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /Tempo: No trace was found for the requested ObservMe session id\./u);
  assert.match(notifications[0].message, /Next: check the session id, wait for trace export, then verify Tempo datasource with \/obs health\./u);
  assertNoSensitiveDiagnosticText(notifications[0].message);
});
