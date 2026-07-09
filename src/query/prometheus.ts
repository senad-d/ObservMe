import type { ObservMeConfig } from "../config/schema.ts";
import type { GrafanaFetch, GrafanaTransportClient } from "./grafana-transport.ts";
import { createGrafanaTransport } from "./grafana-transport.ts";
import { assertNoSensitiveQueryInput } from "../safety/sensitive-input.ts";
import { assertGrafanaQueryReady } from "./grafana-readiness.ts";

export type PrometheusFetch = GrafanaFetch;
export type PrometheusResultLimit = "metricSeries" | "agents";
export type PrometheusResultType = "vector" | "matrix" | "scalar" | "string" | "unknown";
type SuccessfulPrometheusResultType = Exclude<PrometheusResultType, "unknown">;

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
const minimumMaxMetricSeries = 1;
const minimumMaxAgents = 1;
const maxPromQlQueryLength = 4096;

export class PrometheusQueryClient {
  readonly #config: ObservMeConfig;
  readonly #transport: GrafanaTransportClient;

  constructor(config: ObservMeConfig, options: PrometheusQueryClientOptions = {}) {
    this.#config = config;
    this.#transport = createGrafanaTransport(config, options);
  }

  async queryPrometheus(
    query: string,
    time?: Date,
    options: PrometheusQueryExecutionOptions = {},
  ): Promise<QueryResult> {
    return queryPrometheusWithTransport(this.#config, this.#transport, query, time, options);
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
  return queryPrometheusWithTransport(config, createGrafanaTransport(config, options), query, time, options);
}

async function queryPrometheusWithTransport(
  config: ObservMeConfig,
  transport: GrafanaTransportClient,
  query: string,
  time: Date | undefined,
  options: PrometheusQueryExecutionOptions,
): Promise<QueryResult> {
  if (!config.query.enabled) return emptyPrometheusQueryResult();

  assertGrafanaQueryReady(config, "prometheus");
  const normalizedQuery = normalizePrometheusQuery(query);
  const queryTime = normalizeQueryTime(time);
  const resultLimit = resolveResultLimit(config, options.resultLimit);
  const url = createPrometheusQueryUrl(config, transport, normalizedQuery, queryTime, resultLimit);
  const response = await transport.fetch(url, { timeoutMessage: "Prometheus query timed out." });

  return readPrometheusQueryResult(response, transport, resultLimit);
}

export function findForbiddenPrometheusLabels(query: string): string[] {
  return allForbiddenHighCardinalityPrometheusLabels.filter(label => containsPrometheusIdentifier(query, label));
}

function normalizePrometheusQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Prometheus query requires a non-empty PromQL query.");
  if (trimmed.length > maxPromQlQueryLength) throw new Error("Prometheus query is bounded to 4096 characters.");

  assertNoSensitiveQueryInput(trimmed, "Prometheus query");
  assertNoForbiddenHighCardinalityLabels(trimmed);
  return trimmed;
}

function normalizeQueryTime(time: Date | undefined): Date | undefined {
  if (time === undefined) return undefined;
  if (!(time instanceof Date) || !Number.isFinite(time.getTime())) {
    throw new TypeError("Prometheus query time must be a valid Date when provided.");
  }

  return time;
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
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function createPrometheusQueryUrl(
  config: ObservMeConfig,
  transport: GrafanaTransportClient,
  query: string,
  time: Date | undefined,
  resultLimit: number,
): URL {
  const url = transport.datasourceProxyUrl(config.query.grafana.datasourceUids.prometheus, "/api/v1/query");

  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(resultLimit));
  url.searchParams.set("timeout", formatPrometheusDuration(transport.timeoutMs));
  if (time) url.searchParams.set("time", formatPrometheusTimestamp(time));
  return url;
}

async function readPrometheusQueryResult(
  response: Response,
  transport: GrafanaTransportClient,
  resultLimit: number,
): Promise<QueryResult> {
  if (!response.ok) throw new Error(`Prometheus query failed: ${transport.formatHttpFailure(response)}`);

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

function createPrometheusSchemaError(reason: string): Error {
  return new Error(`Prometheus query failed: backend schema error: ${reason}.`);
}

function extractPrometheusQueryResult(payload: unknown, resultLimit: number): QueryResult {
  const data = readPrometheusSuccessData(payload);
  const resultType = readPrometheusResultType(data.resultType);

  if (resultType === "scalar") return extractPrometheusScalarResult(data.result, resultType);
  if (resultType === "string") return extractPrometheusStringResult(data.result, resultType);

  const series = extractPrometheusMetricSeries(data.result, resultType).slice(0, resultLimit);
  return { resultType, series };
}

function readPrometheusSuccessData(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw createPrometheusSchemaError("response must be a JSON object");
  if (payload.status !== "success") throw createPrometheusSchemaError("status must be success");
  if (!isRecord(payload.data)) throw createPrometheusSchemaError("data must be an object");
  return payload.data;
}

function readPrometheusResultType(value: unknown): SuccessfulPrometheusResultType {
  if (value === "vector" || value === "matrix" || value === "scalar" || value === "string") return value;
  throw createPrometheusSchemaError("data.resultType must be vector, matrix, scalar, or string");
}

function extractPrometheusScalarResult(result: unknown, resultType: "scalar"): QueryResult {
  const scalar = toPrometheusSample(result);
  if (!scalar) throw createPrometheusSchemaError("data.result must be a valid scalar sample");
  return { resultType, series: [], scalar };
}

function extractPrometheusStringResult(result: unknown, resultType: "string"): QueryResult {
  const stringValue = toPrometheusSample(result);
  if (!stringValue) throw createPrometheusSchemaError("data.result must be a valid string sample");
  return { resultType, series: [], stringValue };
}

function extractPrometheusMetricSeries(
  result: unknown,
  resultType: "vector" | "matrix",
): PrometheusMetricSeries[] {
  if (!Array.isArray(result)) throw createPrometheusSchemaError("data.result must be an array for vector or matrix results");
  return result.map(item => toPrometheusMetricSeries(item, resultType));
}

function toPrometheusMetricSeries(item: unknown, resultType: "vector" | "matrix"): PrometheusMetricSeries {
  if (!isRecord(item)) throw createPrometheusSchemaError("each data.result item must be an object");

  const metric = readPrometheusMetricLabels(item.metric);
  if (resultType === "vector") return createPrometheusVectorSeries(metric, item.value);
  return createPrometheusMatrixSeries(metric, item.values);
}

function readPrometheusMetricLabels(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw createPrometheusSchemaError("each data.result item metric must be an object");
  return readStringRecord(value);
}

function createPrometheusVectorSeries(metric: Record<string, string>, value: unknown): PrometheusMetricSeries {
  const sample = toPrometheusSample(value);
  if (!sample) throw createPrometheusSchemaError("each vector data.result item must include a valid value sample");
  return { metric, value: sample };
}

function createPrometheusMatrixSeries(metric: Record<string, string>, values: unknown): PrometheusMetricSeries {
  const samples = toPrometheusSamples(values);
  if (samples.length === 0) throw createPrometheusSchemaError("each matrix data.result item must include valid values samples");
  return { metric, values: samples };
}

function toPrometheusSamples(values: unknown): PrometheusSample[] {
  if (!Array.isArray(values)) throw createPrometheusSchemaError("matrix data.result item values must be an array");
  return values.map(toPrometheusSampleStrict);
}

function toPrometheusSampleStrict(value: unknown): PrometheusSample {
  const sample = toPrometheusSample(value);
  if (!sample) throw createPrometheusSchemaError("Prometheus samples must be [timestamp, value] pairs");
  return sample;
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
  return trimmed || undefined;
}

function readStringOrNumber(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
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
  if (!value.includes(".")) return value;

  let end = value.length;
  while (end > 0 && value[end - 1] === "0") end -= 1;

  const withoutTrailingZeros = value.slice(0, end);
  return withoutTrailingZeros.endsWith(".") ? withoutTrailingZeros.slice(0, -1) : withoutTrailingZeros;
}
