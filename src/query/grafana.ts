import type { ObservMeConfig } from "../config/schema.ts";
import { readDiagnosticMessage, sanitizeDiagnosticText } from "../diagnostics/sanitize.ts";
import type { GrafanaTransportClient, GrafanaTransportOptions } from "./grafana-transport.ts";
import { createGrafanaTransport } from "./grafana-transport.ts";
import type { GrafanaQueryDatasourceKey } from "./grafana-readiness.ts";
import {
  formatGrafanaQueryDisabledGuidance,
  formatGrafanaQueryReadiness,
  getGrafanaQueryReadiness,
} from "./grafana-readiness.ts";
import { buildGrafanaTraceLink } from "./trace-link.ts";

export { buildGrafanaTraceLink as getGrafanaTraceLink } from "./trace-link.ts";

export type { GrafanaFetch } from "./grafana-transport.ts";
export type GrafanaHealthCheckKind = "service" | "datasource";
export type GrafanaHealthCheckStatus = "ok" | "failed" | "skipped";

export interface GrafanaHealthCheckResult {
  readonly label: string;
  readonly kind: GrafanaHealthCheckKind;
  readonly status: GrafanaHealthCheckStatus;
  readonly detail?: string;
}

export interface GrafanaHealthResult {
  readonly timeoutMs: number;
  readonly checks: readonly GrafanaHealthCheckResult[];
}

export type GrafanaQueryClientOptions = GrafanaTransportOptions;

interface GrafanaHealthTarget {
  readonly label: string;
  readonly kind: GrafanaHealthCheckKind;
  readonly url: URL;
  readonly fallbackUrl?: URL;
}

interface GrafanaDatasourceDefinition {
  readonly label: string;
  readonly key: GrafanaQueryDatasourceKey;
  readonly uid: string;
  readonly fallbackHealthPath?: string;
}

const datasourceDefinitions = [
  { label: "Tempo datasource", key: "tempo", fallbackHealthPath: "/ready" },
  { label: "Loki datasource", key: "loki", fallbackHealthPath: undefined },
  { label: "Metrics datasource", key: "prometheus", fallbackHealthPath: undefined },
] as const;
export class GrafanaQueryClient {
  readonly #config: ObservMeConfig;
  readonly #transport: GrafanaTransportClient;

  constructor(config: ObservMeConfig, options: GrafanaQueryClientOptions = {}) {
    this.#config = config;
    this.#transport = createGrafanaTransport(config, options);
  }

  async health(): Promise<GrafanaHealthResult> {
    return getGrafanaHealthWithTransport(this.#config, this.#transport);
  }

  getTraceLink(traceId: string): string {
    return buildGrafanaTraceLink(this.#config, traceId);
  }
}

export function createGrafanaQueryClient(
  config: ObservMeConfig,
  options: GrafanaQueryClientOptions = {},
): GrafanaQueryClient {
  return new GrafanaQueryClient(config, options);
}

export async function getGrafanaHealth(
  config: ObservMeConfig,
  options: GrafanaQueryClientOptions = {},
): Promise<GrafanaHealthResult> {
  return getGrafanaHealthWithTransport(config, createGrafanaTransport(config, options));
}

async function getGrafanaHealthWithTransport(
  config: ObservMeConfig,
  transport: GrafanaTransportClient,
): Promise<GrafanaHealthResult> {
  const checks = await Promise.all([
    checkGrafanaReachability(config, transport),
    ...createDatasourceDefinitions(config).map(datasource => checkDatasourceReachability(config, datasource, transport)),
  ]);

  return { timeoutMs: transport.timeoutMs, checks };
}

async function checkGrafanaReachability(
  config: ObservMeConfig,
  transport: GrafanaTransportClient,
): Promise<GrafanaHealthCheckResult> {
  const preflight = resolveGrafanaPreflightResult(config, "Grafana", "service");
  if (preflight) return preflight;

  try {
    const target = createGrafanaHealthTarget(transport);
    return await checkGrafanaTarget(target, transport);
  } catch (error) {
    return failedHealthResult("Grafana", "service", error);
  }
}

async function checkDatasourceReachability(
  config: ObservMeConfig,
  datasource: GrafanaDatasourceDefinition,
  transport: GrafanaTransportClient,
): Promise<GrafanaHealthCheckResult> {
  const preflight = resolveGrafanaPreflightResult(config, datasource.label, "datasource", datasource.key);
  if (preflight) return preflight;

  try {
    const target = createDatasourceHealthTarget(transport, datasource);
    return await checkGrafanaTarget(target, transport);
  } catch (error) {
    return failedHealthResult(datasource.label, "datasource", error);
  }
}

async function checkGrafanaTarget(
  target: GrafanaHealthTarget,
  transport: GrafanaTransportClient,
): Promise<GrafanaHealthCheckResult> {
  try {
    const response = await transport.fetch(target.url);
    if (!shouldFetchGrafanaFallbackTarget(target, response)) return responseToHealthResult(target, response, transport);
    return responseToHealthResult(target, await fetchGrafanaFallbackTarget(target, transport), transport);
  } catch (error) {
    return failedHealthResult(target.label, target.kind, error);
  }
}

function createGrafanaHealthTarget(transport: GrafanaTransportClient): GrafanaHealthTarget {
  return {
    label: "Grafana",
    kind: "service",
    url: transport.apiUrl("/api/health"),
  };
}

function createDatasourceHealthTarget(
  transport: GrafanaTransportClient,
  datasource: GrafanaDatasourceDefinition,
): GrafanaHealthTarget {
  return {
    label: datasource.label,
    kind: "datasource",
    url: transport.datasourceApiUrl(datasource.uid, "/health"),
    fallbackUrl: createDatasourceFallbackHealthUrl(transport, datasource),
  };
}

function createDatasourceFallbackHealthUrl(
  transport: GrafanaTransportClient,
  datasource: GrafanaDatasourceDefinition,
): URL | undefined {
  if (!datasource.fallbackHealthPath) return undefined;

  return transport.datasourceProxyUrl(datasource.uid, datasource.fallbackHealthPath);
}

function createDatasourceDefinitions(config: ObservMeConfig): GrafanaDatasourceDefinition[] {
  return datasourceDefinitions.map(definition => ({
    label: definition.label,
    key: definition.key,
    uid: config.query.grafana.datasourceUids[definition.key],
    fallbackHealthPath: definition.fallbackHealthPath,
  }));
}

function resolveGrafanaPreflightResult(
  config: ObservMeConfig,
  label: string,
  kind: GrafanaHealthCheckKind,
  datasourceKey?: GrafanaQueryDatasourceKey,
): GrafanaHealthCheckResult | undefined {
  const readiness = getGrafanaQueryReadiness(config, datasourceKey);
  if (readiness.status === "ready") return undefined;
  if (readiness.status === "disabled") return skippedHealthResult(label, kind, formatGrafanaQueryDisabledGuidance());

  return {
    label,
    kind,
    status: "failed",
    detail: formatGrafanaQueryReadiness(readiness),
  };
}

function responseToHealthResult(
  target: GrafanaHealthTarget,
  response: Response,
  transport: GrafanaTransportClient,
): GrafanaHealthCheckResult {
  if (response.ok) return { label: target.label, kind: target.kind, status: "ok" };

  return {
    label: target.label,
    kind: target.kind,
    status: "failed",
    detail: transport.formatHttpFailure(response),
  };
}

function shouldFetchGrafanaFallbackTarget(target: GrafanaHealthTarget, response: Response): boolean {
  return target.kind === "datasource" && response.status === 404 && target.fallbackUrl !== undefined;
}

async function fetchGrafanaFallbackTarget(
  target: GrafanaHealthTarget,
  transport: GrafanaTransportClient,
): Promise<Response> {
  const fallbackUrl = target.fallbackUrl;
  if (!fallbackUrl) throw new Error("Grafana datasource fallback health URL is not configured.");
  return transport.fetch(fallbackUrl);
}

function failedHealthResult(label: string, kind: GrafanaHealthCheckKind, error: unknown): GrafanaHealthCheckResult {
  return {
    label,
    kind,
    status: "failed",
    detail: formatHealthFailure(error),
  };
}

function skippedHealthResult(label: string, kind: GrafanaHealthCheckKind, detail: string): GrafanaHealthCheckResult {
  return { label, kind, status: "skipped", detail };
}

function formatHealthFailure(error: unknown): string {
  return formatError(error);
}

function formatError(error: unknown): string {
  return sanitizeDiagnosticText(readDiagnosticMessage(error));
}
