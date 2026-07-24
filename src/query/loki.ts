import { normalizeQueryResultCount } from "../config/query-limits.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import type { GrafanaFetch, GrafanaTransportClient } from "./grafana-transport.ts";
import { createGrafanaTransport } from "./grafana-transport.ts";
import { assertNoSensitiveQueryInput } from "../safety/sensitive-input.ts";
import { assertGrafanaQueryReady } from "./grafana-readiness.ts";

export type LokiFetch = GrafanaFetch;

export interface TimeRange {
  readonly from: Date;
  readonly to: Date;
}

export interface LogResult {
  readonly timestampUnixNano: string;
  readonly line: string;
  readonly labels: Record<string, string>;
  readonly metadata?: Record<string, string>;
}

export interface LokiQueryClientOptions {
  readonly fetch?: LokiFetch;
}

interface NormalizedTimeRange {
  readonly from: Date;
  readonly to: Date;
}

const maxLogQlQueryLength = 4096;
const safeLokiAttributeNamePattern = /^[A-Za-z_][A-Za-z0-9_.]*$/u;
const lokiIdentifierStartPattern = /^[A-Za-z_]$/u;
const lokiIdentifierPartPattern = /^[A-Za-z0-9_.]$/u;

export class LokiQueryClient {
  readonly #config: ObservMeConfig;
  readonly #transport: GrafanaTransportClient;

  constructor(config: ObservMeConfig, options: LokiQueryClientOptions = {}) {
    this.#config = config;
    this.#transport = createGrafanaTransport(config, options);
  }

  async queryLoki(query: string, range: TimeRange): Promise<LogResult[]> {
    return queryLokiWithTransport(this.#config, this.#transport, query, range);
  }
}

export function createLokiQueryClient(
  config: ObservMeConfig,
  options: LokiQueryClientOptions = {},
): LokiQueryClient {
  return new LokiQueryClient(config, options);
}

export async function queryLoki(
  config: ObservMeConfig,
  query: string,
  range: TimeRange,
  options: LokiQueryClientOptions = {},
): Promise<LogResult[]> {
  return queryLokiWithTransport(config, createGrafanaTransport(config, options), query, range);
}

async function queryLokiWithTransport(
  config: ObservMeConfig,
  transport: GrafanaTransportClient,
  query: string,
  range: TimeRange,
): Promise<LogResult[]> {
  assertGrafanaQueryReady(config, "loki");
  const normalizedQuery = normalizeLokiQuery(query);
  const timeRange = normalizeTimeRange(range);
  const maxLogs = resolveMaxLogs(config);
  const url = createLokiQueryRangeUrl(config, transport, normalizedQuery, timeRange, maxLogs);
  const response = await transport.fetch(url, { timeoutMessage: "Loki query timed out." });

  return readLokiLogResults(response, transport, maxLogs);
}

export function normalizeLokiAttributeName(attributeName: string): string {
  const normalizedName = attributeName.trim();
  if (!safeLokiAttributeNamePattern.test(normalizedName)) throw new Error(`Unsafe Loki attribute name: ${attributeName}`);
  return normalizedName.replaceAll(".", "_");
}

export function normalizeLokiQueryAttributes(query: string): string {
  let normalizedQuery = "";
  let index = 0;
  let quote: string | undefined;
  let escaped = false;

  while (index < query.length) {
    const char = query[index];

    if (quote) {
      normalizedQuery += char;
      quote = nextLokiQuote(quote, char, escaped);
      escaped = nextLokiEscapeState(char, escaped);
      index += 1;
      continue;
    }

    if (isLokiQuote(char)) {
      quote = char;
      normalizedQuery += char;
      index += 1;
      continue;
    }

    if (isLokiIdentifierStart(char)) {
      const token = readLokiIdentifier(query, index);
      normalizedQuery += normalizeLokiQueryToken(token);
      index += token.length;
      continue;
    }

    normalizedQuery += char;
    index += 1;
  }

  return normalizedQuery;
}

function nextLokiQuote(quote: string, char: string, escaped: boolean): string | undefined {
  if (escaped || char !== quote) return quote;
  return undefined;
}

function nextLokiEscapeState(char: string, escaped: boolean): boolean {
  if (escaped) return false;
  return char === "\\";
}

function normalizeLokiQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Loki query requires a non-empty LogQL query.");
  if (trimmed.length > maxLogQlQueryLength) throw new Error("Loki query is bounded to 4096 characters.");

  assertNoSensitiveQueryInput(trimmed, "Loki query");
  return normalizeLokiQueryAttributes(trimmed);
}

function normalizeLokiQueryToken(token: string): string {
  return token.includes(".") ? normalizeLokiAttributeName(token) : token;
}

function readLokiIdentifier(query: string, start: number): string {
  let end = start + 1;

  while (end < query.length && isLokiIdentifierPart(query[end])) end += 1;
  return query.slice(start, end);
}

function isLokiQuote(char: string): boolean {
  return char === '"' || char === "'" || char === "`";
}

function isLokiIdentifierStart(char: string): boolean {
  return lokiIdentifierStartPattern.test(char);
}

function isLokiIdentifierPart(char: string): boolean {
  return lokiIdentifierPartPattern.test(char);
}

function normalizeTimeRange(range: TimeRange): NormalizedTimeRange {
  const from = normalizeDate(range.from, "from");
  const to = normalizeDate(range.to, "to");

  if (from.getTime() > to.getTime()) throw new Error("Loki query range must have from <= to.");
  return { from, to };
}

function normalizeDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`Loki query range ${label} must be a valid Date.`);
  }

  return value;
}

function createLokiQueryRangeUrl(
  config: ObservMeConfig,
  transport: GrafanaTransportClient,
  query: string,
  range: NormalizedTimeRange,
  maxLogs: number,
): URL {
  const url = transport.datasourceProxyUrl(config.query.grafana.datasourceUids.loki, "/loki/api/v1/query_range");

  url.searchParams.set("query", query);
  url.searchParams.set("start", formatEpochNanoseconds(range.from));
  url.searchParams.set("end", formatEpochNanoseconds(range.to));
  url.searchParams.set("limit", String(maxLogs));
  url.searchParams.set("direction", "backward");
  return url;
}

function formatEpochNanoseconds(date: Date): string {
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

async function readLokiLogResults(
  response: Response,
  transport: GrafanaTransportClient,
  maxLogs: number,
): Promise<LogResult[]> {
  if (!response.ok) throw new Error(`Loki query failed: ${transport.formatHttpFailure(response)}`);

  const payload = await transport.readJson(response, "loki");
  if (isLokiApiError(payload)) throw new Error("Loki query failed: backend returned an error response.");

  const logs = extractLokiLogResults(payload);
  return logs.slice(0, maxLogs);
}

function isLokiApiError(payload: unknown): boolean {
  return isRecord(payload) && payload.status === "error";
}

function createLokiSchemaError(reason: string): Error {
  return new Error(`Loki query failed: backend schema error: ${reason}.`);
}

function extractLokiLogResults(payload: unknown): LogResult[] {
  const data = readLokiSuccessData(payload);
  return extractLokiStreams(data.result).flatMap(toLogResultsFromStream);
}

function readLokiSuccessData(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw createLokiSchemaError("response must be a JSON object");
  if (payload.status !== "success") throw createLokiSchemaError("status must be success");
  if (!isRecord(payload.data)) throw createLokiSchemaError("data must be an object");
  if (payload.data.resultType !== "streams") throw createLokiSchemaError("data.resultType must be streams");
  return payload.data;
}

function extractLokiStreams(result: unknown): unknown[] {
  if (!Array.isArray(result)) throw createLokiSchemaError("data.result must be an array of streams");
  return result;
}

function toLogResultsFromStream(stream: unknown): LogResult[] {
  if (!isRecord(stream)) throw createLokiSchemaError("each data.result stream must be an object");

  const labels = readLokiStreamLabels(stream.stream);
  const values = readLokiStreamValues(stream.values);
  return values.map(value => toLogResult(value, labels));
}

function readLokiStreamLabels(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw createLokiSchemaError("each data.result stream labels must be an object");
  return readStringRecord(value);
}

function readLokiStreamValues(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw createLokiSchemaError("each data.result stream values must be an array");
  if (value.length === 0) throw createLokiSchemaError("each data.result stream values array must include at least one log entry");
  return value;
}

function toLogResult(value: unknown, labels: Record<string, string>): LogResult {
  if (!Array.isArray(value) || value.length < 2) throw createLokiSchemaError("Loki log values must be [timestamp, line] pairs");

  const timestampUnixNano = readNonEmptyStringOrNumber(value[0]);
  const line = readStringOrNumber(value[1]);
  if (!timestampUnixNano || line === undefined) throw createLokiSchemaError("Loki log values must include timestamp and line strings");

  const metadata = readLokiMetadata(value[2]);
  const result = { timestampUnixNano, line, labels: { ...labels } };
  return Object.keys(metadata).length > 0 ? { ...result, metadata } : result;
}

function readLokiMetadata(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw createLokiSchemaError("Loki log metadata must be an object when present");
  return readStringRecord(value);
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

function readNonEmptyStringOrNumber(value: unknown): string | undefined {
  const text = readStringOrNumber(value)?.trim();
  return text || undefined;
}

function readStringOrNumber(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveMaxLogs(config: ObservMeConfig): number {
  return normalizeQueryResultCount(config.query.maxLogs);
}
