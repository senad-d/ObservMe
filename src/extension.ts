import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerObsCommand } from "./commands/obs.ts";
import { assertObservMePiCapabilities } from "./pi/compatibility.ts";
import { registerHandlers } from "./pi/handlers.ts";
const partialInitializationErrorMessage =
  "ObservMe extension initialization failed while registering /obs after Pi event handlers were already registered. ObservMe rolled back its shared integration listener; Pi discards the staged handlers and commands when the extension factory fails.";

export default function observme(pi: ExtensionAPI): void {
  assertObservMePiCapabilities(pi);
  // Only the Pi process environment is eligible for launcher-provided lineage.
  // Session config loading keeps trusted project .env values out of this boundary.
  const handlerRegistration = registerHandlers(pi, { trustedParentContext: true });
  try {
    registerObsCommand(pi);
  } catch (error) {
    handlerRegistration.rollback();
    throw createPartialInitializationError(error);
  }
}

function createPartialInitializationError(cause: unknown): Error {
  return new Error(partialInitializationErrorMessage, { cause });
}
