import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  ObsTraceCommandContext,
  ObsTraceProvider,
  ObsTraceRequest,
  ObsTraceSnapshot,
  ObsTraceSnapshotOptions,
} from "./obs-trace.ts";
import { completeObsSubcommand, obsUsageWithError } from "./obs-args.ts";
import {
  getObsTraceSnapshot,
  parseObsTraceArgsForSubcommand,
  renderObsTraceWithTitle,
} from "./obs-trace.ts";

export type ObsLinkCommandContext = ObsTraceCommandContext;
export type ObsLinkProvider = ObsTraceProvider;

export interface RegisterObsLinkCommandOptions extends ObsTraceSnapshotOptions {
  readonly getLink?: ObsLinkProvider;
}

const OBS_COMMAND_NAME = "obs";
const OBS_LINK_SUBCOMMAND = "link";
const OBS_LINK_USAGE = "Usage: /obs link [--last-turn|--session <session-id>]";

export function registerObsLinkCommand(pi: ExtensionAPI, options: RegisterObsLinkCommandOptions = {}): void {
  const command = new ObsLinkCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Show an ObservMe Grafana link. Usage: /obs link [--last-turn|--session <session-id>]",
    getArgumentCompletions: getObsLinkCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsLinkCommand(
  args: string,
  ctx: ObsLinkCommandContext,
  options: RegisterObsLinkCommandOptions = {},
): Promise<void> {
  const parsed = parseObsTraceArgsForSubcommand(args, OBS_LINK_SUBCOMMAND);

  if (!parsed.request) {
    await notifyLink(ctx, obsUsageWithError(OBS_LINK_USAGE, parsed.error), "warning");
    return;
  }

  const request = parsed.request;

  try {
    const snapshot = await resolveObsLinkSnapshot(ctx, request, options);
    await notifyLink(ctx, renderObsLink(snapshot), "info");
  } catch (error) {
    await notifyLink(ctx, `ObservMe link unavailable: ${formatError(error)}`, "error");
  }
}

export function getObsLinkCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  return completeObsSubcommand(prefix, OBS_LINK_SUBCOMMAND);
}

export function renderObsLink(snapshot: ObsTraceSnapshot): string {
  return renderObsTraceWithTitle(snapshot, "Grafana link");
}

class ObsLinkCommand {
  readonly #options: RegisterObsLinkCommandOptions;

  constructor(options: RegisterObsLinkCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsLinkCommandContext): Promise<void> {
    await handleObsLinkCommand(args, ctx, this.#options);
  }
}

async function resolveObsLinkSnapshot(
  ctx: ObsLinkCommandContext,
  request: ObsTraceRequest,
  options: RegisterObsLinkCommandOptions,
): Promise<ObsTraceSnapshot> {
  if (options.getLink) return options.getLink(ctx, request);
  return getObsTraceSnapshot(ctx, request, options);
}

async function notifyLink(
  ctx: ObsLinkCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): Promise<void> {
  await ctx.ui.notify(message, type);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
