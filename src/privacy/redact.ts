import { basename, dirname } from "node:path/posix";
import { sha256, type TenantSaltSource } from "./hash.ts";
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
  readonly tenantSaltSource?: TenantSaltSource;
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

export const MAX_CUSTOM_REDACTION_PATTERNS = 16;
export const MAX_CUSTOM_REDACTION_PATTERN_CHARS = 256;

export interface CustomRedactionPatternSafetyIssue {
  readonly code:
    | "custom_redaction_pattern_limit"
    | "custom_redaction_pattern_too_long"
    | "custom_redaction_pattern_unsupported_construct"
    | "custom_redaction_pattern_nested_quantifier"
    | "custom_redaction_pattern_empty_match"
    | "invalid_custom_redaction_pattern";
  readonly message: string;
}

interface RegexGroupScanState {
  hasQuantifier: boolean;
}

interface RegexGroupScanContext {
  readonly groupStack: RegexGroupScanState[];
  escaped: boolean;
  inCharacterClass: boolean;
  lastClosedGroupHadQuantifier: boolean;
}

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

export function redactPath(path: string, pathMode: PrivacyPathMode, tenantSaltSource?: TenantSaltSource): string | undefined {
  if (pathMode === "full") return path;
  if (pathMode === "drop") return undefined;
  if (pathMode === "basename") return basename(path);
  return hashPath(path, tenantSaltSource);
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
  return replaceMatches(value, matches.map(toReplacementMatch), options);
}

export function runPiiDetector(value: string, options: RedactionOptions, stages: RedactionStage[]): string {
  recordStage("pii_detector", options, stages);
  if (options.piiEnabled !== true) return value;
  if (!options.piiDetector) return value;
  const matches = options.piiDetector(value);
  return replaceMatches(value, matches.map(toPiiReplacementMatch), options);
}

export function runPathScrubber(value: string, options: RedactionOptions, stages: RedactionStage[]): string {
  recordStage("path_scrubber", options, stages);
  if (options.pathMode === "full") return value;
  return value.replace(ABSOLUTE_HOME_PATH_PATTERN, match => redactEmbeddedPath(match, options.pathMode, options.tenantSaltSource));
}

export function runCustomRegexRedactors(value: string, options: RedactionOptions, stages: RedactionStage[]): string {
  recordStage("custom_regex_redactors", options, stages);
  const patterns = options.customRedactionPatterns ?? [];
  const issues = validateCustomRedactionPatterns(patterns);
  if (issues.length > 0) throw new Error(issues[0].message);

  let redactedValue = value;
  for (const pattern of patterns) redactedValue = applyCustomRedactionPattern(redactedValue, pattern, options.tenantSaltSource);
  return redactedValue;
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
  if (!options.tenantSaltSource) throw new Error("tenant salt source is required for redaction hashing");
  return sha256(value, options.tenantSaltSource);
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

export function replaceMatches(value: string, matches: readonly ReplacementMatch[], options: RedactionOptions): string {
  const selectedMatches = selectNonOverlappingMatches(matches);
  let result = "";
  let cursor = 0;

  for (const match of selectedMatches) {
    result += value.slice(cursor, match.start);
    result += formatReplacement(match, options);
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

export function formatReplacement(match: ReplacementMatch, options: RedactionOptions): string {
  return `[REDACTED:${match.type}:${sha256Prefix(match.value, options.tenantSaltSource)}]`;
}

export function redactEmbeddedPath(path: string, pathMode: PrivacyPathMode, tenantSaltSource?: TenantSaltSource): string {
  return redactPath(path, pathMode, tenantSaltSource) ?? REDACTED_PATH_PLACEHOLDER;
}

export function hashPath(path: string, tenantSaltSource?: TenantSaltSource): string {
  return `/<home>/${sha256Prefix(dirname(path), tenantSaltSource)}/${basename(path)}`;
}

export function applyCustomRedactionPattern(
  value: string,
  pattern: CustomRedactionPatternConfig,
  tenantSaltSource?: TenantSaltSource,
): string {
  const expression = compileCustomRedactionPattern(pattern.pattern);
  return value.replace(expression, match => formatCustomReplacement(pattern.name, match, tenantSaltSource));
}

export function compileCustomRedactionPattern(pattern: string): RegExp {
  const issues = validateCustomRedactionPattern(pattern);
  if (issues.length > 0) throw new Error(issues[0].message);
  if (pattern.startsWith("(?i)")) return new RegExp(pattern.slice(4), "giu");
  return new RegExp(pattern, "gu");
}

export function validateCustomRedactionPatterns(
  patterns: readonly CustomRedactionPatternConfig[],
): CustomRedactionPatternSafetyIssue[] {
  const issues: CustomRedactionPatternSafetyIssue[] = [];
  if (patterns.length > MAX_CUSTOM_REDACTION_PATTERNS) issues.push(createCustomRedactionPatternLimitIssue());

  for (const [index, pattern] of patterns.entries()) {
    issues.push(...validateCustomRedactionPattern(pattern.pattern).map(issue => addCustomRedactionPatternIndex(issue, index)));
  }

  return issues;
}

export function validateCustomRedactionPattern(pattern: string): CustomRedactionPatternSafetyIssue[] {
  if (pattern.length > MAX_CUSTOM_REDACTION_PATTERN_CHARS) return [createCustomRedactionPatternTooLongIssue()];

  const source = normalizeCustomRedactionPatternSource(pattern);
  const unsafeIssue = detectUnsafeCustomRedactionPattern(source);
  if (unsafeIssue) return [unsafeIssue];

  return validateCustomRedactionPatternSyntax(source);
}

export function normalizeCustomRedactionPatternSource(pattern: string): string {
  if (pattern.startsWith("(?i)")) return pattern.slice(4);
  return pattern;
}

export function detectUnsafeCustomRedactionPattern(source: string): CustomRedactionPatternSafetyIssue | undefined {
  if (hasUnsupportedCustomRedactionConstruct(source)) return createCustomRedactionPatternUnsupportedConstructIssue();
  if (hasNestedQuantifiedGroup(source)) return createCustomRedactionPatternNestedQuantifierIssue();
  return undefined;
}

export function hasUnsupportedCustomRedactionConstruct(source: string): boolean {
  let escaped = false;
  let inCharacterClass = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      if (isBackreferenceEscape(source, index)) return true;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") inCharacterClass = true;
    if (char === "]") inCharacterClass = false;
    if (!inCharacterClass && char === "(" && source[index + 1] === "?" && source[index + 2] !== ":") return true;
  }

  return false;
}

export function hasNestedQuantifiedGroup(source: string): boolean {
  const context = createRegexGroupScanContext();

  for (let index = 0; index < source.length; index += 1) {
    if (scanRegexEscape(source[index], context)) continue;
    if (scanRegexCharacterClass(source[index], context)) continue;
    if (context.inCharacterClass) continue;
    if (scanRegexGroupBoundary(source[index], context)) continue;
    if (scanRegexQuantifier(source, index, context)) return true;
    context.lastClosedGroupHadQuantifier = false;
  }

  return false;
}

function createRegexGroupScanContext(): RegexGroupScanContext {
  return { groupStack: [], escaped: false, inCharacterClass: false, lastClosedGroupHadQuantifier: false };
}

function scanRegexEscape(char: string, context: RegexGroupScanContext): boolean {
  if (context.escaped) {
    context.escaped = false;
    context.lastClosedGroupHadQuantifier = false;
    return true;
  }

  if (char !== "\\") return false;
  context.escaped = true;
  context.lastClosedGroupHadQuantifier = false;
  return true;
}

function scanRegexCharacterClass(char: string, context: RegexGroupScanContext): boolean {
  if (char === "[" && !context.inCharacterClass) {
    context.inCharacterClass = true;
    context.lastClosedGroupHadQuantifier = false;
    return true;
  }

  if (char !== "]" || !context.inCharacterClass) return false;
  context.inCharacterClass = false;
  return true;
}

function scanRegexGroupBoundary(char: string, context: RegexGroupScanContext): boolean {
  if (char === "(") {
    context.groupStack.push({ hasQuantifier: false });
    context.lastClosedGroupHadQuantifier = false;
    return true;
  }

  if (char !== ")") return false;
  context.lastClosedGroupHadQuantifier = context.groupStack.pop()?.hasQuantifier === true;
  return true;
}

function scanRegexQuantifier(source: string, index: number, context: RegexGroupScanContext): boolean {
  if (!isRegexQuantifierStart(source, index)) return false;
  if (context.lastClosedGroupHadQuantifier) return true;

  markCurrentRegexGroupQuantified(context.groupStack);
  context.lastClosedGroupHadQuantifier = false;
  return false;
}

export function validateCustomRedactionPatternSyntax(source: string): CustomRedactionPatternSafetyIssue[] {
  try {
    const expression = new RegExp(source, "u");
    if (expression.test("")) return [createCustomRedactionPatternEmptyMatchIssue()];
    return [];
  } catch (error) {
    return [createInvalidCustomRedactionPatternIssue(error)];
  }
}

export function isBackreferenceEscape(source: string, index: number): boolean {
  const char = source[index];
  return /[1-9]/u.test(char) || (char === "k" && source[index + 1] === "<");
}

export function isRegexQuantifierStart(source: string, index: number): boolean {
  const char = source[index];
  if (char === "?" && source[index - 1] === "(") return false;
  return char === "*" || char === "+" || char === "?" || isBraceQuantifierStart(source, index);
}

export function isBraceQuantifierStart(source: string, index: number): boolean {
  if (source[index] !== "{") return false;
  const closeIndex = source.indexOf("}", index + 1);
  if (closeIndex === -1) return false;
  return /^\d+(?:,\d*)?$/u.test(source.slice(index + 1, closeIndex));
}

export function markCurrentRegexGroupQuantified(groupStack: RegexGroupScanState[]): void {
  const currentGroup = groupStack.at(-1);
  if (currentGroup) currentGroup.hasQuantifier = true;
}

export function addCustomRedactionPatternIndex(
  issue: CustomRedactionPatternSafetyIssue,
  index: number,
): CustomRedactionPatternSafetyIssue {
  return {
    code: issue.code,
    message: `Custom redaction pattern at index ${index} was rejected: ${issue.message}`,
  };
}

export function createCustomRedactionPatternLimitIssue(): CustomRedactionPatternSafetyIssue {
  return {
    code: "custom_redaction_pattern_limit",
    message: `Custom redaction patterns are limited to ${MAX_CUSTOM_REDACTION_PATTERNS} entries.`,
  };
}

export function createCustomRedactionPatternTooLongIssue(): CustomRedactionPatternSafetyIssue {
  return {
    code: "custom_redaction_pattern_too_long",
    message: `Custom redaction patterns are limited to ${MAX_CUSTOM_REDACTION_PATTERN_CHARS} characters.`,
  };
}

export function createCustomRedactionPatternUnsupportedConstructIssue(): CustomRedactionPatternSafetyIssue {
  return {
    code: "custom_redaction_pattern_unsupported_construct",
    message: "Custom redaction patterns do not support lookaround, inline flag groups, named groups, or backreferences.",
  };
}

export function createCustomRedactionPatternNestedQuantifierIssue(): CustomRedactionPatternSafetyIssue {
  return {
    code: "custom_redaction_pattern_nested_quantifier",
    message: "Custom redaction patterns must not repeat a group that already contains a quantifier.",
  };
}

export function createCustomRedactionPatternEmptyMatchIssue(): CustomRedactionPatternSafetyIssue {
  return {
    code: "custom_redaction_pattern_empty_match",
    message: "Custom redaction patterns must not match an empty string.",
  };
}

export function createInvalidCustomRedactionPatternIssue(error?: unknown): CustomRedactionPatternSafetyIssue {
  return {
    code: "invalid_custom_redaction_pattern",
    message: `Custom redaction pattern is not a valid regular expression${formatRegexSyntaxError(error)}.`,
  };
}

function formatRegexSyntaxError(error: unknown): string {
  if (error === undefined) return "";
  if (error instanceof Error) return ` (${error.name})`;
  return " (unknown parser failure)";
}

export function formatCustomReplacement(name: string, value: string, tenantSaltSource?: TenantSaltSource): string {
  return `[REDACTED:${normalizeCustomType(name)}:${sha256Prefix(value, tenantSaltSource)}]`;
}

export function normalizeCustomType(value: string): string {
  const normalized = trimUnderscores(value.toLowerCase().replace(/[^a-z0-9_]+/gu, "_"));
  return normalized || "custom";
}

function trimUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "_") start += 1;
  while (end > start && value[end - 1] === "_") end -= 1;
  return value.slice(start, end);
}

export function sha256Prefix(value: string, tenantSaltSource?: TenantSaltSource): string {
  if (!tenantSaltSource) throw new Error("tenant salt source is required for redaction hashing");
  return sha256Hex(value, tenantSaltSource).slice(0, HASH_PREFIX_LENGTH);
}

export function sha256Hex(value: string, tenantSaltSource: TenantSaltSource): string {
  return sha256(value, tenantSaltSource);
}
