#!/usr/bin/env node
// Read-only end-to-end validation for the user-facing case where Grafana has
// ObservMe data and /obs commands should work against the same stack.
// Secrets are accepted only through environment variables and are never printed.
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleObsCommand } from "../src/commands/obs.ts";
import { loadSessionConfig } from "../src/config/load-config.ts";
import { getGrafanaHealth } from "../src/query/grafana.ts";
import { queryLoki } from "../src/query/loki.ts";
import { queryPrometheus } from "../src/query/prometheus.ts";
import { searchTempo } from "../src/query/tempo.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaultGrafanaUrl = "http://localhost";
const defaultCollectorEndpoint = "http://127.0.0.1:4318";
const defaultServiceName = "observme-pi-extension";
const defaultTempoDatasourceUid = "tempo";
const defaultLokiDatasourceUid = "loki";
const defaultPrometheusDatasourceUid = "prometheus";
const defaultTimeoutMs = 5000;
const defaultRangeMinutes = 120;
const validationSummaryPromQl =
  "sum(observme_sessions_started_total) or sum(observme_events_observed_total) or sum(observme_tool_calls_total)";

async function main() {
  const inputs = readValidationInputs(process.env);
  const config = await loadValidationConfig(inputs);
  const range = createValidationRange(inputs.rangeMinutes);
  const steps = [];

  steps.push(validateAuthInputs(inputs));
  steps.push(await probeGrafanaHealth(config));
  steps.push(await probePrometheusMetric(config));
  steps.push(await probeLokiLogs(config, inputs, range));
  steps.push(await probeTempoSearch(config, inputs, range));
  steps.push(await probeObsCommands(config, inputs));

  renderValidationReport(inputs, steps);
  if (steps.some(stepFailed)) process.exitCode = 1;
}

function readValidationInputs(env) {
  return {
    grafanaUrl: readEnvString(env, "OBSERVME_GRAFANA_URL", defaultGrafanaUrl),
    grafanaToken: readEnvString(env, "OBSERVME_GRAFANA_TOKEN", ""),
    grafanaUsername: readEnvString(env, "OBSERVME_GRAFANA_USERNAME", ""),
    grafanaPassword: readEnvString(env, "OBSERVME_GRAFANA_PASSWORD", ""),
    grafanaTlsInsecureSkipVerify: readEnvBoolean(env, "OBSERVME_GRAFANA_TLS_INSECURE_SKIP_VERIFY", false),
    grafanaPreferIPv4: readEnvBoolean(env, "OBSERVME_GRAFANA_PREFER_IPV4", false),
    otlpEndpoint: readEnvString(env, "OBSERVME_OTLP_ENDPOINT", defaultCollectorEndpoint),
    serviceName: readEnvString(env, "OBSERVME_VALIDATION_SERVICE_NAME", defaultServiceName),
    sessionId: readEnvString(env, "OBSERVME_VALIDATION_SESSION_ID", ""),
    traceId: readEnvString(env, "OBSERVME_VALIDATION_TRACE_ID", ""),
    tempoDatasourceUid: readEnvString(env, "OBSERVME_GRAFANA_TEMPO_DATASOURCE_UID", defaultTempoDatasourceUid),
    lokiDatasourceUid: readEnvString(env, "OBSERVME_GRAFANA_LOKI_DATASOURCE_UID", defaultLokiDatasourceUid),
    prometheusDatasourceUid: readEnvString(env, "OBSERVME_GRAFANA_PROMETHEUS_DATASOURCE_UID", defaultPrometheusDatasourceUid),
    timeoutMs: readEnvNumber(env, "OBSERVME_VALIDATION_TIMEOUT_MS", defaultTimeoutMs),
    rangeMinutes: readEnvNumber(env, "OBSERVME_VALIDATION_RANGE_MINUTES", defaultRangeMinutes),
  };
}

function readEnvString(env, name, fallback) {
  const value = env[name];
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function readEnvBoolean(env, name, fallback) {
  const value = env[name];
  if (value === undefined) return fallback;

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readEnvNumber(env, name, fallback) {
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;

  return Math.trunc(value);
}

async function loadValidationConfig(inputs) {
  return loadSessionConfig({
    env: {},
    readText: ignoreConfigFileRead,
    isProjectTrusted: false,
    loadEnvFile: false,
    runtimeOptions: createValidationRuntimeOptions(inputs),
  });
}

async function ignoreConfigFileRead() {
  return undefined;
}

function createValidationRuntimeOptions(inputs) {
  return {
    environment: "development",
    tenant: "validation",
    otlp: {
      endpoint: inputs.otlpEndpoint,
      protocol: "http/protobuf",
      timeoutMs: inputs.timeoutMs,
      headers: {
        Authorization: "",
      },
      tls: {
        insecureSkipVerify: false,
      },
    },
    resource: {
      attributes: {
        "service.name": inputs.serviceName,
        "observme.tenant.id": "validation",
        "pi.project.name": "observme-validation",
        "deployment.environment.name": "development",
      },
    },
    privacy: {
      allowInsecureTransport: true,
    },
    query: {
      enabled: true,
      timeoutMs: inputs.timeoutMs,
      maxLogs: 20,
      maxTraces: 20,
      maxMetricSeries: 20,
      maxAgents: 20,
      links: {
        traceUrlTemplate: `${trimTrailingSlash(inputs.grafanaUrl)}/explore?trace={traceId}&ds={tempoDatasourceUid}`,
      },
      grafana: {
        url: inputs.grafanaUrl,
        token: inputs.grafanaToken,
        username: inputs.grafanaUsername,
        password: inputs.grafanaPassword,
        datasourceUids: {
          tempo: inputs.tempoDatasourceUid,
          loki: inputs.lokiDatasourceUid,
          prometheus: inputs.prometheusDatasourceUid,
        },
        tls: {
          insecureSkipVerify: inputs.grafanaTlsInsecureSkipVerify,
        },
        transport: {
          preferIPv4: inputs.grafanaPreferIPv4,
        },
      },
    },
  };
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function createValidationRange(rangeMinutes) {
  const now = Date.now();
  return {
    from: new Date(now - rangeMinutes * 60_000),
    to: new Date(now + 60_000),
  };
}

function validateAuthInputs(inputs) {
  const hasToken = Boolean(inputs.grafanaToken);
  const hasBasic = Boolean(inputs.grafanaUsername && inputs.grafanaPassword);

  if (hasToken || hasBasic) {
    return passStep("Grafana auth configuration", "Credentials are configured through environment variables.");
  }

  return failStep(
    "Grafana auth configuration",
    "Set OBSERVME_GRAFANA_TOKEN or OBSERVME_GRAFANA_USERNAME plus OBSERVME_GRAFANA_PASSWORD; this script never reads .env or secret files.",
  );
}

async function probeGrafanaHealth(config) {
  try {
    const health = await getGrafanaHealth(config);
    const failedChecks = health.checks.filter(checkHasFailed);

    if (failedChecks.length === 0) {
      return passStep("Grafana and datasource health", "Grafana, Tempo, Loki, and Prometheus datasource checks passed.");
    }

    return failStep("Grafana and datasource health", summarizeGrafanaHealthFailures(failedChecks));
  } catch (error) {
    return failStep("Grafana and datasource health", formatSafeError(error));
  }
}

function checkHasFailed(check) {
  return check.status !== "ok";
}

function summarizeGrafanaHealthFailures(checks) {
  return checks.map(formatGrafanaHealthFailure).join("; ");
}

function formatGrafanaHealthFailure(check) {
  const detail = check.detail ? `: ${check.detail}` : "";
  return `${check.label} ${check.status}${detail}`;
}

async function probePrometheusMetric(config) {
  try {
    const result = await queryPrometheus(config, validationSummaryPromQl, undefined, { resultLimit: 5 });
    const values = readPrometheusValues(result);

    if (values.some(isPositiveNumber)) {
      return passStep("Prometheus metric ingestion", "Found a positive ObservMe metric through the Grafana Prometheus datasource proxy.");
    }

    return failStep(
      "Prometheus metric ingestion",
      "No positive ObservMe metric series were returned; check Collector metrics export, Prometheus scrape targets, and dashboard metric names.",
    );
  } catch (error) {
    return failStep("Prometheus metric ingestion", formatSafeError(error));
  }
}

function readPrometheusValues(result) {
  const values = [];

  for (const series of result.series) {
    if (series.value) values.push(Number(series.value.value));
    if (series.values) values.push(...series.values.map(readPrometheusSampleValue));
  }

  if (result.scalar) values.push(Number(result.scalar.value));
  return values.filter(Number.isFinite);
}

function readPrometheusSampleValue(sample) {
  return Number(sample.value);
}

function isPositiveNumber(value) {
  return value > 0;
}

async function probeLokiLogs(config, inputs, range) {
  try {
    const query = buildValidationLokiQuery(inputs);
    const logs = await queryLoki(config, query, range);

    if (logs.length > 0) {
      return passStep("Loki log labels", `Found ${logs.length} ObservMe log(s) with normalized service/session labels.`);
    }

    return failStep(
      "Loki log labels",
      "No logs matched normalized labels; check service_name/pi_session_id labels, Collector Loki exporter output, and /obs logs selectors.",
    );
  } catch (error) {
    return failStep("Loki log labels", formatSafeError(error));
  }
}

function buildValidationLokiQuery(inputs) {
  const labels = [`service_name="${escapeLokiLabelValue(inputs.serviceName)}"`];
  if (inputs.sessionId) labels.push(`pi_session_id="${escapeLokiLabelValue(inputs.sessionId)}"`);
  return `{${labels.join(", ")}}`;
}

function escapeLokiLabelValue(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function probeTempoSearch(config, inputs, range) {
  if (!inputs.sessionId) {
    return failStep(
      "Tempo trace search",
      "Set OBSERVME_VALIDATION_SESSION_ID from /obs session so Tempo can be searched with a safe generated session id.",
    );
  }

  try {
    const traces = await searchTempo(config, { "pi.session.id": inputs.sessionId }, range);

    if (traces.length > 0) {
      return passStep("Tempo trace search", `Found ${traces.length} trace result(s) for the validation session id.`);
    }

    return failStep(
      "Tempo trace search",
      "No Tempo traces matched pi.session.id; wait for export, then check Tempo datasource UID and active-session root-span visibility notes.",
    );
  } catch (error) {
    return failStep("Tempo trace search", formatSafeError(error));
  }
}

async function probeObsCommands(config, inputs) {
  if (!inputs.sessionId) {
    return failStep("/obs command path", "Set OBSERVME_VALIDATION_SESSION_ID after running /obs session in Pi.");
  }

  try {
    const outputs = [];
    const commands = createObsValidationCommands(inputs);

    for (const command of commands) outputs.push(await runObsValidationCommand(config, inputs, command));

    return passStep("/obs command path", summarizeObsCommandOutputs(outputs));
  } catch (error) {
    return failStep("/obs command path", formatSafeError(error));
  }
}

function createObsValidationCommands(inputs) {
  const commands = ["status", "health", "session", "logs"];
  commands.push(`trace --session ${inputs.sessionId}`);
  return commands;
}

async function runObsValidationCommand(config, inputs, command) {
  const notifications = [];
  await handleObsCommand(command, createObsValidationContext(notifications), createObsValidationOptions(config, inputs));
  return assertObsValidationNotification(command, notifications);
}

function createObsValidationContext(notifications) {
  return {
    cwd: repoRoot,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    isProjectTrusted() {
      return true;
    },
  };
}

function createObsValidationOptions(config, inputs) {
  const loadConfig = async () => config;
  const getSession = () => createObsValidationSession(inputs);

  return {
    status: {
      getStatus() {
        return { config, queueDrops: 0 };
      },
    },
    health: { loadConfig },
    session: { getSession },
    logs: { loadConfig, getSession },
    trace: { loadConfig, getSession },
  };
}

function createObsValidationSession(inputs) {
  return {
    sessionId: inputs.sessionId,
    traceId: normalizeOptionalTraceId(inputs.traceId),
    turns: 1,
    llmCalls: 0,
    toolCalls: 0,
    costUsd: 0,
  };
}

function normalizeOptionalTraceId(traceId) {
  return /^[a-f0-9]{32}$/iu.test(traceId) ? traceId.toLowerCase() : undefined;
}

function assertObsValidationNotification(command, notifications) {
  if (notifications.length !== 1) throw new Error(`/obs ${command} produced ${notifications.length} notifications.`);

  const notification = notifications[0];
  if (notification.type !== "info") throw new Error(`/obs ${command} returned ${notification.type ?? "unknown"}: ${notification.message}`);

  assertObsValidationMessage(command, notification.message);
  return { command, message: notification.message };
}

function assertObsValidationMessage(command, message) {
  if (command === "status") assertMessageMatches(command, message, /Grafana query readiness: ready/u);
  if (command === "health") assertMessageMatches(command, message, /Grafana: reachable[\s\S]*Tempo datasource: ok[\s\S]*Loki datasource: ok[\s\S]*Metrics datasource: ok/u);
  if (command === "session") assertMessageMatches(command, message, /Session: .+/u);
  if (command === "logs") assertMessageHasSessionLogs(command, message);
  if (command.startsWith("trace --session ")) assertMessageMatches(command, message, /Trace: [a-f0-9]{32}/iu);
}

function assertMessageMatches(command, message, pattern) {
  if (pattern.test(message)) return;

  throw new Error(`/obs ${command} output did not match ${pattern}: ${message}`);
}

function assertMessageHasSessionLogs(command, message) {
  assertMessageMatches(command, message, /Session logs for /u);
  if (!/No session logs found/u.test(message)) return;

  throw new Error(`/obs ${command} did not find Loki session logs: ${message}`);
}

function summarizeObsCommandOutputs(outputs) {
  const commandNames = outputs.map(readObsCommandName).join(", ");
  return `Validated representative command outputs: ${commandNames}.`;
}

function readObsCommandName(output) {
  return `/obs ${output.command}`;
}

function passStep(name, detail) {
  return { name, status: "pass", detail };
}

function failStep(name, detail) {
  return { name, status: "fail", detail };
}

function stepFailed(step) {
  return step.status === "fail";
}

function renderValidationReport(inputs, steps) {
  console.log("ObservMe Grafana + /obs validation flow");
  console.log(`Grafana URL: ${inputs.grafanaUrl}`);
  console.log(`Service label: ${inputs.serviceName}`);
  console.log(`Session id provided: ${inputs.sessionId ? "yes" : "no"}`);
  console.log("");

  for (const step of steps) console.log(`- ${formatStepStatus(step)} ${step.name}: ${step.detail}`);

  console.log("");
  console.log(renderFinalSummary(steps));
}

function formatStepStatus(step) {
  return step.status === "pass" ? "PASS" : "FAIL";
}

function renderFinalSummary(steps) {
  if (!steps.some(stepFailed)) return "Result: PASS — Grafana has data and representative /obs commands work with the configured stack.";

  return "Result: FAIL — use the failed step detail to classify the problem as ingestion, labels, Grafana auth/query, local TLS/DNS, Pi command registration, or session state.";
}

function formatSafeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

await main();
