import { registerObservMeIntegration } from "./integration-api.ts";
import type { HandlerRegistrar } from "./handler-runtime.ts";
import type { HandlerSessionState } from "./handler-types.ts";

interface IntegrationSubscription {
  active: boolean;
  readonly unsubscribe: (() => void) | undefined;
}

export interface IntegrationRegistration {
  rollback: () => void;
}

export function prepareIntegrationRegistration(
  pi: unknown,
  state: HandlerSessionState,
  registrar: HandlerRegistrar,
): IntegrationRegistration {
  const subscription = createIntegrationSubscription(registerObservMeIntegration(pi, state));
  registerIntegrationCleanup(registrar, state, subscription);
  return { rollback: rollbackIntegrationSubscription.bind(undefined, subscription) };
}

function createIntegrationSubscription(unsubscribe: (() => void) | undefined): IntegrationSubscription {
  return { active: unsubscribe !== undefined, unsubscribe };
}

function registerIntegrationCleanup(
  registrar: HandlerRegistrar,
  state: HandlerSessionState,
  subscription: IntegrationSubscription,
): void {
  if (!subscription.active) return;
  registrar.add("session_shutdown", fenceAndUnsubscribeIntegration.bind(undefined, state, subscription));
}

function fenceAndUnsubscribeIntegration(state: HandlerSessionState, subscription: IntegrationSubscription): void {
  state.integrationSessionPhase = "closing";
  unsubscribeIntegration(subscription);
}

function rollbackIntegrationSubscription(subscription: IntegrationSubscription): void {
  try {
    unsubscribeIntegration(subscription);
  } catch {
    return;
  }
}

function unsubscribeIntegration(subscription: IntegrationSubscription): void {
  if (!subscription.active || !subscription.unsubscribe) return;
  subscription.active = false;
  subscription.unsubscribe();
}
