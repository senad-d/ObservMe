import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  LokiQueryClient,
  normalizeLokiAttributeName,
  normalizeLokiQueryAttributes,
  queryLoki,
} from "../src/query/loki.ts";

const defaultRange = {
  from: new Date("2026-07-07T10:00:00.250Z"),
  to: new Date("2026-07-07T11:00:00.750Z"),
};

function cloneDefaultConfig() {
  return structuredClone(defaultObservMeConfig);
}

function createLokiQueryResponse() {
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
                "llm.request.failed",
                {
                  event_name: "llm.request.failed",
                  event_category: "error",
                },
              ],
              ["1783421999000000000", "tool.call.failed"],
            ],
          },
          {
            stream: {
              service_name: "observme-pi-extension",
              pi_session_id: "session-1",
            },
            values: [["1783421998000000000", "handler.failed"]],
          },
        ],
      },
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

test("LokiQueryClient queries logs through the Grafana Loki datasource proxy with normalized bounded LogQL", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 1234;
  config.query.maxLogs = 2;
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.loki = "loki/main";

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal);
    return createLokiQueryResponse();
  };

  const client = new LokiQueryClient(config, { fetch: fetcher });
  const logs = await client.queryLoki(
    '{service.name="observme-pi-extension"} | event.name="llm.request.failed" | pi.session.id="session-1"',
    defaultRange,
  );

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].input);
  assert.equal(
    url.origin + url.pathname,
    "http://grafana.local/grafana/api/datasources/proxy/uid/loki%2Fmain/loki/api/v1/query_range",
  );
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(url.searchParams.get("direction"), "backward");
  assert.equal(url.searchParams.get("start"), "1783418400250000000");
  assert.equal(url.searchParams.get("end"), "1783422000750000000");
  assert.equal(
    url.searchParams.get("query"),
    '{service_name="observme-pi-extension"} | event_name="llm.request.failed" | pi_session_id="session-1"',
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer grafana-token");
  assert.deepEqual(
    logs.map(log => log.line),
    ["llm.request.failed", "tool.call.failed"],
  );
  assert.equal(logs[0].timestampUnixNano, "1783422000000000000");
  assert.equal(logs[0].labels.pi_session_id, "session-1");
  assert.equal(logs[0].metadata.event_name, "llm.request.failed");
});

test("Loki attribute normalization converts dotted OTEL attribute names to Loki query names", () => {
  assert.equal(normalizeLokiAttributeName("event.name"), "event_name");
  assert.equal(normalizeLokiAttributeName("pi.session.id"), "pi_session_id");
  assert.equal(
    normalizeLokiQueryAttributes('{service.name="observme-pi-extension"} | event.name="workflow.failed" | pi.session.id="session-1"'),
    '{service_name="observme-pi-extension"} | event_name="workflow.failed" | pi_session_id="session-1"',
  );
});

test("queryLoki rejects raw prompt, command, path, and environment query inputs before fetching", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  const fetcher = async () => {
    throw new Error("fetch should not be called for unsafe Loki query inputs");
  };

  await assert.rejects(
    queryLoki(config, '{service_name="observme-pi-extension"} |= "Prompt: summarize this repository"', defaultRange, {
      fetch: fetcher,
    }),
    /raw prompts, commands, paths, and inherited environment values/u,
  );
  await assert.rejects(
    queryLoki(config, '{service_name="observme-pi-extension"} |= "rm -rf /tmp/demo"', defaultRange, { fetch: fetcher }),
    /raw prompts, commands, paths, and inherited environment values/u,
  );
  await assert.rejects(
    queryLoki(config, '{service_name="observme-pi-extension"} |= "/Users/example/.ssh/id_rsa"', defaultRange, {
      fetch: fetcher,
    }),
    /raw prompts, commands, paths, and inherited environment values/u,
  );
  await assert.rejects(
    queryLoki(config, '{service_name="observme-pi-extension"} |= "OBSERVME_PARENT_AGENT_ID=agent-1"', defaultRange, {
      fetch: fetcher,
    }),
    /raw prompts, commands, paths, and inherited environment values/u,
  );
});

test("queryLoki applies query.timeoutMs as an aborting fetch timeout", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 1;
  config.query.grafana.url = "http://grafana.local";
  const signals = [];

  await assert.rejects(
    queryLoki(config, '{service_name="observme-pi-extension"} | event_category="error"', defaultRange, {
      fetch: createNeverResolvingFetch(signals),
    }),
    /Loki query timed out/u,
  );
  assert.equal(signals.length, 1);
});

test("queryLoki is optional and skips network calls when query integration is disabled", async () => {
  const config = cloneDefaultConfig();
  config.query.enabled = false;
  const fetcher = async () => {
    throw new Error("fetch should not be called when query integration is disabled");
  };

  const logs = await queryLoki(
    config,
    '{service_name="observme-pi-extension"} | pi_session_id="session-1"',
    defaultRange,
    { fetch: fetcher },
  );

  assert.deepEqual(logs, []);
});
