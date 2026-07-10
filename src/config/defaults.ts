import { RESOURCE_ATTRIBUTES } from "../semconv/attributes.ts";
import type { ObservMeConfig } from "./schema.ts";

export const defaultObservMeConfig = {
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
      [RESOURCE_ATTRIBUTES.SERVICE_NAME]: "observme-pi-extension",
      [RESOURCE_ATTRIBUTES.OBSERVME_TENANT_ID]: "platform",
      [RESOURCE_ATTRIBUTES.PI_PROJECT_NAME]: "my-project",
      [RESOURCE_ATTRIBUTES.DEPLOYMENT_ENVIRONMENT_NAME]: "production",
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
    sampleRatio: 1.0,
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
} satisfies ObservMeConfig;

export const DEFAULT_OBSERVME_CONFIG = defaultObservMeConfig;
