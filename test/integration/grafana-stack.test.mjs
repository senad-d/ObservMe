import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { defaultObservMeConfig } from "../../src/config/defaults.ts";
import { registerHandlers, startSessionTelemetry } from "../../src/pi/handlers.ts";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const stackRoot = resolve(projectRoot, "observability-stack");
const stackComposePath = resolve(stackRoot, "docker-compose.yml");
const integrationComposePath = resolve(projectRoot, "test/integration/grafana-stack.compose.yml");
const grafanaAdminSecretPath = resolve(stackRoot, "secrets/grafana_admin_password");
const dashboardFiles = [
  "dashboards/observme-overview.json",
  "dashboards/observme-cost.json",
  "dashboards/observme-latency.json",
  "dashboards/observme-tools.json",
  "dashboards/observme-agents.json",
  "dashboards/observme-models.json",
  "dashboards/observme-errors.json",
  "dashboards/observme-branches-compactions.json",
  "dashboards/observme-export-health.json",
];
const grafanaServicePort = 3000;
const serviceName = "observme-pi-extension";
const tempoDatasourceUid = "tempo";
const lokiDatasourceUid = "loki";
const prometheusDatasourceUid = "prometheus";

function createTestPi() {
  const handlers = new Map();

  return {
    handlers,
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
  };
}

function createTestContext(ids) {
  return {
    cwd: projectRoot,
    sessionId: ids.sessionId,
    model: {
      provider: "anthropic",
      id: "claude-grafana-stack-it",
      api: "messages",
    },
    thinking: {
      level: "low",
    },
    ui: {
      notifications: [],
      statuses: [],
      notify(message, level) {
        this.notifications.push({ message, level });
      },
      setStatus(key, value) {
        this.statuses.push({ key, value });
      },
    },
    isProjectTrusted() {
      return true;
    },
  };
}

function createIntegrationIds() {
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;

  return {
    sessionId: `session-grafana-stack-${suffix}`,
    workflowId: `workflow-grafana-stack-${suffix}`,
    agentId: `agent-grafana-stack-${suffix}`,
    parentAgentId: `agent-grafana-parent-${suffix}`,
    rootAgentId: `agent-grafana-root-${suffix}`,
    agentRunId: `agent-run-grafana-stack-${suffix}`,
    turnIndex: 1,
    llmRequestId: `llm-request-grafana-stack-${suffix}`,
    toolCallId: `tool-call-grafana-stack-${suffix}`,
  };
}

function createLineageEnv(ids) {
  return {
    OBSERVME_WORKFLOW_ID: ids.workflowId,
    OBSERVME_AGENT_ID: ids.agentId,
    OBSERVME_PARENT_AGENT_ID: ids.parentAgentId,
    OBSERVME_ROOT_AGENT_ID: ids.rootAgentId,
    OBSERVME_AGENT_DEPTH: "1",
    OBSERVME_AGENT_CAPABILITY: "integration-test",
  };
}

function createGrafanaStackIntegrationConfig(otlpHttpPort) {
  const config = structuredClone(defaultObservMeConfig);

  config.environment = "development";
  config.tenant = "grafana-stack-it";
  config.otlp.endpoint = `http://127.0.0.1:${otlpHttpPort}`;
  config.otlp.headers = {};
  config.otlp.timeoutMs = 5000;
  config.otlp.tls.enabled = false;
  config.privacy.allowInsecureTransport = true;
  config.resource.attributes = {
    "service.name": serviceName,
    "observme.tenant.id": "grafana-stack-it",
    "pi.project.name": "observme-integration",
    "deployment.environment.name": "integration",
  };
  config.traces.batch.scheduledDelayMillis = 100;
  config.traces.batch.exportTimeoutMillis = 5000;
  config.metrics.exportIntervalMillis = 1000;
  config.metrics.exportTimeoutMillis = 1000;
  config.logs.batch.scheduledDelayMillis = 100;
  config.query.enabled = false;
  config.shutdown.flushTimeoutMs = 10000;

  return config;
}

function createGrafanaStackState() {
  const projectName = `observme-grafana-it-${process.pid}-${randomUUID().slice(0, 8)}`;

  return {
    projectName,
    env: {},
    grafanaUrl: "",
    otlpHttpPort: 0,
    createdGrafanaSecret: false,
  };
}

function composeBaseArgs(state) {
  return [
    "compose",
    "--project-name",
    state.projectName,
    "--project-directory",
    stackRoot,
    "-f",
    stackComposePath,
    "-f",
    integrationComposePath,
  ];
}

function parsePublishedPort(value) {
  const firstLine = value.trim().split("\n").find(Boolean) ?? "";
  const separatorIndex = firstLine.lastIndexOf(":");
  const port = Number(firstLine.slice(separatorIndex + 1));

  assert.ok(Number.isInteger(port) && port > 0, `Could not parse Docker published port from ${value}`);
  return port;
}

function grafanaApiUrl(stack, path) {
  return `${stack.grafanaUrl}${path}`;
}

function createGrafanaFetchHeaders() {
  return {
    Accept: "application/json",
  };
}

function tempoTraceUrl(stack, traceId) {
  return grafanaApiUrl(
    stack,
    `/api/datasources/proxy/uid/${encodeURIComponent(tempoDatasourceUid)}/api/traces/${encodeURIComponent(traceId)}`,
  );
}

function tempoSearchUrl(stack, tags, range) {
  const url = new URL(grafanaApiUrl(stack, `/api/datasources/proxy/uid/${encodeURIComponent(tempoDatasourceUid)}/api/search`));

  url.searchParams.set("tags", tags);
  url.searchParams.set("start", String(Math.floor(range.from.getTime() / 1000)));
  url.searchParams.set("end", String(Math.ceil(range.to.getTime() / 1000)));
  url.searchParams.set("limit", "20");
  return url.toString();
}

function lokiQueryRangeUrl(stack, query, range) {
  const url = new URL(
    grafanaApiUrl(stack, `/api/datasources/proxy/uid/${encodeURIComponent(lokiDatasourceUid)}/loki/api/v1/query_range`),
  );

  url.searchParams.set("query", query);
  url.searchParams.set("start", formatEpochNanoseconds(range.from));
  url.searchParams.set("end", formatEpochNanoseconds(range.to));
  url.searchParams.set("limit", "20");
  url.searchParams.set("direction", "backward");
  return url.toString();
}

function prometheusQueryUrl(stack, query) {
  const url = new URL(
    grafanaApiUrl(stack, `/api/datasources/proxy/uid/${encodeURIComponent(prometheusDatasourceUid)}/api/v1/query`),
  );

  url.searchParams.set("query", query);
  return url.toString();
}

function formatEpochNanoseconds(date) {
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

function hasTempoTracePayload(payload, ids) {
  const text = JSON.stringify(payload);
  return text.includes(ids.sessionId) && text.includes("pi.session") && text.includes(ids.agentId);
}

function hasTempoLineageSearchResult(payload, traceId) {
  const text = JSON.stringify(payload).toLowerCase();
  return text.includes(traceId.toLowerCase());
}

function hasLokiSessionLog(payload, ids) {
  const text = JSON.stringify(payload);
  return text.includes(ids.sessionId) && text.includes("session.started");
}

function hasPrometheusTokenTotal(payload) {
  const values = extractPrometheusValues(payload);
  return values.some(value => value >= 19);
}

function extractPrometheusValues(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (!payload.data || typeof payload.data !== "object") return [];
  if (!Array.isArray(payload.data.result)) return [];

  return payload.data.result.flatMap(readPrometheusResultValues);
}

function readPrometheusResultValues(result) {
  const values = [];

  if (Array.isArray(result.value) && result.value.length >= 2) values.push(Number(result.value[1]));
  if (Array.isArray(result.values)) {
    for (const value of result.values) {
      if (Array.isArray(value) && value.length >= 2) values.push(Number(value[1]));
    }
  }

  return values.filter(Number.isFinite);
}

function dashboardUidFromDocument(dashboard) {
  assert.equal(typeof dashboard.uid, "string", "dashboard uid is required");
  return dashboard.uid;
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object", "free-port probe should return an address");
  const port = address.port;

  await new Promise((resolveClose, rejectClose) => {
    server.close(error => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });

  return port;
}

async function execDocker(args, state, options = {}) {
  const result = await execFile("docker", args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...state.env,
    },
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    timeout: options.timeout ?? 30000,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function execDockerCompose(state, args, options = {}) {
  return execDocker([...composeBaseArgs(state), ...args], state, options);
}

async function ensureGrafanaSecret(state) {
  if (await fileExists(grafanaAdminSecretPath)) return;

  await mkdir(dirname(grafanaAdminSecretPath), { recursive: true, mode: 0o700 });
  await writeFile(grafanaAdminSecretPath, "observme-integration-test\n", { mode: 0o600 });
  state.createdGrafanaSecret = true;
}

async function prepareGrafanaStackState(state) {
  const otelHttpPort = await getFreePort();
  const otelGrpcPort = await getFreePort();

  state.otlpHttpPort = otelHttpPort;
  state.env = {
    OTEL_HTTP_PORT: String(otelHttpPort),
    OTEL_GRPC_PORT: String(otelGrpcPort),
  };

  await ensureGrafanaSecret(state);
}

async function startGrafanaStack(state) {
  await execDockerCompose(state, ["up", "--detach", "grafana"], { timeout: 120000 });

  const grafanaPort = await getPublishedPort(state, "grafana", grafanaServicePort);
  state.grafanaUrl = `http://127.0.0.1:${grafanaPort}`;

  await waitForGrafanaHealth(state);
  await waitForGrafanaDatasources(state);
}

async function stopGrafanaStack(state) {
  try {
    await execDockerCompose(state, ["down", "--volumes", "--remove-orphans"], { timeout: 120000 });
  } catch {
    // Cleanup is best effort when startup fails part-way through.
  }

  if (!state.createdGrafanaSecret) return;

  try {
    await rm(grafanaAdminSecretPath, { force: true });
  } catch {
    // Secret cleanup is best effort; the file is project-gitignored and contains only a test value.
  }
}

async function getPublishedPort(state, service, containerPort) {
  const result = await execDockerCompose(state, ["port", service, String(containerPort)]);
  return parsePublishedPort(result.stdout);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...createGrafanaFetchHeaders(),
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 1000)}`);
  return payload;
}

async function waitForResult(label, operation, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 90000;
  const intervalMs = options.intervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let lastPayload;
  let lastError = new Error(`${label} did not run`);

  while (Date.now() < deadline) {
    try {
      lastPayload = await operation();
      if (predicate(lastPayload)) return lastPayload;
      lastError = new Error(`${label} returned an unexpected payload: ${JSON.stringify(lastPayload).slice(0, 2000)}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await delay(intervalMs);
  }

  throw lastError;
}

async function waitForGrafanaHealth(stack) {
  await waitForResult(
    "Grafana health",
    () => fetchJson(grafanaApiUrl(stack, "/api/health")),
    payload => payload.database === "ok" || payload.status === "ok",
    { timeoutMs: 120000 },
  );
}

async function waitForGrafanaDatasources(stack) {
  const datasourceUids = [tempoDatasourceUid, lokiDatasourceUid, prometheusDatasourceUid];

  for (const uid of datasourceUids) await waitForGrafanaDatasource(stack, uid);
}

async function waitForGrafanaDatasource(stack, uid) {
  await waitForResult(
    `Grafana datasource ${uid}`,
    () => fetchJson(grafanaApiUrl(stack, `/api/datasources/uid/${encodeURIComponent(uid)}`)),
    payload => payload.uid === uid,
    { timeoutMs: 120000 },
  );
}

async function invoke(pi, eventName, event, context) {
  const handler = pi.handlers.get(eventName);
  assert.equal(typeof handler, "function", `${eventName} handler should be registered`);
  await handler(event, context);
}

async function emitRepresentativeObservMeTelemetry(otlpHttpPort, ids) {
  const pi = createTestPi();
  const context = createTestContext(ids);
  const config = createGrafanaStackIntegrationConfig(otlpHttpPort);
  const handlerErrors = [];
  let telemetrySession;

  registerHandlers(pi, {
    env: createLineageEnv(ids),
    trustedParentContext: true,
    loadConfig: () => Promise.resolve(config),
    startTelemetry: async options => {
      telemetrySession = await startSessionTelemetry(options);
      return telemetrySession;
    },
    onHandlerError: (name, error) => handlerErrors.push({ name, error }),
  });

  await invoke(
    pi,
    "session_start",
    {
      sessionId: ids.sessionId,
      sessionName: "Grafana Stack Integration Session",
      persisted: false,
      sessionVersion: "integration",
      modelProvider: "anthropic",
      modelId: "claude-grafana-stack-it",
      thinkingLevel: "low",
    },
    context,
  );
  const traceId = telemetrySession?.sessionSpan?.spanContext().traceId;

  await invoke(pi, "agent_start", { agentRunId: ids.agentRunId, source: "user" }, context);
  await invoke(pi, "turn_start", { turnIndex: ids.turnIndex, userMessage: "grafana-stack prompt", imageCount: 0 }, context);
  await invoke(
    pi,
    "before_provider_request",
    {
      requestId: ids.llmRequestId,
      payload: {
        operation: "chat",
        messages: [{ role: "user", content: "grafana-stack prompt" }],
        tools: [{ name: "read" }],
        temperature: 0,
        maxTokens: 32,
      },
    },
    context,
  );
  await invoke(pi, "after_provider_response", { requestId: ids.llmRequestId, status: 200 }, context);
  await invoke(
    pi,
    "message_end",
    {
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-grafana-stack-it",
        responseModel: "claude-grafana-stack-it",
        responseId: "grafana-stack-response-id",
        stopReason: "end_turn",
        usage: {
          input: 12,
          output: 7,
          totalTokens: 19,
          cost: {
            input: 0.001,
            output: 0.002,
            total: 0.003,
          },
        },
        content: [{ type: "text", text: "grafana-stack response" }],
      },
    },
    context,
  );
  await invoke(
    pi,
    "tool_execution_start",
    {
      toolCallId: ids.toolCallId,
      toolName: "read",
      arguments: { query: "grafana-stack argument" },
    },
    context,
  );
  await invoke(
    pi,
    "tool_result",
    {
      toolCallId: ids.toolCallId,
      toolName: "read",
      result: { content: "grafana-stack result" },
    },
    context,
  );
  await invoke(
    pi,
    "tool_execution_end",
    {
      toolCallId: ids.toolCallId,
      toolName: "read",
      success: true,
      result: { content: "grafana-stack result" },
    },
    context,
  );
  await invoke(pi, "turn_end", { turnIndex: ids.turnIndex, success: true }, context);
  await invoke(pi, "agent_end", { agentRunId: ids.agentRunId, success: true }, context);
  await invoke(pi, "session_shutdown", { reason: "complete", success: true }, context);

  assert.deepEqual(handlerErrors, [], "ObservMe handlers should not throw during Grafana-stack integration telemetry emission");
  assert.match(traceId ?? "", /^[a-f0-9]{32}$/u, "session span should expose a real trace id");
  return traceId;
}

async function waitForTempoTraceById(stack, traceId, ids) {
  return waitForResult(
    "Tempo trace by trace id",
    () => fetchJson(tempoTraceUrl(stack, traceId)),
    payload => hasTempoTracePayload(payload, ids),
    { timeoutMs: 90000 },
  );
}

async function waitForTempoLineageSearch(stack, traceId, ids, range) {
  const tags = `pi.agent.id="${ids.agentId}" pi.agent.parent_id="${ids.parentAgentId}"`;

  return waitForResult(
    "Tempo lineage search",
    () => fetchJson(tempoSearchUrl(stack, tags, range)),
    payload => hasTempoLineageSearchResult(payload, traceId),
    { timeoutMs: 90000 },
  );
}

async function waitForLokiSessionLogs(stack, ids, range) {
  const query = `{service_name="${serviceName}", pi_session_id="${ids.sessionId}"}`;

  return waitForResult(
    "Loki session log query",
    () => fetchJson(lokiQueryRangeUrl(stack, query, range)),
    payload => hasLokiSessionLog(payload, ids),
    { timeoutMs: 90000 },
  );
}

async function waitForPrometheusTokenTotals(stack) {
  const tokenTotalQuery = "sum(observme_llm_total_tokens_total) or sum(observme_llm_tokens_total)";

  return waitForResult(
    "Prometheus token total query",
    () => fetchJson(prometheusQueryUrl(stack, tokenTotalQuery)),
    hasPrometheusTokenTotal,
    { timeoutMs: 120000, intervalMs: 2000 },
  );
}

async function readDashboardUids() {
  const uids = [];

  for (const path of dashboardFiles) {
    const dashboard = JSON.parse(await readFile(resolve(projectRoot, path), "utf8"));
    uids.push(dashboardUidFromDocument(dashboard));
  }

  return uids;
}

async function waitForDashboardImports(stack) {
  const expectedUids = await readDashboardUids();

  return waitForResult(
    "Grafana dashboard provisioning import",
    () => fetchJson(grafanaApiUrl(stack, "/api/search?type=dash-db&limit=5000")),
    payload => hasDashboardUids(payload, expectedUids),
    { timeoutMs: 120000 },
  );
}

function hasDashboardUids(payload, expectedUids) {
  if (!Array.isArray(payload)) return false;

  const actualUids = new Set(payload.map(item => item.uid).filter(uid => typeof uid === "string"));
  return expectedUids.every(uid => actualUids.has(uid));
}

test("ObservMe telemetry is queryable through the Grafana stack and dashboards import", { timeout: 360000 }, async t => {
  const stack = createGrafanaStackState();
  await prepareGrafanaStackState(stack);
  t.after(() => stopGrafanaStack(stack));

  await startGrafanaStack(stack);
  const ids = createIntegrationIds();
  const rangeStart = new Date(Date.now() - 60_000);
  const traceId = await emitRepresentativeObservMeTelemetry(stack.otlpHttpPort, ids);
  const range = { from: rangeStart, to: new Date(Date.now() + 120_000) };

  await waitForTempoTraceById(stack, traceId, ids);
  await waitForTempoLineageSearch(stack, traceId, ids, range);
  await waitForLokiSessionLogs(stack, ids, range);
  await waitForPrometheusTokenTotals(stack);
  await waitForDashboardImports(stack);
});
