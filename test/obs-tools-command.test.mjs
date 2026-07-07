import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";
import {
  OBS_TOOLS_CALLS_PROMQL,
  OBS_TOOLS_FAILURES_PROMQL,
  getObsToolsSnapshot,
  renderObsTools,
} from "../src/commands/obs-tools.ts";
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

function createToolsResponseForQuery(query) {
  if (query === OBS_TOOLS_CALLS_PROMQL) return createToolCallsResponse();
  if (query === OBS_TOOLS_FAILURES_PROMQL) return createToolFailuresResponse();
  throw new Error(`Unexpected PromQL query: ${query}`);
}

function createToolCallsResponse() {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          {
            metric: { tool_name: "read" },
            value: [1783422000.25, "0.25"],
          },
          {
            metric: { tool_name: "bash" },
            value: [1783422000.25, "0.125"],
          },
        ],
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function createToolFailuresResponse() {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          {
            metric: { tool_name: "bash", error_class: "TimeoutError" },
            value: [1783422000.25, "0.05"],
          },
          {
            metric: { tool_name: "read", error_class: "NotFound" },
            value: [1783422000.25, "0.01"],
          },
        ],
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

test("renderObsTools reports tool call and failure rates", () => {
  const output = renderObsTools({
    window: "1h",
    callQuery: OBS_TOOLS_CALLS_PROMQL,
    failureQuery: OBS_TOOLS_FAILURES_PROMQL,
    calls: [
      { toolName: "read", ratePerSecond: 0.25 },
      { toolName: "bash", ratePerSecond: 0.125 },
    ],
    failures: [
      { toolName: "bash", errorClass: "TimeoutError", ratePerSecond: 0.05 },
      { toolName: "read", errorClass: "NotFound", ratePerSecond: 0.01 },
    ],
  });

  assert.equal(
    output,
    [
      "Tool calls by tool (last 1h)",
      "read: 0.25/s",
      "bash: 0.125/s",
      "Tool failures by tool/error (last 1h)",
      "bash / TimeoutError: 0.05/s",
      "read / NotFound: 0.01/s",
    ].join("\n"),
  );
});

test("/obs tools queries documented PromQL with configured timeout and result limit", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 987;
  config.query.maxMetricSeries = 1;
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.prometheus = "mimir/main";

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal);

    const query = new URL(String(input)).searchParams.get("query");
    return createToolsResponseForQuery(query);
  };

  const snapshot = await getObsToolsSnapshot(createCommandContext([]), {
    loadConfig: async () => config,
    fetch: fetcher,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(call => new URL(call.input).searchParams.get("query")),
    [OBS_TOOLS_CALLS_PROMQL, OBS_TOOLS_FAILURES_PROMQL],
  );

  for (const call of calls) {
    const url = new URL(call.input);
    const query = url.searchParams.get("query");
    assert.equal(query.includes("tool_call_id"), false);
    assert.deepEqual(findForbiddenPrometheusLabels(query), []);
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(url.searchParams.get("timeout"), "0.987s");
    assert.equal(call.init.headers.Authorization, "Bearer grafana-token");
  }

  assert.match(OBS_TOOLS_CALLS_PROMQL, /by \(tool_name\)\)$/u);
  assert.match(OBS_TOOLS_FAILURES_PROMQL, /by \(tool_name, error_class\)$/u);
  assert.equal(snapshot.calls.length, 1);
  assert.equal(snapshot.failures.length, 1);
  assert.deepEqual(snapshot.calls[0], {
    toolName: "read",
    ratePerSecond: 0.25,
    timestampUnixSeconds: "1783422000.25",
  });
  assert.deepEqual(snapshot.failures[0], {
    toolName: "bash",
    errorClass: "TimeoutError",
    ratePerSecond: 0.05,
    timestampUnixSeconds: "1783422000.25",
  });
});

test("root obs command dispatches tools subcommand", async () => {
  const pi = createFakeCommandPi();
  registerObsCommand(pi, {
    tools: {
      getTools: () => ({
        window: "1h",
        callQuery: OBS_TOOLS_CALLS_PROMQL,
        failureQuery: OBS_TOOLS_FAILURES_PROMQL,
        calls: [],
        failures: [],
      }),
    },
  });

  const command = pi.commands.get("obs");
  const notifications = [];
  await command.handler("tools", createCommandContext(notifications));

  assert.deepEqual(getObsRootCommandArgumentCompletions("to"), [{ value: "tools", label: "tools" }]);
  assert.equal(notifications[0].type, "info");
  assert.equal(
    notifications[0].message,
    [
      "Tool calls by tool (last 1h)",
      "No tool call metrics found.",
      "Tool failures by tool/error (last 1h)",
      "No tool failure metrics found.",
    ].join("\n"),
  );
});
