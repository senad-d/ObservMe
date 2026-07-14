import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const observMeEnvironments = ["production", "development", "test"] as const;
const privacyPathModes = ["hash", "basename", "full", "drop"] as const;

export type ObservMeEnvironment = (typeof observMeEnvironments)[number];
export type OtlpProtocol = "http/protobuf";
export type PrivacyPathMode = (typeof privacyPathModes)[number];

export const ACTIVE_AGENT_LEASE_DURATION_MILLIS_MINIMUM = 10_000;
export const ACTIVE_AGENT_LEASE_DURATION_MILLIS_MAXIMUM = 300_000;
export const ACTIVE_AGENT_LEASE_EXPORT_SAFETY_MARGIN_MILLIS = 5_000;

export interface OtlpTlsConfig {
  insecureSkipVerify: boolean;
}

export interface OtlpSignalEndpointsConfig {
  traces?: string;
  metrics?: string;
  logs?: string;
}

export interface OtlpConfig {
  endpoint: string;
  protocol: OtlpProtocol;
  timeoutMs: number;
  headers: Record<string, string>;
  tls: OtlpTlsConfig;
  signalEndpoints?: OtlpSignalEndpointsConfig;
}

export interface ResourceConfig {
  attributes: Record<string, string>;
}

export interface WorkflowConfig {
  idEnv: string;
  enabled: boolean;
  maxDepthWarning: number;
  maxFanoutWarning: number;
}

export interface AgentConfig {
  idEnv: string;
  parentIdEnv: string;
  rootIdEnv: string;
  parentSessionIdEnv: string;
  parentTraceIdEnv: string;
  parentSpanIdEnv: string;
  depthEnv: string;
  spawnIdEnv: string;
  propagateTraceContext: boolean;
  propagateToSubagents: boolean;
  capabilityEnv: string;
  writeCorrelationEntry: boolean;
}

export interface TraceBatchConfig {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
  exportTimeoutMillis: number;
}

export interface TracesConfig {
  enabled: boolean;
  sampleRatio: number;
  batch: TraceBatchConfig;
}

export interface MetricsConfig {
  enabled: boolean;
  exportIntervalMillis: number;
  exportTimeoutMillis: number;
  activeAgentLeaseDurationMillis: number;
  labels?: string[];
}

export interface LogsBatchConfig {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
}

export interface LogsConfig {
  enabled: boolean;
  batch: LogsBatchConfig;
}

export interface CaptureConfig {
  prompts: boolean;
  responses: boolean;
  thinking: boolean;
  toolArguments: boolean;
  toolResults: boolean;
  bashCommands: boolean;
  bashOutput: boolean;
  filePaths: boolean;
}

export interface CustomRedactionPatternConfig {
  name: string;
  pattern: string;
}

export interface PrivacyConfig {
  redactionEnabled: boolean;
  allowUnsafeCapture: boolean;
  allowInsecureTransport: boolean;
  tenantSaltEnv: string;
  pathMode: PrivacyPathMode;
  customRedactionPatterns: CustomRedactionPatternConfig[];
}

export interface LimitsConfig {
  maxPromptChars: number;
  maxResponseChars: number;
  maxToolArgumentChars: number;
  maxToolResultChars: number;
  maxBashOutputChars: number;
  maxLogBodyChars: number;
  maxActiveAgentRuns: number;
  maxActiveTurns: number;
  maxActiveToolCalls: number;
  maxActiveLlmRequests: number;
  maxActiveSubagentSpawns: number;
  maxActiveAgentWaits: number;
  maxActiveAgentJoins: number;
}

export interface QueryLinksConfig {
  traceUrlTemplate: string;
}

export interface GrafanaDatasourceUidsConfig {
  tempo: string;
  loki: string;
  prometheus: string;
}

export interface GrafanaTlsConfig {
  insecureSkipVerify: boolean;
}

export interface GrafanaTransportConfig {
  preferIPv4: boolean;
}

export interface GrafanaConfig {
  url: string;
  token: string;
  username: string;
  password: string;
  datasourceUids: GrafanaDatasourceUidsConfig;
  tls: GrafanaTlsConfig;
  transport: GrafanaTransportConfig;
}

export interface QueryConfig {
  enabled: boolean;
  timeoutMs: number;
  maxLogs: number;
  maxTraces: number;
  maxMetricSeries: number;
  maxAgents: number;
  links: QueryLinksConfig;
  grafana: GrafanaConfig;
}

export interface ShutdownConfig {
  flushTimeoutMs: number;
}

export interface ObservMeConfig {
  enabled: boolean;
  environment: ObservMeEnvironment;
  tenant: string;
  otlp: OtlpConfig;
  resource: ResourceConfig;
  workflow: WorkflowConfig;
  agent: AgentConfig;
  traces: TracesConfig;
  metrics: MetricsConfig;
  logs: LogsConfig;
  capture: CaptureConfig;
  privacy: PrivacyConfig;
  limits: LimitsConfig;
  query: QueryConfig;
  shutdown: ShutdownConfig;
}

const environmentSchema = StringEnum(observMeEnvironments);
const otlpProtocolSchema = Type.Literal("http/protobuf");
const stringRecordSchema = Type.Record(Type.String(), Type.String());
const positiveIntegerSchema = Type.Integer({ minimum: 1 });
const ratioSchema = Type.Number({ minimum: 0, maximum: 1 });
const pathModeSchema = StringEnum(privacyPathModes);

export const customRedactionPatternSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    pattern: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const observMeConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    environment: environmentSchema,
    tenant: Type.String({ minLength: 1 }),
    otlp: Type.Object(
      {
        endpoint: Type.String({ minLength: 1 }),
        protocol: otlpProtocolSchema,
        timeoutMs: positiveIntegerSchema,
        headers: stringRecordSchema,
        tls: Type.Object(
          {
            insecureSkipVerify: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        signalEndpoints: Type.Optional(
          Type.Object(
            {
              traces: Type.Optional(Type.String({ minLength: 1 })),
              metrics: Type.Optional(Type.String({ minLength: 1 })),
              logs: Type.Optional(Type.String({ minLength: 1 })),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    resource: Type.Object(
      {
        attributes: stringRecordSchema,
      },
      { additionalProperties: false },
    ),
    workflow: Type.Object(
      {
        idEnv: Type.String({ minLength: 1 }),
        enabled: Type.Boolean(),
        maxDepthWarning: positiveIntegerSchema,
        maxFanoutWarning: positiveIntegerSchema,
      },
      { additionalProperties: false },
    ),
    agent: Type.Object(
      {
        idEnv: Type.String({ minLength: 1 }),
        parentIdEnv: Type.String({ minLength: 1 }),
        rootIdEnv: Type.String({ minLength: 1 }),
        parentSessionIdEnv: Type.String({ minLength: 1 }),
        parentTraceIdEnv: Type.String({ minLength: 1 }),
        parentSpanIdEnv: Type.String({ minLength: 1 }),
        depthEnv: Type.String({ minLength: 1 }),
        spawnIdEnv: Type.String({ minLength: 1 }),
        propagateTraceContext: Type.Boolean(),
        propagateToSubagents: Type.Boolean(),
        capabilityEnv: Type.String({ minLength: 1 }),
        writeCorrelationEntry: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    traces: Type.Object(
      {
        enabled: Type.Boolean(),
        sampleRatio: ratioSchema,
        batch: Type.Object(
          {
            maxQueueSize: positiveIntegerSchema,
            maxExportBatchSize: positiveIntegerSchema,
            scheduledDelayMillis: positiveIntegerSchema,
            exportTimeoutMillis: positiveIntegerSchema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    metrics: Type.Object(
      {
        enabled: Type.Boolean(),
        exportIntervalMillis: positiveIntegerSchema,
        exportTimeoutMillis: positiveIntegerSchema,
        activeAgentLeaseDurationMillis: Type.Integer({
          minimum: ACTIVE_AGENT_LEASE_DURATION_MILLIS_MINIMUM,
          maximum: ACTIVE_AGENT_LEASE_DURATION_MILLIS_MAXIMUM,
        }),
        labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      },
      { additionalProperties: false },
    ),
    logs: Type.Object(
      {
        enabled: Type.Boolean(),
        batch: Type.Object(
          {
            maxQueueSize: positiveIntegerSchema,
            maxExportBatchSize: positiveIntegerSchema,
            scheduledDelayMillis: positiveIntegerSchema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    capture: Type.Object(
      {
        prompts: Type.Boolean(),
        responses: Type.Boolean(),
        thinking: Type.Boolean(),
        toolArguments: Type.Boolean(),
        toolResults: Type.Boolean(),
        bashCommands: Type.Boolean(),
        bashOutput: Type.Boolean(),
        filePaths: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    privacy: Type.Object(
      {
        redactionEnabled: Type.Boolean(),
        allowUnsafeCapture: Type.Boolean(),
        allowInsecureTransport: Type.Boolean(),
        tenantSaltEnv: Type.String({ minLength: 1 }),
        pathMode: pathModeSchema,
        customRedactionPatterns: Type.Array(customRedactionPatternSchema),
      },
      { additionalProperties: false },
    ),
    limits: Type.Object(
      {
        maxPromptChars: positiveIntegerSchema,
        maxResponseChars: positiveIntegerSchema,
        maxToolArgumentChars: positiveIntegerSchema,
        maxToolResultChars: positiveIntegerSchema,
        maxBashOutputChars: positiveIntegerSchema,
        maxLogBodyChars: positiveIntegerSchema,
        maxActiveAgentRuns: positiveIntegerSchema,
        maxActiveTurns: positiveIntegerSchema,
        maxActiveToolCalls: positiveIntegerSchema,
        maxActiveLlmRequests: positiveIntegerSchema,
        maxActiveSubagentSpawns: positiveIntegerSchema,
        maxActiveAgentWaits: positiveIntegerSchema,
        maxActiveAgentJoins: positiveIntegerSchema,
      },
      { additionalProperties: false },
    ),
    query: Type.Object(
      {
        enabled: Type.Boolean(),
        timeoutMs: positiveIntegerSchema,
        maxLogs: positiveIntegerSchema,
        maxTraces: positiveIntegerSchema,
        maxMetricSeries: positiveIntegerSchema,
        maxAgents: positiveIntegerSchema,
        links: Type.Object(
          {
            traceUrlTemplate: Type.String(),
          },
          { additionalProperties: false },
        ),
        grafana: Type.Object(
          {
            url: Type.String(),
            token: Type.String(),
            username: Type.String(),
            password: Type.String(),
            datasourceUids: Type.Object(
              {
                tempo: Type.String({ minLength: 1 }),
                loki: Type.String({ minLength: 1 }),
                prometheus: Type.String({ minLength: 1 }),
              },
              { additionalProperties: false },
            ),
            tls: Type.Object(
              {
                insecureSkipVerify: Type.Boolean(),
              },
              { additionalProperties: false },
            ),
            transport: Type.Object(
              {
                preferIPv4: Type.Boolean(),
              },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    shutdown: Type.Object(
      {
        flushTimeoutMs: positiveIntegerSchema,
      },
      { additionalProperties: false },
    ),
  },
  { $id: "ObservMeConfig", additionalProperties: false },
);
