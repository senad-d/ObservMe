import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import { loadSessionConfig } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import type { PrometheusFetch, PrometheusMetricSeries, QueryResult } from "../query/prometheus.ts";
import { createPrometheusQueryClient } from "../query/prometheus.ts";

export interface ObsCostCommandContext {
  readonly cwd?: string;
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export interface ObsCostRow {
  readonly model: string;
  readonly provider: string;
  readonly costUsd: number;
  readonly timestampUnixSeconds?: string;
}

export interface ObsCostSnapshot {
  readonly window: "24h";
  readonly query: string;
  readonly rows: readonly ObsCostRow[];
}

export type ObsCostConfigLoader = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type ObsCostProvider = (ctx: ObsCostCommandContext) => Promise<ObsCostSnapshot> | ObsCostSnapshot;

export interface ObsCostSnapshotOptions {
  readonly loadConfig?: ObsCostConfigLoader;
  readonly fetch?: PrometheusFetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
}

export interface RegisterObsCostCommandOptions extends ObsCostSnapshotOptions {
  readonly getCost?: ObsCostProvider;
}

export const OBS_COST_AGGREGATE_PROMQL = "sum(increase(observme_llm_cost_usd_total[24h])) by (model, provider)";

const OBS_COMMAND_NAME = "obs";
const OBS_COST_SUBCOMMAND = "cost";
const OBS_COST_WINDOW = "24h";

type ObsCostRequestStatus = "cost" | "session-disabled" | "usage";

export function registerObsCostCommand(pi: ExtensionAPI, options: RegisterObsCostCommandOptions = {}): void {
  const command = new ObsCostCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Show aggregate ObservMe LLM cost. Usage: /obs cost",
    getArgumentCompletions: getObsCostCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsCostCommand(
  args: string,
  ctx: ObsCostCommandContext,
  options: RegisterObsCostCommandOptions = {},
): Promise<void> {
  const requestStatus = parseObsCostRequest(args);

  if (requestStatus === "usage") {
    await notifyCost(ctx, "Usage: /obs cost", "warning");
    return;
  }

  if (requestStatus === "session-disabled") {
    await notifyCost(ctx, "Session-scoped Prometheus cost queries are disabled by default. Usage: /obs cost", "warning");
    return;
  }

  try {
    const snapshot = await resolveObsCostSnapshot(ctx, options);
    await notifyCost(ctx, renderObsCost(snapshot), "info");
  } catch (error) {
    await notifyCost(ctx, `ObservMe cost unavailable: ${formatError(error)}`, "error");
  }
}

export function getObsCostCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (!OBS_COST_SUBCOMMAND.startsWith(normalizedPrefix)) return null;
  return [{ value: OBS_COST_SUBCOMMAND, label: OBS_COST_SUBCOMMAND }];
}

export async function getObsCostSnapshot(
  ctx: ObsCostCommandContext,
  options: ObsCostSnapshotOptions = {},
): Promise<ObsCostSnapshot> {
  const config = await loadObsCostConfig(ctx, options);
  const result = await queryObsCost(config, options);

  return {
    window: OBS_COST_WINDOW,
    query: OBS_COST_AGGREGATE_PROMQL,
    rows: result.series.map(toObsCostRow).filter(isObsCostRow),
  };
}

export function renderObsCost(snapshot: ObsCostSnapshot): string {
  const rows = snapshot.rows.map(normalizeObsCostRow).filter(isObsCostRow);
  const lines = [`Cost by model/provider (last ${snapshot.window})`];

  if (rows.length === 0) {
    lines.push("No cost metrics found.");
    return lines.join("\n");
  }

  lines.push(...rows.map(renderObsCostRow));
  lines.push(`Total: ${formatUsd(sumObsCostRows(rows))}`);
  return lines.join("\n");
}

class ObsCostCommand {
  readonly #options: RegisterObsCostCommandOptions;

  constructor(options: RegisterObsCostCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsCostCommandContext): Promise<void> {
    await handleObsCostCommand(args, ctx, this.#options);
  }
}

async function resolveObsCostSnapshot(
  ctx: ObsCostCommandContext,
  options: RegisterObsCostCommandOptions,
): Promise<ObsCostSnapshot> {
  if (options.getCost) return options.getCost(ctx);
  return getObsCostSnapshot(ctx, options);
}

async function loadObsCostConfig(ctx: ObsCostCommandContext, options: ObsCostSnapshotOptions): Promise<ObservMeConfig> {
  const loadConfig = options.loadConfig ?? loadSessionConfig;
  return loadConfig({ ctx, cwd: ctx.cwd, configDirName: options.configDirName, env: options.env });
}

async function queryObsCost(config: ObservMeConfig, options: ObsCostSnapshotOptions): Promise<QueryResult> {
  const client = createPrometheusQueryClient(config, { fetch: options.fetch });
  return client.queryPrometheus(OBS_COST_AGGREGATE_PROMQL, undefined, { resultLimit: "metricSeries" });
}

function toObsCostRow(series: PrometheusMetricSeries): ObsCostRow | undefined {
  const costUsd = parseCostUsd(series.value?.value);
  if (costUsd === undefined) return undefined;

  return {
    model: normalizeMetricLabel(series.metric.model),
    provider: normalizeMetricLabel(series.metric.provider),
    costUsd,
    timestampUnixSeconds: series.value?.timestampUnixSeconds,
  };
}

function normalizeObsCostRow(row: ObsCostRow): ObsCostRow | undefined {
  const costUsd = parseCostUsd(row.costUsd);
  if (costUsd === undefined) return undefined;

  return {
    model: normalizeMetricLabel(row.model),
    provider: normalizeMetricLabel(row.provider),
    costUsd,
    timestampUnixSeconds: normalizeOptionalString(row.timestampUnixSeconds),
  };
}

function parseCostUsd(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;

  const costUsd = Number(value);
  if (!Number.isFinite(costUsd) || costUsd < 0) return undefined;
  return costUsd;
}

function normalizeMetricLabel(value: string | undefined): string {
  return normalizeOptionalString(value) ?? "unknown";
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function renderObsCostRow(row: ObsCostRow): string {
  return `${row.model} / ${row.provider}: ${formatUsd(row.costUsd)}`;
}

function sumObsCostRows(rows: readonly ObsCostRow[]): number {
  return rows.reduce(sumObsCostRow, 0);
}

function sumObsCostRow(total: number, row: ObsCostRow): number {
  return total + row.costUsd;
}

function isObsCostRow(row: ObsCostRow | undefined): row is ObsCostRow {
  return row !== undefined;
}

function parseObsCostRequest(args: string): ObsCostRequestStatus {
  const tokens = args.trim().toLowerCase().split(/\s+/u).filter(isNonEmptyString);
  const [subcommand, ...rest] = tokens;

  if (subcommand !== OBS_COST_SUBCOMMAND) return "usage";
  if (rest.some(isSessionScopeCostToken)) return "session-disabled";
  return rest.length === 0 ? "cost" : "usage";
}

function isSessionScopeCostToken(token: string): boolean {
  return token === "--session" || token.startsWith("--session=") || token === "--current-session";
}

function isNonEmptyString(value: string): boolean {
  return value.length > 0;
}

async function notifyCost(ctx: ObsCostCommandContext, message: string, type: "info" | "warning" | "error"): Promise<void> {
  await ctx.ui.notify(message, type);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
