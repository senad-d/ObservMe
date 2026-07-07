import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";
import { OBS_ERRORS_LOGQL, getObsErrorsSnapshot, renderObsErrors } from "../src/commands/obs-errors.ts";
import {
  buildObsLogsLogQl,
  getObsLogsSnapshot,
  handleObsLogsCommand,
  renderObsLogs,
} from "../src/commands/obs-logs.ts";

const fixedNow = new Date("2026-07-07T11:00:00.000Z");

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

function createLokiResponse() {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: {
              service_name: "observme-pi-extension",
              pi_session_id: "session-1",
            },
            values: [
              [
                "1783422000000000000",
                "Prompt: raw prompt body that must not be rendered",
                {
                  event_name: "llm.request.failed",
                  event_category: "error",
                  error_type: "TimeoutError",
                  pi_session_id: "session-1",
                  trace_id: "trace-1",
                },
              ],
              [
                "1783421999000000000",
                "tool failed with raw arguments that should stay hidden",
                {
                  event_name: "tool.call.failed",
                  event_category: "error",
                  error_type: "ToolError",
                  pi_session_id: "session-1",
                  trace_id: "trace-1",
                },
              ],
              [
                "1783421998000000000",
                "handler.failed",
                {
                  event_name: "handler.failed",
                  event_category: "error",
                  error_type: "HandlerError",
                  pi_session_id: "session-1",
                },
              ],
            ],
          },
        ],
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

test("/obs errors queries provisioned event-name LogQL and renders capped summaries", async () => {
  const config = cloneDefaultConfig();
  config.query.maxLogs = 2;
  config.query.timeoutMs = 987;
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.loki = "loki/main";

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal);
    return createLokiResponse();
  };

  const snapshot = await getObsErrorsSnapshot(createCommandContext([]), {
    loadConfig: async () => config,
    fetch: fetcher,
    now: () => fixedNow,
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].input);
  assert.equal(
    url.origin + url.pathname,
    "http://grafana.local/grafana/api/datasources/proxy/uid/loki%2Fmain/loki/api/v1/query_range",
  );
  assert.equal(url.searchParams.get("query"), OBS_ERRORS_LOGQL);
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(url.searchParams.get("direction"), "backward");
  assert.equal(url.searchParams.get("start"), "1783418400000000000");
  assert.equal(url.searchParams.get("end"), "1783422000000000000");
  assert.equal(calls[0].init.headers.Authorization, "Bearer grafana-token");
  assert.equal(snapshot.logs.length, 2);
  assert.equal(snapshot.logs[0].eventName, "llm.request.failed");
  assert.equal(snapshot.logs[0].errorType, "TimeoutError");

  const output = renderObsErrors(snapshot);
  assert.match(output, /Recent error events \(last 1h, max 2\)/u);
  assert.match(output, /llm\.request\.failed category=error error=TimeoutError session=session-1 trace=trace-1/u);
  assert.match(output, /tool\.call\.failed category=error error=ToolError session=session-1 trace=trace-1/u);
  assert.equal(output.includes("raw prompt body"), false);
  assert.equal(output.includes("raw arguments"), false);
});

test("/obs logs queries the current session with normalized pi_session_id and caps result count", async () => {
  const config = cloneDefaultConfig();
  config.query.maxLogs = 2;
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.loki = "loki/main";

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    return createLokiResponse();
  };

  const snapshot = await getObsLogsSnapshot(createCommandContext([]), {
    loadConfig: async () => config,
    fetch: fetcher,
    getSession: () => ({ sessionId: "session-1" }),
    now: () => fixedNow,
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].input);
  assert.equal(url.searchParams.get("query"), '{service_name="observme-pi-extension", pi_session_id="session-1"}');
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(snapshot.query, buildObsLogsLogQl("session-1"));
  assert.equal(snapshot.logs.length, 2);

  const output = renderObsLogs(snapshot);
  assert.match(output, /Session logs for session-1 \(last 1h, max 2\)/u);
  assert.match(output, /llm\.request\.failed/u);
  assert.equal(output.includes("raw prompt body"), false);
  assert.equal(output.includes("raw arguments"), false);
});

test("/obs logs rejects unsafe current session ids before querying Loki", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  let fetchCalled = false;
  const notifications = [];

  await handleObsLogsCommand("logs", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: async () => {
      fetchCalled = true;
      return createLokiResponse();
    },
    getSession: () => ({ sessionId: "Prompt:summarize-this-repository" }),
  });

  assert.equal(fetchCalled, false);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /Unsafe ObservMe session id/u);
});

test("root obs command dispatches errors and logs subcommands", async () => {
  const pi = createFakeCommandPi();
  registerObsCommand(pi, {
    errors: {
      getErrors: () => ({
        window: "1h",
        query: OBS_ERRORS_LOGQL,
        maxLogs: 2,
        logs: [],
      }),
    },
    logs: {
      getLogs: () => ({
        sessionId: "session-1",
        window: "1h",
        query: buildObsLogsLogQl("session-1"),
        maxLogs: 2,
        logs: [],
      }),
    },
  });

  const command = pi.commands.get("obs");
  const notifications = [];
  await command.handler("errors", createCommandContext(notifications));
  await command.handler("logs", createCommandContext(notifications));

  assert.deepEqual(getObsRootCommandArgumentCompletions("er"), [{ value: "errors", label: "errors" }]);
  assert.deepEqual(getObsRootCommandArgumentCompletions("lo"), [{ value: "logs", label: "logs" }]);
  assert.equal(notifications[0].type, "info");
  assert.equal(notifications[0].message, ["Recent error events (last 1h, max 2)", "No error logs found."].join("\n"));
  assert.equal(notifications[1].type, "info");
  assert.equal(notifications[1].message, ["Session logs for session-1 (last 1h, max 2)", "No session logs found."].join("\n"));
});
