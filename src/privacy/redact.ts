import { createHash } from "node:crypto";
import { basename, dirname } from "node:path/posix";
import { matchAllSecretPatterns, type SecretMatch } from "./secret-patterns.ts";
import type { CustomRedactionPatternConfig, PrivacyPathMode } from "../config/schema.ts";

export type RedactionStage =
  | "size_guard"
  | "secret_detector"
  | "pii_detector"
  | "path_scrubber"
  | "custom_regex_redactors"
  | "truncation"
  | "hashing"
  | "export";

export interface PiiMatch {
  readonly type: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export interface RedactionOptions {
  readonly pathMode: PrivacyPathMode;
  readonly customRedactionPatterns?: readonly CustomRedactionPatternConfig[];
  readonly maxInputChars?: number;
  readonly maxOutputChars?: number;
  readonly piiEnabled?: boolean;
  readonly piiDetector?: (value: string) => readonly PiiMatch[];
  readonly secretMatcher?: (value: string) => readonly SecretMatch[];
  readonly onStage?: (stage: RedactionStage) => void;
}

export interface RedactionFailureMetrics {
  readonly redactionFailures: number;
}

export interface RedactionResult {
  readonly value?: string;
  readonly hash?: string;
  readonly dropped: boolean;
  readonly truncated: boolean;
  readonly originalLength?: number;
  readonly failureMetrics: RedactionFailureMetrics;
  readonly errors: readonly string[];
  readonly stages: readonly RedactionStage[];
}

export interface ReplacementMatch {
  readonly type: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const DEFAULT_MAX_INPUT_CHARS = 1_000_000;
const DEFAULT_MAX_OUTPUT_CHARS = 32_000;
const HASH_PREFIX_LENGTH = 12;
const ABSOLUTE_HOME_PATH_PATTERN = /\/(?:home|Users)\/[^\s'"`]+/gu;
const REDACTED_PATH_PLACEHOLDER = "[REDACTED:path]";

export function redactValue(rawValue: string, options: RedactionOptions): RedactionResult {
  const stages: RedactionStage[] = [];
  try {
    const guardedValue = runSizeGuard(rawValue, options, stages);
    const secretRedactedValue = runSecretDetector(guardedValue, options, stages);
    const piiRedactedValue = runPiiDetector(secretRedactedValue, options, stages);
    const pathRedactedValue = runPathScrubber(piiRedactedValue, options, stages);
    const customRedactedValue = runCustomRegexRedactors(pathRedactedValue, options, stages);
    const truncated = runTruncation(customRedactedValue, options, stages);
    const hash = runHashing(truncated.value, options, stages);
    runExportStage(options, stages);

    return {
      value: truncated.value,
      hash,
      dropped: false,
      truncated: truncated.truncated,
      originalLength: truncated.originalLength,
      failureMetrics: { redactionFailures: 0 },
      errors: [],
      stages,
    };
  } catch (error) {
    return redactionFailureResult(error, stages);
  }
}

export function redactPath(path: string, pathMode: PrivacyPathMode): string | undefined {
  if (pathMode === "full") return path;
  if (pathMode === "drop") return undefined;
  if (pathMode === "basename") return basename(path);
  return hashPath(path);
}

export function runSizeGuard(rawValue: string, options: RedactionOptions, stages: RedactionStage[]): string {
  recordStage("size_guard", options, stages);
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  if (rawValue.length > maxInputChars) throw new Error("redaction input exceeds size guard");
  return rawValue;
}

export function runSecretDetector(value: string, options: RedactionOptions, stages: RedactionStage[]): string {
  recordStage("secret_detector", options, stages);
  const secretMatcher = options.secretMatcher ?? matchAllSecretPatterns;
  const matches = secretMatcher(value);
  return replaceMatches(value, matches.map(toReplacementMatch));
}

export function runPiiDetector(value: string, options: RedactionOptions, stages: RedactionStage[]): string {
  recordStage("pii_detector", options, stages);
  if (options.piiEnabled !== true) return value;
  if (!options.piiDetector) return value;
  const matches = options.piiDetector(value);
  return replaceMatches(value, matches.map(toPiiReplacementMatch));
}

export function runPathScrubber(value: string, options: RedactionOptions, stages: RedactionStage[]): string {
  recordStage("path_scrubber", options, stages);
  if (options.pathMode === "full") return value;
  return value.replace(ABSOLUTE_HOME_PATH_PATTERN, match => redactEmbeddedPath(match, options.pathMode));
}

export function runCustomRegexRedactors(value: string, options: RedactionOptions, stages: RedactionStage[]): string {
  recordStage("custom_regex_redactors", options, stages);
  const patterns = options.customRedactionPatterns ?? [];
  return patterns.reduce(applyCustomRedactionPattern, value);
}

export function runTruncation(
  value: string,
  options: RedactionOptions,
  stages: RedactionStage[],
): { readonly value: string; readonly truncated: boolean; readonly originalLength?: number } {
  recordStage("truncation", options, stages);
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  if (value.length <= maxOutputChars) return { value, truncated: false };
  return { value: value.slice(0, maxOutputChars), truncated: true, originalLength: value.length };
}

export function runHashing(value: string, options: RedactionOptions, stages: RedactionStage[]): string {
  recordStage("hashing", options, stages);
  return sha256Hex(value);
}

export function runExportStage(options: RedactionOptions, stages: RedactionStage[]): void {
  recordStage("export", options, stages);
}

export function recordStage(stage: RedactionStage, options: RedactionOptions, stages: RedactionStage[]): void {
  stages.push(stage);
  options.onStage?.(stage);
}

export function redactionFailureResult(error: unknown, stages: readonly RedactionStage[]): RedactionResult {
  return {
    value: undefined,
    dropped: true,
    truncated: false,
    failureMetrics: { redactionFailures: 1 },
    errors: [error instanceof Error ? error.message : String(error)],
    stages,
  };
}

export function replaceMatches(value: string, matches: readonly ReplacementMatch[]): string {
  const selectedMatches = selectNonOverlappingMatches(matches);
  let result = "";
  let cursor = 0;

  for (const match of selectedMatches) {
    result += value.slice(cursor, match.start);
    result += formatReplacement(match);
    cursor = match.end;
  }

  return `${result}${value.slice(cursor)}`;
}

export function selectNonOverlappingMatches(matches: readonly ReplacementMatch[]): ReplacementMatch[] {
  const sortedMatches = [...matches].sort(compareReplacementMatches);
  const selectedMatches: ReplacementMatch[] = [];
  let cursor = 0;

  for (const match of sortedMatches) {
    if (match.start < cursor) continue;
    selectedMatches.push(match);
    cursor = match.end;
  }

  return selectedMatches;
}

export function compareReplacementMatches(left: ReplacementMatch, right: ReplacementMatch): number {
  if (left.start !== right.start) return left.start - right.start;
  if (left.end !== right.end) return right.end - left.end;
  return left.type.localeCompare(right.type);
}

export function toReplacementMatch(match: SecretMatch): ReplacementMatch {
  return {
    type: match.type,
    value: match.value,
    start: match.start,
    end: match.end,
  };
}

export function toPiiReplacementMatch(match: PiiMatch): ReplacementMatch {
  return {
    type: normalizeCustomType(match.type),
    value: match.value,
    start: match.start,
    end: match.end,
  };
}

export function formatReplacement(match: ReplacementMatch): string {
  return `[REDACTED:${match.type}:${sha256Prefix(match.value)}]`;
}

export function redactEmbeddedPath(path: string, pathMode: PrivacyPathMode): string {
  return redactPath(path, pathMode) ?? REDACTED_PATH_PLACEHOLDER;
}

export function hashPath(path: string): string {
  return `/<home>/${sha256Prefix(dirname(path))}/${basename(path)}`;
}

export function applyCustomRedactionPattern(value: string, pattern: CustomRedactionPatternConfig): string {
  const expression = compileCustomRedactionPattern(pattern.pattern);
  return value.replace(expression, match => formatCustomReplacement(pattern.name, match));
}

export function compileCustomRedactionPattern(pattern: string): RegExp {
  if (pattern.startsWith("(?i)")) return new RegExp(pattern.slice(4), "giu");
  return new RegExp(pattern, "gu");
}

export function formatCustomReplacement(name: string, value: string): string {
  return `[REDACTED:${normalizeCustomType(name)}:${sha256Prefix(value)}]`;
}

export function normalizeCustomType(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "") || "custom";
}

export function sha256Prefix(value: string): string {
  return sha256Hex(value).slice(0, HASH_PREFIX_LENGTH);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
