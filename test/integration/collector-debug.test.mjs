import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { defaultObservMeConfig } from "../../src/config/defaults.ts";
import { registerHandlers } from "../../src/pi/handlers.ts";

const execFile = promisify(execFileCallback);
const collectorImage = process.env.OBSERVME_COLLECTOR_IMAGE ?? "otel/opentelemetry-collector-contrib:0.104.0";
const projectRoot = resolve(new URL("../..", import.meta.url).pathname);
const collectorConfigPath = resolve(projectRoot, "test/collector-debug.yaml");
const promptSentinel = "OBSERVME_COLLECTOR_PROMPT_SENTINEL_48";
const responseSentinel = "OBSERVME_COLLECTOR_RESPONSE_SENTINEL_48";
const thinkingSentinel = "OBSERVME_COLLECTOR_THINKING_SENTINEL_48";
const toolArgumentSentinel = "OBSERVME_COLLECTOR_TOOL_ARGUMENT_SENTINEL_48";
const toolResultSentinel = "OBSERVME_COLLECTOR_TOOL_RESULT_SENTINEL_48";

function createTestPi() {
  const handlers = new Map();

  return {
    handlers,
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
  };
}

function createTestContext() {
  return {
    cwd: projectRoot,
    sessionId: "collector-it-session",
    model: {
      provider: "anthropic",
      id: "claude-collector-it",
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

function createCollectorIntegrationConfig(otlpHttpPort) {
  const config = structuredClone(defaultObservMeConfig);

  config.environment = "development";
  config.tenant = "collector-it";
  config.otlp.endpoint = `http://127.0.0.1:${otlpHttpPort}`;
  config.otlp.headers = {};
  config.otlp.timeoutMs = 5000;
  config.privacy.allowInsecureTransport = true;
  config.resource.attributes = {
    "observme.tenant.id": "collector-it",
    "pi.project.name": "observme-integration",
    "deployment.environment.name": "integration",
  };
  config.traces.batch.scheduledDelayMillis = 100;
  config.traces.batch.exportTimeoutMillis = 5000;
  config.metrics.exportIntervalMillis = 1000;
  config.metrics.exportTimeoutMillis = 1000;
  config.logs.batch.scheduledDelayMillis = 100;
  config.shutdown.flushTimeoutMs = 10000;
  config.query.enabled = false;

  return config;
}

async function execDocker(args, options = {}) {
  const result = await execFile("docker", args, {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    timeout: options.timeout ?? 30000,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function startCollectorContainer() {
  const containerName = `observme-collector-it-${process.pid}-${randomUUID().slice(0, 8)}`;

  await execDocker(
    [
      "run",
      "--rm",
      "--detach",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1::4318",
      "--publish",
      "127.0.0.1::13133",
      "--volume",
      `${collectorConfigPath}:/etc/otelcol/config.yaml:ro`,
      collectorImage,
      "--config=/etc/otelcol/config.yaml",
    ],
    { timeout: 60000 },
  );

  const otlpHttpPort = await getPublishedPort(containerName, 4318);
  const healthPort = await getPublishedPort(containerName, 13133);
  await waitForCollectorHealth(healthPort);

  return {
    name: containerName,
    healthPort,
    otlpHttpPort,
  };
}

async function stopCollectorContainer(containerName) {
  try {
    await execDocker(["stop", containerName], { timeout: 30000 });
  } catch {
    // The container may already be gone after a failed startup. Cleanup is best effort.
  }
}

async function getPublishedPort(containerName, containerPort) {
  const result = await execDocker(["port", containerName, `${containerPort}/tcp`]);
  return parsePublishedPort(result.stdout);
}

function parsePublishedPort(value) {
  const firstLine = value.trim().split("\n").find(Boolean) ?? "";
  const separatorIndex = firstLine.lastIndexOf(":");
  const port = Number(firstLine.slice(separatorIndex + 1));

  assert.ok(Number.isInteger(port) && port > 0, `Could not parse Docker published port from ${value}`);
  return port;
}

async function waitForCollectorHealth(healthPort) {
  const deadline = Date.now() + 30000;
  let lastError = new Error("collector health check did not run");

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${healthPort}/`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = new Error(`collector health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await delay(250);
  }

  throw lastError;
}

async function invoke(pi, eventName, event, context) {
  const handler = pi.handlers.get(eventName);
  assert.equal(typeof handler, "function", `${eventName} handler should be registered`);
  await handler(event, context);
}

async function emitRepresentativeObservMeTelemetry(otlpHttpPort) {
  const pi = createTestPi();
  const context = createTestContext();
  const config = createCollectorIntegrationConfig(otlpHttpPort);
  const handlerErrors = [];

  registerHandlers(pi, {
    env: {},
    loadConfig: () => Promise.resolve(config),
    onHandlerError: (name, error) => handlerErrors.push({ name, error }),
  });

  await invoke(
    pi,
    "session_start",
    {
      sessionId: "collector-it-session",
      sessionName: "Collector Integration Session",
      persisted: false,
      sessionVersion: "integration",
      modelProvider: "anthropic",
      modelId: "claude-collector-it",
      thinkingLevel: "low",
    },
    context,
  );
  await invoke(pi, "agent_start", { agentRunId: "collector-agent-run", source: "user" }, context);
  await invoke(pi, "turn_start", { turnIndex: 1, userMessage: promptSentinel, imageCount: 0 }, context);
  await invoke(
    pi,
    "before_provider_request",
    {
      requestId: "collector-llm-request",
      payload: {
        operation: "chat",
        messages: [{ role: "user", content: promptSentinel }],
        tools: [{ name: "read" }],
        temperature: 0,
        maxTokens: 32,
      },
    },
    context,
  );
  await invoke(pi, "after_provider_response", { requestId: "collector-llm-request", status: 200 }, context);
  await invoke(
    pi,
    "message_end",
    {
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-collector-it",
        responseModel: "claude-collector-it",
        responseId: "collector-response-id",
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
          { type: "text", text: responseSentinel },
          { type: "thinking", thinking: thinkingSentinel },
        ],
      },
    },
    context,
  );
  await invoke(
    pi,
    "tool_execution_start",
    {
      toolCallId: "collector-tool-call",
      toolName: "read",
      arguments: { query: toolArgumentSentinel },
    },
    context,
  );
  await invoke(
    pi,
    "tool_result",
    {
      toolCallId: "collector-tool-call",
      toolName: "read",
      result: { content: toolResultSentinel },
    },
    context,
  );
  await invoke(
    pi,
    "tool_execution_end",
    {
      toolCallId: "collector-tool-call",
      toolName: "read",
      success: true,
      result: { content: toolResultSentinel },
    },
    context,
  );
  await invoke(pi, "turn_end", { turnIndex: 1, success: true }, context);
  await invoke(pi, "agent_end", { agentRunId: "collector-agent-run", success: true }, context);
  await invoke(pi, "session_shutdown", { reason: "complete", success: true }, context);

  assert.deepEqual(handlerErrors, [], "ObservMe handlers should not throw during Collector integration telemetry emission");
}

async function readCollectorLogs(containerName) {
  const result = await execDocker(["logs", containerName], { maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
  return `${result.stdout}\n${result.stderr}`;
}

async function waitForCollectorOutput(containerName, expectedSubstrings) {
  const deadline = Date.now() + 30000;
  let logs = "";

  while (Date.now() < deadline) {
    logs = await readCollectorLogs(containerName);
    if (expectedSubstrings.every(substring => logs.includes(substring))) return logs;
    await delay(500);
  }

  return logs;
}

test("ObservMe exports traces, metrics, and logs to a local debug Collector without default content capture", { timeout: 120000 }, async t => {
  const collector = await startCollectorContainer();
  t.after(() => stopCollectorContainer(collector.name));

  await emitRepresentativeObservMeTelemetry(collector.otlpHttpPort);

  const expectedTelemetry = [
    "pi.session",
    "pi.llm.request",
    "pi.tool.call",
    "observme_sessions_started_total",
    "observme_llm_requests_total",
    "session.started",
    "llm.request.completed",
    "collector-it-session",
    "observme.tenant.id",
  ];
  const collectorLogs = await waitForCollectorOutput(collector.name, expectedTelemetry);

  for (const expectedValue of expectedTelemetry) {
    assert.ok(
      collectorLogs.includes(expectedValue),
      `Collector debug output should include ${expectedValue}. Collector output tail:\n${collectorLogs.slice(-4000)}`,
    );
  }

  for (const forbiddenValue of [promptSentinel, responseSentinel, thinkingSentinel, toolArgumentSentinel, toolResultSentinel]) {
    assert.equal(collectorLogs.includes(forbiddenValue), false, `Default-disabled content capture must not export ${forbiddenValue}`);
  }
});
