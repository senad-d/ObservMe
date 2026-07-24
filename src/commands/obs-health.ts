import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import {
  createObsTransportSecuritySnapshot,
  type ObsTransportSecuritySnapshot,
} from "../config/transport-security.ts";
import { readDiagnosticMessage, sanitizeDiagnosticText } from "../diagnostics/sanitize.ts";
import { getGrafanaHealth, type GrafanaFetch } from "../query/grafana.ts";
import { completeObsSubcommand, isExactObsSubcommandRequest } from "./obs-args.ts";
import { loadObsCommandConfig, normalizeObsCommandTimeoutMs, notifyObsCommand } from "./obs-command-support.ts";
import { appendObsRecoveryHint, formatObsCommandFailure } from "./obs-diagnostics.ts";

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
  readonly transportSecurity?: ObsTransportSecuritySnapshot;
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

const OBS_COMMAND_NAME = "obs";
const OBS_HEALTH_SUBCOMMAND = "health";
const OBS_HEALTH_CONFIG_NEXT_ACTION = "fix ObservMe config, then rerun /obs health.";
const OBS_HEALTH_COLLECTOR_NEXT_ACTION = "verify the Collector is running and otlp.endpoint is reachable.";
const OBS_HEALTH_GRAFANA_NEXT_ACTION = "check query.grafana.url and credentials, then rerun /obs health.";
const OBS_HEALTH_TEMPO_NEXT_ACTION = "check Grafana credentials and query.grafana.datasourceUids.tempo, then rerun /obs health.";
const OBS_HEALTH_LOKI_NEXT_ACTION = "check Grafana credentials and query.grafana.datasourceUids.loki, then rerun /obs health.";
const OBS_HEALTH_METRICS_NEXT_ACTION = "check Grafana credentials and query.grafana.datasourceUids.prometheus, then rerun /obs health.";
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
    await notifyObsCommand(ctx, "Usage: /obs health", "warning");
    return;
  }

  try {
    const snapshot = await resolveObsHealthSnapshot(ctx, options);
    await notifyObsCommand(ctx, renderObsHealth(snapshot), resolveObsHealthNotificationType(snapshot));
  } catch (error) {
    await notifyObsCommand(
      ctx,
      formatObsCommandFailure("ObservMe health unavailable", error, {
        subsystem: "Health configuration",
        nextAction: OBS_HEALTH_CONFIG_NEXT_ACTION,
      }),
      "error",
    );
  }
}

export function getObsHealthCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  return completeObsSubcommand(prefix, OBS_HEALTH_SUBCOMMAND);
}

export async function getObsHealthSnapshot(
  ctx: ObsHealthCommandContext,
  options: ObsHealthSnapshotOptions = {},
): Promise<ObsHealthSnapshot> {
  const config = await loadObsHealthConfig(ctx, options);
  const timeoutMs = resolveObsHealthTimeout(config, options);
  const collectorFetcher = resolveCollectorHealthFetch(options.fetch);
  const [collectorCheck, grafanaHealth] = await Promise.all([
    checkCollectorReachability(config, collectorFetcher, timeoutMs),
    getGrafanaHealth(config, { fetch: options.fetch, timeoutMs }),
  ]);

  return {
    timeoutMs,
    checks: [collectorCheck, ...grafanaHealth.checks],
    transportSecurity: createObsTransportSecuritySnapshot(config),
  };
}

export function renderObsHealth(snapshot: ObsHealthSnapshot): string {
  return [
    ...formatObsHealthTransportSecurity(snapshot.transportSecurity),
    ...snapshot.checks.map(renderObsHealthCheck),
  ].join("\n");
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
  return loadObsCommandConfig(ctx, options);
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

async function checkHttpHealthTarget(
  target: HttpHealthTarget,
  fetcher: ObsHealthFetch,
  timeoutMs: number,
): Promise<ObsHealthCheckResult> {
  try {
    const response = await fetchWithTimeout(target, fetcher, timeoutMs);
    try {
      return responseToHealthResult(target, response);
    } finally {
      cancelHttpHealthResponseBody(response);
    }
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

function cancelHttpHealthResponseBody(response: Response): void {
  if (response.body === null) return;
  void response.body.cancel().catch(ignoreHttpHealthResponseCancellationFailure);
}

function ignoreHttpHealthResponseCancellationFailure(): void {
  // Status-only health checks cancel best-effort; the bounded request has already completed.
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

function responseToHealthResult(target: HttpHealthTarget, response: Response): ObsHealthCheckResult {
  if (responseMatchesSuccessMode(target, response)) return { label: target.label, kind: target.kind, status: "ok" };

  return {
    label: target.label,
    kind: target.kind,
    status: "failed",
    detail: formatHttpFailure(response),
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

function formatObsHealthTransportSecurity(security: ObsTransportSecuritySnapshot | undefined): string[] {
  if (!security) return [];
  return [
    `Collector transport security: ${security.collector}`,
    `Grafana transport security: ${security.grafana}`,
  ];
}

function renderObsHealthCheck(check: ObsHealthCheckResult): string {
  const status = formatObsHealthStatus(check);
  const detail = formatObsHealthDetail(check);
  const detailText = detail ? ` (${detail})` : "";
  return `${check.label}: ${status}${detailText}`;
}

function formatObsHealthStatus(check: ObsHealthCheckResult): string {
  if (check.status === "ok") return check.kind === "datasource" ? "ok" : "reachable";
  if (check.status === "skipped") return "skipped";
  return check.kind === "datasource" ? "failed" : "unreachable";
}

function formatObsHealthDetail(check: ObsHealthCheckResult): string | undefined {
  if (!check.detail) return undefined;
  if (check.status !== "failed") return check.detail;
  return appendObsRecoveryHint(check.detail, resolveObsHealthNextAction(check));
}

function resolveObsHealthNextAction(check: ObsHealthCheckResult): string {
  if (check.label === "Collector") return OBS_HEALTH_COLLECTOR_NEXT_ACTION;
  if (check.label === "Grafana") return OBS_HEALTH_GRAFANA_NEXT_ACTION;
  if (check.label === "Tempo datasource") return OBS_HEALTH_TEMPO_NEXT_ACTION;
  if (check.label === "Loki datasource") return OBS_HEALTH_LOKI_NEXT_ACTION;
  if (check.label === "Metrics datasource") return OBS_HEALTH_METRICS_NEXT_ACTION;
  return OBS_HEALTH_CONFIG_NEXT_ACTION;
}

function resolveObsHealthNotificationType(snapshot: ObsHealthSnapshot): "info" | "warning" {
  return snapshot.checks.some(check => check.status === "failed") ? "warning" : "info";
}

function resolveObsHealthTimeout(config: ObservMeConfig, options: ObsHealthSnapshotOptions): number {
  return normalizeObsCommandTimeoutMs(options.timeoutMs, config.query.timeoutMs, 1);
}


function resolveCollectorHealthFetch(fetcher: ObsHealthFetch | undefined): ObsHealthFetch {
  return fetcher ?? globalThis.fetch.bind(globalThis);
}

function isObsHealthRequest(args: string): boolean {
  return isExactObsSubcommandRequest(args, OBS_HEALTH_SUBCOMMAND);
}

function formatHttpFailure(response: Response): string {
  return formatHttpStatus(response);
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
  return sanitizeDiagnosticText(readDiagnosticMessage(error));
}
