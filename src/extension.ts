import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerObsCommand } from "./commands/obs.ts";
import { registerHandlers } from "./pi/handlers.ts";

const extensionPiApiCompatibilityErrorMessage =
  "ObservMe/Pi API compatibility error: expected Pi ExtensionAPI with on(eventName, handler) and registerCommand(name, options) before registering ObservMe.";
const partialInitializationErrorMessage =
  "ObservMe extension initialization failed while registering /obs after Pi event handlers were already registered. Pi ExtensionAPI does not expose unregister hooks for event handlers or slash commands, so ObservMe cannot roll back partial registration; restart Pi after fixing command registration.";

export default function observme(pi: ExtensionAPI): void {
  assertRegistrationApiAvailable(pi);
  // Only the Pi process environment is eligible for launcher-provided lineage.
  // Session config loading keeps trusted project .env values out of this boundary.
  registerHandlers(pi, { trustedParentContext: true });
  registerObsCommandWithPartialInitializationDiagnostic(pi);
}

function assertRegistrationApiAvailable(pi: ExtensionAPI): void {
  const api = pi as Partial<ExtensionAPI> | null | undefined;

  if (!api || typeof api.on !== "function" || typeof api.registerCommand !== "function") {
    throw new TypeError(extensionPiApiCompatibilityErrorMessage);
  }
}

function registerObsCommandWithPartialInitializationDiagnostic(pi: ExtensionAPI): void {
  try {
    registerObsCommand(pi);
  } catch (error) {
    throw createPartialInitializationError(error);
  }
}

function createPartialInitializationError(cause: unknown): Error {
  // Pi exposes pi.on/registerCommand but no unregister API for those registrations.
  // If command registration fails after handler registration, ObservMe can only report the partial state.
  return new Error(partialInitializationErrorMessage, { cause });
}
