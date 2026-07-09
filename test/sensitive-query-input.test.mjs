import assert from "node:assert/strict";
import test from "node:test";
import { handleObsLogsCommand, getObsLogsSnapshot } from "../src/commands/obs-logs.ts";
import { sanitizeObsDiagnosticText } from "../src/commands/obs-diagnostics.ts";
import { getObsTraceSnapshot } from "../src/commands/obs-trace.ts";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getGrafanaTraceLink } from "../src/query/grafana.ts";
import { queryLoki } from "../src/query/loki.ts";
import { queryPrometheus } from "../src/query/prometheus.ts";
import { searchTempo } from "../src/query/tempo.ts";

const generatedSessionId = "session-1";
const generatedTraceId = "11111111111111111111111111111111";
const defaultRange = {
  from: new Date("2026-07-07T10:00:00.000Z"),
  to: new Date("2026-07-07T11:00:00.000Z"),
};
const unsafeInputCases = [
  { name: "raw prompt", value: "Prompt: summarize this repository" },
  { name: "command", value: "rm -rf /tmp/demo" },
  { name: "path", value: "/Users/example/.ssh/id_rsa" },
  { name: "environment variable", value: "OBSERVME_PARENT_AGENT_ID=agent-1" },
  { name: "token", value: "Bearer query-token" },
  { name: "unresolved environment placeholder", value: "${OBSERVME_GRAFANA_TOKEN}" },
];

function cloneQueryReadyConfig() {
  const config = structuredClone(defaultObservMeConfig);
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids = {
    tempo: "tempo/main",
    loki: "loki/main",
    prometheus: "mimir/main",
  };
  config.query.links.traceUrlTemplate = "https://grafana.local/explore?trace={traceId}&ds={tempoDatasourceUid}";
  return config;
}

function createCommandContext(notifications = []) {
  return {
    cwd: "/workspace/demo",
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
    },
    isProjectTrusted: () => false,
  };
}

function createFailingFetch(calls) {
  return async () => {
    calls.count += 1;
    throw new Error("fetch should not be called for unsafe query inputs");
  };
}

function createPrometheusResponse() {
  return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
}

function createLokiResponse() {
  return new Response(JSON.stringify({ status: "success", data: { resultType: "streams", result: [] } }), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
}

function createTempoResponse() {
  return new Response(JSON.stringify({ traces: [{ traceID: generatedTraceId }] }), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
}

function prometheusQueryFor(value) {
  return `observme_tool_calls_total{agent_role="${escapePromQlString(value)}"}`;
}

function lokiQueryFor(value) {
  return `{service_name="observme-pi-extension"} |= "${escapeLogQlString(value)}"`;
}

function escapePromQlString(value) {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function escapeLogQlString(value) {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

test("shared sensitive input corpus is rejected before public query boundaries fetch", async () => {
  const boundaries = [
    {
      name: "Prometheus query",
      run: (value, calls) => queryPrometheus(cloneQueryReadyConfig(), prometheusQueryFor(value), undefined, { fetch: createFailingFetch(calls) }),
    },
    {
      name: "Loki query",
      run: (value, calls) => queryLoki(cloneQueryReadyConfig(), lokiQueryFor(value), defaultRange, { fetch: createFailingFetch(calls) }),
    },
    {
      name: "Tempo search",
      run: (value, calls) => searchTempo(cloneQueryReadyConfig(), { "pi.session.id": value }, defaultRange, { fetch: createFailingFetch(calls) }),
    },
    {
      name: "Grafana trace link",
      run: value => getGrafanaTraceLink(cloneQueryReadyConfig(), value),
    },
    {
      name: "/obs trace --session request",
      run: (value, calls) => getObsTraceSnapshot(createCommandContext(), { scope: "session", sessionId: value }, {
        loadConfig: async () => cloneQueryReadyConfig(),
        fetch: createFailingFetch(calls),
        getSession: () => ({ sessionId: undefined, traceId: undefined, turns: 0 }),
      }),
    },
    {
      name: "/obs logs current-session request",
      run: (value, calls) => getObsLogsSnapshot(createCommandContext(), {
        loadConfig: async () => cloneQueryReadyConfig(),
        fetch: createFailingFetch(calls),
        getSession: () => ({ sessionId: value }),
      }),
    },
  ];

  for (const boundary of boundaries) {
    for (const input of unsafeInputCases) {
      const calls = { count: 0 };
      await assert.rejects(
        async () => boundary.run(input.value, calls),
        /raw prompts, commands, paths, and (?:inherited )?environment values/u,
        `${boundary.name} should reject ${input.name}`,
      );
      assert.equal(calls.count, 0, `${boundary.name} should not fetch for ${input.name}`);
    }
  }
});

test("shared sensitive input corpus still allows benign generated IDs at every public boundary", async () => {
  const config = cloneQueryReadyConfig();
  let prometheusFetches = 0;
  let lokiFetches = 0;
  let tempoFetches = 0;
  let traceFetches = 0;
  let logsFetches = 0;

  await queryPrometheus(config, prometheusQueryFor(generatedSessionId), undefined, {
    fetch: async () => {
      prometheusFetches += 1;
      return createPrometheusResponse();
    },
  });
  await queryLoki(config, lokiQueryFor(generatedSessionId), defaultRange, {
    fetch: async () => {
      lokiFetches += 1;
      return createLokiResponse();
    },
  });
  await searchTempo(config, { "pi.session.id": generatedSessionId }, defaultRange, {
    fetch: async () => {
      tempoFetches += 1;
      return createTempoResponse();
    },
  });
  assert.match(getGrafanaTraceLink(config, generatedTraceId), new RegExp(generatedTraceId, "u"));
  await getObsTraceSnapshot(createCommandContext(), { scope: "session", sessionId: generatedSessionId }, {
    loadConfig: async () => config,
    fetch: async () => {
      traceFetches += 1;
      return createTempoResponse();
    },
    getSession: () => ({ sessionId: undefined, traceId: undefined, turns: 0 }),
  });
  await getObsLogsSnapshot(createCommandContext(), {
    loadConfig: async () => config,
    fetch: async () => {
      logsFetches += 1;
      return createLokiResponse();
    },
    getSession: () => ({ sessionId: generatedSessionId }),
  });

  assert.equal(prometheusFetches, 1);
  assert.equal(lokiFetches, 1);
  assert.equal(tempoFetches, 1);
  assert.equal(traceFetches, 1);
  assert.equal(logsFetches, 1);
});

test("command diagnostics use the shared redaction corpus before rendering UI text", async () => {
  const message = sanitizeObsDiagnosticText(
    "Authorization: Bearer grafana-token Prompt: raw prompt body /Users/senad/project rm -rf /tmp/demo OBSERVME_TOKEN=super-secret ${OBSERVME_GRAFANA_TOKEN} password=grafana-password.",
  );

  assert.doesNotMatch(message, /grafana-token|raw prompt body|\/Users\/senad|rm -rf|super-secret|OBSERVME_GRAFANA_TOKEN|grafana-password/u);
  assert.match(message, /redacted/u);

  const notifications = [];
  await handleObsLogsCommand("logs", createCommandContext(notifications), {
    getSession: () => ({ sessionId: "OBSERVME_PARENT_AGENT_ID=agent-1" }),
  });

  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /Unsafe ObservMe session id/u);
  assert.doesNotMatch(notifications[0].message, /OBSERVME_PARENT_AGENT_ID=agent-1/u);
});
