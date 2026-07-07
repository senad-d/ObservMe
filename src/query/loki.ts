import type { ObservMeConfig } from "../config/schema.ts";

export type LokiFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

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

const minimumTimeoutMs = 1;
const minimumMaxLogs = 1;
const maxLogQlQueryLength = 4096;
const unresolvedEnvironmentPlaceholderPattern = /\$\{[A-Z0-9_]+\}/u;
const safeLokiAttributeNamePattern = /^[A-Za-z_][A-Za-z0-9_.]*$/u;
const lokiIdentifierStartPattern = /^[A-Za-z_]$/u;
const lokiIdentifierPartPattern = /^[A-Za-z0-9_.]$/u;
const sensitiveQueryValuePatterns = [
  /(?:^|[\s"'`|=])(?:prompt|system prompt|user prompt|assistant response|thinking|raw content)\s*:/iu,
  /(?:^|[\s"'`])(?:sudo|rm|mv|cp|curl|wget|npm|pnpm|yarn|node|python3?|bash|sh|git)\s+\S+/iu,
  /(?:^|[\s"'`=])(?:~|\.{1,2}\/|\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\|\\\\)\S*/u,
  /\b[A-Z][A-Z0-9_]{2,}=[^\s"'`]+/u,
  unresolvedEnvironmentPlaceholderPattern,
] as const;

export class LokiQueryClient {
  readonly #config: ObservMeConfig;
  readonly #fetcher: LokiFetch;

  constructor(config: ObservMeConfig, options: LokiQueryClientOptions = {}) {
    this.#config = config;
    this.#fetcher = resolveLokiFetch(options.fetch);
  }

  async queryLoki(query: string, range: TimeRange): Promise<LogResult[]> {
    return queryLoki(this.#config, query, range, { fetch: this.#fetcher });
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
  if (isLokiQueryUnavailable(config)) return [];

  const normalizedQuery = normalizeLokiQuery(query);
  const timeRange = normalizeTimeRange(range);
  const maxLogs = resolveMaxLogs(config);
  const url = createLokiQueryRangeUrl(config, normalizedQuery, timeRange, maxLogs);
  const response = await fetchLokiQuery(url, config, resolveLokiFetch(options.fetch));

  return readLokiLogResults(response, maxLogs);
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
      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }

      if (char === "\\") escaped = true;
      if (char === quote) quote = undefined;
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

function normalizeLokiQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Loki query requires a non-empty LogQL query.");
  if (trimmed.length > maxLogQlQueryLength) throw new Error("Loki query is bounded to 4096 characters.");

  assertNoSensitiveRawQueryInput(trimmed);
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

function assertNoSensitiveRawQueryInput(query: string): void {
  if (!isSensitiveRawQueryInput(query)) return;

  throw new Error("Unsafe Loki query: raw prompts, commands, paths, and inherited environment values are not query inputs.");
}

function isSensitiveRawQueryInput(query: string): boolean {
  return sensitiveQueryValuePatterns.some(pattern => pattern.test(query));
}

function normalizeTimeRange(range: TimeRange): NormalizedTimeRange {
  const from = normalizeDate(range.from, "from");
  const to = normalizeDate(range.to, "to");

  if (from.getTime() > to.getTime()) throw new Error("Loki query range must have from <= to.");
  return { from, to };
}

function normalizeDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Loki query range ${label} must be a valid Date.`);
  }

  return value;
}

function createLokiQueryRangeUrl(
  config: ObservMeConfig,
  query: string,
  range: NormalizedTimeRange,
  maxLogs: number,
): string {
  const url = buildGrafanaApiUrl(
    config.query.grafana.url,
    `/api/datasources/proxy/uid/${encodeURIComponent(config.query.grafana.datasourceUids.loki)}/loki/api/v1/query_range`,
  );

  url.searchParams.set("query", query);
  url.searchParams.set("start", formatEpochNanoseconds(range.from));
  url.searchParams.set("end", formatEpochNanoseconds(range.to));
  url.searchParams.set("limit", String(maxLogs));
  url.searchParams.set("direction", "backward");
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

function formatEpochNanoseconds(date: Date): string {
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

async function fetchLokiQuery(url: string, config: ObservMeConfig, fetcher: LokiFetch): Promise<Response> {
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
    throw normalizeLokiFetchError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLokiFetchError(error: unknown): Error {
  if (isAbortError(error)) return new Error("Loki query timed out.");
  return error instanceof Error ? error : new Error(String(error));
}

async function readLokiLogResults(response: Response, maxLogs: number): Promise<LogResult[]> {
  if (!response.ok) throw new Error(`Loki query failed: ${formatHttpStatus(response)}`);

  const payload = (await response.json()) as unknown;
  const logs = extractLokiLogResults(payload);
  return logs.slice(0, maxLogs);
}

function extractLokiLogResults(payload: unknown): LogResult[] {
  return extractLokiStreams(payload).flatMap(toLogResultsFromStream);
}

function extractLokiStreams(payload: unknown): unknown[] {
  if (!isRecord(payload)) return [];
  if (!isRecord(payload.data)) return [];
  return Array.isArray(payload.data.result) ? payload.data.result : [];
}

function toLogResultsFromStream(stream: unknown): LogResult[] {
  if (!isRecord(stream)) return [];

  const labels = readStringRecord(stream.stream);
  const values = Array.isArray(stream.values) ? stream.values : [];
  return values.map(value => toLogResult(value, labels)).filter(isLogResult);
}

function toLogResult(value: unknown, labels: Record<string, string>): LogResult | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;

  const timestampUnixNano = readNonEmptyStringOrNumber(value[0]);
  const line = readStringOrNumber(value[1]);
  if (!timestampUnixNano || line === undefined) return undefined;

  const metadata = readStringRecord(value[2]);
  const result = { timestampUnixNano, line, labels: { ...labels } };
  return Object.keys(metadata).length > 0 ? { ...result, metadata } : result;
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
  return text ? text : undefined;
}

function readStringOrNumber(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isLogResult(value: LogResult | undefined): value is LogResult {
  return value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createGrafanaHeaders(config: ObservMeConfig): Record<string, string> {
  const token = normalizeConfiguredToken(config.query.grafana.token);
  const headers: Record<string, string> = { Accept: "application/json" };

  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function normalizeConfiguredToken(token: string): string | undefined {
  const trimmed = token.trim();
  if (!trimmed || unresolvedEnvironmentPlaceholderPattern.test(trimmed)) return undefined;
  return trimmed;
}

function isLokiQueryUnavailable(config: ObservMeConfig): boolean {
  return !config.query.enabled || !config.query.grafana.url.trim() || !config.query.grafana.datasourceUids.loki.trim();
}

function resolveLokiFetch(fetcher: LokiFetch | undefined): LokiFetch {
  return fetcher ?? defaultLokiFetch;
}

async function defaultLokiFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function resolveQueryTimeoutMs(config: ObservMeConfig): number {
  const timeoutMs = config.query.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < minimumTimeoutMs) return minimumTimeoutMs;
  return Math.trunc(timeoutMs);
}

function resolveMaxLogs(config: ObservMeConfig): number {
  const maxLogs = config.query.maxLogs;
  if (!Number.isFinite(maxLogs) || maxLogs < minimumMaxLogs) return minimumMaxLogs;
  return Math.trunc(maxLogs);
}

function formatHttpStatus(response: Response): string {
  const statusText = response.statusText.trim();
  return statusText ? `HTTP ${response.status} ${statusText}` : `HTTP ${response.status}`;
}

function isAbortError(error: unknown): boolean {
  return isNamedError(error) && error.name === "AbortError";
}

function isNamedError(error: unknown): error is { name: string } {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string";
}
