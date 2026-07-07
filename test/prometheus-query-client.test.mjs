import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  FORBIDDEN_HIGH_CARDINALITY_PROMETHEUS_LABELS,
  PrometheusQueryClient,
  findForbiddenPrometheusLabels,
  queryPrometheus,
} from "../src/query/prometheus.ts";

const defaultQueryTime = new Date("2026-07-07T11:00:00.250Z");
const documentedLowCardinalityPromQl = [
  "sum(increase(observme_llm_cost_usd_total[24h])) by (model, provider)",
  "sum(rate(observme_subagents_spawned_total[1h])) by (agent_role, subagent_depth, spawn_type, spawn_reason)",
  "histogram_quantile(0.95, sum(rate(observme_agent_fanout_count_bucket[1h])) by (subagent_depth, le))",
  "sum(rate(observme_orphan_agents_total[1h])) by (agent_role, subagent_depth)",
  "topk(10, sum(rate(observme_tool_calls_total[1h])) by (tool_name))",
  "sum(rate(observme_tool_failures_total[1h])) by (tool_name, error_class)",
];

function cloneDefaultConfig() {
  return structuredClone(defaultObservMeConfig);
}

function createPrometheusVectorResponse() {
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
          {
            metric: { model: "gemini-2.5", provider: "google" },
            value: [1783422000.25, "0.21"],
          },
        ],
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function createPrometheusAgentResponse() {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          {
            metric: { agent_role: "orchestrator", subagent_depth: "0" },
            value: [1783422000, "5"],
          },
          {
            metric: { agent_role: "worker", subagent_depth: "1" },
            value: [1783422000, "3"],
          },
        ],
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function createEmptyVectorResponse() {
  return new Response(
    JSON.stringify({
      status: "success",
      data: { resultType: "vector", result: [] },
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

test("PrometheusQueryClient queries metrics through the Grafana Prometheus datasource proxy with bounded PromQL", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 1234;
  config.query.maxMetricSeries = 2;
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.prometheus = "mimir/main";

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal);
    return createPrometheusVectorResponse();
  };

  const client = new PrometheusQueryClient(config, { fetch: fetcher });
  const result = await client.queryPrometheus(
    "sum(increase(observme_llm_cost_usd_total[24h])) by (model, provider)",
    defaultQueryTime,
  );

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].input);
  assert.equal(
    url.origin + url.pathname,
    "http://grafana.local/grafana/api/datasources/proxy/uid/mimir%2Fmain/api/v1/query",
  );
  assert.equal(url.searchParams.get("query"), "sum(increase(observme_llm_cost_usd_total[24h])) by (model, provider)");
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(url.searchParams.get("timeout"), "1.234s");
  assert.equal(url.searchParams.get("time"), "1783422000.25");
  assert.equal(calls[0].init.headers.Authorization, "Bearer grafana-token");
  assert.equal(result.resultType, "vector");
  assert.equal(result.series.length, 2);
  assert.deepEqual(result.series[0].metric, { model: "claude-sonnet", provider: "anthropic" });
  assert.equal(result.series[0].value.value, "1.42");
});

test("queryPrometheus caps agent summaries by query.maxAgents when requested", async () => {
  const config = cloneDefaultConfig();
  config.query.maxMetricSeries = 20;
  config.query.maxAgents = 1;
  config.query.grafana.url = "http://grafana.local";
  const calls = [];
  const fetcher = async input => {
    calls.push(String(input));
    return createPrometheusAgentResponse();
  };

  const result = await queryPrometheus(
    config,
    "sum(rate(observme_orphan_agents_total[1h])) by (agent_role, subagent_depth)",
    undefined,
    { fetch: fetcher, resultLimit: "agents" },
  );

  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get("limit"), "1");
  assert.equal(result.series.length, 1);
  assert.deepEqual(result.series[0].metric, { agent_role: "orchestrator", subagent_depth: "0" });
});

test("documented Prometheus queries built by the client avoid forbidden high-cardinality labels", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  const calls = [];
  const fetcher = async input => {
    calls.push(String(input));
    return createEmptyVectorResponse();
  };

  for (const query of documentedLowCardinalityPromQl) {
    await queryPrometheus(config, query, undefined, { fetch: fetcher });
  }

  assert.equal(calls.length, documentedLowCardinalityPromQl.length);
  for (const call of calls) {
    const builtQuery = new URL(call).searchParams.get("query");
    assert.deepEqual(findForbiddenPrometheusLabels(builtQuery), []);
  }
});

test("queryPrometheus rejects forbidden high-cardinality Prometheus labels before fetching", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  const fetcher = async () => {
    throw new Error("fetch should not be called for unsafe Prometheus query inputs");
  };

  for (const label of FORBIDDEN_HIGH_CARDINALITY_PROMETHEUS_LABELS) {
    await assert.rejects(
      queryPrometheus(config, `sum by (${label})(observme_llm_cost_usd_total)`, undefined, { fetch: fetcher }),
      /forbidden high-cardinality metric labels/u,
    );
  }

  await assert.rejects(
    queryPrometheus(config, 'sum(increase(observme_llm_cost_usd_total{pi_session_id="session-1"}[24h]))', undefined, {
      fetch: fetcher,
    }),
    /pi_session_id/u,
  );
});

test("queryPrometheus rejects raw prompt, command, path, and environment query inputs before fetching", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  const fetcher = async () => {
    throw new Error("fetch should not be called for unsafe Prometheus query inputs");
  };

  await assert.rejects(
    queryPrometheus(config, 'observme_llm_cost_usd_total{model="Prompt: summarize this repository"}', undefined, {
      fetch: fetcher,
    }),
    /raw prompts, commands, paths, and inherited environment values/u,
  );
  await assert.rejects(
    queryPrometheus(config, 'observme_tool_calls_total{tool_name="rm -rf /tmp/demo"}', undefined, { fetch: fetcher }),
    /raw prompts, commands, paths, and inherited environment values/u,
  );
  await assert.rejects(
    queryPrometheus(config, 'observme_tool_calls_total{tool_name="/Users/example/.ssh/id_rsa"}', undefined, {
      fetch: fetcher,
    }),
    /raw prompts, commands, paths, and inherited environment values/u,
  );
  await assert.rejects(
    queryPrometheus(config, 'observme_tool_calls_total{tool_name="OBSERVME_PARENT_AGENT_ID=agent-1"}', undefined, {
      fetch: fetcher,
    }),
    /raw prompts, commands, paths, and inherited environment values/u,
  );
});

test("queryPrometheus applies query.timeoutMs as an aborting fetch timeout", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 1;
  config.query.grafana.url = "http://grafana.local";
  const signals = [];

  await assert.rejects(
    queryPrometheus(config, "topk(10, sum(rate(observme_tool_calls_total[1h])) by (tool_name))", undefined, {
      fetch: createNeverResolvingFetch(signals),
    }),
    /Prometheus query timed out/u,
  );
  assert.equal(signals.length, 1);
});

test("queryPrometheus is optional and skips network calls when query integration is disabled", async () => {
  const config = cloneDefaultConfig();
  config.query.enabled = false;
  const fetcher = async () => {
    throw new Error("fetch should not be called when query integration is disabled");
  };

  const result = await queryPrometheus(config, "observme_llm_cost_usd_total", undefined, { fetch: fetcher });

  assert.deepEqual(result, { resultType: "vector", series: [] });
});
