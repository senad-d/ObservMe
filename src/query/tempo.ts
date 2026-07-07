import type { ObservMeConfig } from "../config/schema.ts";
import type { GrafanaFetch } from "./grafana-transport.ts";
import {
  createGrafanaHeaders,
  formatGrafanaFetchFailure,
  formatGrafanaHttpFailure,
  resolveGrafanaFetch,
} from "./grafana-transport.ts";
import { assertGrafanaQueryReady } from "./grafana-readiness.ts";
import {
  AGENT_RUN_ATTRIBUTES,
  AGENT_SPAWN_ATTRIBUTES,
  AGENT_WAIT_JOIN_ATTRIBUTES,
  BRANCH_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  LOG_ATTRIBUTES,
  RESOURCE_ATTRIBUTES,
  TOOL_ATTRIBUTES,
  TURN_ATTRIBUTES,
} from "../semconv/attributes.ts";

export type TempoFetch = GrafanaFetch;

export interface TimeRange {
  readonly from: Date;
  readonly to: Date;
}

export interface TraceSummary {
  readonly traceId: string;
  readonly rootServiceName?: string;
  readonly rootTraceName?: string;
  readonly startTimeUnixNano?: string;
  readonly durationMs?: number;
  readonly spanSet?: unknown;
}

export interface TempoQueryClientOptions {
  readonly fetch?: TempoFetch;
}

interface NormalizedTempoSearchAttribute {
  readonly key: string;
  readonly value: string;
}

interface NormalizedTimeRange {
  readonly from: Date;
  readonly to: Date;
}

const minimumTimeoutMs = 1;
const minimumMaxTraces = 1;
const maxTempoSearchAttributes = 8;
const maxTempoSearchAttributeValueLength = 256;
const unresolvedEnvironmentPlaceholderPattern = /\$\{[A-Z0-9_]+\}/u;
const safeTempoAttributeKeyPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const safeTempoAttributeValuePattern = /^[A-Za-z0-9._:-]+$/u;
const hashedAttributeKeyPattern = /(?:\.hash|_hash)$/u;
const sensitiveQueryValuePatterns = [
  /(?:^|\b)(?:prompt|system prompt|user prompt|assistant response|thinking|raw content)(?:\b|:)/iu,
  /(?:^|\s)(?:sudo|rm|mv|cp|curl|wget|npm|pnpm|yarn|node|python3?|bash|sh|git)\s+\S+/iu,
  /(?:^|[\s=:])(?:~|\.{1,2}\/|\/|[A-Za-z]:\\|\\\\)\S*/u,
  /\b[A-Z][A-Z0-9_]{2,}=[^\s]+/u,
  unresolvedEnvironmentPlaceholderPattern,
] as const;
const generatedCorrelationAttributeKeys = new Set<string>([
  COMMON_SPAN_ATTRIBUTES.PI_SESSION_ID,
  COMMON_SPAN_ATTRIBUTES.PI_WORKFLOW_ID,
  COMMON_SPAN_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID,
  COMMON_SPAN_ATTRIBUTES.PI_AGENT_ID,
  COMMON_SPAN_ATTRIBUTES.PI_AGENT_PARENT_ID,
  COMMON_SPAN_ATTRIBUTES.PI_AGENT_ROOT_ID,
  COMMON_SPAN_ATTRIBUTES.PI_AGENT_RUN_ID,
  COMMON_SPAN_ATTRIBUTES.PI_ENTRY_ID,
  COMMON_SPAN_ATTRIBUTES.PI_ENTRY_PARENT_ID,
  RESOURCE_ATTRIBUTES.PI_WORKFLOW_ID,
  RESOURCE_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID,
  RESOURCE_ATTRIBUTES.PI_AGENT_ID,
  RESOURCE_ATTRIBUTES.PI_AGENT_PARENT_ID,
  RESOURCE_ATTRIBUTES.PI_AGENT_ROOT_ID,
  LOG_ATTRIBUTES.PI_SESSION_ID,
  LOG_ATTRIBUTES.PI_WORKFLOW_ID,
  LOG_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID,
  LOG_ATTRIBUTES.PI_AGENT_ID,
  LOG_ATTRIBUTES.PI_AGENT_PARENT_ID,
  LOG_ATTRIBUTES.PI_AGENT_ROOT_ID,
  LOG_ATTRIBUTES.PI_AGENT_RUN_ID,
  LOG_ATTRIBUTES.PI_TURN_ID,
  LOG_ATTRIBUTES.TRACE_ID,
  LOG_ATTRIBUTES.SPAN_ID,
  AGENT_RUN_ATTRIBUTES.PI_AGENT_ID,
  AGENT_RUN_ATTRIBUTES.PI_AGENT_PARENT_ID,
  AGENT_RUN_ATTRIBUTES.PI_AGENT_ROOT_ID,
  AGENT_RUN_ATTRIBUTES.PI_AGENT_RUN_ID,
  AGENT_SPAWN_ATTRIBUTES.PI_AGENT_SPAWN_ID,
  AGENT_SPAWN_ATTRIBUTES.PI_AGENT_CHILD_ID,
  AGENT_SPAWN_ATTRIBUTES.PI_AGENT_PARENT_ID,
  AGENT_SPAWN_ATTRIBUTES.PI_AGENT_ROOT_ID,
  AGENT_SPAWN_ATTRIBUTES.PI_WORKFLOW_ID,
  AGENT_SPAWN_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID,
  AGENT_SPAWN_ATTRIBUTES.PI_SESSION_ID,
  AGENT_WAIT_JOIN_ATTRIBUTES.PI_WORKFLOW_ID,
  AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_ID,
  AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_CHILD_ID,
  AGENT_WAIT_JOIN_ATTRIBUTES.PI_AGENT_SPAWN_ID,
  TURN_ATTRIBUTES.PI_TURN_ID,
  TOOL_ATTRIBUTES.PI_TOOL_CALL_ID,
  BRANCH_ATTRIBUTES.PI_BRANCH_FROM_ID,
  BRANCH_ATTRIBUTES.PI_BRANCH_TO_ID,
  BRANCH_ATTRIBUTES.PI_BRANCH_COMMON_ANCESTOR_ID,
  BRANCH_ATTRIBUTES.PI_LEAF_ID,
]);

export class TempoQueryClient {
  readonly #config: ObservMeConfig;
  readonly #fetcher: TempoFetch;

  constructor(config: ObservMeConfig, options: TempoQueryClientOptions = {}) {
    this.#config = config;
    this.#fetcher = resolveGrafanaFetch(config, options.fetch);
  }

  async searchTempo(attrs: Record<string, string>, range: TimeRange): Promise<TraceSummary[]> {
    return searchTempo(this.#config, attrs, range, { fetch: this.#fetcher });
  }
}

export function createTempoQueryClient(
  config: ObservMeConfig,
  options: TempoQueryClientOptions = {},
): TempoQueryClient {
  return new TempoQueryClient(config, options);
}

export async function searchTempo(
  config: ObservMeConfig,
  attrs: Record<string, string>,
  range: TimeRange,
  options: TempoQueryClientOptions = {},
): Promise<TraceSummary[]> {
  if (!config.query.enabled) return [];

  assertGrafanaQueryReady(config, "tempo");
  const searchAttrs = normalizeTempoSearchAttributes(attrs);
  const timeRange = normalizeTimeRange(range);
  const maxTraces = resolveMaxTraces(config);
  const url = createTempoSearchUrl(config, searchAttrs, timeRange, maxTraces);
  const response = await fetchTempoSearch(url, config, resolveGrafanaFetch(config, options.fetch));

  return readTempoTraceSummaries(response, config, maxTraces);
}

function normalizeTempoSearchAttributes(attrs: Record<string, string>): NormalizedTempoSearchAttribute[] {
  const entries = Object.entries(attrs);
  if (entries.length === 0) throw new Error("Tempo search requires at least one safe correlation attribute.");
  if (entries.length > maxTempoSearchAttributes) throw new Error("Tempo search is bounded to at most 8 attributes.");

  return entries.map(normalizeTempoSearchAttribute).sort(compareTempoSearchAttributes);
}

function normalizeTempoSearchAttribute([rawKey, rawValue]: [string, string]): NormalizedTempoSearchAttribute {
  const key = rawKey.trim();
  const value = normalizeTempoSearchAttributeValue(rawValue, key);

  assertSafeTempoAttributeKey(key);
  assertSafeTempoAttributeValue(value, key);
  return { key, value };
}

function normalizeTempoSearchAttributeValue(rawValue: string, key: string): string {
  if (typeof rawValue !== "string") throw new Error(`Unsafe Tempo ${key}: attribute values must be strings.`);

  const value = rawValue.trim();
  if (!value) throw new Error(`Unsafe Tempo ${key}: empty values are not query inputs.`);
  return value;
}

function compareTempoSearchAttributes(
  left: NormalizedTempoSearchAttribute,
  right: NormalizedTempoSearchAttribute,
): number {
  return left.key.localeCompare(right.key);
}

function assertSafeTempoAttributeKey(key: string): void {
  if (!safeTempoAttributeKeyPattern.test(key)) throw new Error(`Unsafe Tempo attribute key: ${key}`);
  if (isAllowedTempoSearchAttributeKey(key)) return;

  throw new Error(
    "Unsafe Tempo attribute key: searchTempo may only use generated workflow IDs, generated agent IDs, session IDs, trace/span IDs, or hashed fields.",
  );
}

function assertSafeTempoAttributeValue(value: string, key: string): void {
  if (value.length > maxTempoSearchAttributeValueLength) {
    throw new Error(`Unsafe Tempo ${key}: attribute values are bounded to 256 characters.`);
  }

  if (!safeTempoAttributeValuePattern.test(value)) {
    throw new Error(
      `Unsafe Tempo ${key}: only generated IDs and hash-like values are accepted; raw prompts, commands, paths, and environment values are rejected.`,
    );
  }

  assertNoSensitiveRawQueryInput(value, key);
}

function isAllowedTempoSearchAttributeKey(key: string): boolean {
  return generatedCorrelationAttributeKeys.has(key) || hashedAttributeKeyPattern.test(key);
}

function assertNoSensitiveRawQueryInput(value: string, label: string): void {
  if (!isSensitiveRawQueryInput(value)) return;

  throw new Error(
    `Unsafe Tempo ${label}: raw prompts, commands, paths, and inherited environment values are not query inputs.`,
  );
}

function isSensitiveRawQueryInput(value: string): boolean {
  return sensitiveQueryValuePatterns.some(pattern => pattern.test(value));
}

function normalizeTimeRange(range: TimeRange): NormalizedTimeRange {
  const from = normalizeDate(range.from, "from");
  const to = normalizeDate(range.to, "to");

  if (from.getTime() > to.getTime()) throw new Error("Tempo search range must have from <= to.");
  return { from, to };
}

function normalizeDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Tempo search range ${label} must be a valid Date.`);
  }

  return value;
}

function createTempoSearchUrl(
  config: ObservMeConfig,
  attrs: readonly NormalizedTempoSearchAttribute[],
  range: NormalizedTimeRange,
  maxTraces: number,
): string {
  const url = buildGrafanaApiUrl(
    config.query.grafana.url,
    `/api/datasources/proxy/uid/${encodeURIComponent(config.query.grafana.datasourceUids.tempo)}/api/search`,
  );

  url.searchParams.set("tags", buildTempoTagsQuery(attrs));
  url.searchParams.set("start", formatEpochSeconds(range.from, "floor"));
  url.searchParams.set("end", formatEpochSeconds(range.to, "ceil"));
  url.searchParams.set("limit", String(maxTraces));
  return url.toString();
}

function buildTempoTagsQuery(attrs: readonly NormalizedTempoSearchAttribute[]): string {
  return attrs.map(formatTempoTagQueryPart).join(" ");
}

function formatTempoTagQueryPart(attr: NormalizedTempoSearchAttribute): string {
  return `${attr.key}="${escapeTempoTagValue(attr.value)}"`;
}

function escapeTempoTagValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function formatEpochSeconds(date: Date, direction: "floor" | "ceil"): string {
  const seconds = date.getTime() / 1000;
  const rounded = direction === "floor" ? Math.floor(seconds) : Math.ceil(seconds);
  return String(rounded);
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

async function fetchTempoSearch(url: string, config: ObservMeConfig, fetcher: TempoFetch): Promise<Response> {
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
    throw normalizeTempoFetchError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTempoFetchError(error: unknown): Error {
  if (isAbortError(error)) return new Error("Tempo search timed out.");
  return new Error(formatGrafanaFetchFailure(error));
}

async function readTempoTraceSummaries(
  response: Response,
  config: ObservMeConfig,
  maxTraces: number,
): Promise<TraceSummary[]> {
  if (!response.ok) throw new Error(`Tempo search failed: ${formatGrafanaHttpFailure(response, config)}`);

  const payload = (await response.json()) as unknown;
  const traces = extractTempoTraceItems(payload);
  return traces.map(toTraceSummary).filter(isTraceSummary).slice(0, maxTraces);
}

function extractTempoTraceItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.traces)) return payload.traces;
  return [];
}

function toTraceSummary(item: unknown): TraceSummary | undefined {
  if (!isRecord(item)) return undefined;

  const traceId = readTraceId(item);
  if (!traceId) return undefined;

  return {
    traceId,
    rootServiceName: readOptionalString(item, "rootServiceName"),
    rootTraceName: readOptionalString(item, "rootTraceName"),
    startTimeUnixNano: readOptionalStringOrNumber(item, "startTimeUnixNano"),
    durationMs: readOptionalFiniteNumber(item, "durationMs"),
    spanSet: item.spanSet,
  };
}

function readTraceId(item: Record<string, unknown>): string | undefined {
  const traceId = readOptionalString(item, "traceID") ?? readOptionalString(item, "traceId");
  if (!traceId) return undefined;
  return traceId.trim().toLowerCase();
}

function readOptionalString(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalStringOrNumber(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function readOptionalFiniteNumber(item: Record<string, unknown>, key: string): number | undefined {
  const value = item[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTraceSummary(value: TraceSummary | undefined): value is TraceSummary {
  return value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveQueryTimeoutMs(config: ObservMeConfig): number {
  const timeoutMs = config.query.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < minimumTimeoutMs) return minimumTimeoutMs;
  return Math.trunc(timeoutMs);
}

function resolveMaxTraces(config: ObservMeConfig): number {
  const maxTraces = config.query.maxTraces;
  if (!Number.isFinite(maxTraces) || maxTraces < minimumMaxTraces) return minimumMaxTraces;
  return Math.trunc(maxTraces);
}

function isAbortError(error: unknown): boolean {
  return isNamedError(error) && error.name === "AbortError";
}

function isNamedError(error: unknown): error is { name: string } {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string";
}
