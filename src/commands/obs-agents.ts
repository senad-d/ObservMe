import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import type { AgentChildStatus, AgentTreeNode, AgentTreeSummary } from "../pi/agent-tree-tracker.ts";
import type { PrometheusFetch, PrometheusMetricSeries, QueryResult } from "../query/prometheus.ts";
import { createPrometheusQueryClient } from "../query/prometheus.ts";
import type { TimeRange, TraceSummary } from "../query/tempo.ts";
import { createTempoQueryClient } from "../query/tempo.ts";
import { COMMON_SPAN_ATTRIBUTES } from "../semconv/attributes.ts";
import { completeObsSubcommand, isExactObsSubcommandRequest } from "./obs-args.ts";
import { loadObsCommandConfig, notifyObsCommand } from "./obs-command-support.ts";
import { formatObsCommandFailure, readObsDiagnosticMessage, type ObsCommandRecoveryHint } from "./obs-diagnostics.ts";
import type { ObsAgentWaitJoinHint, ObsAgentsRuntimeSnapshot } from "./obs-agents-runtime.ts";
import { getLocalObsAgentsRuntimeSnapshot } from "./obs-agents-runtime.ts";

export interface ObsAgentsCommandContext {
  readonly cwd?: string;
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export interface ObsAgentChildRow {
  readonly agentId: string;
  readonly parentAgentId?: string;
  readonly depth: number;
  readonly role: string;
  readonly capability?: string;
  readonly status: AgentChildStatus;
  readonly orphaned: boolean;
  readonly activeChildren: number;
  readonly fanoutCount: number;
}

export interface ObsAgentAggregateRow {
  readonly labels: Record<string, string>;
  readonly value: number;
  readonly timestampUnixSeconds?: string;
}

export interface ObsAgentsAggregateRows {
  readonly spawned: readonly ObsAgentAggregateRow[];
  readonly fanoutP95: readonly ObsAgentAggregateRow[];
  readonly orphaned: readonly ObsAgentAggregateRow[];
}

export interface ObsAgentsSnapshot {
  readonly workflowId?: string;
  readonly workflowRootAgentId?: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly rootAgentId?: string;
  readonly role: string;
  readonly capability?: string;
  readonly depth: number;
  readonly orphaned: boolean;
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly activeChildren: number;
  readonly fanoutCount: number;
  readonly treeDepth: number;
  readonly treeWidth: number;
  readonly orphanCount: number;
  readonly children: readonly ObsAgentChildRow[];
  readonly waitJoinHints: readonly ObsAgentWaitJoinHint[];
  readonly aggregateQueries: readonly string[];
  readonly aggregateRows: ObsAgentsAggregateRows;
  readonly tempoSearchAttributes: Record<string, string>;
  readonly traces: readonly TraceSummary[];
  readonly recentChildrenLimit?: number;
}

export type ObsAgentsConfigLoader = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type ObsAgentsRuntimeProvider = (
  ctx: ObsAgentsCommandContext,
) => Promise<ObsAgentsRuntimeSnapshot> | ObsAgentsRuntimeSnapshot;
export type ObsAgentsProvider = (ctx: ObsAgentsCommandContext) => Promise<ObsAgentsSnapshot> | ObsAgentsSnapshot;

export interface ObsAgentsSnapshotOptions {
  readonly loadConfig?: ObsAgentsConfigLoader;
  readonly fetch?: PrometheusFetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
  readonly getRuntime?: ObsAgentsRuntimeProvider;
  readonly searchRangeHours?: number;
  readonly now?: () => Date;
}

export interface RegisterObsAgentsCommandOptions extends ObsAgentsSnapshotOptions {
  readonly getAgents?: ObsAgentsProvider;
}

export const OBS_AGENTS_SPAWNED_PROMQL =
  "sum(rate(observme_subagents_spawned_total[1h])) by (agent_role, subagent_depth, spawn_type, spawn_reason)";
export const OBS_AGENTS_FANOUT_P95_PROMQL =
  "histogram_quantile(0.95, sum(rate(observme_agent_fanout_count_bucket[1h])) by (subagent_depth, le))";
export const OBS_AGENTS_ORPHAN_PROMQL = "sum(rate(observme_orphan_agents_total[1h])) by (agent_role, subagent_depth)";
export const OBS_AGENTS_TEMPO_DRILLDOWN_ATTRIBUTE_KEYS = [
  COMMON_SPAN_ATTRIBUTES.PI_AGENT_ID,
  COMMON_SPAN_ATTRIBUTES.PI_WORKFLOW_ID,
] as const;

const OBS_COMMAND_NAME = "obs";
const OBS_AGENTS_SUBCOMMAND = "agents";
const OBS_AGENTS_USAGE = "Usage: /obs agents";
const OBS_AGENTS_WINDOW = "1h";
const OBS_AGENTS_ERROR_NEXT_ACTION = "run /obs health and verify Grafana credentials, the Metrics datasource, and the Tempo datasource.";
const OBS_AGENTS_PROMETHEUS_NEXT_ACTION = "verify the Metrics datasource with /obs health, then rerun /obs agents.";
const OBS_AGENTS_TEMPO_NEXT_ACTION = "verify the Tempo datasource with /obs health, then rerun /obs agents.";
const DEFAULT_TRACE_SEARCH_RANGE_HOURS = 24;
const DEFAULT_RECENT_CHILDREN_RENDER_LIMIT = 10;
const millisecondsPerHour = 60 * 60 * 1000;
const emptyAgentTreeSummary = {
  activeChildren: 0,
  fanoutCount: 0,
  treeDepth: 0,
  treeWidth: 0,
  orphanCount: 0,
  childStatuses: {
    starting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    orphaned: 0,
  },
} as const satisfies AgentTreeSummary;

interface ObsAgentsQueryResults {
  readonly spawned: QueryResult;
  readonly fanoutP95: QueryResult;
  readonly orphaned: QueryResult;
}

export function registerObsAgentsCommand(pi: ExtensionAPI, options: RegisterObsAgentsCommandOptions = {}): void {
  const command = new ObsAgentsCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Show ObservMe workflow and agent lineage. Usage: /obs agents",
    getArgumentCompletions: getObsAgentsCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsAgentsCommand(
  args: string,
  ctx: ObsAgentsCommandContext,
  options: RegisterObsAgentsCommandOptions = {},
): Promise<void> {
  if (!isObsAgentsRequest(args)) {
    await notifyObsCommand(ctx, OBS_AGENTS_USAGE, "warning");
    return;
  }

  try {
    const snapshot = await resolveObsAgentsSnapshot(ctx, options);
    await notifyObsCommand(ctx, renderObsAgents(snapshot), "info");
  } catch (error) {
    await notifyObsCommand(
      ctx,
      formatObsCommandFailure("ObservMe agents unavailable", error, resolveObsAgentsDiagnostic(error)),
      "error",
    );
  }
}

export function getObsAgentsCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  return completeObsSubcommand(prefix, OBS_AGENTS_SUBCOMMAND);
}

export async function getObsAgentsSnapshot(
  ctx: ObsAgentsCommandContext,
  options: ObsAgentsSnapshotOptions = {},
): Promise<ObsAgentsSnapshot> {
  const runtime = await resolveObsAgentsRuntime(ctx, options);
  const config = await loadObsAgentsConfig(ctx, options);
  const [aggregateResults, traces] = await Promise.all([
    queryObsAgentsAggregates(config, options),
    queryObsAgentsTempoTraces(config, runtime, options),
  ]);

  return buildObsAgentsSnapshot(runtime, aggregateResults, traces, config.query.maxAgents);
}

export function renderObsAgents(snapshot: ObsAgentsSnapshot): string {
  const latestChild = readLatestChild(snapshot.children);
  const lines = [
    `Workflow: ${formatUnknown(snapshot.workflowId)} root=${formatUnknown(snapshot.workflowRootAgentId ?? snapshot.rootAgentId)}`,
    `Agent: ${formatUnknown(snapshot.agentId)} (${snapshot.role} depth=${snapshot.depth})`,
    `Session: ${formatUnknown(normalizeOptionalString(snapshot.sessionId))}`,
    `Subagents spawned in current trace: ${snapshot.fanoutCount}`,
    `Current tree: depth=${snapshot.treeDepth} width=${snapshot.treeWidth} active=${snapshot.activeChildren} orphaned=${snapshot.orphanCount}`,
    `Recent children: ${renderRecentChildren(snapshot.children, snapshot.recentChildrenLimit)}`,
  ];

  if (latestChild) lines.push(`Latest child: ${renderLatestChild(latestChild, snapshot.waitJoinHints)}`);
  lines.push(
    `Wait/join hints: ${renderWaitJoinHints(snapshot.waitJoinHints)}`,
    `Aggregate agent metrics (last ${OBS_AGENTS_WINDOW}): ${renderAggregateRows(snapshot.aggregateRows)}`,
    `Lineage drill-down: ${renderLineageDrilldown(snapshot)}`,
  );
  return lines.join("\n");
}

class ObsAgentsCommand {
  readonly #options: RegisterObsAgentsCommandOptions;

  constructor(options: RegisterObsAgentsCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsAgentsCommandContext): Promise<void> {
    await handleObsAgentsCommand(args, ctx, this.#options);
  }
}

async function resolveObsAgentsSnapshot(
  ctx: ObsAgentsCommandContext,
  options: RegisterObsAgentsCommandOptions,
): Promise<ObsAgentsSnapshot> {
  if (options.getAgents) return options.getAgents(ctx);
  return getObsAgentsSnapshot(ctx, options);
}

async function resolveObsAgentsRuntime(
  ctx: ObsAgentsCommandContext,
  options: ObsAgentsSnapshotOptions,
): Promise<ObsAgentsRuntimeSnapshot> {
  if (options.getRuntime) return options.getRuntime(ctx);
  return getLocalObsAgentsRuntimeSnapshot();
}

async function loadObsAgentsConfig(
  ctx: ObsAgentsCommandContext,
  options: ObsAgentsSnapshotOptions,
): Promise<ObservMeConfig> {
  return loadObsCommandConfig(ctx, options);
}

async function queryObsAgentsAggregates(
  config: ObservMeConfig,
  options: ObsAgentsSnapshotOptions,
): Promise<ObsAgentsQueryResults> {
  const client = createPrometheusQueryClient(config, { fetch: options.fetch });
  const spawned = await client.queryPrometheus(OBS_AGENTS_SPAWNED_PROMQL, undefined, { resultLimit: "agents" });
  const fanoutP95 = await client.queryPrometheus(OBS_AGENTS_FANOUT_P95_PROMQL, undefined, { resultLimit: "agents" });
  const orphaned = await client.queryPrometheus(OBS_AGENTS_ORPHAN_PROMQL, undefined, { resultLimit: "agents" });

  return { spawned, fanoutP95, orphaned };
}

async function queryObsAgentsTempoTraces(
  config: ObservMeConfig,
  runtime: ObsAgentsRuntimeSnapshot,
  options: ObsAgentsSnapshotOptions,
): Promise<TraceSummary[]> {
  const attrs = createTempoSearchAttributes(runtime);
  if (Object.keys(attrs).length === 0) return [];

  const client = createTempoQueryClient(config, { fetch: options.fetch });
  return client.searchTempo(attrs, createObsAgentsSearchRange(options));
}

function buildObsAgentsSnapshot(
  runtime: ObsAgentsRuntimeSnapshot,
  aggregateResults: ObsAgentsQueryResults,
  traces: readonly TraceSummary[],
  maxRecentChildren: number | undefined,
): ObsAgentsSnapshot {
  const lineage = runtime.lineage;
  const currentAgent = runtime.currentAgent;
  const summary = runtime.summary ?? emptyAgentTreeSummary;

  return {
    workflowId: lineage?.workflowId ?? currentAgent?.workflowId,
    workflowRootAgentId: lineage?.workflowRootAgentId ?? currentAgent?.rootAgentId,
    agentId: lineage?.agentId ?? currentAgent?.agentId,
    parentAgentId: lineage?.parentAgentId ?? currentAgent?.parentAgentId,
    rootAgentId: lineage?.rootAgentId ?? currentAgent?.rootAgentId,
    role: lineage?.role ?? currentAgent?.role ?? "unknown",
    capability: lineage?.capability ?? currentAgent?.capability,
    depth: normalizeCount(lineage?.depth ?? currentAgent?.depth),
    orphaned: Boolean(lineage?.orphaned ?? currentAgent?.orphaned),
    sessionId: normalizeOptionalString(runtime.sessionId),
    traceId: normalizeOptionalString(runtime.traceId),
    activeChildren: normalizeCount(currentAgent?.activeChildren ?? summary.activeChildren),
    fanoutCount: normalizeCount(currentAgent?.fanoutCount ?? summary.fanoutCount),
    treeDepth: normalizeCount(summary.treeDepth),
    treeWidth: normalizeCount(summary.treeWidth),
    orphanCount: normalizeCount(summary.orphanCount),
    children: runtime.children.map(toObsAgentChildRow),
    waitJoinHints: runtime.waitJoinHints,
    aggregateQueries: [OBS_AGENTS_SPAWNED_PROMQL, OBS_AGENTS_FANOUT_P95_PROMQL, OBS_AGENTS_ORPHAN_PROMQL],
    aggregateRows: {
      spawned: aggregateResults.spawned.series.map(toObsAgentAggregateRow).filter(isObsAgentAggregateRow),
      fanoutP95: aggregateResults.fanoutP95.series.map(toObsAgentAggregateRow).filter(isObsAgentAggregateRow),
      orphaned: aggregateResults.orphaned.series.map(toObsAgentAggregateRow).filter(isObsAgentAggregateRow),
    },
    tempoSearchAttributes: createTempoSearchAttributes(runtime),
    traces,
    recentChildrenLimit: normalizeRecentChildrenLimit(maxRecentChildren),
  };
}

function toObsAgentChildRow(node: AgentTreeNode): ObsAgentChildRow {
  return {
    agentId: node.agentId,
    parentAgentId: node.parentAgentId,
    depth: normalizeCount(node.depth),
    role: node.role,
    capability: node.capability,
    status: node.status,
    orphaned: node.orphaned,
    activeChildren: normalizeCount(node.activeChildren),
    fanoutCount: normalizeCount(node.fanoutCount),
  };
}

function toObsAgentAggregateRow(series: PrometheusMetricSeries): ObsAgentAggregateRow | undefined {
  const value = parseMetricValue(series.value?.value);
  if (value === undefined) return undefined;

  return {
    labels: { ...series.metric },
    value,
    timestampUnixSeconds: series.value?.timestampUnixSeconds,
  };
}

function createTempoSearchAttributes(runtime: ObsAgentsRuntimeSnapshot): Record<string, string> {
  const lineage = runtime.lineage;
  if (!lineage) return {};

  return {
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_ID]: lineage.agentId,
    [COMMON_SPAN_ATTRIBUTES.PI_WORKFLOW_ID]: lineage.workflowId,
  };
}

function createObsAgentsSearchRange(options: ObsAgentsSnapshotOptions): TimeRange {
  const to = options.now?.() ?? new Date();
  const rangeHours = normalizeSearchRangeHours(options.searchRangeHours);
  return { from: new Date(to.getTime() - rangeHours * millisecondsPerHour), to };
}

function normalizeSearchRangeHours(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TRACE_SEARCH_RANGE_HOURS;
  return value;
}

function readLatestChild(children: readonly ObsAgentChildRow[]): ObsAgentChildRow | undefined {
  return children.at(-1);
}

function renderRecentChildren(children: readonly ObsAgentChildRow[], limit: number | undefined): string {
  if (children.length === 0) return "none";

  const selection = selectRecentChildrenForRender(children, limit);
  const rendered = selection.children.map(renderRecentChild).join("; ");
  if (selection.omittedCount === 0) return rendered;
  return `${rendered}; omitted ${selection.omittedCount} child row(s)`;
}

function selectRecentChildrenForRender(
  children: readonly ObsAgentChildRow[],
  limit: number | undefined,
): { readonly children: readonly ObsAgentChildRow[]; readonly omittedCount: number } {
  const normalizedLimit = normalizeRecentChildrenLimit(limit);
  if (children.length <= normalizedLimit) return { children, omittedCount: 0 };

  if (normalizedLimit === 1) return { children: children.slice(-1), omittedCount: children.length - 1 };

  const firstCount = Math.floor(normalizedLimit / 2);
  const lastCount = normalizedLimit - firstCount;
  const visibleChildren = [...children.slice(0, firstCount), ...children.slice(-lastCount)];
  return { children: visibleChildren, omittedCount: children.length - visibleChildren.length };
}

function renderRecentChild(child: ObsAgentChildRow): string {
  const orphan = child.orphaned ? " orphaned" : "";
  return `${child.agentId} status=${child.status} depth=${child.depth}${orphan}`;
}

function renderLatestChild(child: ObsAgentChildRow, hints: readonly ObsAgentWaitJoinHint[]): string {
  const joinHint = readLatestHintForChild(child.agentId, hints, "join");
  return `${child.agentId} status=${child.status} active=${child.activeChildren} join=${formatDuration(joinHint?.durationMs)}`;
}

function readLatestHintForChild(
  childAgentId: string,
  hints: readonly ObsAgentWaitJoinHint[],
  kind: "join" | "wait",
): ObsAgentWaitJoinHint | undefined {
  return hints.findLast(hint => hint.kind === kind && hint.childAgentId === childAgentId);
}

function renderWaitJoinHints(hints: readonly ObsAgentWaitJoinHint[]): string {
  if (hints.length === 0) return "none";

  const activeWaits = hints.filter(isActiveWaitHint).length;
  const activeJoins = hints.filter(isActiveJoinHint).length;
  const latest = hints.at(-1);
  return `active_waits=${activeWaits} active_joins=${activeJoins} latest=${renderWaitJoinHint(latest)}`;
}

function renderWaitJoinHint(hint: ObsAgentWaitJoinHint | undefined): string {
  if (!hint) return "none";

  const status = hint.joinStatus ?? hint.childStatus ?? (hint.active ? "waiting" : "complete");
  return `${hint.kind}:${hint.childAgentId ?? hint.spawnId ?? hint.id} status=${status} duration=${formatDuration(hint.durationMs)}`;
}

function renderAggregateRows(rows: ObsAgentsAggregateRows): string {
  return `spawn_series=${rows.spawned.length} fanout_series=${rows.fanoutP95.length} orphan_series=${rows.orphaned.length}`;
}

function renderLineageDrilldown(snapshot: ObsAgentsSnapshot): string {
  const attrs = Object.keys(snapshot.tempoSearchAttributes).join(", ") || "none";
  const traceCount = snapshot.traces.length;
  const latestTrace = normalizeOptionalString(snapshot.traces[0]?.traceId) ?? normalizeOptionalString(snapshot.traceId);
  const traceSuffix = latestTrace ? ` latest_trace=${latestTrace}` : "";
  return `Tempo attributes ${attrs} traces=${traceCount}${traceSuffix}`;
}

function isActiveWaitHint(hint: ObsAgentWaitJoinHint): boolean {
  return hint.active && hint.kind === "wait";
}

function isActiveJoinHint(hint: ObsAgentWaitJoinHint): boolean {
  return hint.active && hint.kind === "join";
}

function isObsAgentAggregateRow(row: ObsAgentAggregateRow | undefined): row is ObsAgentAggregateRow {
  return row !== undefined;
}

function parseMetricValue(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;

  const metricValue = Number(value);
  if (!Number.isFinite(metricValue) || metricValue < 0) return undefined;
  return metricValue;
}

function normalizeCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

function normalizeRecentChildrenLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_RECENT_CHILDREN_RENDER_LIMIT;
  return Math.min(Math.trunc(value), DEFAULT_RECENT_CHILDREN_RENDER_LIMIT);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isObsAgentsRequest(args: string): boolean {
  return isExactObsSubcommandRequest(args, OBS_AGENTS_SUBCOMMAND);
}

function formatUnknown(value: string | undefined): string {
  return value ?? "unknown";
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return "n/a";
  if (value < 1000) return `${value}ms`;
  return `${trimTrailingFractionZeros((value / 1000).toFixed(2))}s`;
}

function trimTrailingFractionZeros(value: string): string {
  const decimalIndex = value.indexOf(".");
  if (decimalIndex === -1) return value;

  let end = value.length;
  while (end > decimalIndex + 1 && value[end - 1] === "0") end -= 1;
  if (end === decimalIndex + 1) return value.slice(0, decimalIndex);
  return value.slice(0, end);
}

function resolveObsAgentsDiagnostic(error: unknown): ObsCommandRecoveryHint {
  const message = readObsDiagnosticMessage(error);

  if (message.includes("Prometheus")) return { subsystem: "Prometheus", nextAction: OBS_AGENTS_PROMETHEUS_NEXT_ACTION };
  if (message.includes("Tempo")) return { subsystem: "Tempo", nextAction: OBS_AGENTS_TEMPO_NEXT_ACTION };
  return { subsystem: "Agent telemetry", nextAction: OBS_AGENTS_ERROR_NEXT_ACTION };
}
