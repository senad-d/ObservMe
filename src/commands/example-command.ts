import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EXTENSION_DISPLAY_NAME } from "../constants.ts";
import { formatGreeting } from "../utils/format.ts";

/**
 * Example slash command.
 *
 * Template note: replace the command name (`template-hello`) and behavior with
 * the command your extension actually provides. Put each larger command in its
 * own file under src/commands/.
 */
export function registerExampleCommand(pi: ExtensionAPI) {
  pi.registerCommand("template-hello", {
    description: "Example template command. Replace with your extension command.",
    getArgumentCompletions(prefix) {
      const examples = ["Pi", "developer", "template"];
      const normalizedPrefix = prefix.trim().toLowerCase();
      const matches = examples.filter((item) => item.toLowerCase().startsWith(normalizedPrefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const target = args.trim() || EXTENSION_DISPLAY_NAME;
      ctx.ui.notify(formatGreeting(target), "info");
    },
  });
}
