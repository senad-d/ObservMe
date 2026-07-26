import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import observme from "../../src/extension.ts";

export default function failObservMeCommandRegistration(pi: ExtensionAPI): void {
  const failingPi = { ...pi, registerCommand: throwCommandRegistrationFailure } as ExtensionAPI;
  observme(failingPi);
}

function throwCommandRegistrationFailure(): never {
  throw new Error("Injected Pi command registration failure");
}
