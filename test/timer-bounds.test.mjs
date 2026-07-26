import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import { runObsBackfill } from "../src/commands/obs-backfill.ts";
import { normalizeObsCommandTimeoutMs } from "../src/commands/obs-command-support.ts";
import { getObsHealthSnapshot } from "../src/commands/obs-health.ts";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { observMeConfigSchema } from "../src/config/schema.ts";
import {
  NODE_TIMER_MAX_MILLISECONDS,
  normalizeNodeTimerMilliseconds,
} from "../src/config/timer-limits.ts";
import { buildLogExporterWiring } from "../src/otel/logs.ts";
import { buildMetricExporterWiring } from "../src/otel/metrics.ts";
import { normalizeOtelOperationTimeoutMs } from "../src/otel/shutdown.ts";
import { buildTraceExporterWiring } from "../src/otel/traces.ts";
import { resolveGrafanaTimeoutMs } from "../src/query/grafana-transport.ts";

const configShape = Compile(observMeConfigSchema);
const timerConfigPaths = [
  ["otlp", "timeoutMs"],
  ["traces", "batch", "scheduledDelayMillis"],
  ["traces", "batch", "exportTimeoutMillis"],
  ["metrics", "exportIntervalMillis"],
  ["metrics", "exportTimeoutMillis"],
  ["logs", "batch", "scheduledDelayMillis"],
  ["query", "timeoutMs"],
  ["shutdown", "flushTimeoutMs"],
];

function cloneDefaultConfig() {
  return structuredClone(defaultObservMeConfig);
}

function setConfigPath(config, path, value) {
  let target = config;
  for (const segment of path.slice(0, -1)) target = target[segment];
  target[path.at(-1)] = value;
}

function createBackfillEntry() {
  return {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-07-07T11:10:00.000Z",
    message: {
      role: "user",
      content: "timer boundary test",
      timestamp: Date.parse("2026-07-07T11:10:00.000Z"),
    },
  };
}

function createBackfillContext(calls) {
  const entries = [createBackfillEntry()];
  return {
    cwd: "/workspace/demo",
    hasUI: true,
    ui: {
      notify: () => undefined,
      confirm: async (_title, _message, options) => {
        calls.confirm = options;
        return true;
      },
    },
    waitForIdle: options => {
      calls.waitForIdle = options;
    },
    isProjectTrusted: () => false,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getHeader: () => ({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-07-07T11:00:00.000Z",
        cwd: "/workspace/demo",
      }),
      getSessionId: () => "session-1",
      getSessionFile: () => "/tmp/session.jsonl",
    },
  };
}

function createBackfillExporter(calls) {
  return {
    emit: (_record, options) => {
      calls.emit = options;
    },
    flush: options => {
      calls.flush = options;
    },
    shutdown: options => {
      calls.shutdown = options;
    },
  };
}

test("timer-backed config fields accept Node's exact maximum and reject maximum-plus-one", () => {
  for (const path of timerConfigPaths) {
    const exactMaximumConfig = cloneDefaultConfig();
    setConfigPath(exactMaximumConfig, path, NODE_TIMER_MAX_MILLISECONDS);
    assert.equal(configShape.Check(exactMaximumConfig), true, `${path.join(".")} should accept the exact maximum`);

    const overflowingConfig = cloneDefaultConfig();
    setConfigPath(overflowingConfig, path, NODE_TIMER_MAX_MILLISECONDS + 1);
    assert.equal(configShape.Check(overflowingConfig), false, `${path.join(".")} should reject maximum-plus-one`);
  }
});

test("non-timer positive integers remain unconstrained by the Node timer maximum", () => {
  const config = cloneDefaultConfig();
  config.workflow.maxDepthWarning = NODE_TIMER_MAX_MILLISECONDS + 1;
  config.limits.maxPromptChars = NODE_TIMER_MAX_MILLISECONDS + 1;

  assert.equal(configShape.Check(config), true);
});

test("programmatic command, query, and shutdown timers cap maximum-plus-one deterministically", () => {
  const overflow = NODE_TIMER_MAX_MILLISECONDS + 1;
  const config = cloneDefaultConfig();
  config.query.timeoutMs = overflow;

  assert.equal(normalizeNodeTimerMilliseconds(NODE_TIMER_MAX_MILLISECONDS), NODE_TIMER_MAX_MILLISECONDS);
  assert.equal(normalizeNodeTimerMilliseconds(overflow), NODE_TIMER_MAX_MILLISECONDS);
  assert.equal(normalizeObsCommandTimeoutMs(overflow, 5_000), NODE_TIMER_MAX_MILLISECONDS);
  assert.equal(resolveGrafanaTimeoutMs(config), NODE_TIMER_MAX_MILLISECONDS);
  assert.equal(resolveGrafanaTimeoutMs(config, overflow), NODE_TIMER_MAX_MILLISECONDS);
  assert.equal(normalizeOtelOperationTimeoutMs(overflow), NODE_TIMER_MAX_MILLISECONDS);
});

test("OTLP and trace, log, and metric SDK scheduler options cap overflowing programmatic config", () => {
  const overflow = NODE_TIMER_MAX_MILLISECONDS + 1;
  const config = cloneDefaultConfig();
  config.otlp.timeoutMs = overflow;
  config.traces.batch.scheduledDelayMillis = overflow;
  config.traces.batch.exportTimeoutMillis = overflow;
  config.metrics.exportIntervalMillis = overflow;
  config.metrics.exportTimeoutMillis = overflow;
  config.logs.batch.scheduledDelayMillis = overflow;

  const traces = buildTraceExporterWiring(config);
  const metrics = buildMetricExporterWiring(config);
  const logs = buildLogExporterWiring(config);

  assert.deepEqual(
    [traces.exporter.timeoutMillis, metrics.exporter.timeoutMillis, logs.exporter.timeoutMillis],
    Array(3).fill(NODE_TIMER_MAX_MILLISECONDS),
  );
  assert.deepEqual(
    [traces.batch.scheduledDelayMillis, traces.batch.exportTimeoutMillis],
    Array(2).fill(NODE_TIMER_MAX_MILLISECONDS),
  );
  assert.deepEqual(
    [metrics.reader.exportIntervalMillis, metrics.reader.exportTimeoutMillis],
    Array(2).fill(NODE_TIMER_MAX_MILLISECONDS),
  );
  assert.equal(logs.batch.scheduledDelayMillis, NODE_TIMER_MAX_MILLISECONDS);
});

test("health and backfill programmatic timer overrides are capped before scheduling", async () => {
  const overflow = NODE_TIMER_MAX_MILLISECONDS + 1;
  const healthConfig = cloneDefaultConfig();
  healthConfig.traces.enabled = false;
  healthConfig.metrics.enabled = false;
  healthConfig.logs.enabled = false;
  healthConfig.query.enabled = false;

  const health = await getObsHealthSnapshot({ ui: { notify: () => undefined } }, {
    loadConfig: async () => healthConfig,
    timeoutMs: overflow,
  });
  assert.equal(health.timeoutMs, NODE_TIMER_MAX_MILLISECONDS);

  const calls = {};
  const summary = await runObsBackfill(
    createBackfillContext(calls),
    { currentSession: true },
    {
      loadConfig: async () => cloneDefaultConfig(),
      createExporter: (_config, _ctx, options) => {
        calls.setup = options;
        return createBackfillExporter(calls);
      },
      confirmTimeoutMs: overflow,
      exportOperationTimeoutMs: overflow,
      maxRecords: 1,
    },
  );

  assert.equal(summary.status, "completed");
  assert.equal(calls.confirm.timeout, NODE_TIMER_MAX_MILLISECONDS);
  for (const operation of ["waitForIdle", "setup", "emit", "flush", "shutdown"]) {
    assert.equal(calls[operation].timeoutMs, NODE_TIMER_MAX_MILLISECONDS, operation);
  }
});
