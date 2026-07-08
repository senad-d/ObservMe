import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";
import {
  OBS_COST_AGGREGATE_PROMQL,
  getObsCostSnapshot,
  handleObsCostCommand,
  renderObsCost,
} from "../src/commands/obs-cost.ts";
import { findForbiddenPrometheusLabels } from "../src/query/prometheus.ts";

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

function createCostResponse() {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          {
            metric: { model: "claude-sonnet", provider: "anthropic" },
            value: [1783422000.25, "1.42"],
          },
          {
            metric: { model: "gpt-4.1", provider: "openai" },
            value: [1783422000.25, "0.98"],
          },
        ],
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function createMalformedCostResponse() {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: { token: "super-secret-token", body: "Bearer backend-secret" },
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function createEmptyCostResponse() {
  return new Response(
    JSON.stringify({
      status: "success",
      data: { resultType: "vector", result: [] },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

test("renderObsCost reports aggregate cost rows and total", () => {
  const output = renderObsCost({
    window: "24h",
    query: OBS_COST_AGGREGATE_PROMQL,
    rows: [
      { model: "claude-sonnet", provider: "anthropic", costUsd: 1.42 },
      { model: "gpt-4.1", provider: "openai", costUsd: 0.98 },
    ],
  });

  assert.equal(
    output,
    [
      "Cost by model/provider (last 24h)",
      "claude-sonnet / anthropic: $1.42",
      "gpt-4.1 / openai: $0.98",
      "Total: $2.40",
    ].join("\n"),
  );
});

test("/obs cost queries aggregate model/provider PromQL with configured timeout and result limit", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 1234;
  config.query.maxMetricSeries = 1;
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.prometheus = "mimir/main";

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal);
    return createCostResponse();
  };

  const snapshot = await getObsCostSnapshot(createCommandContext([]), {
    loadConfig: async () => config,
    fetch: fetcher,
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].input);
  const query = url.searchParams.get("query");
  assert.equal(query, OBS_COST_AGGREGATE_PROMQL);
  assert.equal(query.includes("session"), false);
  assert.equal(query.includes("pi_session_id"), false);
  assert.match(query, /by \(model, provider\)$/u);
  assert.deepEqual(findForbiddenPrometheusLabels(query), []);
  assert.equal(url.searchParams.get("limit"), "1");
  assert.equal(url.searchParams.get("timeout"), "1.234s");
  assert.equal(calls[0].init.headers.Authorization, "Bearer grafana-token");
  assert.equal(snapshot.rows.length, 1);
  assert.deepEqual(snapshot.rows[0], {
    model: "claude-sonnet",
    provider: "anthropic",
    costUsd: 1.42,
    timestampUnixSeconds: "1783422000.25",
  });
});

test("/obs cost reports malformed Prometheus payloads as backend schema errors, not no-data hints", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "grafana-token";
  const notifications = [];

  await handleObsCostCommand("cost", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: async () => createMalformedCostResponse(),
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /ObservMe cost unavailable: Prometheus: Prometheus query failed: backend schema error/u);
  assert.match(notifications[0].message, /data\.result must be an array/u);
  assert.doesNotMatch(notifications[0].message, /No cost metrics found/u);
  assert.doesNotMatch(notifications[0].message, /super-secret-token|Bearer backend-secret/u);
});

test("/obs cost keeps no-data recovery hints for legitimate empty Prometheus responses", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "grafana-token";
  const notifications = [];

  await handleObsCostCommand("cost", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: async () => createEmptyCostResponse(),
  });

  assert.deepEqual(notifications, [
    {
      message: [
        "Cost by model/provider (last 24h)",
        "No cost metrics found. Next: generate LLM usage, then verify the Metrics datasource with /obs health.",
      ].join("\n"),
      type: "info",
    },
  ]);
});

test("/obs cost rejects session-scoped Prometheus cost queries by default before fetching", async () => {
  const notifications = [];
  let loadCalls = 0;
  let fetchCalls = 0;

  await handleObsCostCommand("cost --session session-1", createCommandContext(notifications), {
    loadConfig: async () => {
      loadCalls += 1;
      return cloneDefaultConfig();
    },
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run for disabled session-scoped cost queries");
    },
  });

  assert.equal(loadCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(notifications, [
    {
      message: "Session-scoped Prometheus cost queries are disabled by default. Usage: /obs cost",
      type: "warning",
    },
  ]);
});

test("/obs cost fails fast when Grafana token is unresolved without exposing placeholder values", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "${OBSERVME_GRAFANA_TOKEN}";
  let fetchCalls = 0;
  const notifications = [];

  await handleObsCostCommand("cost", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run when query auth is unresolved");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /ObservMe cost unavailable: Prometheus: Grafana query configuration is not ready/u);
  assert.match(notifications[0].message, /query\.grafana\.token is unresolved/u);
  assert.match(
    notifications[0].message,
    /Next: run \/obs health and verify query\.grafana\.url, Grafana credentials, and the Metrics datasource UID\./u,
  );
  assert.doesNotMatch(notifications[0].message, /\$\{OBSERVME_GRAFANA_TOKEN\}/u);
});

test("root obs command dispatches cost subcommand", async () => {
  const pi = createFakeCommandPi();
  registerObsCommand(pi, {
    cost: {
      getCost: () => ({ window: "24h", query: OBS_COST_AGGREGATE_PROMQL, rows: [] }),
    },
  });

  const command = pi.commands.get("obs");
  const notifications = [];
  await command.handler("cost", createCommandContext(notifications));

  assert.deepEqual(getObsRootCommandArgumentCompletions("co"), [{ value: "cost", label: "cost" }]);
  assert.equal(notifications[0].type, "info");
  assert.equal(
    notifications[0].message,
    [
      "Cost by model/provider (last 24h)",
      "No cost metrics found. Next: generate LLM usage, then verify the Metrics datasource with /obs health.",
    ].join("\n"),
  );
});
