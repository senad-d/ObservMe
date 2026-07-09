#!/usr/bin/env node
// Smoke check: register lifecycle handlers in a Pi API harness and execute the
// session_start/session_shutdown path with an explicit offline telemetry config.
import assert from "node:assert/strict";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { registerHandlers } from "../src/pi/handlers.ts";
import { createSmokeContext, invokeLifecycleEvent, SmokePiHarness } from "./smoke-pi-harness.mjs";

const offlineEndpoint = "http://127.0.0.1:4318";
const offlineGrafanaUrl = "http://127.0.0.1:3000";
const externalEndpointPattern = /(?:^|\.)example\.com$/iu;

function createOfflineLifecycleConfig() {
  const config = structuredClone(defaultObservMeConfig);

  return {
    ...config,
    environment: "development",
    otlp: {
      ...config.otlp,
      endpoint: offlineEndpoint,
      headers: {},
      timeoutMs: 50,
    },
    traces: { ...config.traces, enabled: false },
    metrics: { ...config.metrics, enabled: false },
    logs: { ...config.logs, enabled: false },
    query: {
      ...config.query,
      enabled: false,
      grafana: {
        ...config.query.grafana,
        url: offlineGrafanaUrl,
        token: "",
        username: "",
        password: "",
      },
      links: {
        ...config.query.links,
        traceUrlTemplate: `${offlineGrafanaUrl}/explore?left=...`,
      },
    },
    shutdown: { ...config.shutdown, flushTimeoutMs: 50 },
  };
}

function assertNoExternalEndpoints(value, path = "config") {
  if (typeof value === "string") {
    assertNoExternalEndpointString(value, path);
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertNoExternalEndpoints(item, `${path}[${index}]`);
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertNoExternalEndpoints(item, `${path}.${key}`);
  }
}

async function loadOfflineLifecycleConfig() {
  return lifecycleConfig;
}

function assertNoExternalEndpointString(value, path) {
  const trimmed = value.trim();
  if (!trimmed || !URL.canParse(trimmed)) return;

  const url = new URL(trimmed);
  assert.ok(!externalEndpointPattern.test(url.hostname), `${path} must not use an external example endpoint`);
}

const lifecycleConfig = createOfflineLifecycleConfig();
assertNoExternalEndpoints(lifecycleConfig);

const harness = new SmokePiHarness();
registerHandlers(harness.pi, {
  configDirName: ".pi",
  loadConfig: loadOfflineLifecycleConfig,
});

const eventNames = harness.eventNames();

assert.ok(eventNames.includes("session_start"), "session_start handler must be registered");
assert.ok(eventNames.includes("session_shutdown"), "session_shutdown handler must be registered");

const context = createSmokeContext();
await invokeLifecycleEvent(harness, "session_start", { smoke: true }, context);
await invokeLifecycleEvent(harness, "session_shutdown", { smoke: true }, context);

assert.ok(context.ui.statuses.length >= 2, "lifecycle handlers should update visible Pi status state");
assert.equal(context.ui.statuses.at(-1)?.value, undefined, "session_shutdown should clear extension status");

console.log("Pi lifecycle smoke passed: session_start and session_shutdown handlers executed with offline telemetry disabled.");
