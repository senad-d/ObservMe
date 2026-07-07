import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import { loadSessionConfig } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import type { PrometheusFetch, PrometheusMetricSeries, QueryResult } from "../query/prometheus.ts";
import { createPrometheusQueryClient } from "../query/prometheus.ts";
import { completeObsSubcommand, isExactObsSubcommandRequest } from "./obs-args.ts";
import { appendObsRecoveryHint, formatObsCommandFailure } from "./obs-diagnostics.ts";

export interface ObsToolsCommandContext {
  readonly cwd?: string;
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export interface ObsToolCallRow {
  readonly toolName: string;
  readonly ratePerSecond: number;
  readonly timestampUnixSeconds?: string;
}

export interface ObsToolFailureRow {
  readonly toolName: string;
  readonly errorClass: string;
  readonly ratePerSecond: number;
  readonly timestampUnixSeconds?: string;
}

export interface ObsToolsSnapshot {
  readonly window: "1h";
  readonly callQuery: string;
  readonly failureQuery: string;
  readonly calls: readonly ObsToolCallRow[];
  readonly failures: readonly ObsToolFailureRow[];
}

export type ObsToolsConfigLoader = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type ObsToolsProvider = (ctx: ObsToolsCommandContext) => Promise<ObsToolsSnapshot> | ObsToolsSnapshot;

export interface ObsToolsSnapshotOptions {
  readonly loadConfig?: ObsToolsConfigLoader;
  readonly fetch?: PrometheusFetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
}

export interface RegisterObsToolsCommandOptions extends ObsToolsSnapshotOptions {
  readonly getTools?: ObsToolsProvider;
}

export const OBS_TOOLS_CALLS_PROMQL = "topk(10, sum(rate(observme_tool_calls_total[1h])) by (tool_name))";
export const OBS_TOOLS_FAILURES_PROMQL = "sum(rate(observme_tool_failures_total[1h])) by (tool_name, error_class)";

const OBS_COMMAND_NAME = "obs";
const OBS_TOOLS_SUBCOMMAND = "tools";
const OBS_TOOLS_WINDOW = "1h";
const OBS_TOOLS_USAGE = "Usage: /obs tools";
const OBS_TOOLS_ERROR_NEXT_ACTION = "run /obs health and verify query.grafana.url, Grafana credentials, and the Metrics datasource UID.";
const OBS_TOOLS_NO_CALLS_NEXT_ACTION = "run tool activity, then verify the Metrics datasource with /obs health.";
const OBS_TOOLS_NO_FAILURES_NEXT_ACTION = "check after a failing tool call, then verify Metrics labels with /obs health.";

type ObsToolsRequestStatus = "tools" | "usage";

interface ObsToolsQueryResults {
  readonly calls: QueryResult;
  readonly failures: QueryResult;
}

export function registerObsToolsCommand(pi: ExtensionAPI, options: RegisterObsToolsCommandOptions = {}): void {
  const command = new ObsToolsCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Show aggregate ObservMe tool call and failure rates. Usage: /obs tools",
    getArgumentCompletions: getObsToolsCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsToolsCommand(
  args: string,
  ctx: ObsToolsCommandContext,
  options: RegisterObsToolsCommandOptions = {},
): Promise<void> {
  if (parseObsToolsRequest(args) === "usage") {
    await notifyTools(ctx, OBS_TOOLS_USAGE, "warning");
    return;
  }

  try {
    const snapshot = await resolveObsToolsSnapshot(ctx, options);
    await notifyTools(ctx, renderObsTools(snapshot), "info");
  } catch (error) {
    await notifyTools(
      ctx,
      formatObsCommandFailure("ObservMe tools unavailable", error, {
        subsystem: "Prometheus",
        nextAction: OBS_TOOLS_ERROR_NEXT_ACTION,
      }),
      "error",
    );
  }
}

export function getObsToolsCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  return completeObsSubcommand(prefix, OBS_TOOLS_SUBCOMMAND);
}

export async function getObsToolsSnapshot(
  ctx: ObsToolsCommandContext,
  options: ObsToolsSnapshotOptions = {},
): Promise<ObsToolsSnapshot> {
  const config = await loadObsToolsConfig(ctx, options);
  const result = await queryObsTools(config, options);

  return {
    window: OBS_TOOLS_WINDOW,
    callQuery: OBS_TOOLS_CALLS_PROMQL,
    failureQuery: OBS_TOOLS_FAILURES_PROMQL,
    calls: result.calls.series.map(toObsToolCallRow).filter(isObsToolCallRow),
    failures: result.failures.series.map(toObsToolFailureRow).filter(isObsToolFailureRow),
  };
}

export function renderObsTools(snapshot: ObsToolsSnapshot): string {
  const calls = snapshot.calls.map(normalizeObsToolCallRow).filter(isObsToolCallRow);
  const failures = snapshot.failures.map(normalizeObsToolFailureRow).filter(isObsToolFailureRow);
  const lines = [`Tool calls by tool (last ${snapshot.window})`];

  if (calls.length === 0) {
    lines.push(appendObsRecoveryHint("No tool call metrics found.", OBS_TOOLS_NO_CALLS_NEXT_ACTION));
  } else {
    lines.push(...calls.map(renderObsToolCallRow));
  }

  lines.push(`Tool failures by tool/error (last ${snapshot.window})`);
  if (failures.length === 0) {
    lines.push(appendObsRecoveryHint("No tool failure metrics found.", OBS_TOOLS_NO_FAILURES_NEXT_ACTION));
  } else {
    lines.push(...failures.map(renderObsToolFailureRow));
  }

  return lines.join("\n");
}

class ObsToolsCommand {
  readonly #options: RegisterObsToolsCommandOptions;

  constructor(options: RegisterObsToolsCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsToolsCommandContext): Promise<void> {
    await handleObsToolsCommand(args, ctx, this.#options);
  }
}

async function resolveObsToolsSnapshot(
  ctx: ObsToolsCommandContext,
  options: RegisterObsToolsCommandOptions,
): Promise<ObsToolsSnapshot> {
  if (options.getTools) return options.getTools(ctx);
  return getObsToolsSnapshot(ctx, options);
}

async function loadObsToolsConfig(ctx: ObsToolsCommandContext, options: ObsToolsSnapshotOptions): Promise<ObservMeConfig> {
  const loadConfig = options.loadConfig ?? loadSessionConfig;
  return loadConfig({ ctx, cwd: ctx.cwd, configDirName: options.configDirName, env: options.env });
}

async function queryObsTools(config: ObservMeConfig, options: ObsToolsSnapshotOptions): Promise<ObsToolsQueryResults> {
  const client = createPrometheusQueryClient(config, { fetch: options.fetch });
  const calls = await client.queryPrometheus(OBS_TOOLS_CALLS_PROMQL, undefined, { resultLimit: "metricSeries" });
  const failures = await client.queryPrometheus(OBS_TOOLS_FAILURES_PROMQL, undefined, { resultLimit: "metricSeries" });

  return { calls, failures };
}

function toObsToolCallRow(series: PrometheusMetricSeries): ObsToolCallRow | undefined {
  const ratePerSecond = parseRatePerSecond(series.value?.value);
  if (ratePerSecond === undefined) return undefined;

  return {
    toolName: normalizeMetricLabel(series.metric.tool_name),
    ratePerSecond,
    timestampUnixSeconds: series.value?.timestampUnixSeconds,
  };
}

function toObsToolFailureRow(series: PrometheusMetricSeries): ObsToolFailureRow | undefined {
  const ratePerSecond = parseRatePerSecond(series.value?.value);
  if (ratePerSecond === undefined) return undefined;

  return {
    toolName: normalizeMetricLabel(series.metric.tool_name),
    errorClass: normalizeMetricLabel(series.metric.error_class),
    ratePerSecond,
    timestampUnixSeconds: series.value?.timestampUnixSeconds,
  };
}

function normalizeObsToolCallRow(row: ObsToolCallRow): ObsToolCallRow | undefined {
  const ratePerSecond = parseRatePerSecond(row.ratePerSecond);
  if (ratePerSecond === undefined) return undefined;

  return {
    toolName: normalizeMetricLabel(row.toolName),
    ratePerSecond,
    timestampUnixSeconds: normalizeOptionalString(row.timestampUnixSeconds),
  };
}

function normalizeObsToolFailureRow(row: ObsToolFailureRow): ObsToolFailureRow | undefined {
  const ratePerSecond = parseRatePerSecond(row.ratePerSecond);
  if (ratePerSecond === undefined) return undefined;

  return {
    toolName: normalizeMetricLabel(row.toolName),
    errorClass: normalizeMetricLabel(row.errorClass),
    ratePerSecond,
    timestampUnixSeconds: normalizeOptionalString(row.timestampUnixSeconds),
  };
}

function parseRatePerSecond(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;

  const ratePerSecond = Number(value);
  if (!Number.isFinite(ratePerSecond) || ratePerSecond < 0) return undefined;
  return ratePerSecond;
}

function normalizeMetricLabel(value: string | undefined): string {
  return normalizeOptionalString(value) ?? "unknown";
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function renderObsToolCallRow(row: ObsToolCallRow): string {
  return `${row.toolName}: ${formatRatePerSecond(row.ratePerSecond)}`;
}

function renderObsToolFailureRow(row: ObsToolFailureRow): string {
  return `${row.toolName} / ${row.errorClass}: ${formatRatePerSecond(row.ratePerSecond)}`;
}

function isObsToolCallRow(row: ObsToolCallRow | undefined): row is ObsToolCallRow {
  return row !== undefined;
}

function isObsToolFailureRow(row: ObsToolFailureRow | undefined): row is ObsToolFailureRow {
  return row !== undefined;
}

function parseObsToolsRequest(args: string): ObsToolsRequestStatus {
  return isExactObsSubcommandRequest(args, OBS_TOOLS_SUBCOMMAND) ? "tools" : "usage";
}

async function notifyTools(
  ctx: ObsToolsCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): Promise<void> {
  await ctx.ui.notify(message, type);
}

function formatRatePerSecond(value: number): string {
  return `${trimTrailingFractionZeros(value.toFixed(4))}/s`;
}

function trimTrailingFractionZeros(value: string): string {
  return value.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}
