import { Compile } from "typebox/compile";
import { defaultObservMeConfig } from "./defaults.ts";
import { observMeConfigSchema } from "./schema.ts";
import type { ObservMeConfig } from "./schema.ts";
import { validateCustomRedactionPatterns } from "../privacy/redact.ts";

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ConfigValidationOptions {
  env?: NodeJS.ProcessEnv;
  isProjectTrusted?: boolean;
  projectConfigWasRead?: boolean;
}

export interface ConfigValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ConfigLogSink {
  warn?: (message: string) => void;
}

export interface UnsafeCaptureWarningContext {
  ui?: {
    notify?: (message: string, level?: "warning" | "info" | "error") => void | Promise<void>;
  };
}

const forbiddenMetricLabelPattern =
  /(?:^|[._-])(?:workflow|session|agent|parent|child|trace|span|entry|spawn|tool_call)(?:[._-]|$)|(?:^|[._-])id$/i;
const lineageValuePattern = /^[A-Za-z0-9._:-]+$/;
const traceIdPattern = /^[a-f0-9]{32}$/i;
const spanIdPattern = /^[a-f0-9]{16}$/i;
const maximumLineageValueLength = 128;
const maximumQueueSize = 10_000;
const maximumActiveRegistrySize = 100_000;
const maximumStructuralIssueDetails = 5;
const observMeConfigValidator = Compile(observMeConfigSchema);

export function validateObservMeConfig(
  config: ObservMeConfig,
  options: ConfigValidationOptions = {},
): ConfigValidationResult {
  const structuralIssues = validateConfigStructure(config);
  if (structuralIssues.length > 0) return { valid: false, issues: structuralIssues };

  const issues = [
    ...validateRedactionBoundary(config),
    ...validateTransportSecurity(config),
    ...validateSignalEndpoints(config),
    ...validateMetricLabels(config),
    ...validateCustomRedactionPatternConfig(config),
    ...validateProjectTrust(options),
    ...validateLineageEnvironment(config, options.env ?? process.env),
    ...validateQueueGuardrails(config),
  ];

  return { valid: issues.length === 0, issues };
}

export function ensureValidObservMeConfig(
  config: ObservMeConfig,
  options: ConfigValidationOptions & { logger?: ConfigLogSink } = {},
): ObservMeConfig {
  const result = validateObservMeConfig(config, options);
  if (result.valid) return config;

  logValidationRejection(result.issues, options.logger);
  return structuredClone(defaultObservMeConfig);
}

export function hasContentCaptureEnabled(config: ObservMeConfig): boolean {
  return Object.values(config.capture).some(Boolean);
}

export async function emitUnsafeCaptureWarning(
  config: ObservMeConfig,
  ctx: UnsafeCaptureWarningContext,
): Promise<boolean> {
  if (!config.privacy.allowUnsafeCapture || !hasContentCaptureEnabled(config)) return false;

  await ctx.ui?.notify?.(unsafeCaptureWarningMessage(config), "warning");
  return true;
}

function validateConfigStructure(config: unknown): ValidationIssue[] {
  if (observMeConfigValidator.Check(config)) return [];

  try {
    return buildStructuralValidationIssues(observMeConfigValidator.Errors(config));
  } catch (_error) {
    return [
      {
        code: "invalid_config_shape",
        message: "Configuration shape is invalid and could not be inspected safely.",
      },
    ];
  }
}

function buildStructuralValidationIssues(errors: Array<{ keyword: string; instancePath: string }>): ValidationIssue[] {
  const visibleErrors = errors.slice(0, maximumStructuralIssueDetails);
  const issues = visibleErrors.map(error => ({
    code: "invalid_config_shape",
    message: formatStructuralValidationMessage(error),
  }));

  if (errors.length > visibleErrors.length) {
    issues.push({
      code: "invalid_config_shape",
      message: `Configuration shape has ${errors.length - visibleErrors.length} additional structural issue(s).`,
    });
  }

  return issues;
}

function formatStructuralValidationMessage(error: { keyword: string; instancePath: string }): string {
  return `Configuration shape is invalid at ${formatSchemaPath(error.instancePath)}: ${describeSchemaKeyword(error.keyword)}.`;
}

function formatSchemaPath(instancePath: string): string {
  if (!instancePath) return "root";
  return instancePath.replaceAll("~1", "/").replaceAll("~0", "~");
}

function describeSchemaKeyword(keyword: string): string {
  if (keyword === "additionalProperties") return "unknown property is not allowed";
  if (keyword === "required") return "required property is missing";
  if (keyword === "type") return "value has an unsupported type";
  if (keyword === "const" || keyword === "anyOf" || keyword === "enum") return "value is not one of the supported options";
  if (keyword === "minimum" || keyword === "maximum") return "numeric value is outside the allowed range";
  if (keyword === "minLength" || keyword === "maxLength") return "string length is outside the allowed range";
  return `schema rule ${keyword} failed`;
}

function unsafeCaptureWarningMessage(config: ObservMeConfig): string {
  if (config.privacy.redactionEnabled) {
    return "ObservMe unsafe capture is active. Prompt, response, tool, bash, or path content may be exported after configured redaction.";
  }

  return "ObservMe unsafe capture is active with redaction disabled. Unredacted sensitive prompt, response, tool, bash, or path content may be exported.";
}

function validateRedactionBoundary(config: ObservMeConfig): ValidationIssue[] {
  if (config.privacy.allowUnsafeCapture || config.privacy.redactionEnabled || !hasContentCaptureEnabled(config)) return [];

  return [
    {
      code: "unsafe_capture_without_redaction",
      message: "Content capture requires redaction unless privacy.allowUnsafeCapture is true.",
    },
  ];
}

function validateTransportSecurity(config: ObservMeConfig): ValidationIssue[] {
  if (config.environment !== "production" || config.privacy.allowInsecureTransport) return [];

  return [
    ...validateProductionHttpEndpoint("otlp.endpoint", config.otlp.endpoint),
    ...validateProductionHttpEndpoint("otlp.signalEndpoints.traces", config.otlp.signalEndpoints?.traces),
    ...validateProductionHttpEndpoint("otlp.signalEndpoints.metrics", config.otlp.signalEndpoints?.metrics),
    ...validateProductionHttpEndpoint("otlp.signalEndpoints.logs", config.otlp.signalEndpoints?.logs),
    ...validateProductionHttpEndpoint("query.grafana.url", config.query.grafana.url),
  ];
}

function validateProductionHttpEndpoint(name: string, endpoint: string | undefined): ValidationIssue[] {
  if (!endpoint || !isHttpEndpoint(endpoint)) return [];

  return [
    {
      code: "insecure_production_transport",
      message: `${name} must not use http:// in production unless privacy.allowInsecureTransport is true.`,
    },
  ];
}

function isHttpEndpoint(endpoint: string): boolean {
  return endpoint.trim().toLowerCase().startsWith("http://");
}

function validateSignalEndpoints(config: ObservMeConfig): ValidationIssue[] {
  if (config.otlp.protocol !== "http/protobuf") return [];

  const endpoints = config.otlp.signalEndpoints;
  if (!endpoints) return [];

  return [
    ...validateSignalEndpoint("traces", endpoints.traces, "/v1/traces"),
    ...validateSignalEndpoint("metrics", endpoints.metrics, "/v1/metrics"),
    ...validateSignalEndpoint("logs", endpoints.logs, "/v1/logs"),
  ];
}

function validateSignalEndpoint(signal: string, endpoint: string | undefined, requiredPath: string): ValidationIssue[] {
  if (!endpoint || endpointPathMatches(endpoint, requiredPath)) return [];

  return [
    {
      code: "invalid_signal_endpoint_path",
      message: `${signal} OTLP HTTP exporter URL must include ${requiredPath}.`,
    },
  ];
}

function endpointPathMatches(endpoint: string, requiredPath: string): boolean {
  try {
    return new URL(endpoint).pathname.endsWith(requiredPath);
  } catch (_error) {
    return false;
  }
}

function validateMetricLabels(config: ObservMeConfig): ValidationIssue[] {
  const labels = config.metrics.labels ?? [];
  return labels.filter(isForbiddenMetricLabel).map(label => ({
    code: "high_cardinality_metric_label",
    message: `Metric label ${label} is a forbidden high-cardinality identifier.`,
  }));
}

function validateCustomRedactionPatternConfig(config: ObservMeConfig): ValidationIssue[] {
  return validateCustomRedactionPatterns(config.privacy.customRedactionPatterns).map(issue => ({
    code: issue.code,
    message: issue.message,
  }));
}

function isForbiddenMetricLabel(label: string): boolean {
  return forbiddenMetricLabelPattern.test(label);
}

function validateProjectTrust(options: ConfigValidationOptions): ValidationIssue[] {
  if (!options.projectConfigWasRead || options.isProjectTrusted !== false) return [];

  return [
    {
      code: "untrusted_project_config_read",
      message: "Project-local ObservMe config must not be read while ctx.isProjectTrusted() is false.",
    },
  ];
}

function validateLineageEnvironment(config: ObservMeConfig, env: NodeJS.ProcessEnv): ValidationIssue[] {
  const lineageEnvNames = [
    config.workflow.idEnv,
    config.agent.idEnv,
    config.agent.parentIdEnv,
    config.agent.rootIdEnv,
    config.agent.parentSessionIdEnv,
    config.agent.spawnIdEnv,
  ];
  const issues = lineageEnvNames.flatMap(name => validateLineageValue(name, env[name]));

  return [
    ...issues,
    ...validateTraceValue(config.agent.parentTraceIdEnv, env[config.agent.parentTraceIdEnv]),
    ...validateSpanValue(config.agent.parentSpanIdEnv, env[config.agent.parentSpanIdEnv]),
    ...validateDepthValue(config.agent.depthEnv, env[config.agent.depthEnv]),
  ];
}

function validateLineageValue(envName: string, value: string | undefined): ValidationIssue[] {
  if (!value) return [];
  if (value.length <= maximumLineageValueLength && lineageValuePattern.test(value)) return [];

  return [
    {
      code: "malformed_lineage_value",
      message: `${envName} contains a malformed, oversized, or unsafe lineage value.`,
    },
  ];
}

function validateTraceValue(envName: string, value: string | undefined): ValidationIssue[] {
  if (!value || traceIdPattern.test(value)) return [];
  return [{ code: "malformed_lineage_value", message: `${envName} must be a 32-character hex trace id.` }];
}

function validateSpanValue(envName: string, value: string | undefined): ValidationIssue[] {
  if (!value || spanIdPattern.test(value)) return [];
  return [{ code: "malformed_lineage_value", message: `${envName} must be a 16-character hex span id.` }];
}

function validateDepthValue(envName: string, value: string | undefined): ValidationIssue[] {
  if (!value) return [];
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 64) return [];
  return [{ code: "malformed_lineage_value", message: `${envName} must be an integer depth between 0 and 64.` }];
}

function validateQueueGuardrails(config: ObservMeConfig): ValidationIssue[] {
  const queueChecks = [
    ["traces.batch.maxQueueSize", config.traces.batch.maxQueueSize, maximumQueueSize],
    ["logs.batch.maxQueueSize", config.logs.batch.maxQueueSize, maximumQueueSize],
    ["limits.maxActiveAgentRuns", config.limits.maxActiveAgentRuns, maximumActiveRegistrySize],
    ["limits.maxActiveTurns", config.limits.maxActiveTurns, maximumActiveRegistrySize],
    ["limits.maxActiveToolCalls", config.limits.maxActiveToolCalls, maximumActiveRegistrySize],
    ["limits.maxActiveLlmRequests", config.limits.maxActiveLlmRequests, maximumActiveRegistrySize],
    ["limits.maxActiveSubagentSpawns", config.limits.maxActiveSubagentSpawns, maximumActiveRegistrySize],
    ["limits.maxActiveAgentWaits", config.limits.maxActiveAgentWaits, maximumActiveRegistrySize],
    ["limits.maxActiveAgentJoins", config.limits.maxActiveAgentJoins, maximumActiveRegistrySize],
  ] as const;
  const oversizeIssues = queueChecks.flatMap(([name, value, maximum]) => validateMaximumSize(name, value, maximum));

  return [
    ...oversizeIssues,
    ...validateBatchSize("traces.batch.maxExportBatchSize", config.traces.batch.maxExportBatchSize, config.traces.batch.maxQueueSize),
    ...validateBatchSize("logs.batch.maxExportBatchSize", config.logs.batch.maxExportBatchSize, config.logs.batch.maxQueueSize),
  ];
}

function validateMaximumSize(name: string, value: number, maximum: number): ValidationIssue[] {
  if (value <= maximum) return [];
  return [{ code: "queue_size_exceeds_guardrail", message: `${name} exceeds memory guardrail ${maximum}.` }];
}

function validateBatchSize(name: string, value: number, queueSize: number): ValidationIssue[] {
  if (value <= queueSize) return [];
  return [{ code: "queue_size_exceeds_guardrail", message: `${name} must not exceed its maxQueueSize.` }];
}

function logValidationRejection(issues: ValidationIssue[], logger: ConfigLogSink | undefined) {
  for (const issue of issues) {
    logger?.warn?.(`ObservMe config rejected (${issue.code}): ${issue.message}`);
  }
}
