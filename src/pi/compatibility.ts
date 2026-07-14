import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MINIMUM_SUPPORTED_PI_VERSION = "0.80.5";
export const RELEASE_TESTED_PI_VERSION = "0.80.6";
export const SUPPORTED_PI_VERSION_RANGE = ">=0.80.5 <0.81.0";

const compatibilityErrorPrefix = "ObservMe/Pi API compatibility error";
const requiredPiMethods = ["on", "registerCommand", "appendEntry", "getThinkingLevel"] as const;

export function assertObservMePiCompatibility(
  pi: unknown,
  piVersion = PI_VERSION,
): asserts pi is ExtensionAPI {
  const missingMethods = findMissingPiMethods(pi);
  const detectedVersion = normalizeDetectedVersion(piVersion);
  const versionSupported = isSupportedPiVersion(detectedVersion);
  if (versionSupported && missingMethods.length === 0) return;

  const reasons: string[] = [];
  if (!versionSupported) reasons.push(`detected Pi ${detectedVersion}`);
  if (missingMethods.length > 0) reasons.push(`missing required API method(s): ${missingMethods.join(", ")}`);

  throw new TypeError(
    `${compatibilityErrorPrefix}: ObservMe requires @earendil-works/pi-coding-agent ${SUPPORTED_PI_VERSION_RANGE}; ${reasons.join("; ")}. No ObservMe event handlers or commands were registered.`,
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

function normalizeDetectedVersion(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(trimmed) ? trimmed : "unknown";
}

function isSupportedPiVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 0 && minor === 80 && patch >= 5;
}
