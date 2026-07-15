import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import { loadSessionConfig } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import { boundObsCommandOutput } from "../safety/display-bounds.ts";

export type ObsCommandNotificationType = "info" | "warning" | "error";

export interface ObsCommandContext {
  readonly cwd?: string;
  readonly ui: {
    notify: (message: string, type?: ObsCommandNotificationType) => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export type ObsCommandConfigLoader = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;

export interface ObsCommandConfigOptions {
  readonly loadConfig?: ObsCommandConfigLoader;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
}

export async function loadObsCommandConfig(
  ctx: ObsCommandContext,
  options: ObsCommandConfigOptions,
): Promise<ObservMeConfig> {
  const loadConfig = options.loadConfig ?? loadSessionConfig;
  return loadConfig({ ctx, cwd: ctx.cwd, configDirName: options.configDirName, env: options.env });
}

export async function notifyObsCommand(
  ctx: ObsCommandContext,
  message: string,
  type: ObsCommandNotificationType,
): Promise<void> {
  await ctx.ui?.notify?.(boundObsCommandOutput(message), type);
}

export function normalizeObsCommandTimeoutMs(value: number | undefined, fallback: number, invalidFallback = fallback): number {
  const timeoutMs = value ?? fallback;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return invalidFallback;
  return Math.trunc(timeoutMs);
}
