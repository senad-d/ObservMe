import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import { loadSessionConfig } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import type { LokiFetch } from "../query/loki.ts";
import { createLokiQueryClient } from "../query/loki.ts";
import { normalizeObservMeSessionId } from "../safety/sensitive-input.ts";
import { completeObsSubcommand, isExactObsSubcommandRequest } from "./obs-args.ts";
import { appendObsRecoveryHint, formatObsCommandFailure, readObsDiagnosticMessage, type ObsCommandRecoveryHint } from "./obs-diagnostics.ts";
import type { ObsLokiLogSummaryRow, ObsLokiTimeRangeOptions } from "./obs-loki-summary.ts";
import {
  createRecentObsLokiTimeRange,
  formatObsLokiWindow,
  normalizeObsLokiMaxLogs,
  renderObsLokiLogSummary,
  toObsLokiLogSummaryRow,
} from "./obs-loki-summary.ts";
import type { ObsSessionSnapshot } from "./obs-session.ts";
import { getLocalObsSessionSnapshot } from "./obs-session.ts";

export interface ObsLogsCommandContext {
  readonly cwd?: string;
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export type ObsLogsSessionSnapshot = Pick<ObsSessionSnapshot, "sessionId">;
export type ObsLogsSessionProvider = (ctx: ObsLogsCommandContext) => Promise<ObsLogsSessionSnapshot> | ObsLogsSessionSnapshot;

export interface ObsLogsSnapshot {
  readonly sessionId: string;
  readonly window: string;
  readonly query: string;
  readonly maxLogs: number;
  readonly logs: readonly ObsLokiLogSummaryRow[];
}

export type ObsLogsConfigLoader = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type ObsLogsProvider = (ctx: ObsLogsCommandContext) => Promise<ObsLogsSnapshot> | ObsLogsSnapshot;

export interface ObsLogsSnapshotOptions extends ObsLokiTimeRangeOptions {
  readonly loadConfig?: ObsLogsConfigLoader;
  readonly fetch?: LokiFetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
  readonly getSession?: ObsLogsSessionProvider;
}

export interface RegisterObsLogsCommandOptions extends ObsLogsSnapshotOptions {
  readonly getLogs?: ObsLogsProvider;
}

export const OBS_LOGS_LOGQL_PREFIX = '{service_name="observme-pi-extension", event_category!="llm_content", pi_session_id=';

const OBS_COMMAND_NAME = "obs";
const OBS_LOGS_SUBCOMMAND = "logs";
const OBS_LOGS_USAGE = "Usage: /obs logs";
const OBS_LOGS_LOKI_ERROR_NEXT_ACTION = "run /obs health and verify query.grafana.url, Grafana credentials, the Loki datasource UID, and service labels.";
const OBS_LOGS_SESSION_ERROR_NEXT_ACTION = "run /obs session to confirm a current session before /obs logs.";
const OBS_LOGS_NO_LOGS_NEXT_ACTION = "wait for telemetry export, then verify Loki labels and datasource with /obs health.";

export function registerObsLogsCommand(pi: ExtensionAPI, options: RegisterObsLogsCommandOptions = {}): void {
  const command = new ObsLogsCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Show current-session ObservMe logs from Loki. Usage: /obs logs",
    getArgumentCompletions: getObsLogsCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsLogsCommand(
  args: string,
  ctx: ObsLogsCommandContext,
  options: RegisterObsLogsCommandOptions = {},
): Promise<void> {
  if (!isObsLogsRequest(args)) {
    await notifyLogs(ctx, OBS_LOGS_USAGE, "warning");
    return;
  }

  try {
    const snapshot = await resolveObsLogsSnapshot(ctx, options);
    await notifyLogs(ctx, renderObsLogs(snapshot), "info");
  } catch (error) {
    await notifyLogs(ctx, formatObsCommandFailure("ObservMe logs unavailable", error, resolveObsLogsDiagnostic(error)), "error");
  }
}

export function getObsLogsCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  return completeObsSubcommand(prefix, OBS_LOGS_SUBCOMMAND);
}

export async function getObsLogsSnapshot(
  ctx: ObsLogsCommandContext,
  options: ObsLogsSnapshotOptions = {},
): Promise<ObsLogsSnapshot> {
  const sessionId = await resolveObsLogsSessionId(ctx, options);
  const config = await loadObsLogsConfig(ctx, options);
  const maxLogs = normalizeObsLokiMaxLogs(config.query.maxLogs);
  const query = buildObsLogsLogQl(sessionId);
  const logs = await queryObsLogs(config, query, options);

  return {
    sessionId,
    window: formatObsLokiWindow(options),
    query,
    maxLogs,
    logs: logs.slice(0, maxLogs).map(toObsLokiLogSummaryRow),
  };
}

export function buildObsLogsLogQl(sessionId: string): string {
  return `${OBS_LOGS_LOGQL_PREFIX}"${escapeLogQlString(normalizeObsLogsSessionId(sessionId))}"}`;
}

export function renderObsLogs(snapshot: ObsLogsSnapshot): string {
  return renderObsLokiLogSummary({
    title: `Session logs for ${snapshot.sessionId}`,
    window: snapshot.window,
    maxLogs: snapshot.maxLogs,
    rows: snapshot.logs,
    emptyMessage: appendObsRecoveryHint("No session logs found.", OBS_LOGS_NO_LOGS_NEXT_ACTION),
  });
}

class ObsLogsCommand {
  readonly #options: RegisterObsLogsCommandOptions;

  constructor(options: RegisterObsLogsCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsLogsCommandContext): Promise<void> {
    await handleObsLogsCommand(args, ctx, this.#options);
  }
}

async function resolveObsLogsSnapshot(
  ctx: ObsLogsCommandContext,
  options: RegisterObsLogsCommandOptions,
): Promise<ObsLogsSnapshot> {
  if (options.getLogs) return options.getLogs(ctx);
  return getObsLogsSnapshot(ctx, options);
}

async function resolveObsLogsSessionId(ctx: ObsLogsCommandContext, options: ObsLogsSnapshotOptions): Promise<string> {
  const session = await resolveObsLogsSession(ctx, options);
  return normalizeObsLogsSessionId(session.sessionId);
}

async function resolveObsLogsSession(
  ctx: ObsLogsCommandContext,
  options: ObsLogsSnapshotOptions,
): Promise<ObsLogsSessionSnapshot> {
  if (options.getSession) return options.getSession(ctx);
  return getLocalObsSessionSnapshot();
}

async function loadObsLogsConfig(ctx: ObsLogsCommandContext, options: ObsLogsSnapshotOptions): Promise<ObservMeConfig> {
  const loadConfig = options.loadConfig ?? loadSessionConfig;
  return loadConfig({ ctx, cwd: ctx.cwd, configDirName: options.configDirName, env: options.env });
}

async function queryObsLogs(config: ObservMeConfig, query: string, options: ObsLogsSnapshotOptions) {
  const client = createLokiQueryClient(config, { fetch: options.fetch });
  return client.queryLoki(query, createRecentObsLokiTimeRange(options));
}

function normalizeObsLogsSessionId(value: string | undefined): string {
  return normalizeObservMeSessionId(value, { emptyMessage: "No current ObservMe session id is available." });
}

function escapeLogQlString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function isObsLogsRequest(args: string): boolean {
  return isExactObsSubcommandRequest(args, OBS_LOGS_SUBCOMMAND);
}

async function notifyLogs(
  ctx: ObsLogsCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): Promise<void> {
  await ctx.ui.notify(message, type);
}

function resolveObsLogsDiagnostic(error: unknown): ObsCommandRecoveryHint {
  if (isObsLogsSessionErrorMessage(readObsDiagnosticMessage(error))) {
    return { subsystem: "Session", nextAction: OBS_LOGS_SESSION_ERROR_NEXT_ACTION };
  }

  return { subsystem: "Loki", nextAction: OBS_LOGS_LOKI_ERROR_NEXT_ACTION };
}

function isObsLogsSessionErrorMessage(message: string): boolean {
  return /current ObservMe session id|Unsafe ObservMe session id/u.test(message);
}
