import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  LoadSessionConfigOptions,
  SessionConfigDiagnostics,
  SessionConfigEffectiveSource,
  SessionConfigEnvFileStatus,
  SessionConfigEnvironmentStatus,
  SessionConfigProjectStatus,
} from "../config/load-config.ts";
import { loadSessionConfigWithDiagnostics } from "../config/load-config.ts";
import type { CaptureConfig, ObservMeConfig } from "../config/schema.ts";
import {
  describeGrafanaTransportSecurity,
  describeOtlpTransportSecurity,
} from "../config/transport-security.ts";
import { getGrafanaQueryReadiness } from "../query/grafana-readiness.ts";
import { completeObsSubcommand, isExactObsSubcommandRequest } from "./obs-args.ts";
import { notifyObsCommand } from "./obs-command-support.ts";
import { sanitizeObsDiagnosticText } from "./obs-diagnostics.ts";

export interface ObsStatusCommandContext {
  readonly cwd?: string;
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export interface ObsStatusSnapshot {
  readonly config: ObservMeConfig;
  readonly queueDrops: number;
  readonly lastExportError?: string;
  readonly configDiagnostics?: SessionConfigDiagnostics;
}

export interface ObsStatusRuntimeStatePatch {
  readonly config?: ObservMeConfig;
  readonly queueDrops?: number;
  readonly lastExportError?: string;
  readonly configDiagnostics?: SessionConfigDiagnostics;
}

export interface ObsStatusRuntimeState {
  readonly config?: ObservMeConfig;
  readonly queueDrops: number;
  readonly lastExportError?: string;
  readonly configDiagnostics?: SessionConfigDiagnostics;
}

export interface ObsStatusOperationResult {
  readonly operation: string;
  readonly completed?: boolean;
  readonly timedOut?: boolean;
  readonly error?: unknown;
}

export type ObsStatusConfigLoader = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type ObsStatusProvider = (ctx: ObsStatusCommandContext) => Promise<ObsStatusSnapshot> | ObsStatusSnapshot;
type ObsStatusReadText = NonNullable<LoadSessionConfigOptions["readText"]>;
type ObsStatusRuntimeOptions = NonNullable<LoadSessionConfigOptions["runtimeOptions"]>;
type ObsStatusLogger = NonNullable<LoadSessionConfigOptions["logger"]>;

export interface ObsStatusSnapshotOptions {
  readonly loadConfig?: ObsStatusConfigLoader;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
  readonly globalConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly readText?: ObsStatusReadText;
  readonly runtimeOptions?: ObsStatusRuntimeOptions;
  readonly logger?: ObsStatusLogger;
}

export interface RegisterObsStatusCommandOptions extends ObsStatusSnapshotOptions {
  readonly getStatus?: ObsStatusProvider;
}

const OBS_COMMAND_NAME = "obs";
const OBS_STATUS_SUBCOMMAND = "status";

interface MutableObsStatusRuntimeState {
  config?: ObservMeConfig;
  queueDrops: number;
  lastExportError?: string;
  configDiagnostics?: SessionConfigDiagnostics;
}

const runtimeStatusState: MutableObsStatusRuntimeState = {
  queueDrops: 0,
};

export function registerObsStatusCommand(pi: ExtensionAPI, options: RegisterObsStatusCommandOptions = {}): void {
  const command = new ObsStatusCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Show local ObservMe status. Usage: /obs status",
    getArgumentCompletions: getObsCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsStatusCommand(
  args: string,
  ctx: ObsStatusCommandContext,
  options: RegisterObsStatusCommandOptions = {},
): Promise<void> {
  if (!isObsStatusRequest(args)) {
    await notifyObsCommand(ctx, "Usage: /obs status", "warning");
    return;
  }

  try {
    const snapshot = await resolveObsStatusSnapshot(ctx, options);
    await notifyObsCommand(ctx, renderObsStatus(snapshot), "info");
  } catch (error) {
    await notifyObsCommand(ctx, `ObservMe status unavailable: ${sanitizeObsDiagnosticText(formatError(error))}`, "error");
  }
}

export function getObsCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  return completeObsSubcommand(prefix, OBS_STATUS_SUBCOMMAND);
}

export async function getLocalObsStatusSnapshot(
  ctx: ObsStatusCommandContext,
  options: ObsStatusSnapshotOptions = {},
): Promise<ObsStatusSnapshot> {
  const state = getObsStatusRuntimeState();
  const loaded = state.config ? { config: state.config, diagnostics: state.configDiagnostics } : await loadObsStatusConfig(ctx, options);

  return {
    config: loaded.config,
    queueDrops: normalizeQueueDrops(state.queueDrops),
    lastExportError: normalizeLastExportError(state.lastExportError),
    configDiagnostics: loaded.diagnostics,
  };
}

export function renderObsStatus(snapshot: ObsStatusSnapshot): string {
  const config = snapshot.config;
  const lines = [
    `ObservMe: ${formatEnabled(config.enabled)}`,
    `OTLP endpoint: ${formatSafeConfiguredEndpoint(config.otlp.endpoint)}`,
    `OTLP transport security: ${describeOtlpTransportSecurity(config)}`,
    ...formatConfigDiagnosticsLines(snapshot.configDiagnostics),
    `Grafana URL: ${formatSafeConfiguredUrl(config.query.grafana.url)}`,
    `Grafana transport security: ${describeGrafanaTransportSecurity(config)}`,
    `Grafana query readiness: ${formatGrafanaQueryReadiness(config)}`,
    `Traces: ${formatEnabled(signalEnabled(config, config.traces.enabled))}`,
    `Metrics: ${formatEnabled(signalEnabled(config, config.metrics.enabled))}`,
    `Logs: ${formatEnabled(signalEnabled(config, config.logs.enabled))}`,
    ...formatCaptureLines(config.capture),
    `Queue drops: ${normalizeQueueDrops(snapshot.queueDrops)}`,
    `Last export error: ${normalizeLastExportError(snapshot.lastExportError) ?? "none"}`,
  ];

  return lines.join("\n");
}

export function updateObsStatusRuntimeState(patch: ObsStatusRuntimeStatePatch): void {
  if (patch.config) {
    runtimeStatusState.config = structuredClone(patch.config);
    delete runtimeStatusState.configDiagnostics;
  }
  if (patch.configDiagnostics) runtimeStatusState.configDiagnostics = structuredClone(patch.configDiagnostics);
  if (patch.queueDrops !== undefined) runtimeStatusState.queueDrops = normalizeQueueDrops(patch.queueDrops);
  if (patch.lastExportError !== undefined) runtimeStatusState.lastExportError = normalizeLastExportError(patch.lastExportError);
}

export function resetObsStatusRuntimeState(): void {
  delete runtimeStatusState.config;
  delete runtimeStatusState.lastExportError;
  delete runtimeStatusState.configDiagnostics;
  runtimeStatusState.queueDrops = 0;
}

export function getObsStatusRuntimeState(): ObsStatusRuntimeState {
  return {
    config: runtimeStatusState.config ? structuredClone(runtimeStatusState.config) : undefined,
    queueDrops: normalizeQueueDrops(runtimeStatusState.queueDrops),
    lastExportError: normalizeLastExportError(runtimeStatusState.lastExportError),
    configDiagnostics: runtimeStatusState.configDiagnostics ? structuredClone(runtimeStatusState.configDiagnostics) : undefined,
  };
}

export function recordObsStatusQueueDrop(count = 1): void {
  runtimeStatusState.queueDrops = normalizeQueueDrops(runtimeStatusState.queueDrops) + normalizeQueueDrops(count);
}

export function recordObsStatusExportResult(result: ObsStatusOperationResult): void {
  if (result.timedOut) {
    runtimeStatusState.lastExportError = `${result.operation} timed out`;
    return;
  }

  if (result.error) runtimeStatusState.lastExportError = sanitizeObsDiagnosticText(`${result.operation} failed: ${formatError(result.error)}`);
}

export function clearObsStatusExportError(): void {
  delete runtimeStatusState.lastExportError;
}

class ObsStatusCommand {
  readonly #options: RegisterObsStatusCommandOptions;

  constructor(options: RegisterObsStatusCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsStatusCommandContext): Promise<void> {
    await handleObsStatusCommand(args, ctx, this.#options);
  }
}

async function resolveObsStatusSnapshot(
  ctx: ObsStatusCommandContext,
  options: RegisterObsStatusCommandOptions,
): Promise<ObsStatusSnapshot> {
  if (options.getStatus) return options.getStatus(ctx);
  return getLocalObsStatusSnapshot(ctx, options);
}

async function loadObsStatusConfig(
  ctx: ObsStatusCommandContext,
  options: ObsStatusSnapshotOptions,
): Promise<{ config: ObservMeConfig; diagnostics?: SessionConfigDiagnostics }> {
  const loadOptions = createObsStatusLoadOptions(ctx, options);

  if (options.loadConfig) return { config: await options.loadConfig(loadOptions) };
  return loadSessionConfigWithDiagnostics(loadOptions);
}

function createObsStatusLoadOptions(
  ctx: ObsStatusCommandContext,
  options: ObsStatusSnapshotOptions,
): LoadSessionConfigOptions {
  return {
    ctx,
    cwd: ctx.cwd,
    configDirName: options.configDirName,
    env: options.env,
    globalConfigPath: options.globalConfigPath,
    projectConfigPath: options.projectConfigPath,
    readText: options.readText,
    runtimeOptions: options.runtimeOptions,
    logger: options.logger,
  };
}

function isObsStatusRequest(args: string): boolean {
  return isExactObsSubcommandRequest(args, OBS_STATUS_SUBCOMMAND, { allowEmpty: true });
}

function formatCaptureLines(capture: CaptureConfig): string[] {
  return [
    `Prompt capture: ${formatEnabled(capture.prompts)}`,
    `Response capture: ${formatEnabled(capture.responses)}`,
    `Thinking capture: ${formatEnabled(capture.thinking)}`,
    `Tool argument capture: ${formatEnabled(capture.toolArguments)}`,
    `Tool result capture: ${formatEnabled(capture.toolResults)}`,
    `Bash command capture: ${formatEnabled(capture.bashCommands)}`,
    `Bash output capture: ${formatEnabled(capture.bashOutput)}`,
    `File path capture: ${formatEnabled(capture.filePaths)}`,
  ];
}

function formatConfigDiagnosticsLines(diagnostics: SessionConfigDiagnostics | undefined): string[] {
  if (!diagnostics) return [];

  return [
    `Config source: ${formatConfigEffectiveSource(diagnostics.effectiveSource)}`,
    ...formatGlobalConfigStatus(diagnostics),
    `Project config: ${formatProjectConfigStatus(diagnostics.projectConfigStatus)}`,
    ...formatEnvFileStatus(diagnostics.envFileStatus),
    ...formatEnvironmentStatus(diagnostics.environmentStatus),
    ...formatConfigRejectionLines(diagnostics),
  ];
}

function formatConfigRejectionLines(diagnostics: SessionConfigDiagnostics): string[] {
  const rejection = diagnostics.rejection;
  if (!rejection) return [];

  return [
    `Config rejection: safe defaults applied (${rejection.issueCount} issue(s): ${rejection.issueCodes.join(", ")})`,
  ];
}

function formatConfigEffectiveSource(source: SessionConfigEffectiveSource): string {
  if (source === "runtime_options") return "runtime options";
  if (source === "environment") return "environment overrides";
  if (source === "trusted_project") return "trusted project config (.pi/observme.yaml)";
  if (source === "global") return "global config";
  return "defaults";
}

function formatGlobalConfigStatus(diagnostics: SessionConfigDiagnostics): string[] {
  if (!diagnostics.globalConfigStatus) return [];
  return [`Global config: ${formatFileSourceStatus(diagnostics.globalConfigStatus, "global config")}`];
}

function formatProjectConfigStatus(status: SessionConfigProjectStatus): string {
  if (status === "loaded") return "loaded (trusted .pi/observme.yaml)";
  if (status === "skipped_untrusted") {
    return "skipped (project is untrusted; safe defaults/global/env only)";
  }
  if (status === "missing") return "missing (trusted project has no .pi/observme.yaml)";
  return formatFileSourceStatus(status, "trusted .pi/observme.yaml");
}

function formatEnvFileStatus(status: SessionConfigEnvFileStatus | undefined): string[] {
  if (!status) return [];
  if (status === "skipped_untrusted") return ["Project .env: skipped (project is untrusted)"];
  if (status === "skipped_disabled") return ["Project .env: skipped (loading is disabled)"];
  return [`Project .env: ${formatFileSourceStatus(status, "trusted project .env")}`];
}

function formatEnvironmentStatus(status: SessionConfigEnvironmentStatus | undefined): string[] {
  if (!status) return [];
  if (status === "loaded") return ["Process environment: loaded"];
  if (status === "rejected") return ["Process environment: rejected (malformed supported override)"];
  return ["Process environment: no ObservMe values"];
}

function formatFileSourceStatus(
  status: Exclude<SessionConfigProjectStatus, "skipped_untrusted">,
  label: string,
): string {
  if (status === "loaded") return "loaded";
  if (status === "missing") return "missing";
  if (status === "malformed") return `ignored (${label} is malformed)`;
  if (status === "unreadable") return `ignored (${label} is unreadable)`;
  return `ignored (${label} was structurally rejected)`;
}

function formatGrafanaQueryReadiness(config: ObservMeConfig): string {
  const readiness = getGrafanaQueryReadiness(config);
  const issueCodes = readiness.issues.map(issue => issue.code).join(", ");
  return issueCodes ? `${readiness.status} (${issueCodes})` : readiness.status;
}

function formatSafeConfiguredUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "not configured";

  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return formatInvalidConfiguredUrl(error);
  }
}

function signalEnabled(config: ObservMeConfig, enabled: boolean): boolean {
  return config.enabled && enabled;
}

function formatEnabled(enabled: boolean): "enabled" | "disabled" {
  return enabled ? "enabled" : "disabled";
}

function normalizeQueueDrops(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

function normalizeLastExportError(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? sanitizeObsDiagnosticText(trimmed) : undefined;
}

function formatSafeConfiguredEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "not configured";

  try {
    const parsed = new URL(trimmed);
    const hasExplicitRootPath = trimmed.endsWith("/");
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const formatted = parsed.toString();
    if (parsed.pathname === "/" && !hasExplicitRootPath) return formatted.replace(/\/$/u, "");
    return formatted;
  } catch (error) {
    return formatInvalidConfiguredUrl(error);
  }
}

function formatInvalidConfiguredUrl(error: unknown): string {
  const failureKind = error instanceof Error ? error.name : "unknown parser failure";
  return `invalid configured URL (${failureKind})`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
