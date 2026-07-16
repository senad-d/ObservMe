import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MINIMUM_SUPPORTED_PI_VERSION = "0.80.5";
export const RELEASE_TESTED_PI_VERSION = "0.80.6";
const FIRST_UNSUPPORTED_PI_VERSION = "0.81.0";
export const SUPPORTED_PI_VERSION_RANGE =
  `>=${MINIMUM_SUPPORTED_PI_VERSION} <${FIRST_UNSUPPORTED_PI_VERSION}`;

const compatibilityErrorPrefix = "ObservMe/Pi API compatibility error";
const MAX_DETECTED_PI_VERSION_LENGTH = 128;
const piVersionCorePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const semanticVersionIdentifierPattern = /^[0-9A-Za-z-]+$/u;
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
  const buildSeparatorIndex = version.indexOf("+");
  const versionAndPrerelease = buildSeparatorIndex === -1 ? version : version.slice(0, buildSeparatorIndex);
  const build = buildSeparatorIndex === -1 ? undefined : version.slice(buildSeparatorIndex + 1);
  if (build !== undefined && !hasValidSemanticVersionIdentifiers(build, true)) return undefined;

  const prereleaseSeparatorIndex = versionAndPrerelease.indexOf("-");
  const coreVersion = prereleaseSeparatorIndex === -1
    ? versionAndPrerelease
    : versionAndPrerelease.slice(0, prereleaseSeparatorIndex);
  const prerelease = prereleaseSeparatorIndex === -1
    ? undefined
    : versionAndPrerelease.slice(prereleaseSeparatorIndex + 1);
  if (prerelease !== undefined && !hasValidSemanticVersionIdentifiers(prerelease, false)) return undefined;

  const match = piVersionCorePattern.exec(coreVersion);
  if (!match) return undefined;

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
    ...(prerelease === undefined ? {} : { prerelease }),
  };
}

function hasValidSemanticVersionIdentifiers(value: string, allowLeadingZeros: boolean): boolean {
  for (const identifier of value.split(".")) {
    if (!semanticVersionIdentifierPattern.test(identifier)) return false;
    if (!allowLeadingZeros && hasInvalidNumericIdentifier(identifier)) return false;
  }
  return true;
}

function hasInvalidNumericIdentifier(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith("0") && numericIdentifierPattern.test(identifier);
}

function comparePiVersions(left: PiVersion, right: PiVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}
