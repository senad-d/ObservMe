import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadSessionConfigOptions } from "../config/load-config.ts";
import { loadSessionConfig } from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import { createGrafanaQueryClient, type GrafanaFetch } from "../query/grafana.ts";
import { normalizeObservMeSessionId } from "../safety/sensitive-input.ts";
import type { TimeRange, TraceSummary } from "../query/tempo.ts";
import {
  completeObsSubcommand,
  missingObsOptionValueMessage,
  obsUsageWithError,
  parseObsSubcommandArgs,
  unknownObsOptionMessage,
} from "./obs-args.ts";
import { formatObsCommandFailure, readObsDiagnosticMessage, type ObsCommandRecoveryHint } from "./obs-diagnostics.ts";
import { searchTempo } from "../query/tempo.ts";
import { COMMON_SPAN_ATTRIBUTES } from "../semconv/attributes.ts";
import type { ObsSessionSnapshot } from "./obs-session.ts";
import { getLocalObsSessionSnapshot } from "./obs-session.ts";

export interface ObsTraceCommandContext {
  readonly cwd?: string;
  readonly ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export type ObsTraceScope = "current-session" | "last-turn" | "session";
export type ObsTraceSource = "runtime" | "tempo";
export type ObsTraceConfigLoader = (options: LoadSessionConfigOptions) => Promise<ObservMeConfig>;
export type ObsTraceSessionSnapshot = Pick<ObsSessionSnapshot, "sessionId" | "traceId" | "turns">;
export type ObsTraceSessionProvider = (
  ctx: ObsTraceCommandContext,
) => Promise<ObsTraceSessionSnapshot> | ObsTraceSessionSnapshot;
export type ObsTraceSessionTraceResolver = (
  sessionId: string,
  ctx: ObsTraceCommandContext,
  config: ObservMeConfig,
) => Promise<string | undefined> | string | undefined;
export type ObsTraceProvider = (
  ctx: ObsTraceCommandContext,
  request: ObsTraceRequest,
) => Promise<ObsTraceSnapshot> | ObsTraceSnapshot;

export interface ObsTraceRequest {
  readonly scope: ObsTraceScope;
  readonly sessionId?: string;
}

export interface ObsTraceSnapshot {
  readonly scope: ObsTraceScope;
  readonly source: ObsTraceSource;
  readonly traceId: string;
  readonly traceLink: string;
  readonly sessionId?: string;
}

export interface ObsTraceSnapshotOptions {
  readonly loadConfig?: ObsTraceConfigLoader;
  readonly fetch?: GrafanaFetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly configDirName?: string;
  readonly getSession?: ObsTraceSessionProvider;
  readonly resolveSessionTraceId?: ObsTraceSessionTraceResolver;
  readonly searchRangeHours?: number;
  readonly now?: () => Date;
}

export interface RegisterObsTraceCommandOptions extends ObsTraceSnapshotOptions {
  readonly getTrace?: ObsTraceProvider;
}

interface ObsTraceTarget {
  readonly scope: ObsTraceScope;
  readonly source: ObsTraceSource;
  readonly traceId: string;
  readonly sessionId?: string;
}

export interface ParsedObsTraceRequest {
  readonly request?: ObsTraceRequest;
  readonly error?: string;
}

const OBS_COMMAND_NAME = "obs";
const OBS_TRACE_SUBCOMMAND = "trace";
const OBS_TRACE_USAGE = "Usage: /obs trace [--last-turn|--session <session-id>]";
const OBS_TRACE_TEMPO_ERROR_NEXT_ACTION = "run /obs health and verify query.grafana.url, Grafana credentials, and the Tempo datasource UID.";
const OBS_TRACE_SESSION_ERROR_NEXT_ACTION = "wait for a Pi turn or query a generated session id with /obs trace --session <session-id>.";
const OBS_TRACE_NOT_FOUND_NEXT_ACTION = "check the session id, wait for trace export, then verify Tempo datasource with /obs health.";
const OBS_TRACE_ACTIVE_SESSION_NOTE = "Trace visibility: active sessions may show ended child spans before the root pi.session span; the root is exported after session_shutdown.";
const DEFAULT_TRACE_SEARCH_RANGE_HOURS = 24;
const millisecondsPerHour = 60 * 60 * 1000;
const defaultObsTraceRequest = { scope: "current-session" } as const satisfies ObsTraceRequest;

export function registerObsTraceCommand(pi: ExtensionAPI, options: RegisterObsTraceCommandOptions = {}): void {
  const command = new ObsTraceCommand(options);

  pi.registerCommand(OBS_COMMAND_NAME, {
    description: "Show an ObservMe Grafana trace link. Usage: /obs trace [--last-turn|--session <session-id>]",
    getArgumentCompletions: getObsTraceCommandArgumentCompletions,
    handler: command.handle.bind(command),
  });
}

export async function handleObsTraceCommand(
  args: string,
  ctx: ObsTraceCommandContext,
  options: RegisterObsTraceCommandOptions = {},
): Promise<void> {
  const parsed = parseObsTraceArgsForSubcommand(args, OBS_TRACE_SUBCOMMAND);

  if (!parsed.request) {
    await notifyTrace(ctx, obsUsageWithError(OBS_TRACE_USAGE, parsed.error), "warning");
    return;
  }

  const request = parsed.request;

  try {
    const snapshot = await resolveObsTraceSnapshot(ctx, request, options);
    await notifyTrace(ctx, renderObsTrace(snapshot), "info");
  } catch (error) {
    await notifyTrace(ctx, formatObsCommandFailure("ObservMe trace unavailable", error, resolveObsTraceDiagnostic(error)), "error");
  }
}

export function getObsTraceCommandArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  return completeObsSubcommand(prefix, OBS_TRACE_SUBCOMMAND);
}

export async function getObsTraceSnapshot(
  ctx: ObsTraceCommandContext,
  request: ObsTraceRequest = defaultObsTraceRequest,
  options: ObsTraceSnapshotOptions = {},
): Promise<ObsTraceSnapshot> {
  const config = await loadObsTraceConfig(ctx, options);
  const target = await resolveObsTraceTarget(ctx, request, config, options);
  const client = createGrafanaQueryClient(config, { fetch: options.fetch });
  const traceLink = client.getTraceLink(target.traceId);

  return { ...target, traceLink };
}

export async function resolveObsTraceSnapshot(
  ctx: ObsTraceCommandContext,
  request: ObsTraceRequest,
  options: RegisterObsTraceCommandOptions,
): Promise<ObsTraceSnapshot> {
  if (options.getTrace) return options.getTrace(ctx, request);
  return getObsTraceSnapshot(ctx, request, options);
}

export function renderObsTrace(snapshot: ObsTraceSnapshot): string {
  return renderObsTraceWithTitle(snapshot, "Trace link");
}

export function renderObsTraceWithTitle(snapshot: ObsTraceSnapshot, title: string): string {
  const lines = [`${title} (${formatObsTraceScope(snapshot.scope)})`];
  const sessionId = normalizeOptionalString(snapshot.sessionId);

  if (sessionId) lines.push(`Session: ${sessionId}`);
  lines.push(`Trace: ${snapshot.traceId}`);
  lines.push(`Open trace: ${snapshot.traceLink}`);
  const visibilityNote = formatObsTraceVisibilityNote(snapshot);
  if (visibilityNote) lines.push(visibilityNote);
  return lines.join("\n");
}

export function parseObsTraceRequestForSubcommand(args: string, subcommand: string): ObsTraceRequest | undefined {
  return parseObsTraceArgsForSubcommand(args, subcommand).request;
}

export function parseObsTraceArgsForSubcommand(args: string, subcommand: string): ParsedObsTraceRequest {
  const parsed = parseObsSubcommandArgs(args, subcommand);
  if (!parsed.matched) return {};
  return parseObsTraceOptions(parsed.values);
}

class ObsTraceCommand {
  readonly #options: RegisterObsTraceCommandOptions;

  constructor(options: RegisterObsTraceCommandOptions) {
    this.#options = options;
  }

  async handle(args: string, ctx: ObsTraceCommandContext): Promise<void> {
    await handleObsTraceCommand(args, ctx, this.#options);
  }
}

async function loadObsTraceConfig(
  ctx: ObsTraceCommandContext,
  options: ObsTraceSnapshotOptions,
): Promise<ObservMeConfig> {
  const loadConfig = options.loadConfig ?? loadSessionConfig;
  return loadConfig({ ctx, cwd: ctx.cwd, configDirName: options.configDirName, env: options.env });
}

async function resolveObsTraceTarget(
  ctx: ObsTraceCommandContext,
  request: ObsTraceRequest,
  config: ObservMeConfig,
  options: ObsTraceSnapshotOptions,
): Promise<ObsTraceTarget> {
  const session = await resolveObsTraceSession(ctx, options);

  if (request.scope === "current-session") return resolveCurrentSessionTraceTarget(session);
  if (request.scope === "last-turn") return resolveLastTurnTraceTarget(session);
  return resolveRequestedSessionTraceTarget(ctx, request, session, config, options);
}

async function resolveObsTraceSession(
  ctx: ObsTraceCommandContext,
  options: ObsTraceSnapshotOptions,
): Promise<ObsTraceSessionSnapshot> {
  if (options.getSession) return options.getSession(ctx);
  return getLocalObsSessionSnapshot();
}

function resolveCurrentSessionTraceTarget(session: ObsTraceSessionSnapshot): ObsTraceTarget {
  const traceId = normalizeOptionalString(session.traceId);
  if (!traceId) throw new Error("No current ObservMe session trace is available.");

  return {
    scope: "current-session",
    source: "runtime",
    sessionId: normalizeOptionalString(session.sessionId),
    traceId,
  };
}

function resolveLastTurnTraceTarget(session: ObsTraceSessionSnapshot): ObsTraceTarget {
  const traceId = normalizeOptionalString(session.traceId);

  if (normalizeTurnCount(session.turns) < 1) throw new Error("No last-turn ObservMe trace is available yet.");
  if (!traceId) throw new Error("No last-turn ObservMe trace is available yet.");

  return {
    scope: "last-turn",
    source: "runtime",
    sessionId: normalizeOptionalString(session.sessionId),
    traceId,
  };
}

async function resolveRequestedSessionTraceTarget(
  ctx: ObsTraceCommandContext,
  request: ObsTraceRequest,
  session: ObsTraceSessionSnapshot,
  config: ObservMeConfig,
  options: ObsTraceSnapshotOptions,
): Promise<ObsTraceTarget> {
  const sessionId = normalizeObsTraceSessionId(request.sessionId);
  const localTraceId = resolveLocalTraceIdForSession(sessionId, session);

  if (localTraceId) return { scope: "session", source: "runtime", sessionId, traceId: localTraceId };

  const traceId = await resolveSessionTraceId(sessionId, ctx, config, options);
  if (!traceId) throw new Error("No trace was found for the requested ObservMe session id.");
  return { scope: "session", source: "tempo", sessionId, traceId };
}

async function resolveSessionTraceId(
  sessionId: string,
  ctx: ObsTraceCommandContext,
  config: ObservMeConfig,
  options: ObsTraceSnapshotOptions,
): Promise<string | undefined> {
  if (options.resolveSessionTraceId) return normalizeOptionalString(await options.resolveSessionTraceId(sessionId, ctx, config));
  return searchSessionTraceId(config, sessionId, options);
}

async function searchSessionTraceId(
  config: ObservMeConfig,
  sessionId: string,
  options: ObsTraceSnapshotOptions,
): Promise<string | undefined> {
  const traces = await searchTempo(
    config,
    { [COMMON_SPAN_ATTRIBUTES.PI_SESSION_ID]: sessionId },
    createObsTraceSearchRange(options),
    { fetch: options.fetch },
  );

  return readFirstTraceId(traces);
}

function readFirstTraceId(traces: readonly TraceSummary[]): string | undefined {
  return traces.map(trace => normalizeOptionalString(trace.traceId)).find(isString);
}

function createObsTraceSearchRange(options: ObsTraceSnapshotOptions): TimeRange {
  const to = options.now?.() ?? new Date();
  const rangeHours = normalizeSearchRangeHours(options.searchRangeHours);
  return { from: new Date(to.getTime() - rangeHours * millisecondsPerHour), to };
}

function normalizeSearchRangeHours(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TRACE_SEARCH_RANGE_HOURS;
  return value;
}

function resolveLocalTraceIdForSession(sessionId: string, session: ObsTraceSessionSnapshot): string | undefined {
  const currentSessionId = normalizeOptionalString(session.sessionId);
  const traceId = normalizeOptionalString(session.traceId);

  if (!currentSessionId || currentSessionId !== sessionId) return undefined;
  return traceId;
}

function normalizeObsTraceSessionId(value: string | undefined): string {
  return normalizeObservMeSessionId(value, { emptyMessage: "Unsafe ObservMe session id: empty values are not query inputs." });
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTurnCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

function parseObsTraceOptions(tokens: readonly string[]): ParsedObsTraceRequest {
  if (tokens.length === 0) return { request: defaultObsTraceRequest };

  let request: ObsTraceRequest | undefined;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    const normalizedToken = token.toLowerCase();

    if (isCurrentSessionToken(normalizedToken)) {
      if (request) return { error: `Repeated or conflicting option: ${token}.` };
      request = defaultObsTraceRequest;
      index += 1;
      continue;
    }

    if (normalizedToken === "--last-turn") {
      if (request) return { error: `Repeated or conflicting option: ${token}.` };
      request = { scope: "last-turn" };
      index += 1;
      continue;
    }

    if (normalizedToken === "--session") {
      if (request) return { error: `Repeated or conflicting option: ${token}.` };
      const sessionId = tokens[index + 1];
      if (!sessionId || sessionId.startsWith("--")) return { error: missingObsOptionValueMessage("--session") };
      request = { scope: "session", sessionId };
      index += 2;
      continue;
    }

    if (normalizedToken.startsWith("--session=")) {
      if (request) return { error: "Repeated or conflicting option: --session." };
      const sessionId = token.slice("--session=".length);
      if (!sessionId) return { error: missingObsOptionValueMessage("--session") };
      request = { scope: "session", sessionId };
      index += 1;
      continue;
    }

    return { error: unknownObsOptionMessage(token) };
  }

  return { request: request ?? defaultObsTraceRequest };
}

function isCurrentSessionToken(token: string): boolean {
  return token === "--current-session";
}

function formatObsTraceScope(scope: ObsTraceScope): string {
  if (scope === "current-session") return "current session";
  if (scope === "last-turn") return "last turn";
  return "session";
}

function formatObsTraceVisibilityNote(snapshot: ObsTraceSnapshot): string | undefined {
  if (snapshot.source !== "runtime") return undefined;
  return OBS_TRACE_ACTIVE_SESSION_NOTE;
}

function isString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

async function notifyTrace(
  ctx: ObsTraceCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): Promise<void> {
  await ctx.ui.notify(message, type);
}

function resolveObsTraceDiagnostic(error: unknown): ObsCommandRecoveryHint {
  const message = readObsDiagnosticMessage(error);

  if (isObsTraceSessionErrorMessage(message)) return { subsystem: "Session trace", nextAction: OBS_TRACE_SESSION_ERROR_NEXT_ACTION };
  if (isObsTraceNotFoundMessage(message)) return { subsystem: "Tempo", nextAction: OBS_TRACE_NOT_FOUND_NEXT_ACTION };
  return { subsystem: "Tempo", nextAction: OBS_TRACE_TEMPO_ERROR_NEXT_ACTION };
}

function isObsTraceSessionErrorMessage(message: string): boolean {
  return /No current ObservMe session trace|No last-turn ObservMe trace|Unsafe ObservMe session id/u.test(message);
}

function isObsTraceNotFoundMessage(message: string): boolean {
  return /No trace was found/u.test(message);
}
