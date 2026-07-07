import type { ObservMeConfig } from "../config/schema.ts";
import type { GrafanaFetch } from "./grafana-transport.ts";
import {
  createGrafanaHeaders,
  formatGrafanaFetchFailure,
  formatGrafanaHttpFailure,
  resolveGrafanaFetch,
} from "./grafana-transport.ts";

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

export interface GrafanaQueryClientOptions {
  readonly fetch?: GrafanaFetch;
}

interface GrafanaHealthTarget {
  readonly label: string;
  readonly kind: GrafanaHealthCheckKind;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly config: ObservMeConfig;
  readonly fallbackUrl?: string;
}

interface GrafanaDatasourceDefinition {
  readonly label: string;
  readonly uid: string;
  readonly fallbackHealthPath?: string;
}

interface TraceTemplateReplacement {
  readonly pattern: RegExp;
  readonly key: TraceTemplateValueKey;
}

type TraceTemplateValueKey = "traceId" | "tempoDatasourceUid";

type TraceTemplateValues = Record<TraceTemplateValueKey, string>;

interface GrafanaExploreDatasourceRef {
  readonly type: "tempo";
  readonly uid: string;
}

interface GrafanaTraceQuery {
  readonly refId: "A";
  readonly datasource: GrafanaExploreDatasourceRef;
  readonly queryType: "traceId";
  readonly query: string;
}

interface GrafanaExplorePane {
  readonly datasource: string;
  readonly queries: readonly GrafanaTraceQuery[];
  readonly range: {
    readonly from: "now-1h";
    readonly to: "now";
  };
}

type GrafanaExplorePanes = Record<string, GrafanaExplorePane>;

const minimumTimeoutMs = 1;
const traceIdPattern = /^[a-f0-9]{32}$/iu;
const zeroTraceIdPattern = /^0{32}$/u;
const traceIdTemplatePattern = /\{\{\s*traceId\s*\}\}|\{traceId\}|\$\{traceId\}|%TRACE_ID%/u;
const fallbackTraceTemplateMarkerPattern = /\.\.\./u;
const sensitiveQueryValuePatterns = [
  /(?:^|\b)(?:prompt|system prompt|user prompt|assistant response|thinking|raw content)(?:\b|:)/iu,
  /(?:^|\s)(?:sudo|rm|mv|cp|curl|wget|npm|pnpm|yarn|node|python3?|bash|sh|git)\s+\S+/iu,
  /(?:^|[\s=:])(?:~|\.{1,2}|\/|[A-Za-z]:\\|\\\\)\S*/u,
  /\b[A-Z][A-Z0-9_]{2,}=[^\s]+/u,
] as const;
const datasourceDefinitions = [
  { label: "Tempo datasource", key: "tempo", fallbackHealthPath: "/ready" },
  { label: "Loki datasource", key: "loki", fallbackHealthPath: undefined },
  { label: "Metrics datasource", key: "prometheus", fallbackHealthPath: undefined },
] as const;
const traceTemplateReplacements: readonly TraceTemplateReplacement[] = [
  { pattern: /\{\{\s*traceId\s*\}\}/gu, key: "traceId" },
  { pattern: /\$\{traceId\}/gu, key: "traceId" },
  { pattern: /\{traceId\}/gu, key: "traceId" },
  { pattern: /%TRACE_ID%/gu, key: "traceId" },
  { pattern: /\{\{\s*tempoDatasourceUid\s*\}\}/gu, key: "tempoDatasourceUid" },
  { pattern: /\$\{tempoDatasourceUid\}/gu, key: "tempoDatasourceUid" },
  { pattern: /\{tempoDatasourceUid\}/gu, key: "tempoDatasourceUid" },
  { pattern: /%TEMPO_DATASOURCE_UID%/gu, key: "tempoDatasourceUid" },
];

export class GrafanaQueryClient {
  readonly #config: ObservMeConfig;
  readonly #fetcher: GrafanaFetch;

  constructor(config: ObservMeConfig, options: GrafanaQueryClientOptions = {}) {
    this.#config = config;
    this.#fetcher = resolveGrafanaFetch(config, options.fetch);
  }

  async health(): Promise<GrafanaHealthResult> {
    return getGrafanaHealth(this.#config, { fetch: this.#fetcher });
  }

  getTraceLink(traceId: string): string {
    return getGrafanaTraceLink(this.#config, traceId);
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
  const timeoutMs = resolveQueryTimeoutMs(config);
  const fetcher = resolveGrafanaFetch(config, options.fetch);
  const checks = await Promise.all([
    checkGrafanaReachability(config, fetcher, timeoutMs),
    ...createDatasourceDefinitions(config).map(datasource => checkDatasourceReachability(config, datasource, fetcher, timeoutMs)),
  ]);

  return { timeoutMs, checks };
}

export function getGrafanaTraceLink(config: ObservMeConfig, traceId: string): string {
  const normalizedTraceId = normalizeTraceId(traceId);
  const template = config.query.links.traceUrlTemplate.trim();

  if (hasTraceIdTemplatePlaceholder(template)) return renderTraceUrlTemplate(template, config, normalizedTraceId);
  if (isFallbackTraceTemplate(template)) return buildDefaultGrafanaTraceLink(config, normalizedTraceId);

  throw new Error("Grafana traceUrlTemplate must include a traceId placeholder or use the default Grafana link fallback.");
}

async function checkGrafanaReachability(
  config: ObservMeConfig,
  fetcher: GrafanaFetch,
  timeoutMs: number,
): Promise<GrafanaHealthCheckResult> {
  const skipped = resolveGrafanaSkippedResult(config, "Grafana", "service");
  if (skipped) return skipped;

  try {
    const target = createGrafanaHealthTarget(config);
    return await checkGrafanaTarget(target, fetcher, timeoutMs);
  } catch (error) {
    return failedHealthResult("Grafana", "service", error);
  }
}

async function checkDatasourceReachability(
  config: ObservMeConfig,
  datasource: GrafanaDatasourceDefinition,
  fetcher: GrafanaFetch,
  timeoutMs: number,
): Promise<GrafanaHealthCheckResult> {
  const skipped = resolveGrafanaSkippedResult(config, datasource.label, "datasource");
  if (skipped) return skipped;

  try {
    const target = createDatasourceHealthTarget(config, datasource);
    return await checkGrafanaTarget(target, fetcher, timeoutMs);
  } catch (error) {
    return failedHealthResult(datasource.label, "datasource", error);
  }
}

async function checkGrafanaTarget(
  target: GrafanaHealthTarget,
  fetcher: GrafanaFetch,
  timeoutMs: number,
): Promise<GrafanaHealthCheckResult> {
  try {
    const response = await fetchGrafanaTarget(target, fetcher, timeoutMs);
    if (!shouldFetchGrafanaFallbackTarget(target, response)) return responseToHealthResult(target, response);
    return responseToHealthResult(target, await fetchGrafanaFallbackTarget(target, fetcher, timeoutMs));
  } catch (error) {
    return failedHealthResult(target.label, target.kind, error);
  }
}

async function fetchGrafanaTarget(target: GrafanaHealthTarget, fetcher: GrafanaFetch, timeoutMs: number): Promise<Response> {
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

function createGrafanaHealthTarget(config: ObservMeConfig): GrafanaHealthTarget {
  return {
    label: "Grafana",
    kind: "service",
    url: buildGrafanaApiUrl(config.query.grafana.url, "/api/health"),
    headers: createGrafanaHeaders(config),
    config,
  };
}

function createDatasourceHealthTarget(
  config: ObservMeConfig,
  datasource: GrafanaDatasourceDefinition,
): GrafanaHealthTarget {
  return {
    label: datasource.label,
    kind: "datasource",
    url: buildGrafanaApiUrl(config.query.grafana.url, `/api/datasources/uid/${encodeURIComponent(datasource.uid)}/health`),
    headers: createGrafanaHeaders(config),
    config,
    fallbackUrl: createDatasourceFallbackHealthUrl(config, datasource),
  };
}

function createDatasourceFallbackHealthUrl(
  config: ObservMeConfig,
  datasource: GrafanaDatasourceDefinition,
): string | undefined {
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
  url.search = "";
  url.hash = "";
  return url.toString();
}

function createDatasourceDefinitions(config: ObservMeConfig): GrafanaDatasourceDefinition[] {
  return datasourceDefinitions.map(definition => ({
    label: definition.label,
    uid: config.query.grafana.datasourceUids[definition.key],
    fallbackHealthPath: definition.fallbackHealthPath,
  }));
}

function resolveGrafanaSkippedResult(
  config: ObservMeConfig,
  label: string,
  kind: GrafanaHealthCheckKind,
): GrafanaHealthCheckResult | undefined {
  if (!config.query.enabled) return skippedHealthResult(label, kind, "query disabled");
  if (!config.query.grafana.url.trim()) return skippedHealthResult(label, kind, "Grafana URL not configured");
  return undefined;
}

function responseToHealthResult(target: GrafanaHealthTarget, response: Response): GrafanaHealthCheckResult {
  if (response.ok) return { label: target.label, kind: target.kind, status: "ok" };

  return {
    label: target.label,
    kind: target.kind,
    status: "failed",
    detail: formatGrafanaHttpFailure(response, target.config),
  };
}

function shouldFetchGrafanaFallbackTarget(target: GrafanaHealthTarget, response: Response): boolean {
  return target.kind === "datasource" && response.status === 404 && target.fallbackUrl !== undefined;
}

async function fetchGrafanaFallbackTarget(
  target: GrafanaHealthTarget,
  fetcher: GrafanaFetch,
  timeoutMs: number,
): Promise<Response> {
  const fallbackUrl = target.fallbackUrl;
  if (!fallbackUrl) throw new Error("Grafana datasource fallback health URL is not configured.");
  return fetchGrafanaTarget({ ...target, url: fallbackUrl, fallbackUrl: undefined }, fetcher, timeoutMs);
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

function buildDefaultGrafanaTraceLink(config: ObservMeConfig, traceId: string): string {
  const baseUrl = config.query.grafana.url.trim();
  if (!baseUrl) throw new Error("Grafana URL is not configured for trace-link construction.");

  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}/explore`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("schemaVersion", "1");
  url.searchParams.set("panes", JSON.stringify(createDefaultExplorePanes(config, traceId)));
  return url.toString();
}

function createDefaultExplorePanes(config: ObservMeConfig, traceId: string): GrafanaExplorePanes {
  const tempoUid = config.query.grafana.datasourceUids.tempo;
  return {
    observmeTrace: {
      datasource: tempoUid,
      queries: [
        {
          refId: "A",
          datasource: { type: "tempo", uid: tempoUid },
          queryType: "traceId",
          query: traceId,
        },
      ],
      range: { from: "now-1h", to: "now" },
    },
  };
}

function renderTraceUrlTemplate(template: string, config: ObservMeConfig, traceId: string): string {
  const values = createTraceTemplateValues(config, traceId);
  let rendered = template;

  for (const replacement of traceTemplateReplacements) {
    rendered = rendered.replace(replacement.pattern, values[replacement.key]);
  }

  return rendered;
}

function createTraceTemplateValues(config: ObservMeConfig, traceId: string): TraceTemplateValues {
  return {
    traceId: encodeURIComponent(traceId),
    tempoDatasourceUid: encodeURIComponent(config.query.grafana.datasourceUids.tempo),
  };
}

function normalizeTraceId(traceId: string): string {
  const trimmed = traceId.trim();
  assertNoSensitiveRawQueryInput(trimmed, "traceId");

  if (!traceIdPattern.test(trimmed) || zeroTraceIdPattern.test(trimmed)) {
    throw new Error(
      "Unsafe Grafana traceId: expected a non-zero 32-character hexadecimal OpenTelemetry trace id; raw prompts, commands, paths, and environment values are not query inputs.",
    );
  }

  return trimmed.toLowerCase();
}

function assertNoSensitiveRawQueryInput(value: string, label: string): void {
  if (!isSensitiveRawQueryInput(value)) return;

  throw new Error(
    `Unsafe Grafana ${label}: raw prompts, commands, paths, and inherited environment values are not query inputs.`,
  );
}

function isSensitiveRawQueryInput(value: string): boolean {
  return sensitiveQueryValuePatterns.some(pattern => pattern.test(value));
}

function hasTraceIdTemplatePlaceholder(template: string): boolean {
  return traceIdTemplatePattern.test(template);
}

function isFallbackTraceTemplate(template: string): boolean {
  return template === "" || fallbackTraceTemplateMarkerPattern.test(template);
}

function resolveQueryTimeoutMs(config: ObservMeConfig): number {
  const timeoutMs = config.query.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < minimumTimeoutMs) return minimumTimeoutMs;
  return Math.trunc(timeoutMs);
}

function formatHealthFailure(error: unknown): string {
  return formatGrafanaFetchFailure(error);
}
