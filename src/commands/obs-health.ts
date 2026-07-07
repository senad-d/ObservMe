import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import { loadSessionConfig } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import type { GrafanaFetch } from "../query/grafana-transport.ts";
import {
  createGrafanaHeaders,
  formatGrafanaFetchFailure,
  formatGrafanaHttpFailure,
  resolveGrafanaFetch,
} from "../query/grafana-transport.ts";
import type { GrafanaQueryDatasourceKey } from "../query/grafana-readiness.ts";
import { formatGrafanaQueryReadiness, getGrafanaQueryReadiness } from "../query/grafana-readiness.ts";

export interface ObsHealthCommandContext {
  readonly cwd?: string;
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export type ObsHealthCheckKind = "service" | "datasource";
export type ObsHealthCheckStatus = "ok" | "failed" | "skipped";
export type ObsHealthFetch = GrafanaFetch;
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
  readonly grafanaConfig?: ObservMeConfig;
  readonly fallbackUrl?: string;
}

interface DatasourceDefinition {
  readonly label: string;
  readonly key: GrafanaQueryDatasourceKey;
  readonly uid: string;
  readonly fallbackHealthPath?: string;
}

const OBS_COMMAND_NAME = "obs";
const OBS_HEALTH_SUBCOMMAND = "health";
const minimumTimeoutMs = 1;
const datasourceDefinitions = [
  { label: "Tempo datasource", key: "tempo", fallbackHealthPath: "/ready" },
  { label: "Loki datasource", key: "loki", fallbackHealthPath: undefined },
  { label: "Metrics datasource", key: "prometheus", fallbackHealthPath: undefined },
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
  const collectorFetcher = resolveCollectorHealthFetch(options.fetch);
  const grafanaFetcher = resolveObsHealthFetch(config, options.fetch);
  const checks = await Promise.all([
    checkCollectorReachability(config, collectorFetcher, timeoutMs),
    checkGrafanaReachability(config, grafanaFetcher, timeoutMs),
    ...createDatasourceDefinitions(config).map(datasource => checkDatasourceReachability(config, datasource, grafanaFetcher, timeoutMs)),
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
    key: definition.key,
    uid: config.query.grafana.datasourceUids[definition.key],
    fallbackHealthPath: definition.fallbackHealthPath,
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
  const preflight = resolveGrafanaPreflightResult(config, "Grafana", "service");
  if (preflight) return preflight;

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
  const preflight = resolveGrafanaPreflightResult(config, datasource.label, "datasource", datasource.key);
  if (preflight) return preflight;

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
    if (!shouldFetchFallbackTarget(target, response)) return responseToHealthResult(target, response);
    return responseToHealthResult(target, await fetchFallbackTarget(target, fetcher, timeoutMs));
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
    grafanaConfig: config,
  };
}

function createDatasourceHealthTarget(config: ObservMeConfig, datasource: DatasourceDefinition): HttpHealthTarget {
  return {
    label: datasource.label,
    kind: "datasource",
    url: buildGrafanaApiUrl(config.query.grafana.url, `/api/datasources/uid/${encodeURIComponent(datasource.uid)}/health`),
    headers: createGrafanaHeaders(config),
    successMode: "ok",
    grafanaConfig: config,
    fallbackUrl: createDatasourceFallbackHealthUrl(config, datasource),
  };
}

function createDatasourceFallbackHealthUrl(config: ObservMeConfig, datasource: DatasourceDefinition): string | undefined {
  if (!datasource.fallbackHealthPath) return undefined;

  return buildGrafanaApiUrl(
    config.query.grafana.url,
    `/api/datasources/proxy/uid/${encodeURIComponent(datasource.uid)}${datasource.fallbackHealthPath}`,
  );
}

function buildGrafanaApiUrl(baseUrl: string, apiPath: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  const path = apiPath.replace(/^\/+/, "");
  url.pathname = `${basePath}/${path}`;
  return url.toString();
}

function filterConfiguredHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const filtered: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const trimmed = value.trim();
    if (trimmed && !hasUnresolvedEnvironmentPlaceholder(trimmed)) filtered[name] = trimmed;
  }

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function hasUnresolvedEnvironmentPlaceholder(value: string): boolean {
  return /\$\{[A-Z0-9_]+\}/u.test(value);
}

function resolveGrafanaPreflightResult(
  config: ObservMeConfig,
  label: string,
  kind: ObsHealthCheckKind,
  datasourceKey?: GrafanaQueryDatasourceKey,
): ObsHealthCheckResult | undefined {
  const readiness = getGrafanaQueryReadiness(config, datasourceKey);
  if (readiness.status === "ready") return undefined;
  if (readiness.status === "disabled") return skippedHealthResult(label, kind, "query disabled");

  return {
    label,
    kind,
    status: "failed",
    detail: formatGrafanaQueryReadiness(readiness),
  };
}

function responseToHealthResult(target: HttpHealthTarget, response: Response): ObsHealthCheckResult {
  if (responseMatchesSuccessMode(target, response)) return { label: target.label, kind: target.kind, status: "ok" };

  return {
    label: target.label,
    kind: target.kind,
    status: "failed",
    detail: formatHttpFailure(target, response),
  };
}

function responseMatchesSuccessMode(target: HttpHealthTarget, response: Response): boolean {
  if (target.successMode === "reachable") return response.status < 500;
  return response.ok;
}

function shouldFetchFallbackTarget(target: HttpHealthTarget, response: Response): boolean {
  return target.kind === "datasource" && response.status === 404 && target.fallbackUrl !== undefined;
}

async function fetchFallbackTarget(
  target: HttpHealthTarget,
  fetcher: ObsHealthFetch,
  timeoutMs: number,
): Promise<Response> {
  const fallbackUrl = target.fallbackUrl;
  if (!fallbackUrl) throw new Error("Grafana datasource fallback health URL is not configured.");
  return fetchWithTimeout({ ...target, url: fallbackUrl, fallbackUrl: undefined }, fetcher, timeoutMs);
}

function failedHealthResult(label: string, kind: ObsHealthCheckKind, error: unknown): ObsHealthCheckResult {
  return {
    label,
    kind,
    status: "failed",
    detail: formatHealthFailure(label, error),
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

function resolveCollectorHealthFetch(fetcher: ObsHealthFetch | undefined): ObsHealthFetch {
  return fetcher ?? globalThis.fetch.bind(globalThis);
}

function resolveObsHealthFetch(config: ObservMeConfig, fetcher: ObsHealthFetch | undefined): ObsHealthFetch {
  return resolveGrafanaFetch(config, fetcher);
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

function formatHttpFailure(target: HttpHealthTarget, response: Response): string {
  if (target.grafanaConfig) return formatGrafanaHttpFailure(response, target.grafanaConfig);
  return formatHttpStatus(response);
}

function formatHttpStatus(response: Response): string {
  const statusText = response.statusText.trim();
  return statusText ? `HTTP ${response.status} ${statusText}` : `HTTP ${response.status}`;
}

function formatHealthFailure(label: string, error: unknown): string {
  if (label !== "Collector") return formatGrafanaFetchFailure(error);
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
