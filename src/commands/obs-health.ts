import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import { loadSessionConfig } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";

export interface ObsHealthCommandContext {
  readonly cwd?: string;
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export type ObsHealthCheckKind = "service" | "datasource";
export type ObsHealthCheckStatus = "ok" | "failed" | "skipped";
export type ObsHealthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type ObsHealthConfigLoader = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type ObsHealthProvider = (ctx: ObsHealthCommandContext) => Promise<ObsHealthSnapshot> | ObsHealthSnapshot;

export interface ObsHealthCheckResult {
  readonly label: string;
  readonly kind: ObsHealthCheckKind;
  readonly status: ObsHealthCheckStatus;
  readonly detail?: string;
}

export interface ObsHealthSnapshot {
  readonly timeoutMs: number;
  readonly checks: readonly ObsHealthCheckResult[];
}

export interface ObsHealthSnapshotOptions {
  readonly loadConfig?: ObsHealthConfigLoader;
  readonly fetch?: ObsHealthFetch;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
}

export interface RegisterObsHealthCommandOptions extends ObsHealthSnapshotOptions {
  readonly getHealth?: ObsHealthProvider;
}

interface HttpHealthTarget {
  readonly label: string;
  readonly kind: ObsHealthCheckKind;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly successMode: "ok" | "reachable";
}

interface DatasourceDefinition {
  readonly label: string;
  readonly uid: string;
}

const OBS_COMMAND_NAME = "obs";
const OBS_HEALTH_SUBCOMMAND = "health";
const minimumTimeoutMs = 1;
const datasourceDefinitions = [
  { label: "Tempo datasource", key: "tempo" },
  { label: "Loki datasource", key: "loki" },
  { label: "Metrics datasource", key: "prometheus" },
] as const;

export function registerObsHealthCommand(pi: ExtensionAPI, options: RegisterObsHealthCommandOptions = {}): void {
  const command = new ObsHealthCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Check ObservMe backend health. Usage: /obs health",
    getArgumentCompletions: getObsHealthCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsHealthCommand(
  args: string,
  ctx: ObsHealthCommandContext,
  options: RegisterObsHealthCommandOptions = {},
): Promise<void> {
  if (!isObsHealthRequest(args)) {
    await notifyHealth(ctx, "Usage: /obs health", "warning");
    return;
  }

  try {
    const snapshot = await resolveObsHealthSnapshot(ctx, options);
    await notifyHealth(ctx, renderObsHealth(snapshot), resolveObsHealthNotificationType(snapshot));
  } catch (error) {
    await notifyHealth(ctx, `ObservMe health unavailable: ${formatError(error)}`, "error");
  }
}

export function getObsHealthCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (!OBS_HEALTH_SUBCOMMAND.startsWith(normalizedPrefix)) return null;
  return [{ value: OBS_HEALTH_SUBCOMMAND, label: OBS_HEALTH_SUBCOMMAND }];
}

export async function getObsHealthSnapshot(
  ctx: ObsHealthCommandContext,
  options: ObsHealthSnapshotOptions = {},
): Promise<ObsHealthSnapshot> {
  const config = await loadObsHealthConfig(ctx, options);
  const timeoutMs = resolveObsHealthTimeout(config, options);
  const fetcher = resolveObsHealthFetch(options.fetch);
  const checks = await Promise.all([
    checkCollectorReachability(config, fetcher, timeoutMs),
    checkGrafanaReachability(config, fetcher, timeoutMs),
    ...createDatasourceDefinitions(config).map(datasource => checkDatasourceReachability(config, datasource, fetcher, timeoutMs)),
  ]);

  return { timeoutMs, checks };
}

export function renderObsHealth(snapshot: ObsHealthSnapshot): string {
  return snapshot.checks.map(renderObsHealthCheck).join("\n");
}

class ObsHealthCommand {
  readonly #options: RegisterObsHealthCommandOptions;

  constructor(options: RegisterObsHealthCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsHealthCommandContext): Promise<void> {
    await handleObsHealthCommand(args, ctx, this.#options);
  }
}

async function resolveObsHealthSnapshot(
  ctx: ObsHealthCommandContext,
  options: RegisterObsHealthCommandOptions,
): Promise<ObsHealthSnapshot> {
  if (options.getHealth) return options.getHealth(ctx);
  return getObsHealthSnapshot(ctx, options);
}

async function loadObsHealthConfig(
  ctx: ObsHealthCommandContext,
  options: ObsHealthSnapshotOptions,
): Promise<ObservMeConfig> {
  const loadConfig = options.loadConfig ?? loadSessionConfig;
  return loadConfig({ ctx, cwd: ctx.cwd, configDirName: options.configDirName, env: options.env });
}

function createDatasourceDefinitions(config: ObservMeConfig): DatasourceDefinition[] {
  return datasourceDefinitions.map(definition => ({
    label: definition.label,
    uid: config.query.grafana.datasourceUids[definition.key],
  }));
}

async function checkCollectorReachability(
  config: ObservMeConfig,
  fetcher: ObsHealthFetch,
  timeoutMs: number,
): Promise<ObsHealthCheckResult> {
  const target = {
    label: "Collector",
    kind: "service" as const,
    url: config.otlp.endpoint,
    headers: filterConfiguredHeaders(config.otlp.headers),
    successMode: "reachable" as const,
  };

  return checkHttpHealthTarget(target, fetcher, timeoutMs);
}

async function checkGrafanaReachability(
  config: ObservMeConfig,
  fetcher: ObsHealthFetch,
  timeoutMs: number,
): Promise<ObsHealthCheckResult> {
  const skipped = resolveGrafanaSkippedResult(config, "Grafana", "service");
  if (skipped) return skipped;

  try {
    const target = createGrafanaHealthTarget(config);
    return await checkHttpHealthTarget(target, fetcher, timeoutMs);
  } catch (error) {
    return failedHealthResult("Grafana", "service", error);
  }
}

async function checkDatasourceReachability(
  config: ObservMeConfig,
  datasource: DatasourceDefinition,
  fetcher: ObsHealthFetch,
  timeoutMs: number,
): Promise<ObsHealthCheckResult> {
  const skipped = resolveGrafanaSkippedResult(config, datasource.label, "datasource");
  if (skipped) return skipped;

  try {
    const target = createDatasourceHealthTarget(config, datasource);
    return await checkHttpHealthTarget(target, fetcher, timeoutMs);
  } catch (error) {
    return failedHealthResult(datasource.label, "datasource", error);
  }
}

async function checkHttpHealthTarget(
  target: HttpHealthTarget,
  fetcher: ObsHealthFetch,
  timeoutMs: number,
): Promise<ObsHealthCheckResult> {
  try {
    const response = await fetchWithTimeout(target, fetcher, timeoutMs);
    return responseToHealthResult(target, response);
  } catch (error) {
    return failedHealthResult(target.label, target.kind, error);
  }
}

async function fetchWithTimeout(target: HttpHealthTarget, fetcher: ObsHealthFetch, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetcher(target.url, {
      method: "GET",
      headers: target.headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function createGrafanaHealthTarget(config: ObservMeConfig): HttpHealthTarget {
  return {
    label: "Grafana",
    kind: "service",
    url: buildGrafanaApiUrl(config.query.grafana.url, "/api/health"),
    headers: createGrafanaHeaders(config),
    successMode: "ok",
  };
}

function createDatasourceHealthTarget(config: ObservMeConfig, datasource: DatasourceDefinition): HttpHealthTarget {
  return {
    label: datasource.label,
    kind: "datasource",
    url: buildGrafanaApiUrl(config.query.grafana.url, `/api/datasources/uid/${encodeURIComponent(datasource.uid)}/health`),
    headers: createGrafanaHeaders(config),
    successMode: "ok",
  };
}

function buildGrafanaApiUrl(baseUrl: string, apiPath: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  const path = apiPath.replace(/^\/+/, "");
  url.pathname = `${basePath}/${path}`;
  return url.toString();
}

function createGrafanaHeaders(config: ObservMeConfig): Record<string, string> {
  const token = normalizeConfiguredToken(config.query.grafana.token);
  const headers: Record<string, string> = { Accept: "application/json" };

  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function filterConfiguredHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const filtered: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const trimmed = value.trim();
    if (trimmed && !hasUnresolvedEnvironmentPlaceholder(trimmed)) filtered[name] = trimmed;
  }

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function normalizeConfiguredToken(token: string): string | undefined {
  const trimmed = token.trim();
  if (!trimmed || hasUnresolvedEnvironmentPlaceholder(trimmed)) return undefined;
  return trimmed;
}

function hasUnresolvedEnvironmentPlaceholder(value: string): boolean {
  return /\$\{[A-Z0-9_]+\}/u.test(value);
}

function resolveGrafanaSkippedResult(
  config: ObservMeConfig,
  label: string,
  kind: ObsHealthCheckKind,
): ObsHealthCheckResult | undefined {
  if (!config.query.enabled) return skippedHealthResult(label, kind, "query disabled");
  if (!config.query.grafana.url.trim()) return skippedHealthResult(label, kind, "Grafana URL not configured");
  return undefined;
}

function responseToHealthResult(target: HttpHealthTarget, response: Response): ObsHealthCheckResult {
  if (responseMatchesSuccessMode(target, response)) return { label: target.label, kind: target.kind, status: "ok" };

  return {
    label: target.label,
    kind: target.kind,
    status: "failed",
    detail: formatHttpStatus(response),
  };
}

function responseMatchesSuccessMode(target: HttpHealthTarget, response: Response): boolean {
  if (target.successMode === "reachable") return response.status < 500;
  return response.ok;
}

function failedHealthResult(label: string, kind: ObsHealthCheckKind, error: unknown): ObsHealthCheckResult {
  return {
    label,
    kind,
    status: "failed",
    detail: formatHealthFailure(error),
  };
}

function skippedHealthResult(label: string, kind: ObsHealthCheckKind, detail: string): ObsHealthCheckResult {
  return { label, kind, status: "skipped", detail };
}

function renderObsHealthCheck(check: ObsHealthCheckResult): string {
  const status = formatObsHealthStatus(check);
  const detail = check.detail ? ` (${check.detail})` : "";
  return `${check.label}: ${status}${detail}`;
}

function formatObsHealthStatus(check: ObsHealthCheckResult): string {
  if (check.status === "ok") return check.kind === "datasource" ? "ok" : "reachable";
  if (check.status === "skipped") return "skipped";
  return check.kind === "datasource" ? "failed" : "unreachable";
}

function resolveObsHealthNotificationType(snapshot: ObsHealthSnapshot): "info" | "warning" {
  return snapshot.checks.some(check => check.status === "failed") ? "warning" : "info";
}

function resolveObsHealthTimeout(config: ObservMeConfig, options: ObsHealthSnapshotOptions): number {
  return normalizeTimeoutMs(options.timeoutMs ?? config.query.timeoutMs);
}

function normalizeTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value < minimumTimeoutMs) return minimumTimeoutMs;
  return Math.trunc(value);
}

function resolveObsHealthFetch(fetcher: ObsHealthFetch | undefined): ObsHealthFetch {
  return fetcher ?? globalThis.fetch.bind(globalThis);
}

function isObsHealthRequest(args: string): boolean {
  const [subcommand] = args.trim().toLowerCase().split(/\s+/u);
  return subcommand === OBS_HEALTH_SUBCOMMAND;
}

async function notifyHealth(
  ctx: ObsHealthCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): Promise<void> {
  await ctx.ui.notify(message, type);
}

function formatHttpStatus(response: Response): string {
  const statusText = response.statusText.trim();
  return statusText ? `HTTP ${response.status} ${statusText}` : `HTTP ${response.status}`;
}

function formatHealthFailure(error: unknown): string {
  if (isAbortError(error)) return "timed out";
  return formatError(error);
}

function isAbortError(error: unknown): boolean {
  return isNamedError(error) && error.name === "AbortError";
}

function isNamedError(error: unknown): error is { name: string } {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
