import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ProjectConfigBootstrapStatus = "created" | "exists" | "skipped_untrusted";
export type ProjectConfigNotifyLevel = "info" | "warning" | "error";

export interface ProjectConfigBootstrapResult {
  readonly path: string;
  readonly status: ProjectConfigBootstrapStatus;
}

export interface ProjectConfigBootstrapContext {
  readonly cwd?: string;
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
  readonly ui?: {
    notify?: (message: string, level?: ProjectConfigNotifyLevel) => Promise<void> | void;
  };
}

export interface RegisterProjectConfigBootstrapOptions {
  readonly configDirName?: string;
  readonly ensureProjectConfig?: EnsureProjectConfig;
}

export interface EnsureProjectConfigOptions {
  readonly configDirName?: string;
  readonly cwd?: string;
  readonly isProjectTrusted?: boolean | (() => boolean | Promise<boolean>);
}

export type EnsureProjectConfig = (options: EnsureProjectConfigOptions) => Promise<ProjectConfigBootstrapResult>;

type ProjectConfigBootstrapHandler = (event: unknown, ctx: ProjectConfigBootstrapContext) => Promise<void> | void;

interface ProjectConfigBootstrapPiApi {
  on: (eventName: string, handler: ProjectConfigBootstrapHandler) => void;
}

const defaultConfigDirName = ".pi";
const observmeYamlFileName = "observme.yaml";

export const PROJECT_OBSERVME_YAML_TEMPLATE = `observme:
  enabled: true
  environment: development
  tenant: local-dev
  replayOnStart: false

  otlp:
    endpoint: http://localhost:4318
    protocol: http/protobuf
    timeoutMs: 3000
    headers: {}
    tls:
      enabled: false
      insecureSkipVerify: false
    signalEndpoints:
      traces: http://localhost:4318/v1/traces
      metrics: http://localhost:4318/v1/metrics
      logs: http://localhost:4318/v1/logs

  resource:
    attributes:
      service.name: observme-pi-extension
      observme.tenant.id: local-dev
      pi.project.name: local-project
      deployment.environment.name: development

  workflow:
    idEnv: OBSERVME_WORKFLOW_ID
    enabled: true
    maxDepthWarning: 5
    maxFanoutWarning: 20

  agent:
    idEnv: OBSERVME_AGENT_ID
    parentIdEnv: OBSERVME_PARENT_AGENT_ID
    rootIdEnv: OBSERVME_ROOT_AGENT_ID
    parentSessionIdEnv: OBSERVME_PARENT_SESSION_ID
    parentTraceIdEnv: OBSERVME_PARENT_TRACE_ID
    parentSpanIdEnv: OBSERVME_PARENT_SPAN_ID
    depthEnv: OBSERVME_AGENT_DEPTH
    spawnIdEnv: OBSERVME_SPAWN_ID
    propagateTraceContext: true
    propagateToSubagents: true
    capabilityEnv: OBSERVME_AGENT_CAPABILITY
    writeCorrelationEntry: false

  traces:
    enabled: true
    sampleRatio: 1.0
    batch:
      maxQueueSize: 2048
      maxExportBatchSize: 512
      scheduledDelayMillis: 1000
      exportTimeoutMillis: 3000

  metrics:
    enabled: true
    exportIntervalMillis: 15000
    exportTimeoutMillis: 3000

  logs:
    enabled: true
    batch:
      maxQueueSize: 2048
      maxExportBatchSize: 512
      scheduledDelayMillis: 1000

  capture:
    # Content capture is opt-in. To export redacted local debug content,
    # set only the specific capture flags you need to true and keep
    # privacy.redactionEnabled enabled.
    prompts: false
    responses: false
    thinking: false
    toolArguments: false
    toolResults: false
    bashCommands: false
    bashOutput: false
    filePaths: false

  privacy:
    redactionEnabled: true
    # Set this to true only when you intentionally accept unredacted
    # sensitive-content export from this trusted project.
    allowUnsafeCapture: false
    allowInsecureTransport: true
    tenantSaltEnv: OBSERVME_HASH_SALT
    pathMode: hash
    customRedactionPatterns: []

  limits:
    maxPromptChars: 12000
    maxResponseChars: 12000
    maxToolArgumentChars: 8000
    maxToolResultChars: 16000
    maxBashOutputChars: 16000
    maxLogBodyChars: 32000
    maxActiveAgentRuns: 16
    maxActiveTurns: 128
    maxActiveToolCalls: 1024
    maxActiveLlmRequests: 128
    maxActiveSubagentSpawns: 128
    maxActiveAgentWaits: 128
    maxActiveAgentJoins: 128

  query:
    enabled: true
    timeoutMs: 5000
    maxLogs: 50
    maxTraces: 20
    maxMetricSeries: 20
    maxAgents: 20
    links:
      # Uses the supported bundled-stack Grafana Explore fallback.
      traceUrlTemplate: https://observability.local/explore?left=...
    grafana:
      # Supported local command path: Grafana behind nginx HTTPS.
      url: https://observability.local
      # Preferred: set a Grafana service-account token in this env var.
      token: \${OBSERVME_GRAFANA_TOKEN}
      # Local fallback: set OBSERVME_GRAFANA_PASSWORD from observability-stack/secrets/grafana_admin_password.
      username: "admin"
      password: \${OBSERVME_GRAFANA_PASSWORD}
      datasourceUids:
        tempo: tempo
        loki: loki
        prometheus: prometheus
      tls:
        # Local self-signed certificate only; keep false for production CAs.
        insecureSkipVerify: true
      transport:
        # Avoid observability.local resolving to an unreachable IPv6 loopback first.
        preferIPv4: true

  shutdown:
    flushTimeoutMs: 3000
`;

export function registerProjectConfigBootstrap(
  pi: unknown,
  options: RegisterProjectConfigBootstrapOptions = {},
): void {
  const api = pi as ProjectConfigBootstrapPiApi;
  api.on("session_start", createProjectConfigBootstrapHandler(options));
}

export async function ensureProjectObservMeConfig(
  options: EnsureProjectConfigOptions = {},
): Promise<ProjectConfigBootstrapResult> {
  const configPath = resolveProjectObservMeConfigPath(options);
  const projectTrusted = await resolveBootstrapProjectTrust(options.isProjectTrusted);

  if (!projectTrusted) return { path: configPath, status: "skipped_untrusted" };
  return createProjectObservMeConfigFile(configPath);
}

function createProjectConfigBootstrapHandler(
  options: RegisterProjectConfigBootstrapOptions,
): ProjectConfigBootstrapHandler {
  return async (_event, ctx) => {
    await bootstrapProjectObservMeConfig(ctx, options);
  };
}

/**
 * Single startup source of truth for trusted-project ObservMe config creation and user notification.
 */
export async function bootstrapProjectObservMeConfig(
  ctx: ProjectConfigBootstrapContext,
  options: RegisterProjectConfigBootstrapOptions = {},
): Promise<ProjectConfigBootstrapResult | undefined> {
  try {
    const result = await resolveProjectConfigBootstrapResult(ctx, options);
    await notifyProjectConfigCreated(ctx, result);
    return result;
  } catch (error) {
    await notifyProjectConfigBootstrapFailed(ctx, error);
    return undefined;
  }
}

function resolveProjectConfigBootstrapResult(
  ctx: ProjectConfigBootstrapContext,
  options: RegisterProjectConfigBootstrapOptions,
): Promise<ProjectConfigBootstrapResult> {
  const ensureProjectConfig = options.ensureProjectConfig ?? ensureProjectObservMeConfig;
  return ensureProjectConfig({
    configDirName: options.configDirName,
    cwd: ctx.cwd,
    isProjectTrusted: ctx.isProjectTrusted,
  });
}

async function notifyProjectConfigCreated(
  ctx: ProjectConfigBootstrapContext,
  result: ProjectConfigBootstrapResult,
): Promise<void> {
  if (result.status !== "created") return;
  await ctx.ui?.notify?.(`ObservMe created ${result.path}. Edit this file for custom setup.`, "info");
}

async function notifyProjectConfigBootstrapFailed(ctx: ProjectConfigBootstrapContext, error: unknown): Promise<void> {
  await ctx.ui?.notify?.(`ObservMe could not create the project config file: ${formatError(error)}`, "warning");
}

async function createProjectObservMeConfigFile(configPath: string): Promise<ProjectConfigBootstrapResult> {
  await mkdir(dirname(configPath), { recursive: true });

  try {
    await writeFile(configPath, PROJECT_OBSERVME_YAML_TEMPLATE, { encoding: "utf8", flag: "wx" });
    return { path: configPath, status: "created" };
  } catch (error) {
    if (isFileAlreadyExistsError(error)) return { path: configPath, status: "exists" };
    throw error;
  }
}

function resolveProjectObservMeConfigPath(options: EnsureProjectConfigOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const configDirName = options.configDirName ?? defaultConfigDirName;
  return join(cwd, configDirName, observmeYamlFileName);
}

async function resolveBootstrapProjectTrust(
  isProjectTrusted: EnsureProjectConfigOptions["isProjectTrusted"],
): Promise<boolean> {
  if (typeof isProjectTrusted === "boolean") return isProjectTrusted;
  if (typeof isProjectTrusted === "function") return isProjectTrusted();
  return false;
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return isErrorWithCode(error) && error.code === "EEXIST";
}

function isErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
