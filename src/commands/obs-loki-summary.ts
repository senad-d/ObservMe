import type { LogResult, TimeRange } from "../query/loki.ts";

export interface ObsLokiLogSummaryRow {
  readonly timestamp: string;
  readonly eventName: string;
  readonly category?: string;
  readonly severity?: string;
  readonly errorType?: string;
  readonly sessionId?: string;
  readonly traceId?: string;
}

export interface ObsLokiLogSummaryRenderOptions {
  readonly title: string;
  readonly window: string;
  readonly maxLogs: number;
  readonly rows: readonly ObsLokiLogSummaryRow[];
  readonly emptyMessage: string;
}

export interface ObsLokiTimeRangeOptions {
  readonly now?: () => Date;
  readonly queryRangeHours?: number;
}

const defaultRangeHours = 1;
const minimumMaxLogs = 1;
const millisecondsPerHour = 60 * 60 * 1000;
const nanosecondsPerMillisecond = 1_000_000n;
const maximumDisplayValueLength = 96;
const safeEventBodyPattern = /^[A-Za-z0-9_.:-]{1,96}$/u;
const unknownTimestamp = "unknown-time";
const unknownEventName = "structured-log";
const eventNameAliases = ["event_name", "event.name"] as const;
const eventCategoryAliases = ["event_category", "event.category"] as const;
const severityAliases = ["severity", "severity_text", "level"] as const;
const errorTypeAliases = ["error_type", "error.type", "error_class"] as const;
const sessionIdAliases = ["pi_session_id", "pi.session.id"] as const;
const traceIdAliases = ["trace_id", "trace.id"] as const;

export function createRecentObsLokiTimeRange(options: ObsLokiTimeRangeOptions = {}): TimeRange {
  const to = normalizeDate(options.now?.() ?? new Date());
  const rangeHours = normalizeRangeHours(options.queryRangeHours);
  return { from: new Date(to.getTime() - rangeHours * millisecondsPerHour), to };
}

export function formatObsLokiWindow(options: ObsLokiTimeRangeOptions = {}): string {
  return `${trimTrailingFractionZeros(String(normalizeRangeHours(options.queryRangeHours)))}h`;
}

export function normalizeObsLokiMaxLogs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < minimumMaxLogs) return minimumMaxLogs;
  return Math.trunc(value);
}

export function toObsLokiLogSummaryRow(log: LogResult): ObsLokiLogSummaryRow {
  return {
    timestamp: formatLogTimestamp(log.timestampUnixNano),
    eventName: resolveLogEventName(log),
    category: readFirstLogField(log, eventCategoryAliases),
    severity: readFirstLogField(log, severityAliases),
    errorType: readFirstLogField(log, errorTypeAliases),
    sessionId: readFirstLogField(log, sessionIdAliases),
    traceId: readFirstLogField(log, traceIdAliases),
  };
}

export function renderObsLokiLogSummary(options: ObsLokiLogSummaryRenderOptions): string {
  const maxLogs = normalizeObsLokiMaxLogs(options.maxLogs);
  const rows = options.rows.map(normalizeObsLokiLogSummaryRow).filter(isObsLokiLogSummaryRow).slice(0, maxLogs);
  const lines = [`${options.title} (last ${options.window}, max ${maxLogs})`];

  if (rows.length === 0) {
    lines.push(options.emptyMessage);
    return lines.join("\n");
  }

  lines.push(...rows.map(renderObsLokiLogSummaryRow));
  return lines.join("\n");
}

function normalizeDate(value: Date): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  return new Date();
}

function normalizeRangeHours(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return defaultRangeHours;
  return value;
}

function formatLogTimestamp(timestampUnixNano: string): string {
  const timestamp = timestampUnixNano.trim();
  if (!timestamp) return unknownTimestamp;

  try {
    const milliseconds = BigInt(timestamp) / nanosecondsPerMillisecond;
    if (milliseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return timestamp;
    return new Date(Number(milliseconds)).toISOString();
  } catch (_error) {
    return timestamp;
  }
}

function resolveLogEventName(log: LogResult): string {
  return readFirstLogField(log, eventNameAliases) ?? readSafeLogLineEventName(log.line) ?? unknownEventName;
}

function readSafeLogLineEventName(line: string): string | undefined {
  const value = normalizeDisplayValue(line);
  if (!value || !safeEventBodyPattern.test(value)) return undefined;
  return value;
}

function readFirstLogField(log: LogResult, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const metadataValue = normalizeDisplayValue(log.metadata?.[alias]);
    if (metadataValue) return metadataValue;

    const labelValue = normalizeDisplayValue(log.labels[alias]);
    if (labelValue) return labelValue;
  }

  return undefined;
}

function normalizeObsLokiLogSummaryRow(row: ObsLokiLogSummaryRow): ObsLokiLogSummaryRow | undefined {
  const timestamp = normalizeDisplayValue(row.timestamp) ?? unknownTimestamp;
  const eventName = normalizeDisplayValue(row.eventName) ?? unknownEventName;

  return {
    timestamp,
    eventName,
    category: normalizeDisplayValue(row.category),
    severity: normalizeDisplayValue(row.severity),
    errorType: normalizeDisplayValue(row.errorType),
    sessionId: normalizeDisplayValue(row.sessionId),
    traceId: normalizeDisplayValue(row.traceId),
  };
}

function normalizeDisplayValue(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maximumDisplayValueLength) return normalized;
  return `${normalized.slice(0, maximumDisplayValueLength - 1)}…`;
}

function renderObsLokiLogSummaryRow(row: ObsLokiLogSummaryRow): string {
  return [
    row.timestamp,
    row.eventName,
    renderOptionalField("category", row.category),
    renderOptionalField("severity", row.severity),
    renderOptionalField("error", row.errorType),
    renderOptionalField("session", row.sessionId),
    renderOptionalField("trace", row.traceId),
  ]
    .filter(isString)
    .join(" ");
}

function renderOptionalField(label: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `${label}=${value}`;
}

function isObsLokiLogSummaryRow(row: ObsLokiLogSummaryRow | undefined): row is ObsLokiLogSummaryRow {
  return row !== undefined;
}

function isString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function trimTrailingFractionZeros(value: string): string {
  return value.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}
