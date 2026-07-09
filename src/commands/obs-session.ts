import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeObsSubcommand, isExactObsSubcommandRequest } from "./obs-args.ts";

export interface ObsSessionCommandContext {
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
  };
}

export interface ObsSessionSnapshot {
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly turns: number;
  readonly llmCalls: number;
  readonly toolCalls: number;
  readonly costUsd: number;
  readonly traceLink?: string;
}

export interface ObsSessionRuntimeStatePatch {
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly turns?: number;
  readonly llmCalls?: number;
  readonly toolCalls?: number;
  readonly costUsd?: number;
  readonly traceLink?: string;
}

export interface StartObsSessionRuntimeStateOptions {
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly traceUrlTemplate?: string;
}

export type ObsSessionProvider = (ctx: ObsSessionCommandContext) => Promise<ObsSessionSnapshot> | ObsSessionSnapshot;

export interface RegisterObsSessionCommandOptions {
  readonly getSession?: ObsSessionProvider;
}

interface MutableObsSessionRuntimeState {
  sessionId?: string;
  traceId?: string;
  turns: number;
  llmCalls: number;
  toolCalls: number;
  costUsd: number;
  traceLink?: string;
}

const OBS_COMMAND_NAME = "obs";
const OBS_SESSION_SUBCOMMAND = "session";
const traceIdPattern = /^[a-f0-9]{32}$/iu;

const runtimeSessionState: MutableObsSessionRuntimeState = createEmptyObsSessionRuntimeState();

export function registerObsSessionCommand(pi: ExtensionAPI, options: RegisterObsSessionCommandOptions = {}): void {
  const command = new ObsSessionCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Show current ObservMe session telemetry. Usage: /obs session",
    getArgumentCompletions: getObsSessionCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsSessionCommand(
  args: string,
  ctx: ObsSessionCommandContext,
  options: RegisterObsSessionCommandOptions = {},
): Promise<void> {
  if (!isObsSessionRequest(args)) {
    await notifySession(ctx, "Usage: /obs session", "warning");
    return;
  }

  try {
    const snapshot = await resolveObsSessionSnapshot(ctx, options);
    await notifySession(ctx, renderObsSession(snapshot), "info");
  } catch (error) {
    await notifySession(ctx, `ObservMe session unavailable: ${formatError(error)}`, "error");
  }
}

export function getObsSessionCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  return completeObsSubcommand(prefix, OBS_SESSION_SUBCOMMAND);
}

export function getLocalObsSessionSnapshot(): ObsSessionSnapshot {
  return normalizeObsSessionSnapshot(runtimeSessionState);
}

export function renderObsSession(snapshot: ObsSessionSnapshot): string {
  const normalized = normalizeObsSessionSnapshot(snapshot);
  const lines = [
    `Session: ${normalized.sessionId ?? "unknown"}`,
    `Trace: ${normalized.traceId ?? "unavailable"}`,
    `Turns: ${normalized.turns}`,
    `LLM calls: ${normalized.llmCalls}`,
    `Tool calls: ${normalized.toolCalls}`,
    `Cost: ${formatUsd(normalized.costUsd)}`,
  ];

  if (normalized.traceLink) lines.push(`Open trace: ${normalized.traceLink}`);
  return lines.join("\n");
}

export function startObsSessionRuntimeState(options: StartObsSessionRuntimeStateOptions): void {
  const traceId = normalizeTraceId(options.traceId);
  const traceLink = buildObsSessionTraceLink(traceId, options.traceUrlTemplate);

  replaceObsSessionRuntimeState({
    sessionId: normalizeString(options.sessionId),
    traceId,
    turns: 0,
    llmCalls: 0,
    toolCalls: 0,
    costUsd: 0,
    traceLink,
  });
}

export function updateObsSessionRuntimeState(patch: ObsSessionRuntimeStatePatch): void {
  if (patch.sessionId !== undefined) runtimeSessionState.sessionId = normalizeString(patch.sessionId);
  if (patch.traceId !== undefined) runtimeSessionState.traceId = normalizeTraceId(patch.traceId);
  if (patch.turns !== undefined) runtimeSessionState.turns = normalizeCount(patch.turns);
  if (patch.llmCalls !== undefined) runtimeSessionState.llmCalls = normalizeCount(patch.llmCalls);
  if (patch.toolCalls !== undefined) runtimeSessionState.toolCalls = normalizeCount(patch.toolCalls);
  if (patch.costUsd !== undefined) runtimeSessionState.costUsd = normalizeCost(patch.costUsd);
  if (patch.traceLink !== undefined) runtimeSessionState.traceLink = normalizeString(patch.traceLink);
}

export function recordObsSessionTurn(count = 1): void {
  runtimeSessionState.turns += normalizeCount(count);
}

export function recordObsSessionLlmCall(count = 1): void {
  runtimeSessionState.llmCalls += normalizeCount(count);
}

export function recordObsSessionToolCall(count = 1): void {
  runtimeSessionState.toolCalls += normalizeCount(count);
}

export function recordObsSessionCost(costUsd: number | undefined): void {
  if (costUsd === undefined) return;
  runtimeSessionState.costUsd = normalizeCost(runtimeSessionState.costUsd + normalizeCost(costUsd));
}

export function clearObsSessionRuntimeState(): void {
  replaceObsSessionRuntimeState(createEmptyObsSessionRuntimeState());
}

export function buildObsSessionTraceLink(traceId: string | undefined, traceUrlTemplate: string | undefined): string | undefined {
  const template = normalizeString(traceUrlTemplate);
  if (!traceId || !template) return undefined;

  if (template.includes("{{traceId}}")) return template.replaceAll("{{traceId}}", encodeURIComponent(traceId));
  if (template.includes("${traceId}")) return template.replaceAll("${traceId}", encodeURIComponent(traceId));
  if (template.includes("{traceId}")) return template.replaceAll("{traceId}", encodeURIComponent(traceId));
  if (template.includes("$traceId")) return template.replaceAll("$traceId", encodeURIComponent(traceId));
  if (template.includes("%TRACE_ID%")) return template.replaceAll("%TRACE_ID%", encodeURIComponent(traceId));
  if (template.includes("__TRACE_ID__")) return template.replaceAll("__TRACE_ID__", encodeURIComponent(traceId));
  if (template.includes("...")) return template.replaceAll("...", encodeURIComponent(traceId));
  return undefined;
}

class ObsSessionCommand {
  readonly #options: RegisterObsSessionCommandOptions;

  constructor(options: RegisterObsSessionCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsSessionCommandContext): Promise<void> {
    await handleObsSessionCommand(args, ctx, this.#options);
  }
}

async function resolveObsSessionSnapshot(
  ctx: ObsSessionCommandContext,
  options: RegisterObsSessionCommandOptions,
): Promise<ObsSessionSnapshot> {
  if (options.getSession) return options.getSession(ctx);
  return getLocalObsSessionSnapshot();
}

function replaceObsSessionRuntimeState(state: MutableObsSessionRuntimeState): void {
  runtimeSessionState.sessionId = state.sessionId;
  runtimeSessionState.traceId = state.traceId;
  runtimeSessionState.turns = state.turns;
  runtimeSessionState.llmCalls = state.llmCalls;
  runtimeSessionState.toolCalls = state.toolCalls;
  runtimeSessionState.costUsd = state.costUsd;
  runtimeSessionState.traceLink = state.traceLink;
}

function createEmptyObsSessionRuntimeState(): MutableObsSessionRuntimeState {
  return {
    turns: 0,
    llmCalls: 0,
    toolCalls: 0,
    costUsd: 0,
  };
}

function normalizeObsSessionSnapshot(snapshot: ObsSessionSnapshot): ObsSessionSnapshot {
  return {
    sessionId: normalizeString(snapshot.sessionId),
    traceId: normalizeTraceId(snapshot.traceId),
    turns: normalizeCount(snapshot.turns),
    llmCalls: normalizeCount(snapshot.llmCalls),
    toolCalls: normalizeCount(snapshot.toolCalls),
    costUsd: normalizeCost(snapshot.costUsd),
    traceLink: normalizeString(snapshot.traceLink),
  };
}

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeTraceId(value: string | undefined): string | undefined {
  const trimmed = normalizeString(value);
  if (!trimmed || !traceIdPattern.test(trimmed) || /^0+$/u.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

function normalizeCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

function normalizeCost(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function formatUsd(value: number): string {
  return `$${normalizeCost(value).toFixed(2)}`;
}

function isObsSessionRequest(args: string): boolean {
  return isExactObsSubcommandRequest(args, OBS_SESSION_SUBCOMMAND);
}

async function notifySession(
  ctx: ObsSessionCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): Promise<void> {
  await ctx.ui?.notify?.(message, type);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
