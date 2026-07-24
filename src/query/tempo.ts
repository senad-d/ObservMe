import { normalizeQueryResultCount } from "../config/query-limits.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import type { GrafanaFetch, GrafanaTransportClient } from "./grafana-transport.ts";
import { createGrafanaTransport } from "./grafana-transport.ts";
import { assertNoSensitiveQueryInput } from "../safety/sensitive-input.ts";
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

const maxTempoSearchAttributes = 8;
const maxTempoSearchAttributeValueLength = 256;
const safeTempoAttributeKeyPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const safeTempoAttributeValuePattern = /^[A-Za-z0-9._:-]+$/u;
const hashedAttributeKeyPattern = /(?:\.hash|_hash)$/u;
const backslashCharacter = String.fromCodePoint(92);
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
  readonly #transport: GrafanaTransportClient;

  constructor(config: ObservMeConfig, options: TempoQueryClientOptions = {}) {
    this.#config = config;
    this.#transport = createGrafanaTransport(config, options);
  }

  async searchTempo(attrs: Record<string, string>, range: TimeRange): Promise<TraceSummary[]> {
    return searchTempoWithTransport(this.#config, this.#transport, attrs, range);
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
  return searchTempoWithTransport(config, createGrafanaTransport(config, options), attrs, range);
}

async function searchTempoWithTransport(
  config: ObservMeConfig,
  transport: GrafanaTransportClient,
  attrs: Record<string, string>,
  range: TimeRange,
): Promise<TraceSummary[]> {
  assertGrafanaQueryReady(config, "tempo");
  const searchAttrs = normalizeTempoSearchAttributes(attrs);
  const timeRange = normalizeTimeRange(range);
  const maxTraces = resolveMaxTraces(config);
  const url = createTempoSearchUrl(config, transport, searchAttrs, timeRange, maxTraces);
  const response = await transport.fetch(url, { timeoutMessage: "Tempo search timed out." });

  return readTempoTraceSummaries(response, transport, maxTraces);
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

  assertNoSensitiveQueryInput(value, `Tempo ${key}`);

  if (!safeTempoAttributeValuePattern.test(value)) {
    throw new Error(
      `Unsafe Tempo ${key}: only generated IDs and hash-like values are accepted; raw prompts, commands, paths, and environment values are rejected.`,
    );
  }
}

function isAllowedTempoSearchAttributeKey(key: string): boolean {
  return generatedCorrelationAttributeKeys.has(key) || hashedAttributeKeyPattern.test(key);
}

function normalizeTimeRange(range: TimeRange): NormalizedTimeRange {
  const from = normalizeDate(range.from, "from");
  const to = normalizeDate(range.to, "to");

  if (from.getTime() > to.getTime()) throw new Error("Tempo search range must have from <= to.");
  return { from, to };
}

function normalizeDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`Tempo search range ${label} must be a valid Date.`);
  }

  return value;
}

function createTempoSearchUrl(
  config: ObservMeConfig,
  transport: GrafanaTransportClient,
  attrs: readonly NormalizedTempoSearchAttribute[],
  range: NormalizedTimeRange,
  maxTraces: number,
): URL {
  const url = transport.datasourceProxyUrl(config.query.grafana.datasourceUids.tempo, "/api/search");

  url.searchParams.set("tags", buildTempoTagsQuery(attrs));
  url.searchParams.set("start", formatEpochSeconds(range.from, "floor"));
  url.searchParams.set("end", formatEpochSeconds(range.to, "ceil"));
  url.searchParams.set("limit", String(maxTraces));
  return url;
}

function buildTempoTagsQuery(attrs: readonly NormalizedTempoSearchAttribute[]): string {
  return attrs.map(formatTempoTagQueryPart).join(" ");
}

function formatTempoTagQueryPart(attr: NormalizedTempoSearchAttribute): string {
  return `${attr.key}="${escapeTempoTagValue(attr.value)}"`;
}

function escapeTempoTagValue(value: string): string {
  return value.replaceAll(backslashCharacter, String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function formatEpochSeconds(date: Date, direction: "floor" | "ceil"): string {
  const seconds = date.getTime() / 1000;
  const rounded = direction === "floor" ? Math.floor(seconds) : Math.ceil(seconds);
  return String(rounded);
}

async function readTempoTraceSummaries(
  response: Response,
  transport: GrafanaTransportClient,
  maxTraces: number,
): Promise<TraceSummary[]> {
  if (!response.ok) throw new Error(`Tempo search failed: ${transport.formatHttpFailure(response)}`);

  const payload = await transport.readJson(response, "tempo");
  const traces = extractTempoTraceItems(payload);
  return traces.map(toTraceSummary).slice(0, maxTraces);
}

function extractTempoTraceItems(payload: unknown): unknown[] {
  if (!isRecord(payload)) throw createTempoSchemaError("response must be a JSON object");
  if (payload.status === "error") throw new Error("Tempo search failed: backend returned an error response.");
  if (!Array.isArray(payload.traces)) throw createTempoSchemaError("response.traces must be an array");
  return payload.traces;
}

function toTraceSummary(item: unknown): TraceSummary {
  if (!isRecord(item)) throw createTempoSchemaError("each response.traces item must be an object");

  return {
    traceId: readTraceId(item),
    rootServiceName: readOptionalString(item, "rootServiceName"),
    rootTraceName: readOptionalString(item, "rootTraceName"),
    startTimeUnixNano: readOptionalStringOrNumber(item, "startTimeUnixNano"),
    durationMs: readOptionalFiniteNumber(item, "durationMs"),
    spanSet: item.spanSet,
  };
}

function createTempoSchemaError(reason: string): Error {
  return new Error(`Tempo search failed: backend schema error: ${reason}.`);
}

function readTraceId(item: Record<string, unknown>): string {
  const traceId = readOptionalString(item, "traceID") ?? readOptionalString(item, "traceId");
  if (!traceId) throw createTempoSchemaError("each response.traces item must include a non-empty traceID or traceId string");
  return traceId.toLowerCase();
}

function readOptionalString(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw createTempoSchemaError(`each response.traces item ${key} must be a non-empty string when present`);
  }

  return value.trim();
}

function readOptionalStringOrNumber(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw createTempoSchemaError(`each response.traces item ${key} must be a non-empty string or finite number when present`);
}

function readOptionalFiniteNumber(item: Record<string, unknown>, key: string): number | undefined {
  const value = item[key];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw createTempoSchemaError(`each response.traces item ${key} must be a finite number when present`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveMaxTraces(config: ObservMeConfig): number {
  return normalizeQueryResultCount(config.query.maxTraces);
}
