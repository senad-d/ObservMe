import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { observMeConfigSchema } from "../src/config/schema.ts";

const expectedDocumentedDefaults = {
  enabled: true,
  environment: "production",
  tenant: "platform",
  replayOnStart: false,
  otlp: {
    endpoint: "https://otel-collector.example.com:4318",
    protocol: "http/protobuf",
    timeoutMs: 3000,
    headers: {
      Authorization: "Bearer ${OBSERVME_OTLP_TOKEN}",
    },
    tls: {
      enabled: true,
      insecureSkipVerify: false,
    },
  },
  resource: {
    attributes: {
      "service.name": "observme-pi-extension",
      "observme.tenant.id": "platform",
      "pi.project.name": "my-project",
      "deployment.environment.name": "production",
    },
  },
  workflow: {
    idEnv: "OBSERVME_WORKFLOW_ID",
    enabled: true,
    maxDepthWarning: 5,
    maxFanoutWarning: 20,
  },
  agent: {
    idEnv: "OBSERVME_AGENT_ID",
    parentIdEnv: "OBSERVME_PARENT_AGENT_ID",
    rootIdEnv: "OBSERVME_ROOT_AGENT_ID",
    parentSessionIdEnv: "OBSERVME_PARENT_SESSION_ID",
    parentTraceIdEnv: "OBSERVME_PARENT_TRACE_ID",
    parentSpanIdEnv: "OBSERVME_PARENT_SPAN_ID",
    depthEnv: "OBSERVME_AGENT_DEPTH",
    spawnIdEnv: "OBSERVME_SPAWN_ID",
    propagateTraceContext: true,
    propagateToSubagents: true,
    capabilityEnv: "OBSERVME_AGENT_CAPABILITY",
    writeCorrelationEntry: false,
  },
  traces: {
    enabled: true,
    sampleRatio: 1,
    batch: {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 1000,
      exportTimeoutMillis: 3000,
    },
  },
  metrics: {
    enabled: true,
    exportIntervalMillis: 15000,
    exportTimeoutMillis: 3000,
  },
  logs: {
    enabled: true,
    batch: {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 1000,
    },
  },
  capture: {
    prompts: false,
    responses: false,
    thinking: false,
    toolArguments: false,
    toolResults: false,
    bashCommands: false,
    bashOutput: false,
    filePaths: false,
  },
  privacy: {
    redactionEnabled: true,
    allowUnsafeCapture: false,
    allowInsecureTransport: false,
    tenantSaltEnv: "OBSERVME_HASH_SALT",
    pathMode: "hash",
    customRedactionPatterns: [
      {
        name: "internal-token",
        pattern: "(?i)internal_token=[a-z0-9-]+",
      },
    ],
  },
  limits: {
    maxPromptChars: 12000,
    maxResponseChars: 12000,
    maxToolArgumentChars: 8000,
    maxToolResultChars: 16000,
    maxBashOutputChars: 16000,
    maxLogBodyChars: 32000,
    maxActiveAgentRuns: 16,
    maxActiveTurns: 128,
    maxActiveToolCalls: 1024,
    maxActiveLlmRequests: 128,
    maxActiveSubagentSpawns: 128,
    maxActiveAgentWaits: 128,
    maxActiveAgentJoins: 128,
  },
  query: {
    enabled: true,
    timeoutMs: 5000,
    maxLogs: 50,
    maxTraces: 20,
    maxMetricSeries: 20,
    maxAgents: 20,
    links: {
      traceUrlTemplate: "https://grafana.example.com/explore?left=...",
    },
    grafana: {
      url: "https://grafana.example.com",
      token: "${OBSERVME_GRAFANA_TOKEN}",
      username: "",
      password: "",
      datasourceUids: {
        tempo: "tempo",
        loki: "loki",
        prometheus: "mimir",
      },
      tls: {
        insecureSkipVerify: false,
      },
      transport: {
        preferIPv4: false,
      },
    },
  },
  shutdown: {
    flushTimeoutMs: 3000,
  },
};

const captureDefaults = Object.values(defaultObservMeConfig.capture);

test("default config snapshots every documented default value", () => {
  assert.deepEqual(defaultObservMeConfig, expectedDocumentedDefaults);
});

test("default config is privacy-preserving and capture-free", () => {
  assert.deepEqual(captureDefaults, [false, false, false, false, false, false, false, false]);
  assert.equal(defaultObservMeConfig.privacy.redactionEnabled, true);
  assert.equal(defaultObservMeConfig.privacy.allowUnsafeCapture, false);
  assert.equal(defaultObservMeConfig.privacy.allowInsecureTransport, false);
  assert.equal(defaultObservMeConfig.workflow.enabled, true);
  assert.equal(defaultObservMeConfig.agent.propagateTraceContext, true);
  assert.equal(defaultObservMeConfig.agent.propagateToSubagents, true);
  assert.equal(defaultObservMeConfig.agent.writeCorrelationEntry, false);
  assert.equal(defaultObservMeConfig.replayOnStart, false);
});

test("config schema exposes the documented top-level configuration shape", () => {
  assert.deepEqual(Object.keys(observMeConfigSchema.properties), Object.keys(expectedDocumentedDefaults));
  assert.equal(observMeConfigSchema.additionalProperties, false);
});
