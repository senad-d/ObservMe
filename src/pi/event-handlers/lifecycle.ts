import { open } from "node:fs/promises";
import { SpanStatusCode } from "@opentelemetry/api";
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
} from "../../config/load-config.ts";
import {
  loadSessionConfig,
  loadSessionConfigWithDiagnostics,
} from "../../config/load-config.ts";
import type { ObservMeConfig } from "../../config/schema.ts";
import { emitUnsafeCaptureWarning, normalizeConfigRejectionDiagnostic } from "../../config/validate.ts";
import { EXTENSION_STATUS_KEY, EXTENSION_STATUS_VALUE } from "../../constants.ts";
import type { BoundedOtelOperationResult } from "../../otel/shutdown.ts";
import {
  AGENT_LINEAGE_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  CONFIG_ATTRIBUTES,
  LOG_ATTRIBUTES,
  SESSION_ATTRIBUTES,
  WORKFLOW_ATTRIBUTES,
} from "../../semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../../semconv/metrics.ts";
import { SPAN_NAMES } from "../../semconv/spans.ts";
import { createAgentLineageContext } from "../agent-lineage.ts";
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
  readUnknown,
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
  workflowFailed,
} from "../handler-runtime.ts";
import type { HandlerRegistrar, SerializedLifecycleQueue } from "../handler-runtime.ts";
import type {
  AttributeMap,
  Handler,
  HandlerSessionState,
  LoadSessionConfig,
  MinimalSessionCorrelation,
  ObservMeHandlerContext,
  ObservMeTelemetrySession,
  RegisterHandlersOptions,
  SessionConfigLoadResult,
  SessionRecoveryHeader,
  StartSessionTelemetry,
  StartupRecoveryState,
} from "../handler-types.ts";

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
): AttributeMap {
  const cwd = recovery?.header?.cwd ?? readString(ctx, "cwd") ?? process.cwd();
  const sessionId = recovery?.header?.id ?? resolveSessionId(event, ctx, lineage);
  const parentSessionId = recovery?.header?.parentSession ?? readString(event, "parentSessionId") ?? lineage.parentSessionId;
  const sessionFile = recovery?.sessionFile ?? resolveSessionFilePath(event, ctx);

  return withoutUndefinedAttributes({
    [SESSION_ATTRIBUTES.PI_SESSION_ID]: sessionId,
    [SESSION_ATTRIBUTES.PI_SESSION_NAME]: readString(event, "sessionName") ?? readString(event, "name") ?? "unknown",
    [SESSION_ATTRIBUTES.PI_SESSION_CWD_HASH]: hashValue(cwd, config),
    [SESSION_ATTRIBUTES.PI_SESSION_PARENT_SESSION_HASH]: parentSessionId ? hashValue(parentSessionId, config) : "",
    [SESSION_ATTRIBUTES.PI_SESSION_PERSISTED]: readBoolean(event, "persisted") ?? recovery?.resumed ?? false,
    [SESSION_ATTRIBUTES.PI_SESSION_FILE_HASH]: sessionFile ? hashValue(sessionFile, config) : "",
    [SESSION_ATTRIBUTES.PI_SESSION_VERSION]: readString(recovery?.header, "version") ?? readString(event, "sessionVersion") ?? readString(event, "version") ?? "unknown",
    [SESSION_ATTRIBUTES.PI_MODEL_PROVIDER_CURRENT]: resolveModelProvider(event, ctx),
    [SESSION_ATTRIBUTES.PI_MODEL_ID_CURRENT]: resolveModelId(event, ctx),
    [SESSION_ATTRIBUTES.PI_THINKING_LEVEL_CURRENT]: resolveThinkingLevel(event, ctx),
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
): Handler {
  return handleSessionStart.bind(undefined, state, loadConfigFn, startTelemetryFn, options);
}

async function handleSessionStart(
  state: HandlerSessionState,
  loadConfigFn: LoadSessionConfig,
  startTelemetryFn: StartSessionTelemetry,
  options: RegisterHandlersOptions,
  event: unknown,
  ctx: ObservMeHandlerContext,
): Promise<void> {
  const previousSession = state.session;
  if (previousSession) await shutDownPreviousSessionBeforeDuplicateStart(previousSession, ctx, state);

  await ensureProjectConfigForHandler(options, ctx);
  const loadedConfig = await loadSessionConfigForHandler(loadConfigFn, options, ctx);
  const config = loadedConfig.config;
  await emitUnsafeCaptureWarning(config, ctx);

  const recovery = await resolveStartupRecovery(event, ctx, config, options);
  const recoveryCorrelation = recovery.customCorrelation ?? recovery.header?.correlation;
  const lineage = createAgentLineageContext({
    config,
    env: buildRecoveryLineageEnv(config, recoveryCorrelation, options.env),
    trustedParentContext: options.trustedParentContext === true || recoveryCorrelation !== undefined,
    requireCompletePropagationEnvelope:
      options.requireCompleteParentEnvelope ?? (options.trustedParentContext === true && recoveryCorrelation === undefined),
    failOpenInvalidPropagation: true,
  });
  const session = await startTelemetryFn({ config, lineage, now: options.now });
  session.now = options.now ?? session.now ?? monotonicNowMs;
  updateObsStatusRuntimeState({ config: session.config, configDiagnostics: loadedConfig.diagnostics });
  clearObsStatusExportError();
  state.session = session;
  const attributes = buildSessionAttributes(event, ctx, session.config, lineage, recovery);
  const labels = metricLabels(session.config, lineage);

  session.sessionAttributes = attributes;
  const traceParent = resolveSessionTraceParent(lineage);
  session.sessionSpan = startActiveRootSpan(session, SPAN_NAMES.PI_SESSION, attributes, "session", traceParent);
  emitConfigRejectionDiagnostic(session, loadedConfig.diagnostics, ctx);
  recordSessionTracePropagationFailure(session, traceParent);
  startObsSessionRuntimeState({
    sessionId: readString(attributes, SESSION_ATTRIBUTES.PI_SESSION_ID),
    traceId: readSpanTraceId(session.sessionSpan),
    traceUrlTemplate: session.config.query.links.traceUrlTemplate,
  });
  startObsAgentsRuntimeState({
    lineage,
    agentTree: session.agentTree,
    sessionId: readString(attributes, SESSION_ATTRIBUTES.PI_SESSION_ID),
    traceId: readSpanTraceId(session.sessionSpan),
  });
  session.workflowStartedAtMs = session.now();
  session.metrics.sessionsStarted.add(1, labels);
  session.metrics.activeAgents.add(1, labels);
  session.activeAgentRecorded = true;
  session.sessionSpan.addEvent(LOG_EVENT_NAMES.SESSION_STARTED, attributes);
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.SESSION_STARTED, attributes);
  if (recovery.resumed && session.config.replayOnStart) emitStartupReplayTelemetry(session, attributes);

  if (isRootWorkflow(lineage)) {
    session.metrics.workflowsStarted.add(1, labels);
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_STARTED, attributes);
  }

  await ctx.ui?.setStatus?.(EXTENSION_STATUS_KEY, EXTENSION_STATUS_VALUE);
  state.session = session;
}

function createSessionShutdownHandler(state: HandlerSessionState): Handler {
  return handleSessionShutdown.bind(undefined, state);
}

async function handleSessionShutdown(
  state: HandlerSessionState,
  event: unknown,
  ctx: ObservMeHandlerContext,
): Promise<void> {
  const session = state.session;
  if (!session) return;

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
  const header = sessionFile ? await readHeader(sessionFile) : undefined;
  const customCorrelation = config.agent.writeCorrelationEntry ? readExplicitCustomCorrelation(event) : undefined;

  return {
    resumed: isExistingSessionStart(event),
    sessionFile,
    header,
    customCorrelation,
  };
}

function emitStartupReplayTelemetry(session: ObservMeTelemetrySession, attributes: AttributeMap): void {
  const replayAttributes = {
    ...attributes,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_REPLAYED]: true,
  };

  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.SESSION_STARTED, replayAttributes);
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.SESSION_STARTED, replayAttributes);
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
    ...definedEnvValue(config.agent.depthEnv, correlation.depth === undefined ? undefined : String(correlation.depth)),
    ...definedEnvValue(config.agent.spawnIdEnv, correlation.spawnId),
    ...definedEnvValue(config.agent.capabilityEnv, correlation.capability),
  };
}

function definedEnvValue(name: string, value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined || value === "" ? {} : { [name]: value };
}

function readExplicitCustomCorrelation(event: unknown): MinimalSessionCorrelation | undefined {
  const value = readUnknown(event, "customCorrelation") ?? readUnknown(event, "observmeCorrelation");
  return normalizeMinimalCorrelation(value);
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
    correlation: normalizeMinimalCorrelation(readUnknown(value, "observmeCorrelation") ?? readUnknown(value, "correlation")),
  });
}

function normalizeMinimalCorrelation(value: unknown): MinimalSessionCorrelation | undefined {
  if (!isRecord(value)) return undefined;

  const correlation = withoutUndefinedObjectValues({
    workflowId: readString(value, "workflowId"),
    agentId: readString(value, "agentId"),
    parentAgentId: readString(value, "parentAgentId"),
    rootAgentId: readString(value, "rootAgentId"),
    parentSessionId: readString(value, "parentSessionId"),
    depth: readInteger(value, "depth"),
    spawnId: readString(value, "spawnId"),
    capability: readString(value, "capability"),
  });

  return Object.keys(correlation).length === 0 ? undefined : correlation;
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
      rejection: normalizeConfigRejectionDiagnostic(loaded.diagnostics.rejection),
    },
  };
}

async function ensureProjectConfigForHandler(
  options: RegisterHandlersOptions,
  ctx: ObservMeHandlerContext,
): Promise<void> {
  // Pi emits session_start for startup, reload, new, resume, and fork flows. ObservMe keeps
  // bootstrap idempotent across all of them: create once for trusted projects, then never overwrite.
  await bootstrapProjectObservMeConfig(ctx, {
    configDirName: options.configDirName,
    ensureProjectConfig: options.ensureProjectConfig,
  });
}

async function shutDownPreviousSessionBeforeDuplicateStart(
  session: ObservMeTelemetrySession,
  ctx: ObservMeHandlerContext,
  state: HandlerSessionState,
): Promise<void> {
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.SESSION_DUPLICATE_START, buildDuplicateSessionStartAttributes(session));

  try {
    await shutDownTelemetrySession(session, duplicateSessionStartShutdownEvent(), ctx, state);
  } catch (error) {
    recordDuplicateSessionStartShutdownError(session, error);
    clearObsSessionRuntimeState();
    clearObsAgentsRuntimeState();
    state.session = undefined;
  }
}

function buildDuplicateSessionStartAttributes(session: ObservMeTelemetrySession): AttributeMap {
  return withoutUndefinedAttributes({
    [LOG_ATTRIBUTES.PI_SESSION_ID]: readString(session.sessionAttributes, SESSION_ATTRIBUTES.PI_SESSION_ID),
    [LOG_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [LOG_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID]: session.lineage.workflowRootAgentId,
    [LOG_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [LOG_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
    reason: "active_session_replaced_before_new_start",
  });
}

function duplicateSessionStartShutdownEvent(): Record<string, unknown> {
  return {
    duplicateSessionStart: true,
    status: "ok",
  };
}

function recordDuplicateSessionStartShutdownError(session: ObservMeTelemetrySession, error: unknown): void {
  session.metrics.handlerErrors.add(1, { operation: "session_start.duplicate_shutdown" });
  emitLifecycleLog(
    session.logger,
    LOG_EVENT_NAMES.HANDLER_FAILED,
    handlerErrorAttributes("session_start.duplicate_shutdown", error),
    "ERROR",
  );
}

async function shutDownTelemetrySession(
  session: ObservMeTelemetrySession,
  event: unknown,
  ctx: ObservMeHandlerContext,
  state: HandlerSessionState,
): Promise<void> {
  const labels = metricLabels(session.config, session.lineage);
  const shutdownAttributes = buildShutdownAttributes(event, session);
  const failed = workflowFailed(event);

  session.metrics.sessionsShutdown.add(1, labels);
  if (session.activeAgentRecorded) session.metrics.activeAgents.add(-1, labels);
  recordWorkflowShutdownTelemetry(session, shutdownAttributes, failed, labels);
  endAllActiveSpans(session);
  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.SESSION_SHUTDOWN, shutdownAttributes);
  if (failed) session.sessionSpan?.setStatus({ code: SpanStatusCode.ERROR });
  endActiveSpan(session, session.sessionSpan);
  await ctx.ui?.setStatus?.(EXTENSION_STATUS_KEY, undefined);
  await recordControllerOperationResult(session, "flush");
  await recordControllerOperationResult(session, "shutdown");
  clearObsSessionRuntimeState();
  clearObsAgentsRuntimeState();
  state.session = undefined;
}

async function recordControllerOperationResult(
  session: ObservMeTelemetrySession,
  operation: BoundedOtelOperationResult["operation"],
): Promise<void> {
  const result = await runControllerOperation(session, operation);
  recordObsStatusExportResult(result);
  recordExportOperationResult(session, result);
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
    [LOG_ATTRIBUTES.EVENT_NAME]: LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED,
    [LOG_ATTRIBUTES.EVENT_CATEGORY]: "agent-tree",
    [LOG_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [LOG_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [LOG_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
    [AGENT_LINEAGE_ATTRIBUTES.PI_AGENT_ORPHANED]: session.lineage.orphaned ? true : undefined,
    [LOG_ATTRIBUTES.TRACE_ID]: linkedContext?.traceId,
    [LOG_ATTRIBUTES.SPAN_ID]: linkedContext?.spanId,
    [LOG_ATTRIBUTES.ERROR_TYPE]: resolution.failureReason,
  });
  const labels = {
    agent_role: session.lineage.role,
    subagent_depth: String(Math.max(0, Math.min(session.lineage.depth, session.config.workflow.maxDepthWarning))),
    reason: "trace_context_fallback",
  };

  session.metrics.traceContextPropagationFailures.add(1, labels);
  session.sessionSpan?.addEvent(LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED, attributes);
  emitStructuredLog(session.logger, LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED, "agent-tree", attributes, "ERROR");
  if (!session.lineage.orphaned) return;

  session.metrics.orphanAgents.add(1, { status: "orphaned", reason: "orphaned" });
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
    [CONFIG_ATTRIBUTES.OBSERVME_CONFIG_REJECTION_ISSUE_CODES]: [...rejection.issueCodes],
    [CONFIG_ATTRIBUTES.OBSERVME_CONFIG_REJECTION_ISSUE_COUNT]: rejection.issueCount,
  });

  tryEmitConfigRejectionLog(session, attributes);
  notifyConfigRejection(ctx, diagnostics);
}

function tryEmitConfigRejectionLog(session: ObservMeTelemetrySession, attributes: AttributeMap): void {
  try {
    emitStructuredLog(session.logger, LOG_EVENT_NAMES.CONFIG_REJECTED, "config", attributes, "ERROR");
  } catch {
    return;
  }
}

function notifyConfigRejection(ctx: ObservMeHandlerContext, diagnostics: SessionConfigDiagnostics): void {
  if (ctx.hasUI === false || !ctx.ui?.notify || !diagnostics.rejection) return;

  const rejection = diagnostics.rejection;
  const message = `ObservMe rejected ${formatConfigDiagnosticSource(diagnostics.effectiveSource)} configuration (${rejection.issueCount} issue(s): ${rejection.issueCodes.join(", ")}) and applied safe defaults.`;

  try {
    void Promise.resolve(ctx.ui.notify(message, "warning")).catch(ignoreConfigDiagnosticError);
  } catch {
    return;
  }
}

function formatConfigDiagnosticSource(source: SessionConfigDiagnostics["effectiveSource"]): string {
  return source.replaceAll("_", " ");
}

function ignoreConfigDiagnosticError(): undefined {
  return undefined;
}

function recordWorkflowShutdownTelemetry(
  session: ObservMeTelemetrySession,
  attributes: AttributeMap,
  failed: boolean,
  labels: Record<string, string>,
): void {
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.SESSION_SHUTDOWN, attributes);
  if (!isRootWorkflow(session.lineage)) return;

  const durationMs = attributes[WORKFLOW_ATTRIBUTES.PI_WORKFLOW_DURATION_MS];
  if (typeof durationMs === "number") {
    session.metrics.workflowDurationMs.record(durationMs, { ...labels, status: failed ? "error" : "ok" });
  }

  if (failed) {
    session.metrics.workflowErrors.add(1, labels);
    emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_FAILED, attributes, "ERROR");
    return;
  }

  session.metrics.workflowsCompleted.add(1, labels);
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.WORKFLOW_COMPLETED, attributes);
}

function recordExportOperationResult(session: ObservMeTelemetrySession, result: BoundedOtelOperationResult): void {
  if (result.completed && !result.timedOut && !result.error) return;

  const attributes = exportFailureAttributes(result);
  session.metrics.exportErrors.add(1, exportFailureMetricLabels(result));
  emitLifecycleLog(session.logger, LOG_EVENT_NAMES.EXPORT_FAILED, attributes, "ERROR");
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

function buildShutdownAttributes(event: unknown, session: ObservMeTelemetrySession): AttributeMap {
  return withoutUndefinedAttributes({
    [LOG_ATTRIBUTES.PI_SESSION_ID]: readString(session.sessionAttributes, SESSION_ATTRIBUTES.PI_SESSION_ID),
    [LOG_ATTRIBUTES.PI_WORKFLOW_ID]: session.lineage.workflowId,
    [LOG_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID]: session.lineage.workflowRootAgentId,
    [LOG_ATTRIBUTES.PI_AGENT_ID]: session.lineage.agentId,
    [LOG_ATTRIBUTES.PI_AGENT_ROOT_ID]: session.lineage.rootAgentId,
    [WORKFLOW_ATTRIBUTES.PI_WORKFLOW_DURATION_MS]: resolveWorkflowDurationMs(session),
    [WORKFLOW_ATTRIBUTES.PI_WORKFLOW_STATUS]: workflowFailed(event) ? "error" : "ok",
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
