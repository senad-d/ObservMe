import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExampleCommand } from "./commands/example-command.ts";
import { registerObsCommand } from "./commands/obs.ts";
import { registerHandlers } from "./pi/handlers.ts";
import { registerExampleTool } from "./tools/example-tool.ts";

/**
 * Template entry point.
 *
 * Replace the function name and registered modules when the extension gets a
 * real project name and purpose. Keep this file small: import feature modules
 * and call their register* functions here.
 */
export default function piExtensionTemplate(pi: ExtensionAPI) {
  registerHandlers(pi);
  registerObsCommand(pi);
  registerExampleCommand(pi);
  registerExampleTool(pi);
}
