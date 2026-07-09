import type { ObservMeConfig } from "../config/schema.ts";
import { readDiagnosticMessage, sanitizeDiagnosticText } from "../diagnostics/sanitize.ts";
import { assertNoSensitiveQueryInput } from "../safety/sensitive-input.ts";
import type { GrafanaTransportClient, GrafanaTransportOptions } from "./grafana-transport.ts";
import { createGrafanaTransport } from "./grafana-transport.ts";
import type { GrafanaQueryDatasourceKey } from "./grafana-readiness.ts";
import { formatGrafanaQueryReadiness, getGrafanaQueryReadiness } from "./grafana-readiness.ts";

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

const traceIdPattern = /^[a-f0-9]{32}$/iu;
const zeroTraceIdPattern = /^0{32}$/u;
const traceIdTemplatePattern = /\{\{\s*traceId\s*\}\}|\{traceId\}|\$\{traceId\}|%TRACE_ID%/u;
const fallbackTraceTemplateMarkerPattern = /\.\.\./u;
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
  readonly #transport: GrafanaTransportClient;

  constructor(config: ObservMeConfig, options: GrafanaQueryClientOptions = {}) {
    this.#config = config;
    this.#transport = createGrafanaTransport(config, options);
  }

  async health(): Promise<GrafanaHealthResult> {
    return getGrafanaHealthWithTransport(this.#config, this.#transport);
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

export function getGrafanaTraceLink(config: ObservMeConfig, traceId: string): string {
  const normalizedTraceId = normalizeTraceId(traceId);
  const template = config.query.links.traceUrlTemplate.trim();

  if (hasTraceIdTemplatePlaceholder(template)) return renderTraceUrlTemplate(template, config, normalizedTraceId);
  if (isFallbackTraceTemplate(template)) return buildDefaultGrafanaTraceLink(config, normalizedTraceId);

  throw new Error("Grafana traceUrlTemplate must include a traceId placeholder or use the default Grafana link fallback.");
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
  if (readiness.status === "disabled") return skippedHealthResult(label, kind, "query disabled");

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

function buildDefaultGrafanaTraceLink(config: ObservMeConfig, traceId: string): string {
  const baseUrl = config.query.grafana.url.trim();
  if (!baseUrl) throw new Error("Grafana URL is not configured for trace-link construction.");

  const url = new URL(baseUrl);
  const basePath = removeTrailingSlashes(url.pathname);
  url.pathname = `${basePath}/explore`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("schemaVersion", "1");
  url.searchParams.set("panes", JSON.stringify(createDefaultExplorePanes(config, traceId)));
  return url.toString();
}

function removeTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
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
  assertNoSensitiveQueryInput(trimmed, "Grafana traceId");

  if (!traceIdPattern.test(trimmed) || zeroTraceIdPattern.test(trimmed)) {
    throw new Error(
      "Unsafe Grafana traceId: expected a non-zero 32-character hexadecimal OpenTelemetry trace id; raw prompts, commands, paths, and environment values are not query inputs.",
    );
  }

  return trimmed.toLowerCase();
}

function hasTraceIdTemplatePlaceholder(template: string): boolean {
  return traceIdTemplatePattern.test(template);
}

function isFallbackTraceTemplate(template: string): boolean {
  return template === "" || fallbackTraceTemplateMarkerPattern.test(template);
}

function formatHealthFailure(error: unknown): string {
  return formatError(error);
}

function formatError(error: unknown): string {
  return sanitizeDiagnosticText(readDiagnosticMessage(error));
}
