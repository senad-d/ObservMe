import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RegisterObsBackfillCommandOptions } from "./obs-backfill.ts";
import { handleObsBackfillCommand } from "./obs-backfill.ts";
import type { ObsAgentsCommandContext, RegisterObsAgentsCommandOptions } from "./obs-agents.ts";
import { handleObsAgentsCommand } from "./obs-agents.ts";
import type { ObsCostCommandContext, RegisterObsCostCommandOptions } from "./obs-cost.ts";
import { handleObsCostCommand } from "./obs-cost.ts";
import type { ObsErrorsCommandContext, RegisterObsErrorsCommandOptions } from "./obs-errors.ts";
import { handleObsErrorsCommand } from "./obs-errors.ts";
import type { ObsHealthCommandContext, RegisterObsHealthCommandOptions } from "./obs-health.ts";
import { handleObsHealthCommand } from "./obs-health.ts";
import type { ObsLinkCommandContext, RegisterObsLinkCommandOptions } from "./obs-link.ts";
import { handleObsLinkCommand } from "./obs-link.ts";
import type { ObsLogsCommandContext, RegisterObsLogsCommandOptions } from "./obs-logs.ts";
import { handleObsLogsCommand } from "./obs-logs.ts";
import type { ObsSessionCommandContext, RegisterObsSessionCommandOptions } from "./obs-session.ts";
import { handleObsSessionCommand } from "./obs-session.ts";
import type { ObsStatusCommandContext, RegisterObsStatusCommandOptions } from "./obs-status.ts";
import { handleObsStatusCommand } from "./obs-status.ts";
import type { ObsToolsCommandContext, RegisterObsToolsCommandOptions } from "./obs-tools.ts";
import { handleObsToolsCommand } from "./obs-tools.ts";
import type { ObsTraceCommandContext, RegisterObsTraceCommandOptions } from "./obs-trace.ts";
import { handleObsTraceCommand } from "./obs-trace.ts";

export interface ObsCommandContext
  extends ObsStatusCommandContext,
    ObsHealthCommandContext,
    ObsSessionCommandContext,
    ObsCostCommandContext,
    ObsTraceCommandContext,
    ObsToolsCommandContext,
    ObsAgentsCommandContext,
    ObsErrorsCommandContext,
    ObsLogsCommandContext,
    ObsLinkCommandContext {}

export interface RegisterObsCommandOptions {
  readonly status?: RegisterObsStatusCommandOptions;
  readonly health?: RegisterObsHealthCommandOptions;
  readonly session?: RegisterObsSessionCommandOptions;
  readonly cost?: RegisterObsCostCommandOptions;
  readonly trace?: RegisterObsTraceCommandOptions;
  readonly tools?: RegisterObsToolsCommandOptions;
  readonly agents?: RegisterObsAgentsCommandOptions;
  readonly backfill?: RegisterObsBackfillCommandOptions;
  readonly errors?: RegisterObsErrorsCommandOptions;
  readonly logs?: RegisterObsLogsCommandOptions;
  readonly link?: RegisterObsLinkCommandOptions;
}

const OBS_COMMAND_NAME = "obs";
const OBS_STATUS_SUBCOMMAND = "status";
const OBS_HEALTH_SUBCOMMAND = "health";
const OBS_SESSION_SUBCOMMAND = "session";
const OBS_COST_SUBCOMMAND = "cost";
const OBS_TRACE_SUBCOMMAND = "trace";
const OBS_TOOLS_SUBCOMMAND = "tools";
const OBS_AGENTS_SUBCOMMAND = "agents";
const OBS_BACKFILL_SUBCOMMAND = "backfill";
const OBS_ERRORS_SUBCOMMAND = "errors";
const OBS_LOGS_SUBCOMMAND = "logs";
const OBS_LINK_SUBCOMMAND = "link";
const obsSubcommands = [
  OBS_STATUS_SUBCOMMAND,
  OBS_HEALTH_SUBCOMMAND,
  OBS_SESSION_SUBCOMMAND,
  OBS_COST_SUBCOMMAND,
  OBS_TRACE_SUBCOMMAND,
  OBS_TOOLS_SUBCOMMAND,
  OBS_AGENTS_SUBCOMMAND,
  OBS_BACKFILL_SUBCOMMAND,
  OBS_ERRORS_SUBCOMMAND,
  OBS_LOGS_SUBCOMMAND,
  OBS_LINK_SUBCOMMAND,
] as const;

export function registerObsCommand(pi: ExtensionAPI, options: RegisterObsCommandOptions = {}): void {
  const command = new ObsCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Run ObservMe commands. Usage: /obs <status|health|session|cost|trace|tools|agents|backfill|errors|logs|link>",
    getArgumentCompletions: getObsRootCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsCommand(
  args: string,
  ctx: ObsCommandContext,
  options: RegisterObsCommandOptions = {},
): Promise<void> {
  const subcommand = firstObsSubcommand(args);

  if (!subcommand || subcommand === OBS_STATUS_SUBCOMMAND) {
    await handleObsStatusCommand(OBS_STATUS_SUBCOMMAND, ctx, options.status);
    return;
  }

  if (subcommand === OBS_HEALTH_SUBCOMMAND) {
    await handleObsHealthCommand(OBS_HEALTH_SUBCOMMAND, ctx, options.health);
    return;
  }

  if (subcommand === OBS_SESSION_SUBCOMMAND) {
    await handleObsSessionCommand(OBS_SESSION_SUBCOMMAND, ctx, options.session);
    return;
  }

  if (subcommand === OBS_COST_SUBCOMMAND) {
    await handleObsCostCommand(args, ctx, options.cost);
    return;
  }

  if (subcommand === OBS_TRACE_SUBCOMMAND) {
    await handleObsTraceCommand(args, ctx, options.trace);
    return;
  }

  if (subcommand === OBS_TOOLS_SUBCOMMAND) {
    await handleObsToolsCommand(args, ctx, options.tools);
    return;
  }

  if (subcommand === OBS_AGENTS_SUBCOMMAND) {
    await handleObsAgentsCommand(args, ctx, options.agents);
    return;
  }

  if (subcommand === OBS_BACKFILL_SUBCOMMAND) {
    await handleObsBackfillCommand(args, ctx, options.backfill);
    return;
  }

  if (subcommand === OBS_ERRORS_SUBCOMMAND) {
    await handleObsErrorsCommand(args, ctx, options.errors);
    return;
  }

  if (subcommand === OBS_LOGS_SUBCOMMAND) {
    await handleObsLogsCommand(args, ctx, options.logs);
    return;
  }

  if (subcommand === OBS_LINK_SUBCOMMAND) {
    await handleObsLinkCommand(args, ctx, options.link);
    return;
  }

  await ctx.ui.notify("Usage: /obs <status|health|session|cost|trace|tools|agents|backfill|errors|logs|link>", "warning");
}

export function getObsRootCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const completions = obsSubcommands
    .filter(subcommand => subcommand.startsWith(normalizedPrefix))
    .map(subcommand => ({ value: subcommand, label: subcommand }));

  return completions.length > 0 ? completions : null;
}

class ObsCommand {
  readonly #options: RegisterObsCommandOptions;

  constructor(options: RegisterObsCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsCommandContext): Promise<void> {
    await handleObsCommand(args, ctx, this.#options);
  }
}

function firstObsSubcommand(args: string): string | undefined {
  const [subcommand] = args.trim().toLowerCase().split(/\s+/u);
  return subcommand;
}
