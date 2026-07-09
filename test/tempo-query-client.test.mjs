import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { TempoQueryClient, searchTempo } from "../src/query/tempo.ts";

const defaultRange = {
  from: new Date("2026-07-07T10:00:00.250Z"),
  to: new Date("2026-07-07T11:00:00.750Z"),
};

function cloneDefaultConfig() {
  return structuredClone(defaultObservMeConfig);
}

function createTempoSearchResponse() {
  return new Response(
    JSON.stringify({
      traces: [
        {
          traceID: "4BF92F3577B34DA6A3CE929D0E0E4736",
          rootServiceName: "observme-pi-extension",
          rootTraceName: "pi.session",
          startTimeUnixNano: "1783428000250000000",
          durationMs: 125,
        },
        {
          traceID: "11111111111111111111111111111111",
          rootServiceName: "observme-pi-extension",
          rootTraceName: "pi.agent.run",
          durationMs: 42,
          spanSet: { spans: [{ name: "pi.agent.run" }] },
        },
        {
          traceID: "22222222222222222222222222222222",
          rootServiceName: "observme-pi-extension",
        },
      ],
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function createAbortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function createNeverResolvingFetch(signals) {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      signals.push(init.signal);
      if (init.signal.aborted) {
        reject(createAbortError());
        return;
      }

      init.signal.addEventListener("abort", () => reject(createAbortError()), { once: true });
    });
}

test("TempoQueryClient searches traces through the Grafana Tempo datasource proxy with safe bounded attributes", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 1234;
  config.query.maxTraces = 2;
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.tempo = "tempo/main";

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal);
    return createTempoSearchResponse();
  };

  const client = new TempoQueryClient(config, { fetch: fetcher });
  const traces = await client.searchTempo(
    {
      "pi.workflow.id": "workflow-1",
      "pi.session.id": "session-1",
      "pi.agent.id": "agent-1",
    },
    defaultRange,
  );

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].input);
  assert.equal(url.origin + url.pathname, "http://grafana.local/grafana/api/datasources/proxy/uid/tempo%2Fmain/api/search");
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(url.searchParams.get("start"), "1783418400");
  assert.equal(url.searchParams.get("end"), "1783422001");
  assert.equal(
    url.searchParams.get("tags"),
    'pi.agent.id="agent-1" pi.session.id="session-1" pi.workflow.id="workflow-1"',
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer grafana-token");
  assert.deepEqual(
    traces.map(trace => trace.traceId),
    ["4bf92f3577b34da6a3ce929d0e0e4736", "11111111111111111111111111111111"],
  );
  assert.equal(traces[0].rootServiceName, "observme-pi-extension");
  assert.equal(traces[0].durationMs, 125);
});

test("searchTempo accepts hashed fields and caps results by query.maxTraces", async () => {
  const config = cloneDefaultConfig();
  config.query.maxTraces = 1;
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "grafana-token";

  const traces = await searchTempo(
    config,
    {
      "pi.tool.arguments.hash": "abc123def456",
      "pi.bash.command.hash": "fedcba987654",
      "pi.turn.branch_path_hash": "001122aabbcc",
    },
    defaultRange,
    { fetch: async () => createTempoSearchResponse() },
  );

  assert.equal(traces.length, 1);
  assert.equal(traces[0].traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
});

test("searchTempo rejects raw prompts, commands, paths, environment values, and non-correlation attributes", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "grafana-token";
  const fetcher = async () => {
    throw new Error("fetch should not be called for unsafe Tempo search inputs");
  };

  await assert.rejects(
    searchTempo(config, { "pi.agent.id": "Prompt:summarize-this-repository" }, defaultRange, { fetch: fetcher }),
    /raw prompts, commands, paths, and inherited environment values/u,
  );
  await assert.rejects(
    searchTempo(config, { "pi.bash.command.hash": "rm -rf /tmp/demo" }, defaultRange, { fetch: fetcher }),
    /raw prompts, commands, paths, and (?:inherited )?environment values/u,
  );
  await assert.rejects(
    searchTempo(config, { "pi.cwd.hash": "/Users/example/.ssh/id_rsa" }, defaultRange, { fetch: fetcher }),
    /raw prompts, commands, paths, and (?:inherited )?environment values/u,
  );
  await assert.rejects(
    searchTempo(config, { "pi.agent.id": "OBSERVME_PARENT_AGENT_ID=agent-1" }, defaultRange, { fetch: fetcher }),
    /raw prompts, commands, paths, and (?:inherited )?environment values/u,
  );
  await assert.rejects(
    searchTempo(config, { "pi.tool.name": "bash" }, defaultRange, { fetch: fetcher }),
    /generated workflow IDs, generated agent IDs, session IDs, trace\/span IDs, or hashed fields/u,
  );
});

test("searchTempo applies query.timeoutMs as an aborting fetch timeout", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 1;
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "grafana-token";
  const signals = [];

  await assert.rejects(
    searchTempo(config, { "pi.session.id": "session-1" }, defaultRange, { fetch: createNeverResolvingFetch(signals) }),
    /Tempo search timed out/u,
  );
  assert.equal(signals.length, 1);
});

test("searchTempo rejects unresolved Grafana token before fetching", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "${OBSERVME_GRAFANA_TOKEN}";
  let fetchCalls = 0;

  await assert.rejects(
    searchTempo(config, { "pi.session.id": "session-1" }, defaultRange, {
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not run when query auth is unresolved");
      },
    }),
    error => {
      assert.match(error.message, /Grafana query configuration is not ready/u);
      assert.match(error.message, /query\.grafana\.token is unresolved/u);
      assert.doesNotMatch(error.message, /\$\{OBSERVME_GRAFANA_TOKEN\}/u);
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
});

test("searchTempo rejects missing Tempo datasource UID before fetching", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.tempo = "";
  let fetchCalls = 0;

  await assert.rejects(
    searchTempo(config, { "pi.session.id": "session-1" }, defaultRange, {
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not run when the Tempo datasource UID is missing");
      },
    }),
    /query\.grafana\.datasourceUids\.tempo is not configured/u,
  );
  assert.equal(fetchCalls, 0);
});

test("searchTempo is optional and skips network calls when query integration is disabled", async () => {
  const config = cloneDefaultConfig();
  config.query.enabled = false;
  const fetcher = async () => {
    throw new Error("fetch should not be called when query integration is disabled");
  };

  const traces = await searchTempo(config, { "pi.session.id": "session-1" }, defaultRange, { fetch: fetcher });

  assert.deepEqual(traces, []);
});
