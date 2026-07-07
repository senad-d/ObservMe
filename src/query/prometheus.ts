import type { ObservMeConfig } from "../config/schema.ts";
import type { GrafanaFetch } from "./grafana-transport.ts";
import {
  createGrafanaHeaders,
  formatGrafanaFetchFailure,
  formatGrafanaHttpFailure,
  resolveGrafanaFetch,
} from "./grafana-transport.ts";
import { assertGrafanaQueryReady } from "./grafana-readiness.ts";

export type PrometheusFetch = GrafanaFetch;
export type PrometheusResultLimit = "metricSeries" | "agents";
export type PrometheusResultType = "vector" | "matrix" | "scalar" | "string" | "unknown";

export interface PrometheusSample {
  readonly timestampUnixSeconds: string;
  readonly value: string;
}

export interface PrometheusMetricSeries {
  readonly metric: Record<string, string>;
  readonly value?: PrometheusSample;
  readonly values?: readonly PrometheusSample[];
}

export interface QueryResult {
  readonly resultType: PrometheusResultType;
  readonly series: readonly PrometheusMetricSeries[];
  readonly scalar?: PrometheusSample;
  readonly stringValue?: PrometheusSample;
}

export interface PrometheusQueryClientOptions {
  readonly fetch?: PrometheusFetch;
}

export interface PrometheusQueryExecutionOptions {
  readonly resultLimit?: PrometheusResultLimit | number;
}

export interface PrometheusQueryOptions extends PrometheusQueryClientOptions, PrometheusQueryExecutionOptions {}

export const FORBIDDEN_HIGH_CARDINALITY_PROMETHEUS_LABELS = [
  "agent_id",
  "agent_run_id",
  "child_agent_id",
  "entry_id",
  "parent_agent_id",
  "raw_command",
  "raw_error_message",
  "raw_path",
  "raw_prompt",
  "session_id",
  "span_id",
  "spawn_id",
  "spawn_tool_call_id",
  "tool_call_id",
  "trace_id",
  "workflow_id",
  "workflow_root_agent_id",
] as const;

const forbiddenHighCardinalityPrometheusLabelAliases = [
  "pi_agent_child_id",
  "pi_agent_id",
  "pi_agent_parent_id",
  "pi_agent_root_id",
  "pi_agent_run_id",
  "pi_agent_spawn_id",
  "pi_agent_spawn_tool_call_id",
  "pi_entry_id",
  "pi_session_id",
  "pi_tool_call_id",
  "pi_workflow_id",
  "pi_workflow_root_agent_id",
] as const;
const allForbiddenHighCardinalityPrometheusLabels = [
  ...FORBIDDEN_HIGH_CARDINALITY_PROMETHEUS_LABELS,
  ...forbiddenHighCardinalityPrometheusLabelAliases,
] as const;
const minimumTimeoutMs = 1;
const minimumMaxMetricSeries = 1;
const minimumMaxAgents = 1;
const maxPromQlQueryLength = 4096;
const unresolvedEnvironmentPlaceholderPattern = /\$\{[A-Z0-9_]+\}/u;
const sensitiveQueryValuePatterns = [
  /(?:^|[\s"'`|=])(?:prompt|system prompt|user prompt|assistant response|thinking|raw content)\s*:/iu,
  /(?:^|[\s"'`])(?:sudo|rm|mv|cp|curl|wget|npm|pnpm|yarn|node|python3?|bash|sh|git)\s+\S+/iu,
  /(?:^|[\s"'`=])(?:~|\.{1,2}\/|\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\|\\\\)\S*/u,
  /\b[A-Z][A-Z0-9_]{2,}=[^\s"'`]+/u,
  unresolvedEnvironmentPlaceholderPattern,
] as const;

export class PrometheusQueryClient {
  readonly #config: ObservMeConfig;
  readonly #fetcher: PrometheusFetch;

  constructor(config: ObservMeConfig, options: PrometheusQueryClientOptions = {}) {
    this.#config = config;
    this.#fetcher = resolveGrafanaFetch(config, options.fetch);
  }

  async queryPrometheus(
    query: string,
    time?: Date,
    options: PrometheusQueryExecutionOptions = {},
  ): Promise<QueryResult> {
    return queryPrometheus(this.#config, query, time, { ...options, fetch: this.#fetcher });
  }
}

export function createPrometheusQueryClient(
  config: ObservMeConfig,
  options: PrometheusQueryClientOptions = {},
): PrometheusQueryClient {
  return new PrometheusQueryClient(config, options);
}

export async function queryPrometheus(
  config: ObservMeConfig,
  query: string,
  time?: Date,
  options: PrometheusQueryOptions = {},
): Promise<QueryResult> {
  if (!config.query.enabled) return emptyPrometheusQueryResult();

  assertGrafanaQueryReady(config, "prometheus");
  const normalizedQuery = normalizePrometheusQuery(query);
  const queryTime = normalizeQueryTime(time);
  const resultLimit = resolveResultLimit(config, options.resultLimit);
  const url = createPrometheusQueryUrl(config, normalizedQuery, queryTime, resultLimit);
  const response = await fetchPrometheusQuery(url, config, resolveGrafanaFetch(config, options.fetch));

  return readPrometheusQueryResult(response, config, resultLimit);
}

export function findForbiddenPrometheusLabels(query: string): string[] {
  return allForbiddenHighCardinalityPrometheusLabels.filter(label => containsPrometheusIdentifier(query, label));
}

function normalizePrometheusQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Prometheus query requires a non-empty PromQL query.");
  if (trimmed.length > maxPromQlQueryLength) throw new Error("Prometheus query is bounded to 4096 characters.");

  assertNoSensitiveRawQueryInput(trimmed);
  assertNoForbiddenHighCardinalityLabels(trimmed);
  return trimmed;
}

function normalizeQueryTime(time: Date | undefined): Date | undefined {
  if (time === undefined) return undefined;
  if (!(time instanceof Date) || !Number.isFinite(time.getTime())) {
    throw new Error("Prometheus query time must be a valid Date when provided.");
  }

  return time;
}

function assertNoSensitiveRawQueryInput(query: string): void {
  if (!isSensitiveRawQueryInput(query)) return;

  throw new Error("Unsafe Prometheus query: raw prompts, commands, paths, and inherited environment values are not query inputs.");
}

function isSensitiveRawQueryInput(query: string): boolean {
  return sensitiveQueryValuePatterns.some(pattern => pattern.test(query));
}

function assertNoForbiddenHighCardinalityLabels(query: string): void {
  const labels = findForbiddenPrometheusLabels(query);
  if (labels.length === 0) return;

  throw new Error(`Unsafe Prometheus query: forbidden high-cardinality metric labels are not allowed: ${labels.join(", ")}.`);
}

function containsPrometheusIdentifier(query: string, identifier: string): boolean {
  return createPrometheusIdentifierPattern(identifier).test(query);
}

function createPrometheusIdentifierPattern(identifier: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(identifier)}(?![A-Za-z0-9_])`, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function createPrometheusQueryUrl(config: ObservMeConfig, query: string, time: Date | undefined, resultLimit: number): string {
  const url = buildGrafanaApiUrl(
    config.query.grafana.url,
    `/api/datasources/proxy/uid/${encodeURIComponent(config.query.grafana.datasourceUids.prometheus)}/api/v1/query`,
  );

  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(resultLimit));
  url.searchParams.set("timeout", formatPrometheusDuration(resolveQueryTimeoutMs(config)));
  if (time) url.searchParams.set("time", formatPrometheusTimestamp(time));
  return url.toString();
}

function buildGrafanaApiUrl(baseUrl: string, apiPath: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  const path = apiPath.replace(/^\/+/, "");
  url.pathname = `${basePath}/${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

async function fetchPrometheusQuery(url: string, config: ObservMeConfig, fetcher: PrometheusFetch): Promise<Response> {
  const timeoutMs = resolveQueryTimeoutMs(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetcher(url, {
      method: "GET",
      headers: createGrafanaHeaders(config),
      signal: controller.signal,
    });
  } catch (error) {
    throw normalizePrometheusFetchError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePrometheusFetchError(error: unknown): Error {
  if (isAbortError(error)) return new Error("Prometheus query timed out.");
  return new Error(formatGrafanaFetchFailure(error));
}

async function readPrometheusQueryResult(
  response: Response,
  config: ObservMeConfig,
  resultLimit: number,
): Promise<QueryResult> {
  if (!response.ok) throw new Error(`Prometheus query failed: ${formatGrafanaHttpFailure(response, config)}`);

  const payload = (await response.json()) as unknown;
  const apiError = readPrometheusApiError(payload);
  if (apiError) throw new Error(`Prometheus query failed: ${apiError}`);
  return extractPrometheusQueryResult(payload, resultLimit);
}

function readPrometheusApiError(payload: unknown): string | undefined {
  if (!isRecord(payload) || payload.status !== "error") return undefined;

  const errorType = readOptionalString(payload, "errorType");
  const errorMessage = readOptionalString(payload, "error");
  return [errorType, errorMessage].filter(isNonEmptyString).join(": ") || "unknown Prometheus API error";
}

function extractPrometheusQueryResult(payload: unknown, resultLimit: number): QueryResult {
  const data = readPrometheusData(payload);
  const resultType = readPrometheusResultType(data?.resultType);

  if (resultType === "scalar") return extractPrometheusScalarResult(data?.result, resultType);
  if (resultType === "string") return extractPrometheusStringResult(data?.result, resultType);

  const series = extractPrometheusMetricSeries(data?.result).slice(0, resultLimit);
  return { resultType, series };
}

function readPrometheusData(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
  return payload.data;
}

function readPrometheusResultType(value: unknown): PrometheusResultType {
  if (value === "vector" || value === "matrix" || value === "scalar" || value === "string") return value;
  return "unknown";
}

function extractPrometheusScalarResult(result: unknown, resultType: "scalar"): QueryResult {
  const scalar = toPrometheusSample(result);
  return scalar ? { resultType, series: [], scalar } : { resultType, series: [] };
}

function extractPrometheusStringResult(result: unknown, resultType: "string"): QueryResult {
  const stringValue = toPrometheusSample(result);
  return stringValue ? { resultType, series: [], stringValue } : { resultType, series: [] };
}

function extractPrometheusMetricSeries(result: unknown): PrometheusMetricSeries[] {
  if (!Array.isArray(result)) return [];
  return result.map(toPrometheusMetricSeries).filter(isPrometheusMetricSeries);
}

function toPrometheusMetricSeries(item: unknown): PrometheusMetricSeries | undefined {
  if (!isRecord(item)) return undefined;

  const metric = readStringRecord(item.metric);
  const value = toPrometheusSample(item.value);
  const values = toPrometheusSamples(item.values);
  if (!value && values.length === 0) return undefined;

  return createPrometheusMetricSeries(metric, value, values);
}

function createPrometheusMetricSeries(
  metric: Record<string, string>,
  value: PrometheusSample | undefined,
  values: readonly PrometheusSample[],
): PrometheusMetricSeries {
  const result: PrometheusMetricSeries = { metric };
  if (value) return { ...result, value };
  return values.length > 0 ? { ...result, values } : result;
}

function toPrometheusSamples(values: unknown): PrometheusSample[] {
  if (!Array.isArray(values)) return [];
  return values.map(toPrometheusSample).filter(isPrometheusSample);
}

function toPrometheusSample(value: unknown): PrometheusSample | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;

  const timestampUnixSeconds = readStringOrNumber(value[0]);
  const sampleValue = readStringOrNumber(value[1]);
  if (timestampUnixSeconds === undefined || sampleValue === undefined) return undefined;

  return { timestampUnixSeconds, value: sampleValue };
}

function readStringRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (!isRecord(value)) return record;

  for (const [key, item] of Object.entries(value)) {
    const text = readStringOrNumber(item);
    if (text !== undefined) record[key] = text;
  }

  return record;
}

function readOptionalString(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readStringOrNumber(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isPrometheusMetricSeries(value: PrometheusMetricSeries | undefined): value is PrometheusMetricSeries {
  return value !== undefined;
}

function isPrometheusSample(value: PrometheusSample | undefined): value is PrometheusSample {
  return value !== undefined;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyPrometheusQueryResult(): QueryResult {
  return { resultType: "vector", series: [] };
}

function resolveResultLimit(config: ObservMeConfig, limit: PrometheusResultLimit | number | undefined): number {
  if (limit === "agents") return resolveMaxAgents(config);
  if (typeof limit === "number") return normalizeExplicitResultLimit(limit);
  return resolveMaxMetricSeries(config);
}

function normalizeExplicitResultLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < minimumMaxMetricSeries) {
    throw new Error("Prometheus result limit must be a positive finite number.");
  }

  return Math.trunc(limit);
}

function resolveQueryTimeoutMs(config: ObservMeConfig): number {
  const timeoutMs = config.query.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < minimumTimeoutMs) return minimumTimeoutMs;
  return Math.trunc(timeoutMs);
}

function resolveMaxMetricSeries(config: ObservMeConfig): number {
  const maxMetricSeries = config.query.maxMetricSeries;
  if (!Number.isFinite(maxMetricSeries) || maxMetricSeries < minimumMaxMetricSeries) return minimumMaxMetricSeries;
  return Math.trunc(maxMetricSeries);
}

function resolveMaxAgents(config: ObservMeConfig): number {
  const maxAgents = config.query.maxAgents;
  if (!Number.isFinite(maxAgents) || maxAgents < minimumMaxAgents) return minimumMaxAgents;
  return Math.trunc(maxAgents);
}

function formatPrometheusTimestamp(date: Date): string {
  return trimTrailingFractionZeros((date.getTime() / 1000).toFixed(3));
}

function formatPrometheusDuration(milliseconds: number): string {
  return `${trimTrailingFractionZeros((milliseconds / 1000).toFixed(3))}s`;
}

function trimTrailingFractionZeros(value: string): string {
  return value.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}

function isAbortError(error: unknown): boolean {
  return isNamedError(error) && error.name === "AbortError";
}

function isNamedError(error: unknown): error is { name: string } {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string";
}
