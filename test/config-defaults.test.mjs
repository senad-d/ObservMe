import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  ACTIVE_AGENT_LEASE_DURATION_MILLIS_MAXIMUM,
  ACTIVE_AGENT_LEASE_DURATION_MILLIS_MINIMUM,
  ACTIVE_AGENT_LEASE_EXPORT_SAFETY_MARGIN_MILLIS,
  observMeConfigSchema,
} from "../src/config/schema.ts";

const expectedDocumentedDefaults = {
  enabled: true,
  environment: "production",
  tenant: "platform",
  otlp: {
    endpoint: "https://otel-collector.example.com:4318",
    protocol: "http/protobuf",
    timeoutMs: 3000,
    headers: {
      Authorization: "Bearer ${OBSERVME_OTLP_TOKEN}",
    },
    tls: {
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
    activeAgentLeaseDurationMillis: 60000,
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
const observMeConfigValidator = Compile(observMeConfigSchema);
const defaultlessSchemaContractPaths = [
  "metrics.labels",
  "otlp.signalEndpoints",
  "otlp.signalEndpoints.logs",
  "otlp.signalEndpoints.metrics",
  "otlp.signalEndpoints.traces",
].sort();
const openRecordContractPaths = new Set(["otlp.headers", "resource.attributes"]);

function collectDefaultContractPaths(value, basePath = "") {
  if (Array.isArray(value)) return collectDefaultArrayContractPaths(value, basePath);
  if (!isPlainObject(value) || openRecordContractPaths.has(basePath)) return [];

  const paths = Object.entries(value).flatMap(([key, child]) => {
    const childPath = appendContractPath(basePath, key);
    return [childPath, ...collectDefaultContractPaths(child, childPath)];
  });

  return sortUnique(paths);
}

function collectDefaultArrayContractPaths(value, basePath) {
  const firstItem = value[0];
  if (!basePath || !isPlainObject(firstItem)) return [];

  const itemPath = `${basePath}[]`;
  return sortUnique([itemPath, ...collectDefaultContractPaths(firstItem, itemPath)]);
}

function collectSchemaContractPaths(schema, basePath = "") {
  if (hasSchemaProperties(schema)) return collectSchemaObjectContractPaths(schema, basePath);
  if (hasObjectArrayItems(schema) && basePath) return collectSchemaArrayContractPaths(schema, basePath);
  return [];
}

function collectSchemaObjectContractPaths(schema, basePath) {
  const paths = Object.entries(schema.properties).flatMap(([key, child]) => {
    const childPath = appendContractPath(basePath, key);
    return [childPath, ...collectSchemaContractPaths(child, childPath)];
  });

  return sortUnique(paths);
}

function collectSchemaArrayContractPaths(schema, basePath) {
  const itemPath = `${basePath}[]`;
  return sortUnique([itemPath, ...collectSchemaContractPaths(schema.items, itemPath)]);
}

function schemaValidationErrors(config) {
  return Array.from(observMeConfigValidator.Errors(config), error => `${error.instancePath || "root"}: ${error.message}`);
}

function hasSchemaProperties(value) {
  return isPlainObject(value?.properties);
}

function hasObjectArrayItems(value) {
  return isPlainObject(value?.items) && hasSchemaProperties(value.items);
}

function appendContractPath(basePath, key) {
  if (!basePath) return key;
  return `${basePath}.${key}`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortUnique(values) {
  return [...new Set(values)].sort();
}

test("default config snapshots every documented default value", () => {
  assert.deepEqual(defaultObservMeConfig, expectedDocumentedDefaults);
});

test("default active-agent lease satisfies the bounded export relationship", () => {
  const leaseDuration = defaultObservMeConfig.metrics.activeAgentLeaseDurationMillis;
  const requiredDuration =
    (2 * defaultObservMeConfig.metrics.exportIntervalMillis) + ACTIVE_AGENT_LEASE_EXPORT_SAFETY_MARGIN_MILLIS;

  assert.equal(leaseDuration, 60000);
  assert.ok(leaseDuration >= ACTIVE_AGENT_LEASE_DURATION_MILLIS_MINIMUM);
  assert.ok(leaseDuration <= ACTIVE_AGENT_LEASE_DURATION_MILLIS_MAXIMUM);
  assert.ok(leaseDuration >= requiredDuration);
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
});

test("config schema exposes the documented top-level configuration shape", () => {
  assert.deepEqual(Object.keys(observMeConfigSchema.properties), Object.keys(expectedDocumentedDefaults));
  assert.equal(observMeConfigSchema.additionalProperties, false);
});

test("config string enums use the Google-compatible schema representation", () => {
  const environmentSchema = observMeConfigSchema.properties.environment;
  const pathModeSchema = observMeConfigSchema.properties.privacy.properties.pathMode;

  assert.equal(environmentSchema.type, "string");
  assert.deepEqual(environmentSchema.enum, ["production", "development", "test"]);
  assert.equal("anyOf" in environmentSchema, false);
  assert.equal(pathModeSchema.type, "string");
  assert.deepEqual(pathModeSchema.enum, ["hash", "basename", "full", "drop"]);
  assert.equal("anyOf" in pathModeSchema, false);
});

test("default config conforms to the exported runtime schema", () => {
  assert.deepEqual(schemaValidationErrors(defaultObservMeConfig), []);
});

test("config defaults and runtime schema expose the same contract paths", () => {
  const defaultPaths = collectDefaultContractPaths(defaultObservMeConfig);
  const schemaPaths = collectSchemaContractPaths(observMeConfigSchema);
  const allowedDefaultlessPaths = new Set(defaultlessSchemaContractPaths);
  const schemaOnlyPaths = schemaPaths.filter(path => !defaultPaths.includes(path) && !allowedDefaultlessPaths.has(path));
  const defaultOnlyPaths = defaultPaths.filter(path => !schemaPaths.includes(path));
  const staleDefaultlessPaths = defaultlessSchemaContractPaths.filter(path => !schemaPaths.includes(path));

  assert.deepEqual(defaultOnlyPaths, [], "default config includes contract paths that are absent from observMeConfigSchema");
  assert.deepEqual(schemaOnlyPaths, [], "observMeConfigSchema includes contract paths that are absent from documented defaults");
  assert.deepEqual(staleDefaultlessPaths, [], "defaultless schema contract path allowlist contains stale paths");
});
