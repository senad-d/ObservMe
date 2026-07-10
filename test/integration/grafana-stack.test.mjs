import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { handleObsCommand } from "../../src/commands/obs.ts";
import { getObsStatusRuntimeState } from "../../src/commands/obs-status.ts";
import { OBS_COST_AGGREGATE_PROMQL } from "../../src/commands/obs-cost.ts";
import { OBS_TOOLS_CALLS_PROMQL, OBS_TOOLS_FAILURES_PROMQL } from "../../src/commands/obs-tools.ts";
import { loadSessionConfig } from "../../src/config/load-config.ts";
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
  "dashboards/observme-agent-node-graphs.json",
  "dashboards/observme-models.json",
  "dashboards/observme-errors.json",
  "dashboards/observme-branches-compactions.json",
  "dashboards/observme-export-health.json",
  "dashboards/observme-slo-health.json",
  "dashboards/observme-logs-llm.json",
  "dashboards/observme-llm-conversations.json",
  "dashboards/observme-trace-journey.json",
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

function createTestContext(ids, cwd = projectRoot) {
  return {
    cwd,
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
    failedToolCallId: `tool-call-grafana-stack-failed-${suffix}`,
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

function createGrafanaStackState() {
  const projectName = `observme-grafana-it-${process.pid}-${randomUUID().slice(0, 8)}`;

  return {
    projectName,
    env: {},
    grafanaUrl: "",
    grafanaUsername: "admin",
    grafanaPassword: "",
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

function createGrafanaFetchHeaders(stack) {
  return {
    Accept: "application/json",
    Authorization: createGrafanaBasicAuthorizationHeader(stack),
  };
}

function createGrafanaBasicAuthorizationHeader(stack) {
  assert.ok(stack.grafanaPassword, "Grafana admin password should be available for authenticated integration calls");
  return `Basic ${Buffer.from(`${stack.grafanaUsername}:${stack.grafanaPassword}`).toString("base64")}`;
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

function hasTempoLlmContentPayload(payload) {
  const text = JSON.stringify(payload);
  return text.includes("pi.llm.prompt.redacted")
    && text.includes("pi.llm.response.redacted")
    && text.includes("pi.llm.thinking.redacted")
    && text.includes("grafana-stack-prompt-marker")
    && text.includes("grafana-stack-response-marker")
    && text.includes("grafana-stack-thinking-marker")
    && !text.includes("grafana-stack-secret");
}

function hasTempoLineageSearchResult(payload, traceId) {
  const text = JSON.stringify(payload).toLowerCase();
  return text.includes(traceId.toLowerCase());
}

function hasLokiSessionLog(payload, ids) {
  const text = JSON.stringify(payload);
  return text.includes(ids.sessionId) && text.includes("session.started");
}

function hasLokiErrorLog(payload) {
  const text = JSON.stringify(payload);
  return text.includes("tool.call.failed") && text.includes("IntegrationError");
}

function hasLokiContentLog(payload, marker) {
  const text = JSON.stringify(payload);
  return text.includes(marker) && text.includes("[REDACTED:") && !text.includes("grafana-stack-secret");
}

function hasPrometheusTokenTotal(payload) {
  const values = extractPrometheusValues(payload);
  return values.some(value => value >= 19);
}

function hasPrometheusSeries(payload) {
  return extractPrometheusValues(payload).length > 0;
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

async function readGrafanaAdminPassword() {
  const password = (await readFile(grafanaAdminSecretPath, "utf8")).trim();
  assert.ok(password, "Grafana admin password secret must not be empty for authenticated integration calls");
  return password;
}

async function prepareGrafanaStackState(state) {
  const otelHttpPort = await getFreePort();
  const otelGrpcPort = await getFreePort();

  state.otlpHttpPort = otelHttpPort;
  state.env = {
    OTEL_HTTP_PORT: String(otelHttpPort),
    OTEL_GRPC_PORT: String(otelGrpcPort),
    OBSERVME_IT_FRONTEND_NETWORK: `${state.projectName}-frontend`,
    OBSERVME_IT_BACKEND_NETWORK: `${state.projectName}-backend`,
  };

  await ensureGrafanaSecret(state);
  state.grafanaPassword = await readGrafanaAdminPassword();
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
      Accept: "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 1000)}`);
  return payload;
}

async function fetchGrafanaJson(stack, url, options = {}) {
  return fetchJson(url, {
    ...options,
    headers: {
      ...createGrafanaFetchHeaders(stack),
      ...options.headers,
    },
  });
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
    () => fetchGrafanaJson(stack, grafanaApiUrl(stack, "/api/health")),
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
    () => fetchGrafanaJson(stack, grafanaApiUrl(stack, `/api/datasources/uid/${encodeURIComponent(uid)}`)),
    payload => payload.uid === uid,
    { timeoutMs: 120000 },
  );
}

async function invoke(pi, eventName, event, context) {
  const handler = pi.handlers.get(eventName);
  assert.equal(typeof handler, "function", `${eventName} handler should be registered`);
  await handler(event, context);
}

async function emitRepresentativeObservMeTelemetry(project, ids) {
  const pi = createTestPi();
  const context = createTestContext(ids, project.root);
  const handlerErrors = [];
  let telemetrySession;

  registerHandlers(pi, {
    env: createLineageEnv(ids),
    trustedParentContext: true,
    requireCompleteParentEnvelope: false,
    loadConfig: project.loadConfig,
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
        messages: [{ role: "user", content: "grafana-stack-prompt-marker api_key=grafana-stack-secret" }],
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
        content: [
          { type: "thinking", thinking: "grafana-stack-thinking-marker api_key=grafana-stack-secret" },
          { type: "text", text: "grafana-stack-response-marker api_key=grafana-stack-secret" },
        ],
      },
    },
    context,
  );
  await emitToolCall(pi, context, ids.toolCallId, "read", true);
  await emitToolCall(pi, context, ids.failedToolCallId, "write", false);
  await invoke(pi, "turn_end", { turnIndex: ids.turnIndex, success: true }, context);
  await invoke(pi, "agent_end", { agentRunId: ids.agentRunId, success: true }, context);

  assert.deepEqual(handlerErrors, [], "ObservMe handlers should not throw during Grafana-stack integration telemetry emission");
  assert.match(traceId ?? "", /^[a-f0-9]{32}$/u, "session span should expose a real trace id");

  return {
    traceId,
    shutdown: () => shutdownRepresentativeObservMeTelemetry(pi, context, handlerErrors),
  };
}

async function emitToolCall(pi, context, toolCallId, toolName, success) {
  await invoke(
    pi,
    "tool_execution_start",
    {
      toolCallId,
      toolName,
      arguments: { fixture: "grafana-stack-command-smoke" },
    },
    context,
  );
  await invoke(
    pi,
    "tool_result",
    {
      toolCallId,
      toolName,
      result: success ? { content: "grafana-stack result" } : { errorClass: "IntegrationError" },
    },
    context,
  );
  await invoke(
    pi,
    "tool_execution_end",
    {
      toolCallId,
      toolName,
      success,
      errorClass: success ? undefined : "IntegrationError",
      result: success ? { content: "grafana-stack result" } : { error: "integration failure" },
    },
    context,
  );
}

async function shutdownRepresentativeObservMeTelemetry(pi, context, handlerErrors) {
  await invoke(pi, "session_shutdown", { reason: "complete", success: true }, context);
  assert.deepEqual(handlerErrors, [], "ObservMe handlers should not throw during Grafana-stack shutdown");
}

async function waitForTempoTraceById(stack, traceId, ids) {
  return waitForResult(
    "Tempo trace by trace id",
    () => fetchGrafanaJson(stack, tempoTraceUrl(stack, traceId)),
    payload => hasTempoTracePayload(payload, ids),
    { timeoutMs: 90000 },
  );
}

async function waitForTempoLlmContent(stack, traceId) {
  return waitForResult(
    "Tempo LLM content attributes",
    () => fetchGrafanaJson(stack, tempoTraceUrl(stack, traceId)),
    hasTempoLlmContentPayload,
    { timeoutMs: 90000 },
  );
}

async function waitForTempoLineageSearch(stack, traceId, ids, range) {
  const tags = `pi.agent.id="${ids.agentId}" pi.agent.parent_id="${ids.parentAgentId}"`;

  return waitForResult(
    "Tempo lineage search",
    () => fetchGrafanaJson(stack, tempoSearchUrl(stack, tags, range)),
    payload => hasTempoLineageSearchResult(payload, traceId),
    { timeoutMs: 90000 },
  );
}

async function waitForLokiSessionLogs(stack, ids, range) {
  const query = `{service_name="${serviceName}", pi_session_id="${ids.sessionId}"}`;

  return waitForResult(
    "Loki session log query",
    () => fetchGrafanaJson(stack, lokiQueryRangeUrl(stack, query, range)),
    payload => hasLokiSessionLog(payload, ids),
    { timeoutMs: 90000 },
  );
}

async function waitForLokiErrorLogs(stack, range) {
  const query = `{service_name="${serviceName}", event_name="tool.call.failed"}`;

  return waitForResult(
    "Loki error label query",
    () => fetchGrafanaJson(stack, lokiQueryRangeUrl(stack, query, range)),
    hasLokiErrorLog,
    { timeoutMs: 90000 },
  );
}

async function waitForLokiContentLog(stack, range, eventName, marker) {
  const query = `{service_name="${serviceName}", event_name="${eventName}"}`;

  return waitForResult(
    `Loki ${eventName} content log query`,
    () => fetchGrafanaJson(stack, lokiQueryRangeUrl(stack, query, range)),
    payload => hasLokiContentLog(payload, marker),
    { timeoutMs: 90000 },
  );
}

async function waitForPrometheusTokenTotals(stack) {
  const tokenTotalQuery = "sum(observme_llm_total_tokens_total) or sum(observme_llm_tokens_total)";

  return waitForResult(
    "Prometheus token total query",
    () => fetchGrafanaJson(stack, prometheusQueryUrl(stack, tokenTotalQuery)),
    hasPrometheusTokenTotal,
    { timeoutMs: 120000, intervalMs: 2000 },
  );
}

async function waitForPrometheusCommandQueries(stack) {
  await waitForPrometheusQuerySeries(stack, "Prometheus cost command query", OBS_COST_AGGREGATE_PROMQL);
  await waitForPrometheusQuerySeries(stack, "Prometheus tool call command query", OBS_TOOLS_CALLS_PROMQL);
  await waitForPrometheusQuerySeries(stack, "Prometheus tool failure command query", OBS_TOOLS_FAILURES_PROMQL);
}

async function waitForPrometheusQuerySeries(stack, label, query) {
  return waitForResult(
    label,
    () => fetchGrafanaJson(stack, prometheusQueryUrl(stack, query)),
    hasPrometheusSeries,
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
    () => fetchGrafanaJson(stack, grafanaApiUrl(stack, "/api/search?type=dash-db&limit=5000")),
    payload => hasDashboardUids(payload, expectedUids),
    { timeoutMs: 120000 },
  );
}

function hasDashboardUids(payload, expectedUids) {
  if (!Array.isArray(payload)) return false;

  const actualUids = new Set(payload.map(item => item.uid).filter(uid => typeof uid === "string"));
  return expectedUids.every(uid => actualUids.has(uid));
}

async function createGrafanaStackCommandProject(stack) {
  const root = await mkdtemp(join(tmpdir(), "observme-grafana-stack-commands-"));
  const configPath = resolve(root, ".pi", "observme.yaml");
  const globalConfigPath = resolve(root, "global-observme.yaml");
  const env = {
    OBSERVME_GRAFANA_USERNAME: stack.grafanaUsername,
    OBSERVME_GRAFANA_PASSWORD: stack.grafanaPassword,
  };

  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, renderGrafanaStackCommandConfig(stack), { mode: 0o600 });

  return {
    root,
    configPath,
    env,
    loadConfig: options => loadSessionConfig({
      ...options,
      env: { ...options.env, ...env },
      globalConfigPath,
      projectConfigPath: configPath,
      isProjectTrusted: true,
    }),
  };
}

function renderGrafanaStackCommandConfig(stack) {
  return `# Live-stack /obs command smoke config.
# Required inputs: Grafana URL, Basic auth username/password, datasource UIDs, and OTLP HTTP endpoint.
# Credentials are supplied through OBSERVME_GRAFANA_USERNAME/PASSWORD so the fixture does not render secret values.
observme:
  enabled: true
  environment: development
  tenant: grafana-stack-it
  otlp:
    endpoint: http://127.0.0.1:${stack.otlpHttpPort}
    protocol: http/protobuf
    timeoutMs: 5000
    headers:
      Authorization: ""
    tls:
      enabled: false
  resource:
    attributes:
      service.name: ${serviceName}
      observme.tenant.id: grafana-stack-it
      pi.project.name: observme-integration
      deployment.environment.name: integration
  traces:
    batch:
      scheduledDelayMillis: 100
      exportTimeoutMillis: 5000
  metrics:
    exportIntervalMillis: 1000
    exportTimeoutMillis: 1000
  logs:
    batch:
      scheduledDelayMillis: 100
  capture:
    prompts: true
    responses: true
    thinking: true
  privacy:
    redactionEnabled: true
    allowUnsafeCapture: true
    allowInsecureTransport: true
  query:
    enabled: true
    timeoutMs: 5000
    maxLogs: 20
    maxTraces: 20
    maxMetricSeries: 20
    maxAgents: 20
    links:
      traceUrlTemplate: ${stack.grafanaUrl}/explore?trace={traceId}&ds={tempoDatasourceUid}
    grafana:
      url: ${stack.grafanaUrl}
      token: ""
      username: \${OBSERVME_GRAFANA_USERNAME}
      password: \${OBSERVME_GRAFANA_PASSWORD}
      datasourceUids:
        tempo: ${tempoDatasourceUid}
        loki: ${lokiDatasourceUid}
        prometheus: ${prometheusDatasourceUid}
      tls:
        insecureSkipVerify: false
      transport:
        preferIPv4: true
  shutdown:
    flushTimeoutMs: 10000
`;
}

function createObsCommandHarness(project) {
  const notifications = [];

  return {
    notifications,
    ctx: {
      cwd: project.root,
      ui: {
        notify: (message, type) => notifications.push({ message, type }),
      },
      isProjectTrusted: () => true,
    },
  };
}

function createObsCommandOptions(project, ids) {
  const common = { loadConfig: project.loadConfig };

  return {
    status: common,
    health: common,
    cost: common,
    trace: common,
    tools: common,
    agents: {
      ...common,
      getRuntime: () => createCommandAgentsRuntime(ids),
    },
    errors: common,
    logs: {
      ...common,
      getSession: () => ({ sessionId: ids.sessionId }),
    },
    link: common,
  };
}

function createCommandAgentsRuntime(ids) {
  const lineage = {
    workflowId: ids.workflowId,
    workflowRootAgentId: ids.rootAgentId,
    agentId: ids.agentId,
    parentAgentId: ids.parentAgentId,
    rootAgentId: ids.rootAgentId,
    depth: 1,
    role: "subagent",
    capability: "integration-test",
    orphaned: false,
  };

  return {
    lineage,
    children: [],
    waitJoinHints: [],
    sessionId: ids.sessionId,
  };
}

async function runObsInfoCommand(harness, options, args) {
  harness.notifications.length = 0;
  await handleObsCommand(args, harness.ctx, options);

  assert.equal(harness.notifications.length, 1, `/obs ${args} should render one notification`);
  const notification = harness.notifications[0];
  assert.equal(notification.type, "info", `/obs ${args} should succeed: ${notification.message}`);
  return notification.message;
}

async function runObsRuntimeCommandSmoke(project, ids) {
  const harness = createObsCommandHarness(project);
  const options = createObsCommandOptions(project, ids);

  assert.match(await runObsInfoCommand(harness, options, "status"), /ObservMe: enabled/u);
  const health = await runObsInfoCommand(harness, options, "health");
  assert.match(health, /Collector: reachable/u);
  assert.match(health, /Grafana: reachable/u);
  assert.match(health, /Tempo datasource: ok/u);
  assert.match(health, /Loki datasource: ok/u);
  assert.match(health, /Metrics datasource: ok/u);

  const cost = await runObsInfoCommand(harness, options, "cost");
  assert.match(cost, /Cost by model\/provider/u);
  assert.doesNotMatch(cost, /No cost metrics found/u);

  const tools = await runObsInfoCommand(harness, options, "tools");
  assert.match(tools, /Tool calls by tool/u);
  assert.match(tools, /\bread:/u);
  assert.match(tools, /write\s+\/\s+[^\s:]+:/u);

  const errors = await runObsInfoCommand(harness, options, "errors");
  assert.match(errors, /Recent error events/u);
  assert.match(errors, /tool\.call\.failed/u);

  const logs = await runObsInfoCommand(harness, options, "logs");
  assert.match(logs, new RegExp(`Session logs for ${escapeRegExp(ids.sessionId)}`, "u"));
  assert.match(logs, /session\.started/u);

  const agents = await runObsInfoCommand(harness, options, "agents");
  assert.match(agents, new RegExp(`Workflow: ${escapeRegExp(ids.workflowId)}`, "u"));
  assert.match(agents, /Lineage drill-down: Tempo attributes pi\.agent\.id, pi\.workflow\.id traces=\d+/u);
}

async function runObsTraceCommandSmoke(project, ids, traceId) {
  const harness = createObsCommandHarness(project);
  const options = createObsCommandOptions(project, ids);
  const trace = await runObsInfoCommand(harness, options, `trace --session ${ids.sessionId}`);
  const link = await runObsInfoCommand(harness, options, `link --session ${ids.sessionId}`);

  assert.match(trace, new RegExp(`Trace: ${traceId}`, "u"));
  assert.match(trace, /Open trace: http:\/\/127\.0\.0\.1:\d+\/explore\?trace=/u);
  assert.match(link, new RegExp(`Trace: ${traceId}`, "u"));
  assert.match(link, /Grafana link \(session\)/u);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function canRunDockerComposeStack() {
  try {
    await execFile("docker", ["compose", "version"], { encoding: "utf8", timeout: 10000 });
    await execFile("docker", ["info"], { encoding: "utf8", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

test("ObservMe telemetry is queryable through the Grafana stack and /obs commands", { timeout: 420000 }, async t => {
  if (!(await canRunDockerComposeStack())) {
    t.skip("Docker Compose or the Docker daemon is unavailable; skipping live Grafana-stack integration.");
    return;
  }

  const stack = createGrafanaStackState();
  await prepareGrafanaStackState(stack);
  t.after(() => stopGrafanaStack(stack));

  await startGrafanaStack(stack);
  const commandProject = await createGrafanaStackCommandProject(stack);
  t.after(() => rm(commandProject.root, { recursive: true, force: true }));

  const ids = createIntegrationIds();
  let telemetry;
  t.after(async () => {
    if (telemetry) await telemetry.shutdown();
  });

  const rangeStart = new Date(Date.now() - 60_000);
  telemetry = await emitRepresentativeObservMeTelemetry(commandProject, ids);
  await telemetry.shutdown();
  assert.equal(getObsStatusRuntimeState().lastExportError, undefined, "ObservMe export should not fail before live-stack command smoke");
  const traceId = telemetry.traceId;
  telemetry = undefined;
  const range = { from: rangeStart, to: new Date(Date.now() + 120_000) };

  await waitForTempoTraceById(stack, traceId, ids);
  await waitForTempoLlmContent(stack, traceId);
  await waitForTempoLineageSearch(stack, traceId, ids, range);
  await waitForLokiSessionLogs(stack, ids, range);
  await waitForLokiErrorLogs(stack, range);
  await waitForLokiContentLog(stack, range, "llm.prompt.captured", "grafana-stack-prompt-marker");
  await waitForLokiContentLog(stack, range, "llm.response.captured", "grafana-stack-response-marker");
  await waitForLokiContentLog(stack, range, "llm.thinking.captured", "grafana-stack-thinking-marker");
  await waitForPrometheusTokenTotals(stack);
  await waitForPrometheusCommandQueries(stack);
  await waitForDashboardImports(stack);
  await runObsRuntimeCommandSmoke(commandProject, ids);
  await runObsTraceCommandSmoke(commandProject, ids, traceId);
});
