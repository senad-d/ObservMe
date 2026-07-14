import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getGrafanaHealth } from "../src/query/grafana.ts";
import { MAX_GRAFANA_RESPONSE_BODY_BYTES } from "../src/query/grafana-transport.ts";
import { queryLoki } from "../src/query/loki.ts";
import { queryPrometheus } from "../src/query/prometheus.ts";
import { searchTempo } from "../src/query/tempo.ts";
import {
  createExactBoundaryJsonResponse,
  createOversizedGrafanaStreamResponse,
  createStallingGrafanaResponse,
} from "./grafana-response-limit-helpers.mjs";

const defaultRange = {
  from: new Date("2026-07-07T10:00:00.250Z"),
  to: new Date("2026-07-07T11:00:00.750Z"),
};

function cloneReadyConfig() {
  const config = structuredClone(defaultObservMeConfig);
  config.query.timeoutMs = 1234;
  config.query.grafana.url = "http://grafana.local/observability/";
  config.query.grafana.token = "super-secret-token";
  config.query.grafana.datasourceUids = {
    tempo: "tempo/main",
    loki: "loki/main",
    prometheus: "mimir/main",
  };
  return config;
}

function createPrometheusSuccessResponse() {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: [{ metric: { service_name: "observme-pi-extension" }, value: [1783422000.25, "1"] }],
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function createLokiSuccessResponse() {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "streams",
        result: [
          {
            stream: { service_name: "observme-pi-extension" },
            values: [["1783422000000000000", "workflow.started"]],
          },
        ],
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function createTempoSuccessResponse() {
  return new Response(
    JSON.stringify({ traces: [{ traceID: "4bf92f3577b34da6a3ce929d0e0e4736", rootServiceName: "observme-pi-extension" }] }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function createHealthyResponse() {
  return new Response("{}", { status: 200, statusText: "OK" });
}

function createUnauthorizedResponse() {
  return new Response("{}", { status: 401, statusText: "Unauthorized" });
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

async function runPrometheusQuery(config, fetcher) {
  return queryPrometheus(config, "observme_sessions_started_total", undefined, { fetch: fetcher });
}

async function runLokiQuery(config, fetcher) {
  return queryLoki(config, '{service_name="observme-pi-extension"}', defaultRange, { fetch: fetcher });
}

async function runTempoSearch(config, fetcher) {
  return searchTempo(config, { "pi.session.id": "session-1" }, defaultRange, { fetch: fetcher });
}

async function withLocalHttpServer(handler, callback) {
  const server = createServer(handler);
  await listenLocalServer(server);

  try {
    return await callback(localServerUrl(server));
  } finally {
    await closeLocalServer(server);
  }
}

async function listenLocalServer(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeLocalServer(server) {
  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function localServerUrl(server) {
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return `http://127.0.0.1:${address.port}`;
}

test("shared Grafana transport builds URLs, auth headers, timeouts, and success responses for health and datasource queries", async () => {
  const config = cloneReadyConfig();
  const calls = [];
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.Authorization, "Bearer super-secret-token");
    assert.equal(init.headers.Accept, "application/json");

    if (url.pathname.endsWith("/api/v1/query")) return createPrometheusSuccessResponse();
    if (url.pathname.endsWith("/loki/api/v1/query_range")) return createLokiSuccessResponse();
    if (url.pathname.endsWith("/api/search")) return createTempoSuccessResponse();
    return createHealthyResponse();
  };

  const health = await getGrafanaHealth(config, { fetch: fetcher });
  const metrics = await runPrometheusQuery(config, fetcher);
  const logs = await runLokiQuery(config, fetcher);
  const traces = await runTempoSearch(config, fetcher);

  assert.deepEqual(health.checks.map(check => check.status), ["ok", "ok", "ok", "ok"]);
  assert.equal(metrics.series.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(traces.length, 1);
  assert.equal(health.timeoutMs, 1234);
  assert.ok(
    calls.some(call => call.url.pathname === "/observability/api/datasources/proxy/uid/mimir%2Fmain/api/v1/query"),
  );
  assert.ok(
    calls.some(call => call.url.pathname === "/observability/api/datasources/proxy/uid/loki%2Fmain/loki/api/v1/query_range"),
  );
  assert.ok(
    calls.some(call => call.url.pathname === "/observability/api/datasources/proxy/uid/tempo%2Fmain/api/search"),
  );
});

test("shared Grafana transport normalizes 401 auth failures without exposing token values", async () => {
  const config = cloneReadyConfig();
  const fetcher = async () => createUnauthorizedResponse();
  const assertSafeAuthFailure = error => {
    assert.match(error.message, /HTTP 401 Unauthorized/u);
    assert.match(error.message, /Grafana authentication failed/u);
    assert.doesNotMatch(error.message, /super-secret-token/u);
    return true;
  };

  const health = await getGrafanaHealth(config, { fetch: fetcher });
  for (const check of health.checks) {
    assert.equal(check.status, "failed");
    assert.match(check.detail, /HTTP 401 Unauthorized/u);
    assert.match(check.detail, /Grafana authentication failed/u);
    assert.doesNotMatch(check.detail, /super-secret-token/u);
  }

  await assert.rejects(runPrometheusQuery(config, fetcher), assertSafeAuthFailure);
  await assert.rejects(runLokiQuery(config, fetcher), assertSafeAuthFailure);
  await assert.rejects(runTempoSearch(config, fetcher), assertSafeAuthFailure);
});

test("shared Grafana transport applies aborting timeouts to health and datasource queries", async () => {
  const config = cloneReadyConfig();
  config.query.timeoutMs = 1;

  const healthSignals = [];
  const health = await getGrafanaHealth(config, { fetch: createNeverResolvingFetch(healthSignals) });
  assert.equal(healthSignals.length, 4);
  assert.deepEqual(
    health.checks.map(check => check.detail),
    ["timed out", "timed out", "timed out", "timed out"],
  );

  await assert.rejects(runPrometheusQuery(config, createNeverResolvingFetch([])), /Prometheus query timed out/u);
  await assert.rejects(runLokiQuery(config, createNeverResolvingFetch([])), /Loki query timed out/u);
  await assert.rejects(runTempoSearch(config, createNeverResolvingFetch([])), /Tempo search timed out/u);
});

test("default Grafana fetch rejects declared oversized response bodies without exposing body content", async () => {
  const config = cloneReadyConfig();
  const oversizedSecretBody = `default-fetch-secret-${"x".repeat(MAX_GRAFANA_RESPONSE_BODY_BYTES)}`;

  await withLocalHttpServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-length": String(Buffer.byteLength(oversizedSecretBody)),
        "content-type": "application/json",
      });
      response.end(oversizedSecretBody);
    },
    async baseUrl => {
      config.query.grafana.url = baseUrl;
      await assert.rejects(runPrometheusQuery(config), error => {
        assert.match(error.message, /Grafana response body exceeded maximum size/u);
        assert.doesNotMatch(error.message, /default-fetch-secret/u);
        return true;
      });
    },
  );
});

test("custom Node Grafana transport rejects streamed oversized response bodies without exposing body content", async () => {
  const config = cloneReadyConfig();
  config.query.grafana.transport.preferIPv4 = true;
  const oversizedSecretBody = `oversized-secret-token-${"x".repeat(MAX_GRAFANA_RESPONSE_BODY_BYTES)}`;

  await withLocalHttpServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const midpoint = Math.floor(oversizedSecretBody.length / 2);
      response.write(oversizedSecretBody.slice(0, midpoint));
      response.end(oversizedSecretBody.slice(midpoint));
    },
    async baseUrl => {
      config.query.grafana.url = baseUrl;
      await assert.rejects(runPrometheusQuery(config), error => {
        assert.match(error.message, /Grafana response body exceeded maximum size/u);
        assert.match(error.message, /Narrow the query or lower query result limits/u);
        assert.doesNotMatch(error.message, /oversized-secret-token/u);
        return true;
      });
    },
  );
});

test("injected Grafana fetch rejects false Content-Length bodies by streamed bytes and cancels them", async () => {
  const config = cloneReadyConfig();
  const oversized = createOversizedGrafanaStreamResponse({ "content-length": "not-a-number" });

  await assert.rejects(runLokiQuery(config, async () => oversized.response), error => {
    assert.match(error.message, /Grafana response body exceeded maximum size/u);
    assert.doesNotMatch(error.message, /response body content/u);
    return true;
  });
  assert.equal(oversized.state.cancelled, true);
});

test("Grafana health cancels responses whose declared Content-Length exceeds the limit", async () => {
  const config = cloneReadyConfig();
  const states = [];
  const health = await getGrafanaHealth(config, {
    fetch: async () => {
      const oversized = createOversizedGrafanaStreamResponse({
        "content-length": String(MAX_GRAFANA_RESPONSE_BODY_BYTES + 1),
      });
      states.push(oversized.state);
      return oversized.response;
    },
  });

  assert.deepEqual(
    health.checks.map(check => check.status),
    ["failed", "failed", "failed", "failed"],
  );
  for (const check of health.checks) {
    assert.match(check.detail, /Grafana response body exceeded maximum size/u);
  }
  assert.equal(states.length, 4);
  assert.ok(states.every(state => state.cancelled));
});

test("Grafana transport accepts and parses an exact-boundary valid response", async () => {
  const config = cloneReadyConfig();
  const response = createExactBoundaryJsonResponse({
    status: "success",
    data: { resultType: "vector", result: [] },
  });

  const result = await runPrometheusQuery(config, async () => response);
  assert.deepEqual(result, { resultType: "vector", series: [] });
});

test("Grafana response-body reads preserve query timeout and cancellation semantics", async () => {
  const config = cloneReadyConfig();
  config.query.timeoutMs = 5;
  const stalled = createStallingGrafanaResponse();

  await assert.rejects(runTempoSearch(config, async () => stalled.response), /Tempo search timed out/u);
  assert.equal(stalled.state.cancelled, true);
});

test("shared Grafana readiness rejects invalid Grafana URLs before health and datasource query fetches", async () => {
  const config = cloneReadyConfig();
  config.query.grafana.url = "file:///tmp/grafana";
  let fetchCalls = 0;
  const fetcher = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not run for invalid Grafana URL configuration");
  };

  const health = await getGrafanaHealth(config, { fetch: fetcher });
  for (const check of health.checks) {
    assert.equal(check.status, "failed");
    assert.match(check.detail, /query\.grafana\.url must be a valid http:\/\/ or https:\/\/ URL/u);
  }

  await assert.rejects(runPrometheusQuery(config, fetcher), /query\.grafana\.url must be a valid http:\/\/ or https:\/\/ URL/u);
  await assert.rejects(runLokiQuery(config, fetcher), /query\.grafana\.url must be a valid http:\/\/ or https:\/\/ URL/u);
  await assert.rejects(runTempoSearch(config, fetcher), /query\.grafana\.url must be a valid http:\/\/ or https:\/\/ URL/u);
  assert.equal(fetchCalls, 0);
});
