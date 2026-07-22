export const EARLIEST_TESTED_PI_VERSION = "0.80.5";
export const RELEASE_TESTED_PI_VERSION = "0.81.1";
export const PI_RUNTIME_COMPATIBILITY_POLICY = "required-api-capabilities" as const;

const capabilityErrorPrefix = "ObservMe/Pi API capability error";
const requiredPiMethods = ["on", "registerCommand"] as const;

/** Pi's reported version is intentionally not part of this startup decision. */
export function assertObservMePiCapabilities(pi: unknown): void {
  const missingMethods = findMissingPiMethods(pi);
  if (missingMethods.length === 0) return;

  throw new TypeError(
    `${capabilityErrorPrefix}: ObservMe requires ExtensionAPI method(s): ${missingMethods.join(", ")}. Pi version is not used as a startup gate. No ObservMe event handlers or commands were registered.`,
  );
}

function findMissingPiMethods(pi: unknown): string[] {
  if (!isRecord(pi)) return [...requiredPiMethods];

  const missing: string[] = [];
  for (const method of requiredPiMethods) {
    if (typeof pi[method] !== "function") missing.push(method);
  }
  return missing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
