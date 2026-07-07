import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSessionConfig } from "../config/load-config.ts";
import { emitUnsafeCaptureWarning } from "../config/validate.ts";
import { EXTENSION_DISPLAY_NAME, EXTENSION_STATUS_KEY } from "../constants.ts";

/**
 * Example lifecycle hooks.
 *
 * Template note: keep long-lived resources session-scoped. Start them from
 * session_start or a command/tool, and clean them up in session_shutdown.
 */
export function registerLifecycleEvents(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const config = await loadSessionConfig({ ctx });
    await emitUnsafeCaptureWarning(config, ctx);
    ctx.ui.setStatus(EXTENSION_STATUS_KEY, `${EXTENSION_DISPLAY_NAME} loaded`);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(EXTENSION_STATUS_KEY, undefined);
  });
}
