import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";
import { handleObsLinkCommand } from "../src/commands/obs-link.ts";
import {
  getObsTraceSnapshot,
  handleObsTraceCommand,
  renderObsTrace,
} from "../src/commands/obs-trace.ts";
import {
  clearObsSessionRuntimeState,
  recordObsSessionTurn,
  startObsSessionRuntimeState,
} from "../src/commands/obs-session.ts";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const remoteTraceId = "11111111111111111111111111111111";
const responseFragmentMarker = "private-tempo-command-response-fragment";

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

function createTempoSearchResponse() {
  return new Response(
    JSON.stringify({
      traces: [
        {
          traceID: remoteTraceId,
          rootServiceName: "observme-pi-extension",
          rootTraceName: "pi.session",
        },
      ],
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

test("/obs trace keeps current-session links available when query integration is disabled", async t => {
  clearObsSessionRuntimeState();
  t.after(() => clearObsSessionRuntimeState());

  const config = cloneDefaultConfig();
  config.query.enabled = false;
  config.query.links.traceUrlTemplate = "https://grafana.local/explore?trace={traceId}&ds={tempoDatasourceUid}";
  config.query.grafana.datasourceUids.tempo = "tempo/main";
  startObsSessionRuntimeState({ sessionId: "session-1", traceId, config });

  let fetchCalls = 0;
  const snapshot = await getObsTraceSnapshot(createCommandContext([]), { scope: "current-session" }, {
    loadConfig: async () => config,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run for current-session trace links");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(snapshot.source, "runtime");
  assert.equal(
    snapshot.traceLink,
    `https://grafana.local/explore?trace=${traceId}&ds=tempo%2Fmain`,
  );
  assert.equal(new URL(snapshot.traceLink).searchParams.has("session"), false);
  assert.equal(
    renderObsTrace(snapshot),
    [
      "Trace link (current session)",
      "Session: session-1",
      `Trace: ${traceId}`,
      `Open trace: https://grafana.local/explore?trace=${traceId}&ds=tempo%2Fmain`,
      "Trace visibility: active sessions may show ended child spans before the root pi.session span; the root is exported after session_shutdown.",
    ].join("\n"),
  );
});

test("/obs trace --last-turn returns the current trace once a turn has been observed", async t => {
  clearObsSessionRuntimeState();
  t.after(() => clearObsSessionRuntimeState());

  const config = cloneDefaultConfig();
  config.query.links.traceUrlTemplate = "https://grafana.local/explore?trace=%TRACE_ID%";
  startObsSessionRuntimeState({ sessionId: "session-turn", traceId, config });
  recordObsSessionTurn();

  const notifications = [];
  await handleObsTraceCommand("trace --last-turn", createCommandContext(notifications), {
    loadConfig: async () => config,
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "info");
  assert.match(notifications[0].message, /Trace link \(last turn\)/u);
  assert.match(notifications[0].message, new RegExp(`Open trace: https://grafana\\.local/explore\\?trace=${traceId}`, "u"));
  assert.match(notifications[0].message, /root pi\.session span; the root is exported after session_shutdown/u);
});

test("/obs trace --session searches Tempo by safe session id and renders a configured Grafana trace link", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.tempo = "tempo/main";
  config.query.links.traceUrlTemplate = "https://grafana.local/explore?trace=${traceId}";

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal);
    return createTempoSearchResponse();
  };

  const notifications = [];
  await handleObsTraceCommand("trace --session session-remote", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: fetcher,
    now: () => new Date("2026-07-07T12:00:00.000Z"),
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].input);
  assert.equal(url.origin + url.pathname, "http://grafana.local/grafana/api/datasources/proxy/uid/tempo%2Fmain/api/search");
  assert.equal(url.searchParams.get("tags"), 'pi.session.id="session-remote"');
  assert.equal(url.searchParams.get("limit"), String(config.query.maxTraces));
  assert.equal(calls[0].init.headers.Authorization, "Bearer grafana-token");
  assert.equal(notifications[0].type, "info");
  assert.match(notifications[0].message, /Trace link \(session\)/u);
  assert.match(notifications[0].message, new RegExp(`Open trace: https://grafana\\.local/explore\\?trace=${remoteTraceId}`, "u"));
  assert.doesNotMatch(notifications[0].message, /root pi\.session span/u);
});

test("/obs trace reports malformed Tempo responses as backend failures without body fragments", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "grafana-token";
  const notifications = [];

  await handleObsTraceCommand("trace --session session-malformed", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: async () => new Response(responseFragmentMarker, { status: 200 }),
    getSession: () => ({}),
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /Tempo search failed: backend schema error: response body must be valid JSON/u);
  assert.doesNotMatch(notifications[0].message, /No trace was found/u);
  assert.doesNotMatch(notifications[0].message, new RegExp(responseFragmentMarker, "u"));
});

test("/obs trace keeps no-data guidance for legitimate empty Tempo responses", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "grafana-token";
  const notifications = [];

  await handleObsTraceCommand("trace --session session-empty", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: async () => new Response(JSON.stringify({ traces: [] }), { status: 200 }),
    getSession: () => ({}),
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /No trace was found for the requested ObservMe session id/u);
  assert.match(notifications[0].message, /check the session id, wait for trace export/u);
  assert.doesNotMatch(notifications[0].message, /backend schema error/u);
});

test("/obs trace and /obs link reject raw prompt or command-like session ids before building query strings", async () => {
  const config = cloneDefaultConfig();
  let fetchCalls = 0;
  const fetcher = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not run for unsafe session ids");
  };

  const traceNotifications = [];
  await handleObsTraceCommand("trace --session Prompt:summarize-this-repository", createCommandContext(traceNotifications), {
    loadConfig: async () => config,
    fetch: fetcher,
  });

  const linkNotifications = [];
  await handleObsLinkCommand("link --session OBSERVME_PARENT_AGENT_ID=agent-1", createCommandContext(linkNotifications), {
    loadConfig: async () => config,
    fetch: fetcher,
  });

  assert.equal(fetchCalls, 0);
  assert.equal(traceNotifications[0].type, "error");
  assert.match(traceNotifications[0].message, /raw prompts, commands, paths, and environment values/u);
  assert.equal(linkNotifications[0].type, "error");
  assert.match(linkNotifications[0].message, /raw prompts, commands, paths, and environment values/u);
});

test("root obs command dispatches trace and link subcommands", async () => {
  const pi = createFakeCommandPi();
  registerObsCommand(pi, {
    trace: {
      getTrace: (_ctx, request) => ({
        scope: request.scope,
        source: "runtime",
        sessionId: "session-root",
        traceId,
        traceLink: `https://grafana.local/explore?trace=${traceId}`,
      }),
    },
    link: {
      getLink: (_ctx, request) => ({
        scope: request.scope,
        source: "runtime",
        sessionId: "session-root",
        traceId,
        traceLink: `https://grafana.local/explore?trace=${traceId}`,
      }),
    },
  });

  const command = pi.commands.get("obs");
  const notifications = [];
  await command.handler("trace", createCommandContext(notifications));
  await command.handler("link", createCommandContext(notifications));

  assert.deepEqual(getObsRootCommandArgumentCompletions("tr"), [{ value: "trace", label: "trace" }]);
  assert.deepEqual(getObsRootCommandArgumentCompletions("li"), [{ value: "link", label: "link" }]);
  assert.match(notifications[0].message, /Trace link \(current session\)/u);
  assert.match(notifications[1].message, /Grafana link \(current session\)/u);
});
