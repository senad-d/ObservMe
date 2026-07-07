import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerObsCommand } from "./commands/obs.ts";
import { registerHandlers } from "./pi/handlers.ts";

export default function observme(pi: ExtensionAPI): void {
  registerHandlers(pi);
  registerObsCommand(pi);
}
