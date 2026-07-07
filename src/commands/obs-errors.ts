import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import { loadSessionConfig } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import type { LokiFetch } from "../query/loki.ts";
import { createLokiQueryClient } from "../query/loki.ts";
import type { ObsLokiLogSummaryRow, ObsLokiTimeRangeOptions } from "./obs-loki-summary.ts";
import {
  createRecentObsLokiTimeRange,
  formatObsLokiWindow,
  normalizeObsLokiMaxLogs,
  renderObsLokiLogSummary,
  toObsLokiLogSummaryRow,
} from "./obs-loki-summary.ts";

export interface ObsErrorsCommandContext {
  readonly cwd?: string;
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export interface ObsErrorsSnapshot {
  readonly window: string;
  readonly query: string;
  readonly maxLogs: number;
  readonly logs: readonly ObsLokiLogSummaryRow[];
}

export type ObsErrorsConfigLoader = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type ObsErrorsProvider = (ctx: ObsErrorsCommandContext) => Promise<ObsErrorsSnapshot> | ObsErrorsSnapshot;

export interface ObsErrorsSnapshotOptions extends ObsLokiTimeRangeOptions {
  readonly loadConfig?: ObsErrorsConfigLoader;
  readonly fetch?: LokiFetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
}

export interface RegisterObsErrorsCommandOptions extends ObsErrorsSnapshotOptions {
  readonly getErrors?: ObsErrorsProvider;
}

export const OBS_ERROR_EVENT_NAME_PATTERN = ".*[.]failed|.*[.]dropped|agent[.]orphaned";
export const OBS_ERRORS_LOGQL = `{service_name="observme-pi-extension", event_name=~"${OBS_ERROR_EVENT_NAME_PATTERN}"}`;

const OBS_COMMAND_NAME = "obs";
const OBS_ERRORS_SUBCOMMAND = "errors";
const OBS_ERRORS_USAGE = "Usage: /obs errors";

export function registerObsErrorsCommand(pi: ExtensionAPI, options: RegisterObsErrorsCommandOptions = {}): void {
  const command = new ObsErrorsCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Show recent ObservMe error events from Loki. Usage: /obs errors",
    getArgumentCompletions: getObsErrorsCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsErrorsCommand(
  args: string,
  ctx: ObsErrorsCommandContext,
  options: RegisterObsErrorsCommandOptions = {},
): Promise<void> {
  if (!isObsErrorsRequest(args)) {
    await notifyErrors(ctx, OBS_ERRORS_USAGE, "warning");
    return;
  }

  try {
    const snapshot = await resolveObsErrorsSnapshot(ctx, options);
    await notifyErrors(ctx, renderObsErrors(snapshot), "info");
  } catch (error) {
    await notifyErrors(ctx, `ObservMe errors unavailable: ${formatError(error)}`, "error");
  }
}

export function getObsErrorsCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (!OBS_ERRORS_SUBCOMMAND.startsWith(normalizedPrefix)) return null;
  return [{ value: OBS_ERRORS_SUBCOMMAND, label: OBS_ERRORS_SUBCOMMAND }];
}

export async function getObsErrorsSnapshot(
  ctx: ObsErrorsCommandContext,
  options: ObsErrorsSnapshotOptions = {},
): Promise<ObsErrorsSnapshot> {
  const config = await loadObsErrorsConfig(ctx, options);
  const maxLogs = normalizeObsLokiMaxLogs(config.query.maxLogs);
  const logs = await queryObsErrors(config, options);

  return {
    window: formatObsLokiWindow(options),
    query: OBS_ERRORS_LOGQL,
    maxLogs,
    logs: logs.slice(0, maxLogs).map(toObsLokiLogSummaryRow),
  };
}

export function renderObsErrors(snapshot: ObsErrorsSnapshot): string {
  return renderObsLokiLogSummary({
    title: "Recent error events",
    window: snapshot.window,
    maxLogs: snapshot.maxLogs,
    rows: snapshot.logs,
    emptyMessage: "No error logs found.",
  });
}

class ObsErrorsCommand {
  readonly #options: RegisterObsErrorsCommandOptions;

  constructor(options: RegisterObsErrorsCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsErrorsCommandContext): Promise<void> {
    await handleObsErrorsCommand(args, ctx, this.#options);
  }
}

async function resolveObsErrorsSnapshot(
  ctx: ObsErrorsCommandContext,
  options: RegisterObsErrorsCommandOptions,
): Promise<ObsErrorsSnapshot> {
  if (options.getErrors) return options.getErrors(ctx);
  return getObsErrorsSnapshot(ctx, options);
}

async function loadObsErrorsConfig(
  ctx: ObsErrorsCommandContext,
  options: ObsErrorsSnapshotOptions,
): Promise<ObservMeConfig> {
  const loadConfig = options.loadConfig ?? loadSessionConfig;
  return loadConfig({ ctx, cwd: ctx.cwd, configDirName: options.configDirName, env: options.env });
}

async function queryObsErrors(config: ObservMeConfig, options: ObsErrorsSnapshotOptions) {
  const client = createLokiQueryClient(config, { fetch: options.fetch });
  return client.queryLoki(OBS_ERRORS_LOGQL, createRecentObsLokiTimeRange(options));
}

function isObsErrorsRequest(args: string): boolean {
  const tokens = args.trim().toLowerCase().split(/\s+/u).filter(isNonEmptyString);
  const [subcommand, ...rest] = tokens;
  return subcommand === OBS_ERRORS_SUBCOMMAND && rest.length === 0;
}

function isNonEmptyString(value: string): boolean {
  return value.length > 0;
}

async function notifyErrors(
  ctx: ObsErrorsCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): Promise<void> {
  await ctx.ui.notify(message, type);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
