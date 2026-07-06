import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatGreeting } from "../utils/format.ts";

const greetingParameters = Type.Object({
  name: Type.String({ description: "Name or short label to greet." }),
  punctuation: Type.Optional(Type.String({ description: "Optional punctuation. Defaults to !" })),
});

/**
 * Example custom tool.
 *
 * Template note: rename `template_greet`, update the schema, and replace the
 * execute body with task-specific behavior. Put each larger tool in its own
 * file under src/tools/.
 */
export function registerExampleTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "template_greet",
    label: "Template Greet",
    description: "Example Pi extension tool that returns a greeting. Replace it with a project-specific tool.",
    promptSnippet: "Create a short greeting for a provided name.",
    promptGuidelines: [
      "Use template_greet only as a template demonstration; replace this guideline with project-specific tool guidance.",
    ],
    parameters: greetingParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const message = formatGreeting(params.name, params.punctuation ?? "!");
      return {
        content: [{ type: "text", text: message }],
        details: { message },
      };
    },
  });
}
