import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MINIMUM_SUPPORTED_PI_VERSION = "0.80.5";
export const RELEASE_TESTED_PI_VERSION = "0.80.6";
const FIRST_UNSUPPORTED_PI_VERSION = "0.81.0";
export const SUPPORTED_PI_VERSION_RANGE =
  `>=${MINIMUM_SUPPORTED_PI_VERSION} <${FIRST_UNSUPPORTED_PI_VERSION}`;

const compatibilityErrorPrefix = "ObservMe/Pi API compatibility error";
const MAX_DETECTED_PI_VERSION_LENGTH = 128;
const piVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const numericIdentifierPattern = /^\d+$/u;
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
  if (trimmed.length === 0 || trimmed.length > MAX_DETECTED_PI_VERSION_LENGTH) return "unknown";
  return parsePiVersion(trimmed) ? trimmed : "unknown";
}

function isSupportedPiVersion(version: string): boolean {
  const detected = parsePiVersion(version);
  const minimum = parsePiVersion(MINIMUM_SUPPORTED_PI_VERSION);
  const maximum = parsePiVersion(FIRST_UNSUPPORTED_PI_VERSION);
  if (!detected || detected.prerelease || !minimum || !maximum) return false;

  return comparePiVersions(detected, minimum) >= 0 && comparePiVersions(detected, maximum) < 0;
}

interface PiVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parsePiVersion(version: string): PiVersion | undefined {
  const match = piVersionPattern.exec(version);
  if (!match || hasInvalidNumericPrereleaseIdentifier(match[4])) return undefined;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return undefined;
  }

  return {
    major,
    minor,
    patch,
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  };
}

function hasInvalidNumericPrereleaseIdentifier(prerelease: string | undefined): boolean {
  if (prerelease === undefined) return false;

  for (const identifier of prerelease.split(".")) {
    if (identifier.length > 1 && identifier.startsWith("0") && numericIdentifierPattern.test(identifier)) {
      return true;
    }
  }
  return false;
}

function comparePiVersions(left: PiVersion, right: PiVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}
