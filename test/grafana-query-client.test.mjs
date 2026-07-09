import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  GrafanaQueryClient,
  getGrafanaHealth,
  getGrafanaTraceLink,
} from "../src/query/grafana.ts";
import { formatGrafanaFetchFailure, requiresCustomGrafanaTransport } from "../src/query/grafana-transport.ts";

const sampleTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const telemetrySourceRoots = ["src/events", "src/otel", "src/pi"];
const telemetryGrafanaDependencyPattern =
  /query\/grafana|GrafanaQueryClient|createGrafanaQueryClient|getGrafanaHealth|getGrafanaTraceLink/u;

function cloneDefaultConfig() {
  return structuredClone(defaultObservMeConfig);
}

function createHealthyResponse() {
  return new Response("{}", { status: 200, statusText: "OK" });
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

async function collectTypeScriptFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(path)));
      continue;
    }

    if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }

  return files;
}

test("GrafanaQueryClient checks Grafana and datasource health with the configured query timeout", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 1234;
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids = {
    tempo: "tempo/main",
    loki: "loki-main",
    prometheus: "mimir-main",
  };

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal);
    return createHealthyResponse();
  };

  const client = new GrafanaQueryClient(config, { fetch: fetcher });
  const health = await client.health();

  assert.equal(health.timeoutMs, 1234);
  assert.deepEqual(
    health.checks.map(check => check.status),
    ["ok", "ok", "ok", "ok"],
  );
  assert.deepEqual(
    calls.map(call => call.input),
    [
      "http://grafana.local/grafana/api/health",
      "http://grafana.local/grafana/api/datasources/uid/tempo%2Fmain/health",
      "http://grafana.local/grafana/api/datasources/uid/loki-main/health",
      "http://grafana.local/grafana/api/datasources/uid/mimir-main/health",
    ],
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer grafana-token");
});

test("Grafana health supports local Basic auth when the bearer token placeholder is unresolved", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 1234;
  config.query.grafana.url = "https://observability.local/";
  config.query.grafana.token = "${OBSERVME_GRAFANA_TOKEN}";
  config.query.grafana.username = "admin";
  config.query.grafana.password = "local-password";
  config.query.grafana.tls.insecureSkipVerify = true;
  config.query.grafana.transport.preferIPv4 = true;

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from("admin:local-password").toString("base64")}`);
    return createHealthyResponse();
  };

  const health = await getGrafanaHealth(config, { fetch: fetcher });

  assert.equal(requiresCustomGrafanaTransport(config), true);
  assert.equal(health.timeoutMs, 1234);
  assert.deepEqual(
    health.checks.map(check => check.status),
    ["ok", "ok", "ok", "ok"],
  );
  assert.deepEqual(
    calls.map(call => call.input),
    [
      "https://observability.local/api/health",
      "https://observability.local/api/datasources/uid/tempo/health",
      "https://observability.local/api/datasources/uid/loki/health",
      "https://observability.local/api/datasources/uid/mimir/health",
    ],
  );
});

test("Grafana health falls back to Tempo proxy readiness when plugin health is unsupported", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.tempo = "tempo";

  const calls = [];
  const health = await getGrafanaHealth(config, {
    fetch: async input => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/datasources/uid/tempo/health")) {
        return new Response("{}", { status: 404, statusText: "Not Found" });
      }
      return createHealthyResponse();
    },
  });

  assert.deepEqual(
    health.checks.map(check => `${check.label}:${check.status}`),
    ["Grafana:ok", "Tempo datasource:ok", "Loki datasource:ok", "Metrics datasource:ok"],
  );
  assert.ok(calls.includes("http://grafana.local/api/health"));
  assert.ok(calls.includes("http://grafana.local/api/datasources/uid/tempo/health"));
  assert.ok(calls.includes("http://grafana.local/api/datasources/proxy/uid/tempo/ready"));
});

test("Grafana health reports unresolved auth before making backend calls", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "${OBSERVME_GRAFANA_TOKEN}";
  let fetchCalls = 0;

  const health = await getGrafanaHealth(config, {
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run when query auth is unresolved");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(
    health.checks.map(check => check.status),
    ["failed", "failed", "failed", "failed"],
  );
  for (const check of health.checks) {
    assert.match(check.detail, /Grafana query configuration is not ready/u);
    assert.match(check.detail, /query\.grafana\.token is unresolved/u);
    assert.doesNotMatch(check.detail, /\$\{OBSERVME_GRAFANA_TOKEN\}/u);
  }
});

test("Grafana health reports configured auth failures as 401 diagnostics", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "bad-token";

  const health = await getGrafanaHealth(config, {
    fetch: async () => new Response("{}", { status: 401, statusText: "Unauthorized" }),
  });

  assert.deepEqual(
    health.checks.map(check => check.status),
    ["failed", "failed", "failed", "failed"],
  );
  for (const check of health.checks) {
    assert.match(check.detail, /HTTP 401 Unauthorized/u);
    assert.match(check.detail, /Grafana authentication failed/u);
    assert.doesNotMatch(check.detail, /bad-token/u);
  }
});

test("Grafana transport failure formatting distinguishes TLS and DNS failures", () => {
  const tlsError = Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  const dnsError = Object.assign(new Error("not found"), { code: "ENOTFOUND" });

  assert.match(formatGrafanaFetchFailure(tlsError), /TLS certificate verification failed/u);
  assert.match(formatGrafanaFetchFailure(dnsError), /DNS lookup failed/u);
});

test("Grafana health sanitizes transport failure details", async () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "https://admin:secret@grafana.local?token=url-token";
  config.query.grafana.token = "grafana-token";

  const health = await getGrafanaHealth(config, {
    fetch: async () => {
      throw new Error(
        "Authorization: Bearer grafana-token https://admin:secret@grafana.local?token=url-token password=grafana-password /home/senad/private.env curl https://example.test OBSERVME_TOKEN=env-secret",
      );
    },
  });

  assert.equal(health.checks[0].status, "failed");
  assert.match(health.checks[0].detail, /\[redacted\]/u);
  assert.doesNotMatch(
    health.checks[0].detail,
    /grafana-token|admin:secret|url-token|grafana-password|private\.env|curl https|env-secret/u,
  );
});

test("Grafana health applies query.timeoutMs as an aborting fetch timeout", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 1;
  config.query.grafana.url = "http://grafana.local";
  config.query.grafana.token = "grafana-token";
  const signals = [];

  const health = await getGrafanaHealth(config, { fetch: createNeverResolvingFetch(signals) });

  assert.equal(health.timeoutMs, 1);
  assert.equal(signals.length, 4);
  assert.deepEqual(
    health.checks.map(check => check.status),
    ["failed", "failed", "failed", "failed"],
  );
  assert.deepEqual(
    health.checks.map(check => check.detail),
    ["timed out", "timed out", "timed out", "timed out"],
  );
});

test("Grafana trace links render configured safe trace URL templates", () => {
  const config = cloneDefaultConfig();
  config.query.links.traceUrlTemplate = "https://grafana.local/explore?trace={traceId}&ds={tempoDatasourceUid}";
  config.query.grafana.datasourceUids.tempo = "tempo/main";

  assert.equal(
    getGrafanaTraceLink(config, sampleTraceId.toUpperCase()),
    "https://grafana.local/explore?trace=4bf92f3577b34da6a3ce929d0e0e4736&ds=tempo%2Fmain",
  );

  config.query.links.traceUrlTemplate = "https://grafana.local/explore?trace=${traceId}&ds=${tempoDatasourceUid}";
  assert.equal(
    getGrafanaTraceLink(config, sampleTraceId),
    "https://grafana.local/explore?trace=4bf92f3577b34da6a3ce929d0e0e4736&ds=tempo%2Fmain",
  );
});

test("Grafana trace links fall back to a bounded Tempo Explore URL", () => {
  const config = cloneDefaultConfig();
  config.query.grafana.url = "https://grafana.local/observability";
  config.query.grafana.datasourceUids.tempo = "tempo-main";
  config.query.links.traceUrlTemplate = "";

  const link = getGrafanaTraceLink(config, sampleTraceId);
  const url = new URL(link);
  const panes = JSON.parse(url.searchParams.get("panes"));

  assert.equal(url.origin + url.pathname, "https://grafana.local/observability/explore");
  assert.equal(url.searchParams.get("schemaVersion"), "1");
  assert.equal(panes.observmeTrace.datasource, "tempo-main");
  assert.equal(panes.observmeTrace.queries[0].queryType, "traceId");
  assert.equal(panes.observmeTrace.queries[0].query, sampleTraceId);
});

test("Grafana trace links reject raw prompt, command, path, and malformed query inputs", () => {
  const config = cloneDefaultConfig();

  assert.throws(() => getGrafanaTraceLink(config, "Prompt: summarize this repository"), /raw prompts/u);
  assert.throws(() => getGrafanaTraceLink(config, "rm -rf /tmp/demo"), /commands/u);
  assert.throws(() => getGrafanaTraceLink(config, "/Users/example/.ssh/id_rsa"), /paths/u);
  assert.throws(() => getGrafanaTraceLink(config, "abc123"), /32-character hexadecimal/u);
});

test("telemetry emission modules do not depend on the Grafana query client", async () => {
  const files = (await Promise.all(telemetrySourceRoots.map(root => collectTypeScriptFiles(root)))).flat();
  const offenders = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (telemetryGrafanaDependencyPattern.test(text)) offenders.push(file);
  }

  assert.deepEqual(offenders, []);
});
