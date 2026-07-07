#!/usr/bin/env node
// Smoke check: launch a real Pi RPC process with the local ObservMe extension,
// verify /obs command discovery, and exercise command routing against a
// deterministic local backend without reading developer secrets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const rpcTimeoutMs = 15_000;
const smokeUsername = "smoke";
const smokePassword = "smoke";
const expectedGrafanaAuthorization = `Basic ${Buffer.from(`${smokeUsername}:${smokePassword}`).toString("base64")}`;

class SmokeBackendServer {
  constructor() {
    this.grafanaRequests = [];
    this.slowPrometheusQueryDelayMs = 0;
    this.server = createServer(this.handleRequest.bind(this));
  }

  get baseUrl() {
    const address = this.server.address();
    assert.ok(address && typeof address === "object", "smoke backend must have a TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
  }

  async close() {
    if (!this.server.listening) return;

    this.server.close();
    await once(this.server, "close");
  }

  delayPrometheusQueries(delayMs) {
    this.slowPrometheusQueryDelayMs = Math.max(0, Math.trunc(delayMs));
  }

  handleRequest(request, response) {
    const requestUrl = request.url ?? "/";
    const authorization = String(request.headers.authorization ?? "");

    if (requestUrl.startsWith("/api/")) {
      this.grafanaRequests.push({ url: requestUrl, authorization });
      if (this.shouldDelayPrometheusQuery(requestUrl)) {
        this.respondToDelayedGrafanaRequest(authorization, response);
        return;
      }

      this.respondToGrafanaRequest(authorization, response);
      return;
    }

    writeTextResponse(response, 200, "ok");
  }

  respondToGrafanaRequest(authorization, response) {
    if (authorization !== expectedGrafanaAuthorization) {
      writeJsonResponse(response, 401, { message: "unauthorized" });
      return;
    }

    writeJsonResponse(response, 200, { status: "ok" });
  }

  respondToDelayedGrafanaRequest(authorization, response) {
    const timeout = setTimeout(this.respondToDelayedGrafanaRequestNow.bind(this, authorization, response), this.slowPrometheusQueryDelayMs);
    timeout.unref?.();
  }

  respondToDelayedGrafanaRequestNow(authorization, response) {
    if (response.destroyed || response.writableEnded) return;
    this.respondToGrafanaRequest(authorization, response);
  }

  shouldDelayPrometheusQuery(requestUrl) {
    return this.slowPrometheusQueryDelayMs > 0 && requestUrl.startsWith("/api/datasources/proxy/uid/prometheus/api/v1/query");
  }

  assertAuthenticatedGrafanaProbes() {
    assert.ok(this.grafanaRequests.length >= 4, "Grafana health and datasource probes should use the smoke backend");

    for (const request of this.grafanaRequests) {
      assert.equal(request.authorization, expectedGrafanaAuthorization, `Grafana probe ${request.url} should use configured Basic auth`);
    }
  }
}

class PiRpcClient {
  constructor(options) {
    this.records = [];
    this.waiters = [];
    this.stderr = "";
    this.stdoutBuffer = "";
    this.decoder = new StringDecoder("utf8");
    this.exitCode = undefined;
    this.exitSignal = undefined;
    this.nextId = 1;
    this.child = spawn("pi", options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", this.handleStdoutData.bind(this));
    this.child.stderr.on("data", this.handleStderrData.bind(this));
    this.child.on("error", this.handleError.bind(this));
    this.child.on("exit", this.handleExit.bind(this));
  }

  handleStdoutData(chunk) {
    this.stdoutBuffer += this.decoder.write(chunk);
    this.drainStdoutBuffer();
  }

  handleStderrData(chunk) {
    this.stderr += chunk.toString();
  }

  handleExit(code, signal) {
    this.exitCode = code;
    this.exitSignal = signal;
    this.rejectWaiters(new Error(`Pi RPC process exited early (${formatExit(code, signal)}).${this.formatStderr()}`));
  }

  handleError(error) {
    this.rejectWaiters(new Error(`Failed to start Pi RPC process: ${formatError(error)}.${this.formatStderr()}`));
  }

  drainStdoutBuffer() {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleStdoutLine(stripTrailingCarriageReturn(rawLine));
    }
  }

  handleStdoutLine(line) {
    if (!line.trim()) return;

    try {
      this.records.push(JSON.parse(line));
      this.resolveWaiters();
    } catch (error) {
      this.stderr += `\nNon-JSON stdout from Pi RPC: ${line}\n${formatError(error)}`;
    }
  }

  send(command) {
    assert.ok(this.child.stdin.writable, "Pi RPC stdin should be writable");
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async request(command) {
    const id = `smoke-${this.nextId}`;
    this.nextId += 1;
    this.send({ id, ...command });

    const response = await this.waitForRecord(record => isResponseForId(record, id), `response ${id}`);
    assert.equal(response.success, true, `RPC ${command.type} should succeed: ${response.error ?? "unknown error"}`);
    return response;
  }

  async waitForNotifyMessage(prefix) {
    const record = await this.waitForRecord(record => isNotifyMessageWithPrefix(record, prefix), `notify ${prefix}`);
    return String(record.message);
  }

  async waitForStatusLoaded() {
    return this.waitForRecord(isObservMeLoadedStatus, "ObservMe status indicator");
  }

  waitForRecord(predicate, label) {
    const existing = this.records.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.exitCode !== undefined) {
      return Promise.reject(new Error(`Pi RPC process exited before ${label} (${formatExit(this.exitCode, this.exitSignal)}).${this.formatStderr()}`));
    }

    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        predicate,
        label,
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout: setTimeout(() => this.rejectWaiterByLabel(label), rpcTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  resolveWaiters() {
    for (const waiter of [...this.waiters]) {
      const match = this.records.find(waiter.predicate);
      if (!match) continue;

      this.removeWaiter(waiter);
      waiter.resolve(match);
    }
  }

  rejectWaiterByLabel(label) {
    const waiter = this.waiters.find(candidate => candidate.label === label);
    if (!waiter) return;

    this.removeWaiter(waiter);
    waiter.reject(new Error(`Timed out waiting for ${label}.${this.formatStderr()}`));
  }

  rejectWaiters(error) {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(error);
    }
  }

  removeWaiter(waiter) {
    clearTimeout(waiter.timeout);
    this.waiters = this.waiters.filter(candidate => candidate !== waiter);
  }

  formatStderr() {
    const trimmed = this.stderr.trim();
    return trimmed ? `\nStderr:\n${trimmed}` : "";
  }

  async stop() {
    if (this.exitCode !== undefined) return;

    this.child.kill("SIGTERM");
    await waitForProcessExit(this.child, 5_000);
    if (this.exitCode !== undefined) return;

    this.child.kill("SIGKILL");
    await waitForProcessExit(this.child, 5_000);
  }
}

async function main() {
  const backend = new SmokeBackendServer();
  let client;
  let temporaryRoot;

  try {
    await backend.start();
    temporaryRoot = await createTemporaryPiProject(backend.baseUrl);
    client = new PiRpcClient(createPiRpcOptions(temporaryRoot.projectDir, temporaryRoot.homeDir));

    await client.waitForStatusLoaded();
    await assertObsCommandIsDiscoverable(client);
    await assertObsStatusCommand(client, backend.baseUrl);
    await assertObsSessionCommand(client);
    await assertObsHealthCommand(client);
    backend.assertAuthenticatedGrafanaProbes();
    await assertObsCostTimeoutCommand(client, backend);

    console.log("Pi runtime smoke passed: real RPC process discovered /obs and executed status, session, health, and bounded query commands.");
  } finally {
    await client?.stop();
    await backend.close();
    await removeTemporaryRoot(temporaryRoot?.rootDir);
  }
}

async function createTemporaryPiProject(baseUrl) {
  const rootDir = await mkdtemp(join(tmpdir(), "observme-pi-runtime-"));
  const homeDir = join(rootDir, "home");
  const projectDir = join(rootDir, "project");
  const configDir = join(projectDir, ".pi");

  await mkdir(homeDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "observme.yaml"), renderSmokeObservMeConfig(baseUrl), "utf8");

  return { rootDir, homeDir, projectDir };
}

function createPiRpcOptions(projectDir, homeDir) {
  return {
    cwd: projectDir,
    env: createSanitizedEnvironment(homeDir),
    args: [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--approve",
      "--extension",
      repoRoot,
    ],
  };
}

function createSanitizedEnvironment(homeDir) {
  const env = { ...process.env, HOME: homeDir, NO_COLOR: "1" };

  for (const key of Object.keys(env)) {
    if (key.startsWith("OBSERVME_")) delete env[key];
  }

  return env;
}

function renderSmokeObservMeConfig(baseUrl) {
  return `observme:
  environment: development
  tenant: pi-runtime-smoke
  otlp:
    endpoint: ${baseUrl}
    headers: {}
  resource:
    attributes:
      service.name: observme-pi-runtime-smoke
      observme.tenant.id: pi-runtime-smoke
      deployment.environment.name: development
  traces:
    enabled: false
  metrics:
    enabled: false
  logs:
    enabled: false
  privacy:
    allowInsecureTransport: true
    customRedactionPatterns: []
  query:
    timeoutMs: 500
    links:
      traceUrlTemplate: ${baseUrl}/explore?traceId=\${traceId}
    grafana:
      url: ${baseUrl}
      token: ""
      username: ${smokeUsername}
      password: ${smokePassword}
      datasourceUids:
        tempo: tempo
        loki: loki
        prometheus: prometheus
`;
}

async function assertObsCommandIsDiscoverable(client) {
  const response = await client.request({ type: "get_commands" });
  const commands = response.data?.commands ?? [];
  const obsCommand = commands.find(command => command.name === "obs" && command.source === "extension");

  assert.ok(obsCommand, "real Pi command registry should list /obs as an extension command");
}

async function assertObsStatusCommand(client, baseUrl) {
  const notification = client.waitForNotifyMessage("ObservMe:");
  await client.request({ type: "prompt", message: "/obs status" });
  const message = await notification;

  assert.match(message, /ObservMe: enabled/u, "/obs status should report ObservMe enabled from the trusted fixture config");
  assert.match(message, new RegExp(`OTLP endpoint: ${escapeRegExp(baseUrl)}`, "u"), "/obs status should use the trusted project config endpoint");
  assert.match(message, /Config source: trusted project config \(\.pi\/observme\.yaml\)/u, "/obs status should expose trusted project config source");
  assert.match(message, new RegExp(`Grafana URL: ${escapeRegExp(baseUrl)}/?`, "u"), "/obs status should expose the trusted local Grafana query URL");
  assert.match(message, /Grafana query readiness: ready/u, "/obs status should report configured Grafana query readiness");
  assert.match(message, /Traces: disabled/u, "/obs status should reflect the smoke fixture signal settings");
  assert.doesNotMatch(message, /unavailable|unknown state/iu, "/obs status should not report unloaded or unknown extension state");
}

async function assertObsSessionCommand(client) {
  const notification = client.waitForNotifyMessage("Session:");
  await client.request({ type: "prompt", message: "/obs session" });
  const message = await notification;

  assert.match(message, /^Session: session-/mu, "/obs session should expose session_start runtime state");
  assert.doesNotMatch(message, /Session: unknown/u, "/obs session should not report an unknown session while the extension is active");
  assert.doesNotMatch(message, /ObservMe session unavailable/iu, "/obs session should not fail through Pi command routing");
}

async function assertObsHealthCommand(client) {
  const notification = client.waitForNotifyMessage("Collector:");
  await client.request({ type: "prompt", message: "/obs health" });
  const message = await notification;

  assert.match(message, /Collector: reachable/u, "/obs health should verify the configured Collector endpoint");
  assert.match(message, /Grafana: reachable/u, "/obs health should verify configured Grafana auth and reachability");
  assert.match(message, /Tempo datasource: ok/u, "/obs health should verify the Tempo datasource");
  assert.match(message, /Loki datasource: ok/u, "/obs health should verify the Loki datasource");
  assert.match(message, /Metrics datasource: ok/u, "/obs health should verify the Prometheus datasource");
}

async function assertObsCostTimeoutCommand(client, backend) {
  const notification = client.waitForNotifyMessage("ObservMe cost unavailable:");
  const startedAtMs = Date.now();

  backend.delayPrometheusQueries(2_000);
  try {
    await client.request({ type: "prompt", message: "/obs cost" });
    const message = await notification;
    const elapsedMs = Date.now() - startedAtMs;

    assert.match(message, /Prometheus query timed out\./u, "/obs cost should surface the query timeout reason");
    assert.ok(elapsedMs < 1_500, `/obs cost should complete within the bounded query timeout, got ${elapsedMs}ms`);
  } finally {
    backend.delayPrometheusQueries(0);
  }
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null) return;

  const timeout = wait(timeoutMs);
  await Promise.race([once(child, "exit"), timeout]);
}

async function wait(timeoutMs) {
  await new Promise(resolvePromise => {
    const timeout = setTimeout(resolvePromise, timeoutMs);
    timeout.unref?.();
  });
}

async function removeTemporaryRoot(rootDir) {
  if (!rootDir) return;
  await rm(rootDir, { recursive: true, force: true });
}

function isResponseForId(record, id) {
  return record?.type === "response" && record.id === id;
}

function isNotifyMessageWithPrefix(record, prefix) {
  return record?.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string" && record.message.startsWith(prefix);
}

function isObservMeLoadedStatus(record) {
  return record?.type === "extension_ui_request" && record.method === "setStatus" && record.statusKey === "observme" && record.statusText === "🧿";
}

function writeJsonResponse(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeTextResponse(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "text/plain" });
  response.end(body);
}

function stripTrailingCarriageReturn(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function formatExit(code, signal) {
  if (code !== null && code !== undefined) return `code ${code}`;
  return `signal ${signal ?? "unknown"}`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

await main();
