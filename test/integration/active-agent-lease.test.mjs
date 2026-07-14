import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  CANONICAL_ACTIVE_AGENT_TOTAL_PROMQL,
  CANONICAL_RAW_ACTIVE_AGENT_CLAIMS_PROMQL,
} from "../support/active-agent-promql.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const childFixturePath = resolve(projectRoot, "test/integration/fixtures/active-agent-child.mjs");
const collectorConfigPath = resolve(projectRoot, "test/integration/active-agent-lease-collector.yaml");
const prometheusConfigPath = resolve(projectRoot, "test/integration/active-agent-lease-prometheus.yaml");
const collectorImage = process.env.OBSERVME_COLLECTOR_IMAGE ?? "otel/opentelemetry-collector-contrib:0.104.0";
const prometheusImage = process.env.OBSERVME_PROMETHEUS_IMAGE ?? "prom/prometheus:v2.53.1";
const dockerResourceLabel = "io.observme.integration=active-agent-lease";
const rawActiveQuery = CANONICAL_RAW_ACTIVE_AGENT_CLAIMS_PROMQL;
const leasedActiveQuery = CANONICAL_ACTIVE_AGENT_TOTAL_PROMQL;
const leaseExpiryQuery = "max(observme_agent_lease_expires_unixtime_seconds)";
const fixtureLeaseDurationMs = 10_000;
const supportedClockSkewMs = 5_000;
const prometheusScrapeIntervalMs = 1_000;
const abruptConvergenceBoundMs = fixtureLeaseDurationMs + supportedClockSkewMs + prometheusScrapeIntervalMs;

function createIntegrationState() {
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  return {
    networkName: `observme-lease-it-${suffix}`,
    collectorName: `observme-lease-collector-${suffix}`,
    prometheusName: `observme-lease-prometheus-${suffix}`,
    collectorOtlpPort: 0,
    prometheusPort: 0,
    children: new Set(),
  };
}

async function execDocker(args, operation, options = {}) {
  try {
    const result = await execFile("docker", args, {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: options.timeout ?? 30_000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch {
    throw new Error(`${operation} failed without exposing Docker arguments or local paths.`);
  }
}

async function canRunDocker() {
  try {
    await execFile("docker", ["info"], { encoding: "utf8", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function startIntegrationStack(state) {
  await execDocker(
    ["network", "create", "--label", dockerResourceLabel, state.networkName],
    "Docker network creation",
  );
  await startCollector(state);
  await startPrometheus(state);
}

async function startCollector(state) {
  await execDocker(
    [
      "run",
      "--rm",
      "--detach",
      "--name",
      state.collectorName,
      "--label",
      dockerResourceLabel,
      "--network",
      state.networkName,
      "--network-alias",
      "otel-collector",
      "--publish",
      "127.0.0.1::4318",
      "--publish",
      "127.0.0.1::13133",
      "--volume",
      `${collectorConfigPath}:/etc/otelcol/config.yaml:ro`,
      collectorImage,
      "--config=/etc/otelcol/config.yaml",
    ],
    "Collector startup",
    { timeout: 60_000 },
  );

  state.collectorOtlpPort = await getPublishedPort(state.collectorName, 4318);
  const healthPort = await getPublishedPort(state.collectorName, 13133);
  await waitForHttpOk(`http://127.0.0.1:${healthPort}/`, "Collector health", 30_000);
}

async function startPrometheus(state) {
  await execDocker(
    [
      "run",
      "--rm",
      "--detach",
      "--name",
      state.prometheusName,
      "--label",
      dockerResourceLabel,
      "--network",
      state.networkName,
      "--publish",
      "127.0.0.1::9090",
      "--volume",
      `${prometheusConfigPath}:/etc/prometheus/prometheus.yml:ro`,
      "--tmpfs",
      "/prometheus:rw,mode=1777",
      prometheusImage,
      "--config.file=/etc/prometheus/prometheus.yml",
      "--storage.tsdb.path=/prometheus",
    ],
    "Prometheus startup",
    { timeout: 60_000 },
  );

  state.prometheusPort = await getPublishedPort(state.prometheusName, 9090);
  await waitForHttpOk(
    `http://127.0.0.1:${state.prometheusPort}/-/ready`,
    "Prometheus readiness",
    30_000,
  );
}

async function getPublishedPort(containerName, containerPort) {
  const result = await execDocker(
    ["port", containerName, `${containerPort}/tcp`],
    "Docker published-port lookup",
  );
  const firstLine = result.stdout.trim().split("\n").find(Boolean) ?? "";
  const port = Number(firstLine.slice(firstLine.lastIndexOf(":") + 1));

  if (!Number.isInteger(port) || port <= 0) throw new Error("Docker returned an invalid published port.");
  return port;
}

async function waitForHttpOk(url, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The bounded readiness loop owns transient startup failures.
    }
    await delay(250);
  }

  throw new Error(`${label} did not become ready within its bounded wait.`);
}

function startTelemetryChild(state) {
  const child = spawn(process.execPath, [childFixturePath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      OBSERVME_IT_OTLP_ENDPOINT: `http://127.0.0.1:${state.collectorOtlpPort}`,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  state.children.add(child);
  return child;
}

async function waitForChildReady(child) {
  const [message] = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
  assert.ok(message && message.type === "ready", "Telemetry child should report sanitized readiness.");
}

async function waitForChildExit(state, child) {
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit", { signal: AbortSignal.timeout(15_000) });
  }
  state.children.delete(child);
}

async function queryPrometheus(state, query) {
  const url = new URL(`http://127.0.0.1:${state.prometheusPort}/api/v1/query`);
  url.searchParams.set("query", query);

  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error("Prometheus query returned a non-success status.");

  const payload = await response.json();
  if (payload.status !== "success" || !Array.isArray(payload.data?.result)) {
    throw new Error("Prometheus query returned an invalid response shape.");
  }

  const result = payload.data.result[0];
  if (!Array.isArray(result?.value) || result.value.length < 2) return Number.NaN;
  return Number(result.value[1]);
}

function isPositive(value) {
  return Number.isFinite(value) && value > 0;
}

function isZero(value) {
  return value === 0;
}

function hasLeaseHeadroom(value) {
  return Number.isFinite(value) && value > (Date.now() / 1000) + 6;
}

async function waitForPrometheusValue(state, label, query, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = Number.NaN;

  while (Date.now() < deadline) {
    try {
      lastValue = await queryPrometheus(state, query);
      if (predicate(lastValue)) return { value: lastValue, observedAtMs: Date.now() };
    } catch {
      // Prometheus scrape and query propagation are eventually consistent.
    }
    await delay(250);
  }

  const renderedValue = Number.isFinite(lastValue) ? String(lastValue) : "no numeric sample";
  throw new Error(`${label} timed out with ${renderedValue}.`);
}

async function waitForActiveChild(state, child) {
  await waitForChildReady(child);
  await waitForPrometheusValue(state, "raw active claim", rawActiveQuery, isPositive, 15_000);
  await waitForPrometheusValue(state, "leased active count", leasedActiveQuery, isPositive, 15_000);
  return waitForPrometheusValue(state, "renewed lease", leaseExpiryQuery, hasLeaseHeadroom, 15_000);
}

async function requestCleanShutdown(child) {
  child.send({ type: "shutdown" });
}

function requestSigtermShutdown(child) {
  const signalled = child.kill("SIGTERM");
  assert.ok(signalled, "Telemetry child should accept SIGTERM.");
}

async function exerciseGracefulTermination(state, termination) {
  const child = startTelemetryChild(state);
  const lease = await waitForActiveChild(state, child);

  if (termination === "message") await requestCleanShutdown(child);
  else requestSigtermShutdown(child);
  await waitForChildExit(state, child);

  await waitForPrometheusValue(state, "clean raw claim removal", rawActiveQuery, isZero, 8_000);
  const zero = await waitForPrometheusValue(
    state,
    "clean leased count removal",
    leasedActiveQuery,
    isZero,
    8_000,
  );
  assert.ok(
    zero.observedAtMs / 1000 < lease.value,
    "Clean lifecycle propagation should reach zero before the last observed lease expires.",
  );
}

async function inspectCollector(state) {
  const result = await execDocker(
    ["inspect", "--format", "{{.Id}}|{{.RestartCount}}", state.collectorName],
    "Collector identity inspection",
  );
  const [id, restartCountText] = result.stdout.trim().split("|");
  return { id, restartCount: Number(restartCountText) };
}

async function exerciseAbruptTermination(state) {
  const child = startTelemetryChild(state);
  await waitForActiveChild(state, child);
  const collectorBefore = await inspectCollector(state);
  const killedAtMs = Date.now();
  const signalled = child.kill("SIGKILL");
  assert.ok(signalled, "Telemetry child should accept SIGKILL.");
  await waitForChildExit(state, child);

  await delay(2_500);
  await waitForPrometheusValue(
    state,
    "cached raw claim after fresh scrapes",
    rawActiveQuery,
    isPositive,
    5_000,
  );
  const zero = await waitForPrometheusValue(
    state,
    "lease-aware abrupt convergence",
    leasedActiveQuery,
    isZero,
    abruptConvergenceBoundMs,
  );
  const rawAfterExpiry = await queryPrometheus(state, rawActiveQuery);
  const collectorAfter = await inspectCollector(state);

  assert.ok(
    zero.observedAtMs - killedAtMs <= abruptConvergenceBoundMs,
    "Lease-aware activity should converge within lease, supported skew, and one scrape interval.",
  );
  assert.ok(
    rawAfterExpiry > 0,
    "The cached raw claim should remain positive when the lease-aware count has reached zero.",
  );
  assert.ok(
    collectorAfter.id === collectorBefore.id,
    "The Collector container should remain unchanged across abrupt producer termination.",
  );
  assert.ok(
    collectorAfter.restartCount === 0 && collectorBefore.restartCount === 0,
    "Lease expiry should require no Collector restart.",
  );
}

async function cleanupIntegrationState(state) {
  await stopChildren(state);
  await removeContainer(state.prometheusName);
  await removeContainer(state.collectorName);
  await removeNetwork(state.networkName);
}

async function stopChildren(state) {
  const pending = [];
  for (const child of state.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    pending.push(waitForChildExitQuietly(child));
  }
  await Promise.all(pending);
  state.children.clear();
}

async function waitForChildExitQuietly(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(5000) });
  } catch {
    return;
  }
}

async function removeContainer(name) {
  try {
    await execDocker(["rm", "--force", "--volumes", name], "Docker container cleanup", {
      timeout: 30_000,
    });
  } catch {
    // Cleanup is idempotent after partial startup or Docker daemon loss.
  }
}

async function removeNetwork(name) {
  try {
    await execDocker(["network", "rm", name], "Docker network cleanup", { timeout: 30_000 });
  } catch {
    // Cleanup is idempotent after partial startup or Docker daemon loss.
  }
}

test("active-agent leases expire after abrupt producer death while raw Collector claims stay cached", { timeout: 180_000 }, async t => {
  if (process.platform === "win32" || !(await canRunDocker())) {
    t.skip("A POSIX host with a reachable Docker daemon is required for abrupt-termination integration coverage.");
    return;
  }

  const state = createIntegrationState();
  t.after(cleanupIntegrationState.bind(undefined, state));
  await startIntegrationStack(state);

  await exerciseGracefulTermination(state, "message");
  await exerciseGracefulTermination(state, "sigterm");
  await exerciseAbruptTermination(state);
});
