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
import { completeObsSubcommands, firstObsCommandToken, obsUsageWithError } from "./obs-args.ts";

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
const OBS_DEFAULT_SUBCOMMAND = "status" satisfies ObsRootSubcommandName;

type ObsRootArgsMode = "raw" | "subcommand";
export type ObsRootSubcommandName = keyof RegisterObsCommandOptions;

type ObsSubcommandHandler<Options> = (
  args: string,
  ctx: ObsCommandContext,
  options?: Options,
) => Promise<void>;

type ObsSubcommandRegistry = {
  readonly [Name in ObsRootSubcommandName]: {
    readonly rootArgs: ObsRootArgsMode;
    readonly handle: ObsSubcommandHandler<RegisterObsCommandOptions[Name]>;
    readonly selectOptions: (options: RegisterObsCommandOptions) => RegisterObsCommandOptions[Name];
  };
};

const obsSubcommandRegistry = {
  status: {
    rootArgs: "subcommand",
    handle: handleObsStatusCommand,
    selectOptions: options => options.status,
  },
  health: {
    rootArgs: "subcommand",
    handle: handleObsHealthCommand,
    selectOptions: options => options.health,
  },
  session: {
    rootArgs: "subcommand",
    handle: handleObsSessionCommand,
    selectOptions: options => options.session,
  },
  cost: {
    rootArgs: "raw",
    handle: handleObsCostCommand,
    selectOptions: options => options.cost,
  },
  trace: {
    rootArgs: "raw",
    handle: handleObsTraceCommand,
    selectOptions: options => options.trace,
  },
  tools: {
    rootArgs: "raw",
    handle: handleObsToolsCommand,
    selectOptions: options => options.tools,
  },
  agents: {
    rootArgs: "raw",
    handle: handleObsAgentsCommand,
    selectOptions: options => options.agents,
  },
  backfill: {
    rootArgs: "raw",
    handle: handleObsBackfillCommand,
    selectOptions: options => options.backfill,
  },
  errors: {
    rootArgs: "raw",
    handle: handleObsErrorsCommand,
    selectOptions: options => options.errors,
  },
  logs: {
    rootArgs: "raw",
    handle: handleObsLogsCommand,
    selectOptions: options => options.logs,
  },
  link: {
    rootArgs: "raw",
    handle: handleObsLinkCommand,
    selectOptions: options => options.link,
  },
} as const satisfies ObsSubcommandRegistry;

const obsSubcommands = Object.keys(obsSubcommandRegistry) as ObsRootSubcommandName[];
const OBS_ROOT_USAGE = buildObsRootUsage(obsSubcommands);

export function registerObsCommand(pi: ExtensionAPI, options: RegisterObsCommandOptions = {}): void {
  const command = new ObsCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: `Run ObservMe commands. ${OBS_ROOT_USAGE}`,
    getArgumentCompletions: getObsRootCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsCommand(
  args: string,
  ctx: ObsCommandContext,
  options: RegisterObsCommandOptions = {},
): Promise<void> {
  const subcommand = firstObsCommandToken(args);
  const rootSubcommand = resolveObsRootSubcommand(subcommand);

  if (rootSubcommand) {
    await dispatchObsRootSubcommand(rootSubcommand, args, ctx, options);
    return;
  }

  await ctx.ui?.notify?.(obsUsageWithError(OBS_ROOT_USAGE, subcommand ? `Unknown subcommand: ${subcommand}.` : undefined), "warning");
}

export function getObsRootCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  return completeObsSubcommands(prefix, obsSubcommands);
}

export function getObsRootSubcommands(): readonly ObsRootSubcommandName[] {
  return [...obsSubcommands];
}

export function getObsRootUsage(): string {
  return OBS_ROOT_USAGE;
}

function buildObsRootUsage(subcommands: readonly ObsRootSubcommandName[]): string {
  return `Usage: /obs <${subcommands.join("|")}>`;
}

function resolveObsRootSubcommand(subcommand: string | undefined): ObsRootSubcommandName | undefined {
  if (!subcommand) return OBS_DEFAULT_SUBCOMMAND;
  if (isObsRootSubcommandName(subcommand)) return subcommand;
  return undefined;
}

function isObsRootSubcommandName(value: string): value is ObsRootSubcommandName {
  return Object.hasOwn(obsSubcommandRegistry, value);
}

async function dispatchObsRootSubcommand<Name extends ObsRootSubcommandName>(
  subcommand: Name,
  args: string,
  ctx: ObsCommandContext,
  options: RegisterObsCommandOptions,
): Promise<void> {
  const registration: ObsSubcommandRegistry[Name] = obsSubcommandRegistry[subcommand];
  const handlerArgs = getObsRootHandlerArgs(subcommand, args, registration.rootArgs);
  await registration.handle(handlerArgs, ctx, registration.selectOptions(options));
}

function getObsRootHandlerArgs(subcommand: ObsRootSubcommandName, args: string, rootArgs: ObsRootArgsMode): string {
  if (rootArgs === "subcommand") return subcommand;
  return args;
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
