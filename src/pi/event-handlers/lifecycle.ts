import { open } from "node:fs/promises";
import type {
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  clearObsAgentsRuntimeState,
  startObsAgentsRuntimeState,
} from "../../commands/obs-agents-runtime.ts";
import {
  clearObsSessionRuntimeState,
  startObsSessionRuntimeState,
} from "../../commands/obs-session.ts";
import {
  clearObsStatusExportError,
  recordObsStatusExportResult,
  updateObsStatusRuntimeState,
} from "../../commands/obs-status.ts";
import { bootstrapProjectObservMeConfig } from "../../config/bootstrap-project-config.ts";
import type {
  LoadSessionConfigResult,
  SessionConfigDiagnostics,
  SessionConfigRejectedSource,
} from "../../config/load-config.ts";
import {
  loadSessionConfig,
  loadSessionConfigWithDiagnostics,
} from "../../config/load-config.ts";
import type { ObservMeConfig } from "../../config/schema.ts";
import { emitUnsafeCaptureWarning, normalizeConfigRejectionDiagnostic } from "../../config/validate.ts";
import { EXTENSION_STATUS_KEY, EXTENSION_STATUS_VALUE } from "../../constants.ts";
import { notifyBestEffort } from "../../diagnostics/notify.ts";
import { ObservMeOtelStartupError, type OtelStartupCleanupRetry } from "../../otel/sdk.ts";
import type { BoundedOtelOperationResult, OtelOperationSettlement } from "../../otel/shutdown.ts";
import {
  AGENT_LINEAGE_ATTRIBUTES,
  CONFIG_ATTRIBUTES,
  LOG_ATTRIBUTES,
  SESSION_ATTRIBUTES,
  WORKFLOW_ATTRIBUTES,
} from "../../semconv/attributes.ts";
import { createOrphanAgentMetricLabels, LOG_EVENT_NAMES } from "../../semconv/metrics.ts";
import { SPAN_NAMES } from "../../semconv/spans.ts";
import { createAgentLineageContext, normalizeAgentRoleMetricLabel } from "../agent-lineage.ts";
import {
  buildCommonSessionSpanAttributes,
  buildLineageMetricSafeLogAttributes,
  emitLifecycleLog,
  emitStructuredLog,
  endActiveSpan,
  endAllActiveSpans,
  errorClass,
  hashValue,
  isMissingFileError,
  isRecord,
  metricLabels,
  normalizeMetricValue,
  readBoolean,
  readInteger,
  readSpanId,
  readSpanTraceId,
  readString,
  resolveModelId,
  resolveModelProvider,
  resolveSessionFilePath,
  resolveSessionId,
  resolveSessionTraceParent,
  resolveThinkingLevel,
  startActiveRootSpan,
  withoutUndefinedAttributes,
} from "../handler-internals.ts";
import {
  isRootWorkflow,
  monotonicNowMs,
  startSessionTelemetry,
} from "../handler-runtime.ts";
import {
  appendSessionCorrelationEntry,
  readLatestSessionCorrelation,
} from "../session-correlation.ts";
import { interruptActiveSubagentOperations } from "../subagent-spawn.ts";
import type { HandlerRegistrar, SerializedLifecycleQueue } from "../handler-runtime.ts";
import type {
  AttributeMap,
  HandlerSessionState,
  LoadSessionConfig,
  MinimalSessionCorrelation,
  ObservMeHandlerContext,
  ObservMeTelemetrySession,
  PiHandler,
  RegisterHandlersOptions,
  SessionConfigLoadResult,
  SessionRecoveryHeader,
  StartSessionTelemetry,
  StartupRecoveryState,
  TerminalOutcome,
} from "../handler-types.ts";
import { deriveWorkflowOutcome, setTerminalSpanStatus } from "../terminal-outcome.ts";

export function registerLifecycleHandlers(
  registrar: HandlerRegistrar,
  state: HandlerSessionState,
  options: RegisterHandlersOptions,
  lifecycleQueue: SerializedLifecycleQueue,
): void {
  const loadConfigFn = options.loadConfig ?? loadSessionConfig;
  const startTelemetryFn = options.startTelemetry ?? startSessionTelemetry;
  const startHandler = createSessionStartHandler(state, loadConfigFn, startTelemetryFn, options);
  const shutdownHandler = createSessionShutdownHandler(state);

  registrar.add("session_start", lifecycleQueue.wrap(startHandler));
  registrar.add("session_shutdown", lifecycleQueue.wrap(shutdownHandler));
}

export function buildSessionAttributes(
  event: unknown,
  ctx: ObservMeHandlerContext,
  config: ObservMeConfig,
  lineage: ObservMeTelemetrySession["lineage"],
  recovery?: StartupRecoveryState,
  initialThinkingLevel?: unknown,
): AttributeMap {
  const sessionManager = ctx.sessionManager;
  const managerHeader = normalizeSessionHeader(sessionManager?.getHeader());
  const header = managerHeader ?? recovery?.header;
  const cwd = sessionManager?.getCwd() ?? header?.cwd ?? ctx.cwd ?? process.cwd();
  const sessionId = sessionManager?.getSessionId() ?? header?.id ?? resolveSessionId(event, ctx, lineage);
  const parentSessionId = header?.parentSession ?? lineage.parentSessionId;
  const sessionFile = sessionManager?.getSessionFile() ?? recovery?.sessionFile ?? resolveSessionFilePath(event, ctx);
  const sessionName = sessionManager
    ? sessionManager.getSessionName() ?? "unknown"
    : readString(event, "sessionName") ?? readString(event, "name") ?? "unknown";
  const persisted = sessionManager
    ? sessionFile !== undefined
    : readBoolean(event, "persisted") ?? recovery?.resumed ?? false;

  return withoutUndefinedAttributes({
    [SESSION_ATTRIBUTES.PI_SESSION_ID]: sessionId,
    [SESSION_ATTRIBUTES.PI_SESSION_NAME]: sessionName,
    [SESSION_ATTRIBUTES.PI_SESSION_CWD_HASH]: hashValue(cwd, config),
    [SESSION_ATTRIBUTES.PI_SESSION_PARENT_SESSION_HASH]: parentSessionId ? hashValue(parentSessionId, config) : "",
    [SESSION_ATTRIBUTES.PI_SESSION_PERSISTED]: persisted,
    [SESSION_ATTRIBUTES.PI_SESSION_FILE_HASH]: sessionFile ? hashValue(sessionFile, config) : "",
    [SESSION_ATTRIBUTES.PI_SESSION_VERSION]: readString(header, "version") ?? "unknown",
    [SESSION_ATTRIBUTES.PI_MODEL_PROVIDER_CURRENT]: resolveModelProvider(ctx),
    [SESSION_ATTRIBUTES.PI_MODEL_ID_CURRENT]: resolveModelId(ctx),
    [SESSION_ATTRIBUTES.PI_THINKING_LEVEL_CURRENT]: resolveThinkingLevel(initialThinkingLevel),
    ...buildCommonSessionSpanAttributes(sessionId, config, lineage),
  });
}

export async function readSessionHeaderFromFile(sessionFile: string): Promise<SessionRecoveryHeader | undefined> {
  let file;

  try {
    file = await open(sessionFile, "r");
    const buffer = Buffer.alloc(65_536);
    const result = await file.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, result.bytesRead).toString("utf8").split(/\r?\n/u)[0]?.trim();
    if (!firstLine) return undefined;

    return normalizeSessionHeader(JSON.parse(firstLine));
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}

function createSessionStartHandler(
  state: HandlerSessionState,
  loadConfigFn: LoadSessionConfig,
  startTelemetryFn: StartSessionTelemetry,
  options: RegisterHandlersOptions,
): PiHandler<"session_start"> {
  return handleSessionStart.bind(undefined, state, loadConfigFn, startTelemetryFn, options);
}

async function handleSessionStart(
  state: HandlerSessionState,
  loadConfigFn: LoadSessionConfig,
  startTelemetryFn: StartSessionTelemetry,
  options: RegisterHandlersOptions,
  event: SessionStartEvent,
  ctx: ExtensionContext,
): Promise<void> {
  if (!(await resolvePendingTelemetryCleanupBeforeStart(state, ctx))) return;

  const previousSession = state.session;
  if (previousSession && !(await shutDownPreviousSessionBeforeDuplicateStart(previousSession, ctx, state))) return;

  await ensureProjectConfigForHandler(options, ctx);
  const loadedConfig = await loadSessionConfigForHandler(loadConfigFn, options, ctx);
  const config = loadedConfig.config;
  updateObsStatusRuntimeState({ config, configDiagnostics: loadedConfig.diagnostics });
  clearObsStatusExportError();

  if (!config.enabled) {
    clearDisabledTelemetryRuntimeState(state);
    notifyConfigRejection(ctx, loadedConfig.diagnostics, false);
    await clearExtensionStatus(ctx);
    return;
  }

  await emitUnsafeCaptureWarning(config, ctx);
  const recovery = await resolveStartupRecovery(event, ctx, config, options);
  const recoveryCorrelation = recovery.customCorrelation;
  const lineage = createAgentLineageContext({
    config,
    env: buildRecoveryLineageEnv(config, recoveryCorrelation, options.env),
    trustedParentContext: options.trustedParentContext === true || recoveryCorrelation !== undefined,
    capability: recoveryCorrelation?.capability,
    requireCompletePropagationEnvelope:
      options.requireCompleteParentEnvelope ?? (options.trustedParentContext === true && recoveryCorrelation === undefined),
    failOpenInvalidPropagation: true,
  });
  let session: ObservMeTelemetrySession;
  try {
    session = await startTelemetryFn({
      config,
      lineage,
      now: options.now,
      wallClockNow: options.wallClockNow,
    });
  } catch (error) {
    await handleTelemetryStartupFailure(state, ctx, error);
    return;
  }

  session.now = options.now ?? session.now ?? monotonicNowMs;
  state.session = session;

  try {
    const attributes = buildSessionAttributes(
      event,
      ctx,
      session.config,
      lineage,
      recovery,
      options.getThinkingLevel?.(),
    );
    const labels = metricLabels(session.config, lineage);

    session.sessionAttributes = attributes;
    const traceParent = resolveSessionTraceParent(lineage);
    session.sessionSpan = startActiveRootSpan(session, SPAN_NAMES.PI_SESSION, attributes, "session", traceParent);
    emitConfigRejectionDiagnostic(session, loadedConfig.diagnostics, ctx);
    recordSessionTracePropagationFailure(session, traceParent);
    startObsSessionRuntimeState({
      sessionId: readString(attributes, SESSION_ATTRIBUTES.PI_SESSION_ID),
      traceId: readSpanTraceId(session.sessionSpan),
      config: session.config,
    });
    startObsAgentsRuntimeState({
      lineage,
      agentTree: session.agentTree,
      sessionId: readString(attributes, SESSION_ATTRIBUTES.PI_SESSION_ID),
      traceId: readSpanTraceId(session.sessionSpan),
    });
    session.workflowStartedAtMs = session.now();
    session.metrics.sessionsStarted.add(1, labels);
    session.sessionSpan.addEvent(LOG_EVENT_NAMES.SESSION_STARTED, attributes);
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.SESSION_STARTED, attributes);

    if (isRootWorkflow(lineage)) {
      session.metrics.workflowsStarted.add(1, labels);
      emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_STARTED, attributes);
    }

    ctx.ui?.setStatus?.(EXTENSION_STATUS_KEY, EXTENSION_STATUS_VALUE);
    activateSessionActiveAgent(session, labels);
    if (session.config.agent.writeCorrelationEntry) {
      appendSessionCorrelationEntry(options.appendEntry, lineage, recovery.customCorrelation);
    }
  } catch (error) {
    await cleanUpFailedSessionStart(session, ctx, state);
    throw error;
  }
}

function createSessionShutdownHandler(state: HandlerSessionState): PiHandler<"session_shutdown"> {
  return handleSessionShutdown.bind(undefined, state);
}

async function handleSessionShutdown(
  state: HandlerSessionState,
  event: SessionShutdownEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const session = state.session;
  if (!session) {
    state.integrationSessionPhase = undefined;
    return;
  }

  await shutDownTelemetrySession(session, event, ctx, state);
}

async function resolveStartupRecovery(
  event: unknown,
  ctx: ObservMeHandlerContext,
  config: ObservMeConfig,
  options: RegisterHandlersOptions,
): Promise<StartupRecoveryState> {
  const sessionFile = resolveSessionFilePath(event, ctx);
  const readHeader = options.readSessionHeader ?? readSessionHeaderFromFile;
  let header: SessionRecoveryHeader | undefined;
  if (ctx.sessionManager) {
    header = normalizeSessionHeader(ctx.sessionManager.getHeader());
  } else if (sessionFile) {
    header = await readHeader(sessionFile);
  }
  const customCorrelation = config.agent.writeCorrelationEntry ? readActiveBranchCorrelation(ctx) : undefined;

  return {
    resumed: isExistingSessionStart(event),
    sessionFile,
    header,
    customCorrelation,
  };
}

function buildRecoveryLineageEnv(
  config: ObservMeConfig,
  correlation: MinimalSessionCorrelation | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!correlation) return env;

  return {
    ...env,
    ...definedEnvValue(config.workflow.idEnv, correlation.workflowId),
    ...definedEnvValue(config.agent.idEnv, correlation.agentId),
    ...definedEnvValue(config.agent.parentIdEnv, correlation.parentAgentId),
    ...definedEnvValue(config.agent.rootIdEnv, correlation.rootAgentId),
    ...definedEnvValue(config.agent.parentSessionIdEnv, correlation.parentSessionId),
    ...definedEnvValue(config.agent.depthEnv, recoveryPropagationDepth(correlation)),
    ...definedEnvValue(config.agent.spawnIdEnv, correlation.spawnId),
  };
}

function recoveryPropagationDepth(correlation: MinimalSessionCorrelation): string | undefined {
  if (correlation.depth === undefined) return undefined;
  const parentDepth = correlation.parentAgentId ? Math.max(0, correlation.depth - 1) : correlation.depth;
  return String(parentDepth);
}

function definedEnvValue(name: string, value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined || value === "" ? {} : { [name]: value };
}

function readActiveBranchCorrelation(ctx: ObservMeHandlerContext): StartupRecoveryState["customCorrelation"] {
  try {
    return readLatestSessionCorrelation(ctx.sessionManager?.getBranch());
  } catch {
    return undefined;
  }
}

function normalizeSessionHeader(value: unknown): SessionRecoveryHeader | undefined {
  if (!isRecord(value) || readString(value, "type") !== "session") return undefined;

  return withoutUndefinedObjectValues({
    type: "session",
    version: readString(value, "version") ?? readInteger(value, "version"),
    id: readString(value, "id"),
    timestamp: readString(value, "timestamp"),
    cwd: readString(value, "cwd"),
    parentSession: readString(value, "parentSession"),
  });
}

function withoutUndefinedObjectValues<T extends Record<string, unknown>>(value: T): T {
  const definedEntries: Array<[string, unknown]> = [];
  for (const entry of Object.entries(value)) {
    if (entry[1] !== undefined) definedEntries.push(entry);
  }
  return Object.fromEntries(definedEntries) as T;
}

function isExistingSessionStart(event: unknown): boolean {
  const reason = readString(event, "reason");
  return reason === "resume" || reason === "reload" || readBoolean(event, "resumed") === true || readBoolean(event, "existingSession") === true;
}

async function loadSessionConfigForHandler(
  loadConfigFn: LoadSessionConfig,
  options: RegisterHandlersOptions,
  ctx: ObservMeHandlerContext,
): Promise<SessionConfigLoadResult> {
  const loadOptions = { ctx, cwd: ctx.cwd, configDirName: options.configDirName, env: options.env };

  if (!options.loadConfig) return loadSessionConfigWithDiagnostics(loadOptions);

  const loaded = await loadConfigFn(loadOptions);
  return isLoadSessionConfigResult(loaded)
    ? normalizeLoadSessionConfigResult(loaded)
    : { config: loaded, diagnostics: undefined };
}

function isLoadSessionConfigResult(value: ObservMeConfig | LoadSessionConfigResult): value is LoadSessionConfigResult {
  return isRecord(value) && isRecord(value.config) && isRecord(value.diagnostics);
}

function normalizeLoadSessionConfigResult(loaded: LoadSessionConfigResult): LoadSessionConfigResult {
  if (!loaded.diagnostics.rejection) return loaded;

  return {
    config: loaded.config,
    diagnostics: {
      ...loaded.diagnostics,
      rejectedSources: normalizeRejectedConfigSources(loaded.diagnostics.rejectedSources),
      safeFallbackApplied: loaded.diagnostics.safeFallbackApplied === true,
      rejection: normalizeConfigRejectionDiagnostic(loaded.diagnostics.rejection),
    },
  };
}

function normalizeRejectedConfigSources(value: unknown): SessionConfigRejectedSource[] {
  if (!Array.isArray(value)) return [];

  const sources: SessionConfigRejectedSource[] = [];
  for (const source of value) {
    if (!isSessionConfigRejectedSource(source) || sources.includes(source)) continue;
    sources.push(source);
  }
  return sources;
}

function isSessionConfigRejectedSource(value: unknown): value is SessionConfigRejectedSource {
  return (
    value === "global" ||
    value === "trusted_project" ||
    value === "project_env" ||
    value === "process_environment"
  );
}

async function ensureProjectConfigForHandler(
  options: RegisterHandlersOptions,
  ctx: ObservMeHandlerContext,
): Promise<void> {
  // Pi emits session_start for startup, reload, new, resume, and fork flows. ObservMe keeps
  // bootstrap idempotent across all of them: create one inactive setup guide for trusted projects,
  // then never overwrite it or an intentionally adopted project configuration.
  await bootstrapProjectObservMeConfig(ctx, {
    configDirName: options.configDirName,
    ensureProjectConfig: options.ensureProjectConfig,
  });
}

async function shutDownPreviousSessionBeforeDuplicateStart(
  session: ObservMeTelemetrySession,
  ctx: ObservMeHandlerContext,
  state: HandlerSessionState,
): Promise<boolean> {
  runTelemetryBookkeeping(recordDuplicateSessionStart.bind(undefined, session));

  try {
    await shutDownTelemetrySession(session, duplicateSessionStartShutdownEvent(), ctx, state);
    if (!state.otelOperationOwnership.hasUnresolvedOperations) return true;
    notifyPendingTelemetryCleanupOnce(state, ctx);
    return false;
  } catch (error) {
    retainControllerOperationFailure(state, session, "shutdown", error);
    clearObsSessionRuntimeState();
    clearObsAgentsRuntimeState();
    state.session = undefined;
    recordDuplicateSessionStartShutdownError(session, error);
    notifyPendingTelemetryCleanupOnce(state, ctx);
    return false;
  }
}

function recordDuplicateSessionStart(session: ObservMeTelemetrySession): void {
  emitLifecycleLog(
    session.logger,
    LOG_EVENT_NAMES.SESSION_DUPLICATE_START,
    buildDuplicateSessionStartAttributes(session),
  );
}

async function resolvePendingTelemetryCleanupBeforeStart(
  state: HandlerSessionState,
  ctx: ObservMeHandlerContext,
): Promise<boolean> {
  if (await state.otelOperationOwnership.resolveBeforeStart()) return true;
  notifyPendingTelemetryCleanupOnce(state, ctx);
  return false;
}

function notifyPendingTelemetryCleanupOnce(
  state: HandlerSessionState,
  ctx: ObservMeHandlerContext,
): void {
  if (!state.otelOperationOwnership.takeStartupDiagnostic()) return;
  notifyPendingTelemetryCleanup(ctx);
}

function notifyPendingTelemetryCleanup(ctx: ObservMeHandlerContext): void {
  notifyBestEffort(
    ctx,
    "ObservMe telemetry startup was deferred because prior OTEL flush or shutdown cleanup is still unresolved.",
    "warning",
  );
}

function buildDuplicateSessionStartAttributes(session: ObservMeTelemetrySession): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildLineageMetricSafeLogAttributes(session),
    reason: "active_session_replaced_before_new_start",
  });
}

function duplicateSessionStartShutdownEvent(): SessionShutdownEvent {
  return {
    type: "session_shutdown",
    reason: "reload",
  };
}

function recordDuplicateSessionStartShutdownError(session: ObservMeTelemetrySession, error: unknown): void {
  runTelemetryBookkeeping(
    session.metrics.handlerErrors.add.bind(session.metrics.handlerErrors, 1, {
      operation: "session_start.duplicate_shutdown",
    }),
  );
  runTelemetryBookkeeping(
    emitLifecycleLog.bind(
      undefined,
      session.logger,
      LOG_EVENT_NAMES.HANDLER_FAILED,
      handlerErrorAttributes("session_start.duplicate_shutdown", error),
      "ERROR",
    ),
  );
}

async function cleanUpFailedSessionStart(
  session: ObservMeTelemetrySession,
  ctx: ObservMeHandlerContext,
  state: HandlerSessionState,
): Promise<void> {
  const labels = metricLabels(session.config, session.lineage);
  state.integrationSessionPhase = "closing";
  recordFailedSessionStartCleanupBookkeeping(session, labels);
  await clearExtensionStatus(ctx);

  try {
    await cleanUpTelemetryController(state, session);
  } finally {
    finalizeTelemetrySessionCleanup(session, state);
  }
}

async function shutDownTelemetrySession(
  session: ObservMeTelemetrySession,
  event: SessionShutdownEvent,
  ctx: ObservMeHandlerContext,
  state: HandlerSessionState,
): Promise<BoundedOtelOperationResult> {
  state.integrationSessionPhase = "closing";
  const labels = metricLabels(session.config, session.lineage);
  const outcome = deriveWorkflowOutcome(event, session.workflowOutcome);
  const shutdownAttributes = buildShutdownAttributes(event, session, outcome);
  recordSessionShutdownBookkeeping(session, shutdownAttributes, outcome, labels);
  await clearExtensionStatus(ctx);

  try {
    return await cleanUpTelemetryController(state, session);
  } finally {
    finalizeTelemetrySessionCleanup(session, state);
  }
}

function recordFailedSessionStartCleanupBookkeeping(
  session: ObservMeTelemetrySession,
  labels: Record<string, string>,
): void {
  runTelemetryBookkeeping(deactivateSessionActiveAgent.bind(undefined, session, labels));
  runTelemetryBookkeeping(interruptActiveSubagentOperations.bind(undefined, session));
  runTelemetryBookkeeping(endAllActiveSpans.bind(undefined, session));
  runTelemetryBookkeeping(endActiveSpan.bind(undefined, session, session.sessionSpan));
}

function recordSessionShutdownBookkeeping(
  session: ObservMeTelemetrySession,
  shutdownAttributes: AttributeMap,
  outcome: TerminalOutcome,
  labels: Record<string, string>,
): void {
  runTelemetryBookkeeping(deactivateSessionActiveAgent.bind(undefined, session, labels));
  runTelemetryBookkeeping(session.metrics.sessionsShutdown.add.bind(session.metrics.sessionsShutdown, 1, labels));
  runTelemetryBookkeeping(
    recordWorkflowShutdownTelemetry.bind(undefined, session, shutdownAttributes, outcome, labels),
  );
  runTelemetryBookkeeping(interruptActiveSubagentOperations.bind(undefined, session));
  runTelemetryBookkeeping(endAllActiveSpans.bind(undefined, session));
  runTelemetryBookkeeping(recordSessionShutdownSpanEvent.bind(undefined, session, shutdownAttributes));
  runTelemetryBookkeeping(recordSessionWorkflowOutcomeAttribute.bind(undefined, session, outcome));
  runTelemetryBookkeeping(recordSessionTerminalSpanStatus.bind(undefined, session, outcome));
  runTelemetryBookkeeping(endActiveSpan.bind(undefined, session, session.sessionSpan));
}

function recordSessionShutdownSpanEvent(
  session: ObservMeTelemetrySession,
  shutdownAttributes: AttributeMap,
): void {
  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.SESSION_SHUTDOWN, shutdownAttributes);
}

function recordSessionWorkflowOutcomeAttribute(
  session: ObservMeTelemetrySession,
  outcome: TerminalOutcome,
): void {
  session.sessionSpan?.setAttribute(WORKFLOW_ATTRIBUTES.PI_WORKFLOW_STATUS, outcome);
}

function recordSessionTerminalSpanStatus(
  session: ObservMeTelemetrySession,
  outcome: TerminalOutcome,
): void {
  if (session.sessionSpan) setTerminalSpanStatus(session.sessionSpan, outcome);
}

function runTelemetryBookkeeping(operation: () => void): void {
  try {
    operation();
  } catch {
    return;
  }
}

async function cleanUpTelemetryController(
  state: HandlerSessionState,
  session: ObservMeTelemetrySession,
): Promise<BoundedOtelOperationResult> {
  let flushFailed = false;
  let flushError: unknown;
  try {
    await recordOwnedControllerOperation(state, session, "flush");
  } catch (error) {
    flushFailed = true;
    flushError = error;
  }

  const shutdownResult = await recordOwnedControllerOperation(state, session, "shutdown");
  if (flushFailed) throw flushError;
  return shutdownResult;
}

function finalizeTelemetrySessionCleanup(
  session: ObservMeTelemetrySession,
  state: HandlerSessionState,
): void {
  runTelemetryBookkeeping(disposeSessionActiveAgentLease.bind(undefined, session));
  clearTelemetrySessionRuntimeState(session, state);
}

function activateSessionActiveAgent(
  session: ObservMeTelemetrySession,
  labels: Record<string, string>,
): void {
  if (session.activeAgentRecorded) return;

  session.metrics.activeAgents.add(1, labels);
  session.activeAgentRecorded = true;
  session.activeAgentLease?.activate();
}

function deactivateSessionActiveAgent(
  session: ObservMeTelemetrySession,
  labels: Record<string, string>,
): void {
  try {
    session.activeAgentLease?.deactivate();
  } finally {
    if (session.activeAgentRecorded) {
      session.activeAgentRecorded = false;
      session.metrics.activeAgents.add(-1, labels);
    }
  }
}

function disposeSessionActiveAgentLease(session: ObservMeTelemetrySession): void {
  session.activeAgentLease?.dispose();
}

function clearTelemetrySessionRuntimeState(
  session: ObservMeTelemetrySession,
  state: HandlerSessionState,
): void {
  clearObsSessionRuntimeState();
  clearObsAgentsRuntimeState();
  if (state.session === session) {
    state.session = undefined;
    state.integrationSessionPhase = undefined;
  }
}

function clearDisabledTelemetryRuntimeState(state: HandlerSessionState): void {
  state.session = undefined;
  state.integrationSessionPhase = undefined;
  clearObsSessionRuntimeState();
  clearObsAgentsRuntimeState();
}

async function handleTelemetryStartupFailure(
  state: HandlerSessionState,
  ctx: ObservMeHandlerContext,
  error: unknown,
): Promise<void> {
  if (!(error instanceof ObservMeOtelStartupError)) {
    clearDisabledTelemetryRuntimeState(state);
    throw error;
  }

  retainTelemetryStartupCleanup(state, error);
  clearDisabledTelemetryRuntimeState(state);
  tryRecordObsStatusExportResult({ operation: "startup", error });
  await clearExtensionStatus(ctx);
  notifyTelemetryStartupFailure(ctx, error.message);
}

function retainTelemetryStartupCleanup(
  state: HandlerSessionState,
  error: ObservMeOtelStartupError,
): void {
  const cleanup = error.cleanup;
  if (!cleanup) return;

  const retryCleanup = error.retryCleanup ?? retryUnavailableStartupCleanup.bind(undefined, cleanup.operation);
  state.otelOperationOwnership.retain(
    cleanup,
    recordStartupCleanupRetry.bind(undefined, retryCleanup, cleanup.operation),
    recordLateStartupCleanupSettlement,
  );
}

async function recordStartupCleanupRetry(
  retryCleanup: OtelStartupCleanupRetry,
  operation: BoundedOtelOperationResult["operation"],
): Promise<BoundedOtelOperationResult> {
  try {
    const result = await retryCleanup();
    tryRecordObsStatusExportResult(result);
    return result;
  } catch (error) {
    const result = { operation, completed: false, timedOut: false, error } as const;
    tryRecordObsStatusExportResult(result);
    return result;
  }
}

function retryUnavailableStartupCleanup(
  operation: BoundedOtelOperationResult["operation"],
): Promise<BoundedOtelOperationResult> {
  return Promise.resolve({
    operation,
    completed: false,
    timedOut: false,
    error: new Error("ObservMe OTEL startup cleanup cannot be retried by this telemetry factory."),
  });
}

function recordLateStartupCleanupSettlement(settlement: OtelOperationSettlement): void {
  tryRecordObsStatusExportResult(settlement);
}

function notifyTelemetryStartupFailure(ctx: ObservMeHandlerContext, message: string): void {
  notifyBestEffort(ctx, message, "error");
}

async function clearExtensionStatus(ctx: ObservMeHandlerContext): Promise<void> {
  try {
    await ctx.ui?.setStatus?.(EXTENSION_STATUS_KEY, undefined);
  } catch {
    return;
  }
}

async function recordOwnedControllerOperation(
  state: HandlerSessionState,
  session: ObservMeTelemetrySession,
  operation: BoundedOtelOperationResult["operation"],
): Promise<BoundedOtelOperationResult> {
  const result = await runControllerOperation(session, operation);
  retainControllerOperationResult(state, session, result);
  recordControllerOperationDiagnostics(session, result);
  return result;
}

function retainControllerOperationFailure(
  state: HandlerSessionState,
  session: ObservMeTelemetrySession,
  operation: BoundedOtelOperationResult["operation"],
  error: unknown,
): void {
  retainControllerOperationResult(state, session, {
    operation,
    completed: false,
    timedOut: false,
    error,
  });
}

function retainControllerOperationResult(
  state: HandlerSessionState,
  session: ObservMeTelemetrySession,
  result: BoundedOtelOperationResult,
): void {
  state.otelOperationOwnership.retain(
    result,
    recordControllerOperationResult.bind(undefined, session, result.operation),
    recordLateControllerOperationSettlement.bind(undefined, session),
  );
}

function recordLateControllerOperationSettlement(
  session: ObservMeTelemetrySession,
  settlement: OtelOperationSettlement,
): void {
  recordControllerOperationDiagnostics(session, settlement);
}

async function recordControllerOperationResult(
  session: ObservMeTelemetrySession,
  operation: BoundedOtelOperationResult["operation"],
): Promise<BoundedOtelOperationResult> {
  const result = await runControllerOperation(session, operation);
  recordControllerOperationDiagnostics(session, result);
  return result;
}

function recordControllerOperationDiagnostics(
  session: ObservMeTelemetrySession,
  result: BoundedOtelOperationResult,
): void {
  tryRecordObsStatusExportResult(result);
  runTelemetryBookkeeping(recordExportOperationResult.bind(undefined, session, result));
}

function tryRecordObsStatusExportResult(result: Parameters<typeof recordObsStatusExportResult>[0]): void {
  try {
    recordObsStatusExportResult(result);
  } catch {
    return;
  }
}

async function runControllerOperation(
  session: ObservMeTelemetrySession,
  operation: BoundedOtelOperationResult["operation"],
): Promise<BoundedOtelOperationResult> {
  try {
    return await session.controller[operation](session.config.shutdown.flushTimeoutMs);
  } catch (error) {
    return { operation, completed: false, timedOut: false, error };
  }
}

function recordSessionTracePropagationFailure(
  session: ObservMeTelemetrySession,
  resolution: ReturnType<typeof resolveSessionTraceParent>,
): void {
  if (!resolution.failureReason) return;

  const linkedContext = resolution.links?.[0]?.context;
  const attributes = withoutUndefinedAttributes({
    ...buildLineageMetricSafeLogAttributes(session),
    [LOG_ATTRIBUTES.EVENT_NAME]: LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED,
    [LOG_ATTRIBUTES.EVENT_CATEGORY]: "agent-tree",
    [AGENT_LINEAGE_ATTRIBUTES.PI_AGENT_ORPHANED]: session.lineage.orphaned ? true : undefined,
    [LOG_ATTRIBUTES.TRACE_ID]: linkedContext?.traceId,
    [LOG_ATTRIBUTES.SPAN_ID]: linkedContext?.spanId,
    [LOG_ATTRIBUTES.ERROR_TYPE]: resolution.failureReason,
  });
  const labels = {
    agent_role: normalizeAgentRoleMetricLabel(session.lineage.role),
    subagent_depth: String(Math.max(0, Math.min(session.lineage.depth, session.config.workflow.maxDepthWarning))),
    reason: "trace_context_fallback",
  };

  session.metrics.traceContextPropagationFailures.add(1, labels);
  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED, attributes);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED, "agent-tree", attributes, "ERROR");
  if (!session.lineage.orphaned) return;

  session.metrics.orphanAgents.add(1, createOrphanAgentMetricLabels("orphaned", "orphaned"));
  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.AGENT_ORPHANED, attributes);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.AGENT_ORPHANED, "agent-tree", attributes, "ERROR");
}

function emitConfigRejectionDiagnostic(
  session: ObservMeTelemetrySession,
  diagnostics: SessionConfigDiagnostics | undefined,
  ctx: ObservMeHandlerContext,
): void {
  const rejection = diagnostics?.rejection;
  if (!rejection) return;

  const attributes = withoutUndefinedAttributes({
    ...buildLineageMetricSafeLogAttributes(session),
    [LOG_ATTRIBUTES.TRACE_ID]: readSpanTraceId(session.sessionSpan),
    [LOG_ATTRIBUTES.SPAN_ID]: readSpanId(session.sessionSpan),
    [CONFIG_ATTRIBUTES.OBSERVME_CONFIG_SOURCE]: diagnostics.effectiveSource,
    [CONFIG_ATTRIBUTES.OBSERVME_CONFIG_REJECTED_SOURCES]: [...diagnostics.rejectedSources],
    [CONFIG_ATTRIBUTES.OBSERVME_CONFIG_SAFE_FALLBACK_APPLIED]: diagnostics.safeFallbackApplied,
    [CONFIG_ATTRIBUTES.OBSERVME_CONFIG_REJECTION_ISSUE_CODES]: [...rejection.issueCodes],
    [CONFIG_ATTRIBUTES.OBSERVME_CONFIG_REJECTION_ISSUE_COUNT]: rejection.issueCount,
  });

  tryEmitConfigRejectionLog(session, attributes);
  notifyConfigRejection(ctx, diagnostics, true);
}

function tryEmitConfigRejectionLog(session: ObservMeTelemetrySession, attributes: AttributeMap): void {
  try {
    emitStructuredLog(session.logger, LOG_EVENT_NAMES.CONFIG_REJECTED, "config", attributes, "ERROR");
  } catch {
    return;
  }
}

function notifyConfigRejection(
  ctx: ObservMeHandlerContext,
  diagnostics: SessionConfigDiagnostics | undefined,
  telemetryEnabled: boolean,
): void {
  if (!diagnostics?.rejection) return;

  const rejection = diagnostics.rejection;
  const rejectedSourceDescription = formatRejectedConfigSources(diagnostics.rejectedSources);
  const actionDescription = formatConfigRejectionAction(
    diagnostics.safeFallbackApplied,
    telemetryEnabled,
  );
  const message = `ObservMe rejected ${rejectedSourceDescription} (${rejection.issueCount} issue(s): ${rejection.issueCodes.join(", ")}) and ${actionDescription}.`;

  notifyBestEffort(ctx, message, "warning");
}

function formatRejectedConfigSources(sources: readonly SessionConfigRejectedSource[]): string {
  if (sources.length === 0) return "merged configuration";
  const sourceNames = sources.map(formatRejectedConfigSource).join(", ");
  return `${sourceNames} ${sources.length === 1 ? "source" : "sources"}`;
}

function formatRejectedConfigSource(source: SessionConfigRejectedSource): string {
  if (source === "global") return "global config";
  if (source === "trusted_project") return "trusted project config";
  if (source === "project_env") return "trusted project .env";
  return "process environment";
}

function formatConfigRejectionAction(safeFallbackApplied: boolean, telemetryEnabled: boolean): string {
  if (safeFallbackApplied && !telemetryEnabled) {
    return "applied safe defaults with explicit disablement preserved; ObservMe remains disabled and telemetry was not started";
  }
  if (safeFallbackApplied) return "applied safe defaults";
  if (!telemetryEnabled) {
    return "ignored those layers with explicit disablement preserved; ObservMe remains disabled and telemetry was not started";
  }
  return "ignored those layers; accepted configuration remains effective";
}

function recordWorkflowShutdownTelemetry(
  session: ObservMeTelemetrySession,
  attributes: AttributeMap,
  outcome: TerminalOutcome,
  labels: Record<string, string>,
): void {
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.SESSION_SHUTDOWN, attributes);
  if (!isRootWorkflow(session.lineage)) return;

  const durationMs = attributes[WORKFLOW_ATTRIBUTES.PI_WORKFLOW_DURATION_MS];
  if (typeof durationMs === "number") {
    session.metrics.workflowDurationMs.record(durationMs, { ...labels, status: outcome });
  }

  if (outcome === "error") {
    session.metrics.workflowErrors.add(1, labels);
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_FAILED, attributes, "ERROR");
    return;
  }
  if (outcome === "cancelled") {
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_CANCELLED, attributes);
    return;
  }
  if (outcome === "unknown") {
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_UNKNOWN, attributes);
    return;
  }

  session.metrics.workflowsCompleted.add(1, labels);
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_COMPLETED, attributes);
}

function recordExportOperationResult(session: ObservMeTelemetrySession, result: BoundedOtelOperationResult): void {
  if (result.completed && !result.timedOut && !result.error) return;

  const attributes = exportFailureAttributes(result);
  runTelemetryBookkeeping(
    session.metrics.exportErrors.add.bind(
      session.metrics.exportErrors,
      1,
      exportFailureMetricLabels(result),
    ),
  );
  runTelemetryBookkeeping(
    emitLifecycleLog.bind(
      undefined,
      session.logger,
      LOG_EVENT_NAMES.EXPORT_FAILED,
      attributes,
      "ERROR",
    ),
  );
}

function exportFailureAttributes(result: BoundedOtelOperationResult): AttributeMap {
  return {
    operation: result.operation,
    reason: exportFailureReason(result),
    status: result.timedOut ? "timeout" : "error",
    [LOG_ATTRIBUTES.ERROR_TYPE]: exportFailureErrorClass(result),
  };
}

function exportFailureMetricLabels(result: BoundedOtelOperationResult): Record<string, string> {
  return {
    operation: result.operation,
    reason: exportFailureReason(result),
    error_class: exportFailureErrorClass(result),
  };
}

function exportFailureReason(result: BoundedOtelOperationResult): "export_error" | "export_timeout" {
  return result.timedOut ? "export_timeout" : "export_error";
}

function exportFailureErrorClass(result: BoundedOtelOperationResult): string {
  if (result.timedOut) return "timeout";
  if (!result.error) return "unknown";
  return normalizeMetricValue(errorClass(result.error), "error");
}

function buildShutdownAttributes(
  event: SessionShutdownEvent,
  session: ObservMeTelemetrySession,
  outcome: TerminalOutcome,
): AttributeMap {
  return withoutUndefinedAttributes({
    ...buildLineageMetricSafeLogAttributes(session),
    [WORKFLOW_ATTRIBUTES.PI_WORKFLOW_DURATION_MS]: resolveWorkflowDurationMs(session),
    [WORKFLOW_ATTRIBUTES.PI_WORKFLOW_STATUS]: outcome,
    reason: event.reason,
  });
}

function resolveWorkflowDurationMs(session: ObservMeTelemetrySession): number | undefined {
  if (session.workflowStartedAtMs === undefined) return undefined;
  return Math.max(0, (session.now?.() ?? Date.now()) - session.workflowStartedAtMs);
}

function handlerErrorAttributes(name: string, error: unknown): AttributeMap {
  return {
    handler: name,
    [LOG_ATTRIBUTES.ERROR_TYPE]: errorClass(error),
  };
}
