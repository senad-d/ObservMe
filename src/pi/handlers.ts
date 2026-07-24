import { registerAgentTurnHandlers } from "./event-handlers/agent-turn.ts";
import { registerLifecycleHandlers } from "./event-handlers/lifecycle.ts";
import { registerLlmHandlers } from "./event-handlers/llm.ts";
import { registerSessionEventHandlers } from "./event-handlers/session-events.ts";
import { registerToolBashHandlers } from "./event-handlers/tool-bash.ts";
import {
  HandlerRegistrar,
  SerializedLifecycleQueue,
  createStatefulHandlerErrorRecorder,
  resolveObservMePiApi,
  setDefaultHandlerErrorRecorder,
} from "./handler-runtime.ts";
import type { HandlerSessionState, RegisterHandlersOptions } from "./handler-types.ts";
import { prepareIntegrationRegistration } from "./integration-registration.ts";
import { getProcessOtelOperationOwnership } from "./otel-operation-ownership.ts";

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
} from "./handler-runtime.ts";
export { createOtelOperationOwnership } from "./otel-operation-ownership.ts";
export type { OtelOperationOwnership } from "./otel-operation-ownership.ts";
export type {
  AppendEntry,
  AttributeMap,
  AttributePrimitive,
  BranchPreparationState,
  CompositeOtelSignalSdk,
  EnsureProjectConfig,
  GetThinkingLevel,
  Handler,
  HandlerErrorRecorder,
  LoadSessionConfig,
  MinimalSessionCorrelation,
  ObservMeHandlerContext,
  ObservMeMetrics,
  ObservMePiApi,
  ObservMeSessionManager,
  ObservMeTelemetrySession,
  PendingBashOperationState,
  PiEvent,
  PiEventName,
  PiHandler,
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
  TerminalOutcome,
  ToolCallState,
  TurnSequenceRegistry,
} from "./handler-types.ts";

export function registerHandlers(pi: unknown, options: RegisterHandlersOptions = {}): void {
  const api = resolveObservMePiApi(pi);
  const state: HandlerSessionState = {
    otelOperationOwnership: options.otelOperationOwnership ?? getProcessOtelOperationOwnership(),
  };
  const errorRecorder = createStatefulHandlerErrorRecorder(state, options.onHandlerError);
  const registrar = new HandlerRegistrar(api, state, errorRecorder);
  const lifecycleQueue = new SerializedLifecycleQueue();
  const runtimeOptions = {
    ...options,
    appendEntry: options.appendEntry ?? api.appendEntry,
    getThinkingLevel: options.getThinkingLevel ?? api.getThinkingLevel,
  };

  setDefaultHandlerErrorRecorder(errorRecorder);
  const integrationRegistration = prepareIntegrationRegistration(pi, state, registrar);
  try {
    registerLifecycleHandlers(registrar, state, runtimeOptions, lifecycleQueue);
    registerAgentTurnHandlers(registrar, state);
    registerLlmHandlers(registrar, state);
    registerToolBashHandlers(registrar, state);
    registerSessionEventHandlers(registrar, state);
    registrar.commit();
  } catch (error) {
    integrationRegistration.rollback();
    throw error;
  }
}
