import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";
import {
  getObsHealthSnapshot,
  handleObsHealthCommand,
  renderObsHealth,
} from "../src/commands/obs-health.ts";

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

function createHealthyResponse() {
  return new Response("{}", { status: 200, statusText: "OK" });
}

class TrackedCollectorResponseBody {
  cancelCount = 0;

  cancel() {
    this.cancelCount += 1;
  }
}

class PendingCollectorFetch {
  closureCount = 0;

  async fetch(_input, init) {
    try {
      await delay(60_000, undefined, { signal: init.signal });
      throw new Error("pending Collector fetch unexpectedly completed");
    } catch (error) {
      this.closureCount += 1;
      throw error;
    }
  }
}

function createCollectorOnlyConfig() {
  const config = cloneDefaultConfig();
  config.otlp.endpoint = "http://collector.local:4318";
  config.query.enabled = false;
  return config;
}

function createTrackedCollectorResponse(status) {
  const body = new TrackedCollectorResponseBody();
  const response = new Response(new ReadableStream(body), {
    status,
    statusText: status >= 500 ? "Service Unavailable" : "OK",
  });
  return { body, response };
}

test("renderObsHealth reports Collector, Grafana, and datasource successes", () => {
  const output = renderObsHealth({
    timeoutMs: 500,
    checks: [
      { label: "Collector", kind: "service", status: "ok" },
      { label: "Grafana", kind: "service", status: "ok" },
      { label: "Tempo datasource", kind: "datasource", status: "ok" },
      { label: "Loki datasource", kind: "datasource", status: "ok" },
      { label: "Metrics datasource", kind: "datasource", status: "ok" },
    ],
  });

  assert.equal(
    output,
    [
      "Collector: reachable",
      "Grafana: reachable",
      "Tempo datasource: ok",
      "Loki datasource: ok",
      "Metrics datasource: ok",
    ].join("\n"),
  );
});

test("/obs health checks Collector, Grafana, and configured datasources with the configured timeout", async () => {
  const config = cloneDefaultConfig();
  config.otlp.endpoint = "http://collector.local:4318";
  config.otlp.headers = { Authorization: "Bearer otlp-token" };
  config.query.timeoutMs = 1234;
  config.query.grafana.url = "http://grafana.local:3000";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids = {
    tempo: "tempo-main",
    loki: "loki-main",
    prometheus: "mimir-main",
  };

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.ok(init.signal instanceof AbortSignal);
    return createHealthyResponse();
  };

  const snapshot = await getObsHealthSnapshot(createCommandContext([]), {
    loadConfig: async () => config,
    fetch: fetcher,
  });

  assert.equal(snapshot.timeoutMs, 1234);
  assert.match(renderObsHealth(snapshot), /Collector transport security: plaintext HTTP/u);
  assert.match(renderObsHealth(snapshot), /Grafana transport security: plaintext HTTP/u);
  assert.equal(renderObsHealth(snapshot).includes("Collector: reachable"), true);
  assert.deepEqual(
    calls.map(call => call.input),
    [
      "http://collector.local:4318",
      "http://grafana.local:3000/api/health",
      "http://grafana.local:3000/api/datasources/uid/tempo-main/health",
      "http://grafana.local:3000/api/datasources/uid/loki-main/health",
      "http://grafana.local:3000/api/datasources/uid/mimir-main/health",
    ],
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer otlp-token");
  assert.equal(calls[1].init.headers.Authorization, "Bearer grafana-token");
});

test("/obs health cancels successful and failed Collector response bodies exactly once", async () => {
  const config = createCollectorOnlyConfig();
  const cases = [
    { status: 200, expectedStatus: "ok" },
    { status: 503, expectedStatus: "failed" },
  ];

  for (const testCase of cases) {
    const tracked = createTrackedCollectorResponse(testCase.status);
    const snapshot = await getObsHealthSnapshot(createCommandContext([]), {
      loadConfig: async () => config,
      fetch: async () => tracked.response,
      timeoutMs: 25,
    });

    await Promise.resolve();
    assert.equal(snapshot.checks[0].status, testCase.expectedStatus);
    assert.equal(tracked.body.cancelCount, 1);
  }
});

test("/obs health releases every stalled Collector body across repeated checks", async () => {
  const config = createCollectorOnlyConfig();
  const trackedBodies = [];

  for (let index = 0; index < 5; index += 1) {
    const tracked = createTrackedCollectorResponse(200);
    trackedBodies.push(tracked.body);
    const snapshot = await getObsHealthSnapshot(createCommandContext([]), {
      loadConfig: async () => config,
      fetch: async () => tracked.response,
      timeoutMs: 25,
    });

    assert.match(renderObsHealth(snapshot), /Collector: reachable/u);
  }

  await Promise.resolve();
  assert.deepEqual(
    trackedBodies.map(body => body.cancelCount),
    [1, 1, 1, 1, 1],
  );
});

test("/obs health aborts a pending Collector request and closes it exactly once", async () => {
  const config = createCollectorOnlyConfig();
  const pending = new PendingCollectorFetch();
  const snapshot = await getObsHealthSnapshot(createCommandContext([]), {
    loadConfig: async () => config,
    fetch: pending.fetch.bind(pending),
    timeoutMs: 5,
  });

  assert.equal(pending.closureCount, 1);
  assert.equal(snapshot.checks[0].status, "failed");
  assert.equal(snapshot.checks[0].detail, "timed out");
  assert.match(renderObsHealth(snapshot), /Collector: unreachable \(timed out/u);
});

test("/obs health reports acknowledged TLS verification bypasses without credentials", async () => {
  const config = cloneDefaultConfig();
  config.otlp.tls.insecureSkipVerify = true;
  config.query.grafana.tls.insecureSkipVerify = true;
  config.privacy.allowInsecureTransport = true;
  config.otlp.headers = { Authorization: "Bearer private-otlp-token" };
  config.query.grafana.token = "private-grafana-token";

  const snapshot = await getObsHealthSnapshot(createCommandContext([]), {
    loadConfig: async () => config,
    fetch: async () => createHealthyResponse(),
  });
  const output = renderObsHealth(snapshot);

  assert.match(output, /Collector transport security: TLS certificate verification disabled \(explicitly acknowledged\)/u);
  assert.match(output, /Grafana transport security: TLS certificate verification disabled \(explicitly acknowledged\)/u);
  assert.doesNotMatch(output, /private-otlp-token|private-grafana-token/u);
});

test("/obs health reports query.enabled=false and skips every Grafana network call", async () => {
  const config = cloneDefaultConfig();
  config.otlp.endpoint = "http://collector.local:4318";
  config.query.enabled = false;
  const notifications = [];
  const calls = [];

  await handleObsHealthCommand("health", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: async input => {
      calls.push(String(input));
      return createHealthyResponse();
    },
  });

  assert.deepEqual(calls, ["http://collector.local:4318"]);
  assert.equal(notifications[0].type, "info");
  assert.match(notifications[0].message, /Collector: reachable/u);
  assert.match(
    notifications[0].message,
    /Grafana: skipped \(Grafana query integration is disabled \(query\.enabled=false\)\. Next: set query\.enabled=true to enable Grafana-backed commands\.\)/u,
  );
  assert.match(
    notifications[0].message,
    /Metrics datasource: skipped \(Grafana query integration is disabled \(query\.enabled=false\)\./u,
  );
});

test("/obs health reports unresolved Grafana auth before making Grafana calls", async () => {
  const config = cloneDefaultConfig();
  config.otlp.endpoint = "http://collector.local:4318";
  config.query.grafana.url = "http://grafana.local:3000";
  config.query.grafana.token = "${OBSERVME_GRAFANA_TOKEN}";
  const notifications = [];
  const calls = [];

  const fetcher = async input => {
    calls.push(String(input));
    if (String(input) === "http://collector.local:4318") return createHealthyResponse();
    throw new Error("fetch should not run for Grafana when query auth is unresolved");
  };

  await handleObsHealthCommand("health", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: fetcher,
    timeoutMs: 25,
  });

  assert.deepEqual(calls, ["http://collector.local:4318"]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
  assert.match(notifications[0].message, /Collector: reachable/u);
  assert.match(notifications[0].message, /Grafana: unreachable \(Grafana query configuration is not ready: .*query\.grafana\.token is unresolved/u);
  assert.match(notifications[0].message, /Next: check query\.grafana\.url and credentials, then rerun \/obs health\./u);
  assert.doesNotMatch(notifications[0].message, /\$\{OBSERVME_GRAFANA_TOKEN\}/u);
});

test("/obs health reports an unreachable Collector without throwing", async () => {
  const config = cloneDefaultConfig();
  config.otlp.endpoint = "http://collector.local:4318";
  config.query.grafana.url = "http://grafana.local:3000";
  config.query.grafana.token = "grafana-token";

  const fetcher = async input => {
    if (String(input) === "http://collector.local:4318") throw new Error("connect ECONNREFUSED");
    return createHealthyResponse();
  };
  const notifications = [];

  await assert.doesNotReject(
    handleObsHealthCommand("health", createCommandContext(notifications), {
      loadConfig: async () => config,
      fetch: fetcher,
      timeoutMs: 25,
    }),
  );

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
  assert.match(notifications[0].message, /Collector: unreachable \(connect ECONNREFUSED Next: verify the Collector is running and otlp\.endpoint is reachable\.\)/u);
  assert.match(notifications[0].message, /Grafana: reachable/u);
});

test("/obs health diagnostics do not render configured header secrets", async () => {
  const config = cloneDefaultConfig();
  config.otlp.endpoint = "http://collector.local:4318";
  config.otlp.headers = { Authorization: "Bearer otlp-header-secret" };
  config.query.grafana.url = "http://grafana.local:3000";
  config.query.grafana.token = "grafana-token-secret";
  const notifications = [];

  const fetcher = async input => {
    if (String(input) === "http://collector.local:4318") {
      throw new Error("Authorization: Bearer otlp-header-secret /tmp/private.env OBSERVME_OTLP_TOKEN=otlp-header-secret");
    }

    throw new Error("Authorization: Bearer grafana-token-secret password=grafana-password-secret");
  };

  await handleObsHealthCommand("health", createCommandContext(notifications), {
    loadConfig: async () => config,
    fetch: fetcher,
    timeoutMs: 25,
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
  assert.match(notifications[0].message, /Collector: unreachable/u);
  assert.match(notifications[0].message, /Grafana: unreachable/u);
  assert.doesNotMatch(notifications[0].message, /otlp-header-secret|grafana-token-secret|grafana-password-secret|private\.env/u);
});

test("/obs health stores sanitized failure details before rendering", async () => {
  const config = cloneDefaultConfig();
  config.otlp.endpoint = "http://collector.local:4318";
  config.query.grafana.url = "http://grafana.local:3000";
  config.query.grafana.token = "grafana-token";

  const snapshot = await getObsHealthSnapshot(createCommandContext([]), {
    loadConfig: async () => config,
    fetch: async input => {
      if (String(input) === "http://collector.local:4318") {
        throw new Error(
          "Authorization: Basic private-basic password=collector-password /Users/senad/private.env rm -rf /tmp/demo OBSERVME_TOKEN=collector-token",
        );
      }

      return createHealthyResponse();
    },
    timeoutMs: 25,
  });

  assert.equal(snapshot.checks[0].status, "failed");
  assert.match(snapshot.checks[0].detail, /\[redacted\]/u);
  assert.doesNotMatch(snapshot.checks[0].detail, /private-basic|collector-password|private\.env|rm -rf|collector-token/u);
});

test("root obs command dispatches status and health subcommands", async () => {
  const pi = createFakeCommandPi();
  const config = cloneDefaultConfig();
  const health = {
    timeoutMs: 50,
    checks: [{ label: "Collector", kind: "service", status: "ok" }],
  };

  registerObsCommand(pi, {
    status: { getStatus: () => ({ config, queueDrops: 0 }) },
    health: { getHealth: () => health },
  });

  const command = pi.commands.get("obs");
  const notifications = [];
  await command.handler("health", createCommandContext(notifications));
  await command.handler("status", createCommandContext(notifications));

  assert.deepEqual(getObsRootCommandArgumentCompletions(""), [
    { value: "status", label: "status" },
    { value: "health", label: "health" },
    { value: "session", label: "session" },
    { value: "cost", label: "cost" },
    { value: "trace", label: "trace" },
    { value: "tools", label: "tools" },
    { value: "agents", label: "agents" },
    { value: "backfill", label: "backfill" },
    { value: "errors", label: "errors" },
    { value: "logs", label: "logs" },
    { value: "link", label: "link" },
  ]);
  assert.equal(notifications[0].message, "Collector: reachable");
  assert.match(notifications[1].message, /ObservMe: enabled/u);
});
