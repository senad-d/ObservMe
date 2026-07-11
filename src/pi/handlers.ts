import { registerAgentTurnHandlers } from "./event-handlers/agent-turn.ts";
import { registerLifecycleHandlers } from "./event-handlers/lifecycle.ts";
import { registerLlmHandlers } from "./event-handlers/llm.ts";
import { registerSessionEventHandlers } from "./event-handlers/session-events.ts";
import { registerToolBashHandlers } from "./event-handlers/tool-bash.ts";
import { registerObservMeIntegration } from "./integration-api.ts";
import {
  HandlerRegistrar,
  SerializedLifecycleQueue,
  createStatefulHandlerErrorRecorder,
  resolveObservMePiApi,
  setDefaultHandlerErrorRecorder,
} from "./handler-runtime.ts";
import type { HandlerSessionState, RegisterHandlersOptions } from "./handler-types.ts";

export { buildSessionAttributes, readSessionHeaderFromFile } from "./event-handlers/lifecycle.ts";
export { deriveTurnId, emitLifecycleLog } from "./handler-internals.ts";
export {
  OBSERVME_SEMCONV_VERSION,
  buildTelemetryInstanceResourceAttributes,
  createAgentTreeTracker,
  createCompositeOtelSignalSdk,
  createHistogram,
  createObservMeMetrics,
  createSpanRegistry,
  createTurnSequenceRegistry,
  isRootWorkflow,
  safeHandler,
  startSessionTelemetry,
  withTelemetrySessionResourceAttributes,
  workflowFailed,
} from "./handler-runtime.ts";
export type {
  AttributeMap,
  AttributePrimitive,
  BranchPreparationState,
  CompositeOtelSignalSdk,
  EnsureProjectConfig,
  Handler,
  HandlerErrorRecorder,
  LoadSessionConfig,
  MinimalSessionCorrelation,
  ObservMeHandlerContext,
  ObservMeMetrics,
  ObservMePiApi,
  ObservMeTelemetrySession,
  PendingBashOperationState,
  ReadSessionHeader,
  RegisterHandlersOptions,
  SessionRecoveryHeader,
  SpanRegistry,
  StartSessionTelemetry,
  StartSessionTelemetryOptions,
  StartupRecoveryState,
  TelemetryLogger,
  TelemetryMeter,
  TelemetryTracer,
  ToolCallState,
  TurnSequenceRegistry,
} from "./handler-types.ts";

export function registerHandlers(pi: unknown, options: RegisterHandlersOptions = {}): void {
  const api = resolveObservMePiApi(pi);
  const state: HandlerSessionState = {};
  const errorRecorder = createStatefulHandlerErrorRecorder(state, options.onHandlerError);
  const registrar = new HandlerRegistrar(api, state, errorRecorder);
  const lifecycleQueue = new SerializedLifecycleQueue();

  setDefaultHandlerErrorRecorder(errorRecorder);
  registerLifecycleHandlers(registrar, state, options, lifecycleQueue);
  registerAgentTurnHandlers(registrar, state);
  registerLlmHandlers(registrar, state);
  registerToolBashHandlers(registrar, state);
  registerSessionEventHandlers(registrar, state);
  registerIntegrationCleanup(registrar, registerObservMeIntegration(pi, state));
  registrar.commit();
}

function registerIntegrationCleanup(registrar: HandlerRegistrar, unsubscribe: (() => void) | undefined): void {
  if (!unsubscribe) return;
  registrar.add("session_shutdown", unsubscribeIntegration.bind(undefined, unsubscribe));
}

function unsubscribeIntegration(unsubscribe: () => void): void {
  unsubscribe();
}
