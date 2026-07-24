import {
  basename as posixBasename,
  dirname as posixDirname,
  isAbsolute as isPosixAbsolute,
} from "node:path/posix";
import {
  basename as windowsBasename,
  dirname as windowsDirname,
  isAbsolute as isWindowsAbsolute,
} from "node:path/win32";
import { sha256, type TenantSaltSource } from "./hash.ts";
import { matchAllSecretPatterns, type SecretMatch } from "./secret-patterns.ts";
import {
  CUSTOM_REDACTION_PATTERN_NAME_MAX_CHARS,
  type CustomRedactionPatternConfig,
  type PrivacyPathMode,
} from "../config/schema.ts";

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

export const DEFAULT_MAX_INPUT_CHARS = 1_000_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 32_000;
export const MAX_CUSTOM_REDACTION_MATCHES = 4_096;
export const MAX_CUSTOM_REDACTION_INTERMEDIATE_CHARS = DEFAULT_MAX_INPUT_CHARS;
const HASH_PREFIX_LENGTH = 12;
export const MAX_CUSTOM_REDACTION_REPLACEMENT_CHARS =
  "[REDACTED::]".length + CUSTOM_REDACTION_PATTERN_NAME_MAX_CHARS + HASH_PREFIX_LENGTH;
const CUSTOM_REDACTION_BUDGET_EXCEEDED_ERROR = "custom redaction budget exceeded";
const ABSOLUTE_PATH_CANDIDATE_PATTERN = /(?:[a-zA-Z]:[\\/][^\s'"`<>|]*|\\\\[^\s'"`<>|]*|\/[^\s'"`<>|]*)/gu;
const PATH_PREFIX_CONTINUATION_PATTERN = /[\p{L}\p{N}._~:/\\-]/u;
const TRAILING_PATH_PUNCTUATION = new Set([".", ",", ";", "!", "?", ")", "]", "}"]);
const REDACTED_PATH_PLACEHOLDER = "[REDACTED:path]";

export type AbsolutePathStyle = "posix" | "windows";

export interface AbsolutePathMatch {
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly style: AbsolutePathStyle;
}

export const MAX_CUSTOM_REDACTION_PATTERNS = 16;
export const MAX_CUSTOM_REDACTION_PATTERN_CHARS = 256;

export interface CustomRedactionPatternSafetyIssue {
  readonly code:
    | "custom_redaction_pattern_limit"
    | "custom_redaction_pattern_name_too_long"
    | "custom_redaction_pattern_too_long"
    | "custom_redaction_pattern_unsupported_construct"
    | "custom_redaction_pattern_nested_quantifier"
    | "custom_redaction_pattern_ambiguous_alternation"
    | "custom_redaction_pattern_ambiguous_repetition"
    | "custom_redaction_pattern_empty_match"
    | "invalid_custom_redaction_pattern";
  readonly message: string;
}

interface RegexCharacterRange {
  readonly start: number;
  readonly end: number;
}

type RegexCharacterDomain = readonly RegexCharacterRange[];

type RegexSafetyNode =
  | RegexEmptyNode
  | RegexCharacterNode
  | RegexSequenceNode
  | RegexAlternationNode
  | RegexRepetitionNode;

interface RegexEmptyNode {
  readonly kind: "empty";
}

interface RegexCharacterNode {
  readonly kind: "character";
  readonly domain: RegexCharacterDomain | undefined;
}

interface RegexSequenceNode {
  readonly kind: "sequence";
  readonly children: readonly RegexSafetyNode[];
}

interface RegexAlternationNode {
  readonly kind: "alternation";
  readonly branches: readonly RegexSafetyNode[];
}

interface RegexRepetitionNode {
  readonly kind: "repetition";
  readonly child: RegexSafetyNode;
  readonly minimum: number;
  readonly maximum: number;
  readonly variable: boolean;
}

interface RegexSafetyParserState {
  readonly source: string;
  readonly caseInsensitive: boolean;
  index: number;
  failed: boolean;
}

interface RegexQuantifier {
  readonly minimum: number;
  readonly maximum: number;
  readonly end: number;
}

interface RegexEscapeToken {
  readonly end: number;
  readonly assertion: boolean;
  readonly domain: RegexCharacterDomain | undefined;
  readonly singleton: number | undefined;
}

interface RegexCharacterClassToken {
  readonly end: number;
  readonly domain: RegexCharacterDomain | undefined;
  readonly singleton: number | undefined;
}

type UnsafeQuantifiedGroupKind = "nested_quantifier" | "ambiguous_alternation" | "ambiguous_repetition";

interface CustomRedactionWorkState {
  matchCount: number;
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

  const style = detectAbsolutePathStyle(path) ?? "posix";
  if (pathMode === "basename") return pathBasename(path, style);
  return hashPath(path, tenantSaltSource, style);
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
  return replaceAbsolutePaths(value, findAbsolutePaths(value), options.pathMode, options.tenantSaltSource);
}

export function runCustomRegexRedactors(value: string, options: RedactionOptions, stages: RedactionStage[]): string {
  recordStage("custom_regex_redactors", options, stages);
  const patterns = options.customRedactionPatterns ?? [];
  const issues = validateCustomRedactionPatterns(patterns);
  if (issues.length > 0) throw new Error(issues[0].message);

  const workState: CustomRedactionWorkState = { matchCount: 0 };
  let redactedValue = value;
  for (const pattern of patterns) {
    redactedValue = applyCustomRedactionPattern(redactedValue, pattern, options.tenantSaltSource, workState);
  }
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

export function findAbsolutePaths(value: string): AbsolutePathMatch[] {
  const matches: AbsolutePathMatch[] = [];

  for (const candidateMatch of value.matchAll(ABSOLUTE_PATH_CANDIDATE_PATTERN)) {
    const candidateStart = candidateMatch.index;
    if (!isAbsolutePathStartBoundary(value, candidateStart)) continue;

    const candidate = trimTrailingPathPunctuation(candidateMatch[0]);
    const style = detectAbsolutePathStyle(candidate);
    if (!style) continue;

    matches.push({ value: candidate, start: candidateStart, end: candidateStart + candidate.length, style });
  }

  return matches;
}

export function isAbsolutePathStartBoundary(value: string, start: number): boolean {
  if (start === 0) return true;
  return !PATH_PREFIX_CONTINUATION_PATTERN.test(value[start - 1]);
}

export function trimTrailingPathPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_PATH_PUNCTUATION.has(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

export function detectAbsolutePathStyle(path: string): AbsolutePathStyle | undefined {
  if (isWindowsDrivePath(path) || isUncPath(path)) return "windows";
  if (isPosixAbsolute(path) && !path.startsWith("//")) return "posix";
  return undefined;
}

export function isWindowsDrivePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(path) && isWindowsAbsolute(path);
}

export function isUncPath(path: string): boolean {
  if (!path.startsWith("\\\\") || !isWindowsAbsolute(path)) return false;
  const segments = path.slice(2).split(/[\\/]+/u);
  return segments.length >= 2 && segments[0].length > 0 && segments[1].length > 0;
}

export function replaceAbsolutePaths(
  value: string,
  matches: readonly AbsolutePathMatch[],
  pathMode: PrivacyPathMode,
  tenantSaltSource?: TenantSaltSource,
): string {
  let result = "";
  let cursor = 0;

  for (const match of matches) {
    result += value.slice(cursor, match.start);
    result += redactEmbeddedPath(match.value, pathMode, tenantSaltSource, match.style);
    cursor = match.end;
  }

  return `${result}${value.slice(cursor)}`;
}

export function redactEmbeddedPath(
  path: string,
  pathMode: PrivacyPathMode,
  tenantSaltSource?: TenantSaltSource,
  style: AbsolutePathStyle = detectAbsolutePathStyle(path) ?? "posix",
): string {
  if (pathMode === "full") return path;
  if (pathMode === "drop") return REDACTED_PATH_PLACEHOLDER;
  if (pathMode === "basename") return pathBasename(path, style);
  return hashPath(path, tenantSaltSource, style);
}

export function hashPath(
  path: string,
  tenantSaltSource?: TenantSaltSource,
  style: AbsolutePathStyle = detectAbsolutePathStyle(path) ?? "posix",
): string {
  return `/<home>/${sha256Prefix(pathDirname(path, style), tenantSaltSource)}/${pathBasename(path, style)}`;
}

export function pathBasename(path: string, style: AbsolutePathStyle): string {
  return style === "windows" ? windowsBasename(path) : posixBasename(path);
}

export function pathDirname(path: string, style: AbsolutePathStyle): string {
  return style === "windows" ? windowsDirname(path) : posixDirname(path);
}

export function applyCustomRedactionPattern(
  value: string,
  pattern: CustomRedactionPatternConfig,
  tenantSaltSource?: TenantSaltSource,
  workState: CustomRedactionWorkState = { matchCount: 0 },
): string {
  if (value.length > MAX_CUSTOM_REDACTION_INTERMEDIATE_CHARS) {
    throw new Error(CUSTOM_REDACTION_BUDGET_EXCEEDED_ERROR);
  }

  const expression = compileCustomRedactionPattern(pattern.pattern);
  const normalizedName = normalizeCustomType(pattern.name);
  const replacementPrefix = `[REDACTED:${normalizedName}:`;
  const replacementLength = replacementPrefix.length + HASH_PREFIX_LENGTH + 1;
  const chunks: string[] = [];
  let cursor = 0;
  let outputLength = 0;
  let match = expression.exec(value);

  while (match) {
    workState.matchCount += 1;
    if (workState.matchCount > MAX_CUSTOM_REDACTION_MATCHES) throw new Error(CUSTOM_REDACTION_BUDGET_EXCEEDED_ERROR);

    const unmatchedLength = match.index - cursor;
    if (outputLength + unmatchedLength + replacementLength > MAX_CUSTOM_REDACTION_INTERMEDIATE_CHARS) {
      throw new Error(CUSTOM_REDACTION_BUDGET_EXCEEDED_ERROR);
    }

    chunks.push(value.slice(cursor, match.index));
    chunks.push(`${replacementPrefix}${sha256Prefix(match[0], tenantSaltSource)}]`);
    outputLength += unmatchedLength + replacementLength;
    cursor = match.index + match[0].length;
    match = expression.exec(value);
  }

  const tailLength = value.length - cursor;
  if (outputLength + tailLength > MAX_CUSTOM_REDACTION_INTERMEDIATE_CHARS) {
    throw new Error(CUSTOM_REDACTION_BUDGET_EXCEEDED_ERROR);
  }
  if (chunks.length === 0) return value;

  chunks.push(value.slice(cursor));
  return chunks.join("");
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

  const validatedPatternCount = Math.min(patterns.length, MAX_CUSTOM_REDACTION_PATTERNS);
  for (let index = 0; index < validatedPatternCount; index += 1) {
    const pattern = patterns[index];
    if (pattern.name.length > CUSTOM_REDACTION_PATTERN_NAME_MAX_CHARS) {
      issues.push(addCustomRedactionPatternIndex(createCustomRedactionPatternNameTooLongIssue(), index));
    }
    issues.push(...validateCustomRedactionPattern(pattern.pattern).map(issue => addCustomRedactionPatternIndex(issue, index)));
  }

  return issues;
}

export function validateCustomRedactionPattern(pattern: string): CustomRedactionPatternSafetyIssue[] {
  if (pattern.length > MAX_CUSTOM_REDACTION_PATTERN_CHARS) return [createCustomRedactionPatternTooLongIssue()];

  const source = normalizeCustomRedactionPatternSource(pattern);
  const unsafeIssue = detectUnsafeCustomRedactionPattern(source, pattern.startsWith("(?i)"));
  if (unsafeIssue) return [unsafeIssue];

  return validateCustomRedactionPatternSyntax(source);
}

export function normalizeCustomRedactionPatternSource(pattern: string): string {
  if (pattern.startsWith("(?i)")) return pattern.slice(4);
  return pattern;
}

export function detectUnsafeCustomRedactionPattern(
  source: string,
  caseInsensitive = false,
): CustomRedactionPatternSafetyIssue | undefined {
  if (hasUnsupportedCustomRedactionConstruct(source)) return createCustomRedactionPatternUnsupportedConstructIssue();

  const unsafeQuantifiedGroup = detectUnsafeQuantifiedGroup(source, caseInsensitive);
  if (unsafeQuantifiedGroup === "nested_quantifier") return createCustomRedactionPatternNestedQuantifierIssue();
  if (unsafeQuantifiedGroup === "ambiguous_alternation") return createCustomRedactionPatternAmbiguousAlternationIssue();
  if (unsafeQuantifiedGroup === "ambiguous_repetition") return createCustomRedactionPatternAmbiguousRepetitionIssue();
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

export function hasNestedQuantifiedGroup(source: string, caseInsensitive = false): boolean {
  const tree = parseRegexSafetyPattern(source, caseInsensitive);
  return tree ? hasNestedRegexRepetition(tree) : false;
}

export function hasQuantifiedAlternationGroup(source: string, caseInsensitive = false): boolean {
  const tree = parseRegexSafetyPattern(source, caseInsensitive);
  return tree ? hasAmbiguousRepeatedAlternation(tree) : false;
}

export function detectUnsafeQuantifiedGroup(
  source: string,
  caseInsensitive = false,
): UnsafeQuantifiedGroupKind | undefined {
  const tree = parseRegexSafetyPattern(source, caseInsensitive);
  if (!tree) return undefined;
  if (hasNestedRegexRepetition(tree)) return "nested_quantifier";
  if (hasAmbiguousRepeatedAlternation(tree)) return "ambiguous_alternation";
  if (hasAmbiguousSequentialRepetition(tree)) return "ambiguous_repetition";
  return undefined;
}

function parseRegexSafetyPattern(source: string, caseInsensitive: boolean): RegexSafetyNode | undefined {
  const state: RegexSafetyParserState = { source, caseInsensitive, index: 0, failed: false };
  const tree = parseRegexSafetyAlternation(state);
  if (state.failed || state.index !== source.length) return undefined;
  return tree;
}

function parseRegexSafetyAlternation(state: RegexSafetyParserState): RegexSafetyNode {
  const branches: RegexSafetyNode[] = [parseRegexSafetySequence(state)];
  while (!state.failed && state.source[state.index] === "|") {
    state.index += 1;
    branches.push(parseRegexSafetySequence(state));
  }
  if (branches.length === 1) return branches[0];
  return { kind: "alternation", branches };
}

function parseRegexSafetySequence(state: RegexSafetyParserState): RegexSafetyNode {
  const children: RegexSafetyNode[] = [];
  while (!state.failed && state.index < state.source.length) {
    const char = state.source[state.index];
    if (char === "|" || char === ")") break;
    children.push(parseRegexSafetyQuantifiedAtom(state));
  }
  if (children.length === 0) return { kind: "empty" };
  if (children.length === 1) return children[0];
  return { kind: "sequence", children };
}

function parseRegexSafetyQuantifiedAtom(state: RegexSafetyParserState): RegexSafetyNode {
  const atom = parseRegexSafetyAtom(state);
  if (state.failed) return atom;

  const quantifier = readRegexQuantifier(state.source, state.index);
  if (!quantifier) return atom;
  state.index = quantifier.end;
  if (state.source[state.index] === "?") state.index += 1;
  if (quantifier.minimum === 1 && quantifier.maximum === 1) return atom;
  if (quantifier.maximum === 0) return { kind: "empty" };
  return {
    kind: "repetition",
    child: atom,
    minimum: quantifier.minimum,
    maximum: quantifier.maximum,
    variable: quantifier.minimum !== quantifier.maximum,
  };
}

function parseRegexSafetyAtom(state: RegexSafetyParserState): RegexSafetyNode {
  const char = state.source[state.index];
  if (char === "(") return parseRegexSafetyGroup(state);
  if (char === "[") return parseRegexSafetyCharacterClass(state);
  if (char === "\\") return parseRegexSafetyEscape(state);
  if (char === ".") {
    state.index += 1;
    return { kind: "character", domain: undefined };
  }
  if (char === "^" || char === "$") {
    state.index += 1;
    return { kind: "empty" };
  }
  if (char === undefined || "*+?{})".includes(char)) {
    state.failed = true;
    return { kind: "empty" };
  }

  const codePoint = state.source.codePointAt(state.index);
  if (codePoint === undefined) {
    state.failed = true;
    return { kind: "empty" };
  }
  state.index += codePoint > 0xffff ? 2 : 1;
  return { kind: "character", domain: createRegexCharacterDomain(codePoint, state.caseInsensitive) };
}

function parseRegexSafetyGroup(state: RegexSafetyParserState): RegexSafetyNode {
  if (state.source.startsWith("(?:", state.index)) state.index += 3;
  else state.index += 1;

  const child = parseRegexSafetyAlternation(state);
  if (state.source[state.index] !== ")") {
    state.failed = true;
    return child;
  }
  state.index += 1;
  return child;
}

function parseRegexSafetyCharacterClass(state: RegexSafetyParserState): RegexSafetyNode {
  const closeIndex = findRegexCharacterClassEnd(state.source, state.index + 1);
  if (closeIndex === -1) {
    state.failed = true;
    return { kind: "empty" };
  }

  const domain = readRegexCharacterClassDomain(
    state.source,
    state.index + 1,
    closeIndex,
    state.caseInsensitive,
  );
  state.index = closeIndex + 1;
  return { kind: "character", domain };
}

function parseRegexSafetyEscape(state: RegexSafetyParserState): RegexSafetyNode {
  const token = readRegexEscapeToken(state.source, state.index, false, state.caseInsensitive);
  state.index = token.end;
  if (token.assertion) return { kind: "empty" };
  return { kind: "character", domain: token.domain };
}

function readRegexQuantifier(source: string, index: number): RegexQuantifier | undefined {
  const char = source[index];
  if (char === "*") return { minimum: 0, maximum: Number.POSITIVE_INFINITY, end: index + 1 };
  if (char === "+") return { minimum: 1, maximum: Number.POSITIVE_INFINITY, end: index + 1 };
  if (char === "?") return { minimum: 0, maximum: 1, end: index + 1 };
  if (char !== "{") return undefined;

  const closeIndex = source.indexOf("}", index + 1);
  if (closeIndex === -1) return undefined;
  const body = source.slice(index + 1, closeIndex);
  if (!/^\d+(?:,\d*)?$/u.test(body)) return undefined;

  const commaIndex = body.indexOf(",");
  if (commaIndex === -1) {
    const exact = Number(body);
    return { minimum: exact, maximum: exact, end: closeIndex + 1 };
  }
  const minimum = Number(body.slice(0, commaIndex));
  const maximumSource = body.slice(commaIndex + 1);
  const maximum = maximumSource.length === 0 ? Number.POSITIVE_INFINITY : Number(maximumSource);
  return { minimum, maximum, end: closeIndex + 1 };
}

function findRegexCharacterClassEnd(source: string, start: number): number {
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (source[index] === "\\") {
      escaped = true;
      continue;
    }
    if (source[index] === "]") return index;
  }
  return -1;
}

function readRegexCharacterClassDomain(
  source: string,
  start: number,
  end: number,
  caseInsensitive: boolean,
): RegexCharacterDomain | undefined {
  if (source[start] === "^") return undefined;

  const ranges: RegexCharacterRange[] = [];
  let index = start;
  while (index < end) {
    const left = readRegexCharacterClassToken(source, index);
    if (!left.domain) return undefined;
    index = left.end;
    if (source[index] === "-" && index + 1 < end) {
      const right = readRegexCharacterClassToken(source, index + 1);
      if (left.singleton === undefined || right.singleton === undefined || left.singleton > right.singleton) {
        return undefined;
      }
      ranges.push({ start: left.singleton, end: right.singleton });
      index = right.end;
      continue;
    }
    ranges.push(...left.domain);
  }

  const domain = mergeRegexCharacterRanges(ranges);
  return caseInsensitive ? addAsciiCaseVariants(domain) : domain;
}

function readRegexCharacterClassToken(source: string, index: number): RegexCharacterClassToken {
  if (source[index] === "\\") {
    const token = readRegexEscapeToken(source, index, true, false);
    return { end: token.end, domain: token.domain, singleton: token.singleton };
  }

  const codePoint = source.codePointAt(index);
  if (codePoint === undefined) return { end: index + 1, domain: undefined, singleton: undefined };
  const end = index + (codePoint > 0xffff ? 2 : 1);
  return { end, domain: [{ start: codePoint, end: codePoint }], singleton: codePoint };
}

function readRegexEscapeToken(
  source: string,
  index: number,
  inCharacterClass: boolean,
  caseInsensitive: boolean,
): RegexEscapeToken {
  const escaped = source[index + 1];
  const end = findRegexEscapeEnd(source, index, escaped);
  if (!inCharacterClass && (escaped === "b" || escaped === "B")) {
    return { end, assertion: true, domain: [], singleton: undefined };
  }

  const shorthandDomain = regexShorthandDomain(escaped);
  if (shorthandDomain) return { end, assertion: false, domain: shorthandDomain, singleton: undefined };
  const singleton = decodeRegexEscapeCodePoint(source, index, escaped, inCharacterClass);
  const domain = singleton === undefined ? undefined : createRegexCharacterDomain(singleton, caseInsensitive);
  return { end, assertion: false, domain, singleton };
}

function findRegexEscapeEnd(source: string, index: number, escaped: string | undefined): number {
  if (escaped === undefined) return source.length;
  if ((escaped === "p" || escaped === "P") && source[index + 2] === "{") {
    const closeIndex = source.indexOf("}", index + 3);
    return closeIndex === -1 ? source.length : closeIndex + 1;
  }
  if (escaped === "u" && source[index + 2] === "{") {
    const closeIndex = source.indexOf("}", index + 3);
    return closeIndex === -1 ? source.length : closeIndex + 1;
  }
  if (escaped === "u") return Math.min(source.length, index + 6);
  if (escaped === "x") return Math.min(source.length, index + 4);
  if (escaped === "c") return Math.min(source.length, index + 3);
  return Math.min(source.length, index + 2);
}

function regexShorthandDomain(escaped: string | undefined): RegexCharacterDomain | undefined {
  if (escaped === "d") return [{ start: 0x30, end: 0x39 }];
  if (escaped === "w") {
    return [
      { start: 0x30, end: 0x39 },
      { start: 0x41, end: 0x5a },
      { start: 0x5f, end: 0x5f },
      { start: 0x61, end: 0x7a },
    ];
  }
  if (escaped === "s") {
    return [
      { start: 0x09, end: 0x0d },
      { start: 0x20, end: 0x20 },
      { start: 0xa0, end: 0xa0 },
      { start: 0x1680, end: 0x1680 },
      { start: 0x2000, end: 0x200a },
      { start: 0x2028, end: 0x2029 },
      { start: 0x202f, end: 0x202f },
      { start: 0x205f, end: 0x205f },
      { start: 0x3000, end: 0x3000 },
      { start: 0xfeff, end: 0xfeff },
    ];
  }
  return undefined;
}

function decodeRegexEscapeCodePoint(
  source: string,
  index: number,
  escaped: string | undefined,
  inCharacterClass: boolean,
): number | undefined {
  if (escaped === undefined) return undefined;
  const simpleEscapes: Readonly<Record<string, number>> = {
    "0": 0x00,
    b: inCharacterClass ? 0x08 : 0x62,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
  };
  if (simpleEscapes[escaped] !== undefined) return simpleEscapes[escaped];
  if (escaped === "x") return parseRegexHexEscape(source.slice(index + 2, index + 4));
  if (escaped === "u" && source[index + 2] === "{") {
    const closeIndex = source.indexOf("}", index + 3);
    return closeIndex === -1 ? undefined : parseRegexHexEscape(source.slice(index + 3, closeIndex));
  }
  if (escaped === "u") return parseRegexHexEscape(source.slice(index + 2, index + 6));
  if (escaped === "c") {
    const controlCodePoint = source.codePointAt(index + 2);
    return controlCodePoint === undefined ? undefined : controlCodePoint % 32;
  }
  if ("dDsSwWpPkK123456789".includes(escaped)) return undefined;
  return escaped.codePointAt(0);
}

function parseRegexHexEscape(source: string): number | undefined {
  if (!/^[\da-f]+$/iu.test(source)) return undefined;
  const codePoint = Number.parseInt(source, 16);
  return Number.isFinite(codePoint) ? codePoint : undefined;
}

function createRegexCharacterDomain(codePoint: number, caseInsensitive: boolean): RegexCharacterDomain | undefined {
  const domain = [{ start: codePoint, end: codePoint }];
  return caseInsensitive ? addAsciiCaseVariants(domain) : domain;
}

function addAsciiCaseVariants(domain: RegexCharacterDomain): RegexCharacterDomain | undefined {
  const ranges: RegexCharacterRange[] = [...domain];
  for (const range of domain) {
    if (range.end > 0x7f) return undefined;
    const upperStart = Math.max(range.start, 0x41);
    const upperEnd = Math.min(range.end, 0x5a);
    if (upperStart <= upperEnd) ranges.push({ start: upperStart + 0x20, end: upperEnd + 0x20 });
    const lowerStart = Math.max(range.start, 0x61);
    const lowerEnd = Math.min(range.end, 0x7a);
    if (lowerStart <= lowerEnd) ranges.push({ start: lowerStart - 0x20, end: lowerEnd - 0x20 });
  }
  return mergeRegexCharacterRanges(ranges);
}

function mergeRegexCharacterRanges(ranges: readonly RegexCharacterRange[]): RegexCharacterDomain {
  const sorted = [...ranges].sort(compareRegexCharacterRanges);
  const merged: RegexCharacterRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end + 1) {
      merged.push(range);
      continue;
    }
    if (range.end > previous.end) merged[merged.length - 1] = { start: previous.start, end: range.end };
  }
  return merged;
}

function compareRegexCharacterRanges(left: RegexCharacterRange, right: RegexCharacterRange): number {
  if (left.start !== right.start) return left.start - right.start;
  return left.end - right.end;
}

function regexNodeCanMatchEmpty(node: RegexSafetyNode): boolean {
  if (node.kind === "empty") return true;
  if (node.kind === "character") return false;
  if (node.kind === "repetition") return node.minimum === 0 || regexNodeCanMatchEmpty(node.child);
  if (node.kind === "alternation") {
    for (const branch of node.branches) if (regexNodeCanMatchEmpty(branch)) return true;
    return false;
  }
  for (const child of node.children) if (!regexNodeCanMatchEmpty(child)) return false;
  return true;
}

function regexNodeFirstDomain(node: RegexSafetyNode): RegexCharacterDomain | undefined {
  if (node.kind === "empty") return [];
  if (node.kind === "character") return node.domain;
  if (node.kind === "repetition") return regexNodeFirstDomain(node.child);
  if (node.kind === "alternation") return unionRegexNodeDomains(node.branches, false);
  return unionRegexNodeDomains(node.children, true);
}

function unionRegexNodeDomains(
  nodes: readonly RegexSafetyNode[],
  stopAfterRequiredNode: boolean,
): RegexCharacterDomain | undefined {
  const ranges: RegexCharacterRange[] = [];
  for (const node of nodes) {
    const domain = regexNodeFirstDomain(node);
    if (!domain) return undefined;
    ranges.push(...domain);
    if (stopAfterRequiredNode && !regexNodeCanMatchEmpty(node)) break;
  }
  return mergeRegexCharacterRanges(ranges);
}

function regexDomainsAreProvablyDisjoint(
  left: RegexCharacterDomain | undefined,
  right: RegexCharacterDomain | undefined,
): boolean {
  if (!left || !right) return false;
  for (const leftRange of left) {
    for (const rightRange of right) {
      if (leftRange.start <= rightRange.end && rightRange.start <= leftRange.end) return false;
    }
  }
  return true;
}

function regexNodeHasRepetition(node: RegexSafetyNode): boolean {
  if (node.kind === "repetition") return true;
  if (node.kind === "sequence") {
    for (const child of node.children) if (regexNodeHasRepetition(child)) return true;
  }
  if (node.kind === "alternation") {
    for (const branch of node.branches) if (regexNodeHasRepetition(branch)) return true;
  }
  return false;
}

function hasNestedRegexRepetition(node: RegexSafetyNode): boolean {
  if (node.kind === "repetition") {
    if (regexNodeHasRepetition(node.child)) return true;
    return hasNestedRegexRepetition(node.child);
  }
  if (node.kind === "sequence") {
    for (const child of node.children) if (hasNestedRegexRepetition(child)) return true;
  }
  if (node.kind === "alternation") {
    for (const branch of node.branches) if (hasNestedRegexRepetition(branch)) return true;
  }
  return false;
}

function hasAmbiguousRepeatedAlternation(node: RegexSafetyNode): boolean {
  if (node.kind === "repetition") {
    if (hasAmbiguousAlternationWithin(node.child)) return true;
    return hasAmbiguousRepeatedAlternation(node.child);
  }
  if (node.kind === "sequence") {
    for (const child of node.children) if (hasAmbiguousRepeatedAlternation(child)) return true;
  }
  if (node.kind === "alternation") {
    for (const branch of node.branches) if (hasAmbiguousRepeatedAlternation(branch)) return true;
  }
  return false;
}

function hasAmbiguousAlternationWithin(node: RegexSafetyNode): boolean {
  if (node.kind === "alternation") {
    if (regexAlternationBranchesOverlap(node)) return true;
    for (const branch of node.branches) if (hasAmbiguousAlternationWithin(branch)) return true;
  }
  if (node.kind === "sequence") {
    for (const child of node.children) if (hasAmbiguousAlternationWithin(child)) return true;
  }
  if (node.kind === "repetition") return hasAmbiguousAlternationWithin(node.child);
  return false;
}

function regexAlternationBranchesOverlap(node: RegexAlternationNode): boolean {
  for (const branch of node.branches) if (regexNodeCanMatchEmpty(branch)) return true;
  for (let leftIndex = 0; leftIndex < node.branches.length; leftIndex += 1) {
    const leftDomain = regexNodeFirstDomain(node.branches[leftIndex]);
    for (let rightIndex = leftIndex + 1; rightIndex < node.branches.length; rightIndex += 1) {
      const rightDomain = regexNodeFirstDomain(node.branches[rightIndex]);
      if (!regexDomainsAreProvablyDisjoint(leftDomain, rightDomain)) return true;
    }
  }
  return false;
}

function hasAmbiguousSequentialRepetition(node: RegexSafetyNode): boolean {
  if (node.kind === "sequence") return regexSequenceHasAmbiguousRepetition(node);
  if (node.kind === "alternation") {
    for (const branch of node.branches) if (hasAmbiguousSequentialRepetition(branch)) return true;
  }
  if (node.kind === "repetition") return hasAmbiguousSequentialRepetition(node.child);
  return false;
}

function regexSequenceHasAmbiguousRepetition(node: RegexSequenceNode): boolean {
  const previousRepetitions: RegexRepetitionNode[] = [];
  for (const child of node.children) {
    if (hasAmbiguousSequentialRepetition(child)) return true;
    const currentRepetitions = collectVariableRegexRepetitions(child);
    if (regexRepetitionCollectionsOverlap(previousRepetitions, currentRepetitions)) return true;
    previousRepetitions.push(...currentRepetitions);
  }
  return false;
}

function collectVariableRegexRepetitions(node: RegexSafetyNode): RegexRepetitionNode[] {
  if (node.kind === "repetition") return node.variable ? [node] : [];
  const repetitions: RegexRepetitionNode[] = [];
  if (node.kind === "sequence") {
    for (const child of node.children) repetitions.push(...collectVariableRegexRepetitions(child));
  }
  if (node.kind === "alternation") {
    for (const branch of node.branches) repetitions.push(...collectVariableRegexRepetitions(branch));
  }
  return repetitions;
}

function regexRepetitionCollectionsOverlap(
  left: readonly RegexRepetitionNode[],
  right: readonly RegexRepetitionNode[],
): boolean {
  for (const leftRepetition of left) {
    const leftDomain = regexNodeFirstDomain(leftRepetition.child);
    for (const rightRepetition of right) {
      const rightDomain = regexNodeFirstDomain(rightRepetition.child);
      if (!regexDomainsAreProvablyDisjoint(leftDomain, rightDomain)) return true;
    }
  }
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

export function createCustomRedactionPatternNameTooLongIssue(): CustomRedactionPatternSafetyIssue {
  return {
    code: "custom_redaction_pattern_name_too_long",
    message: `Custom redaction pattern names are limited to ${CUSTOM_REDACTION_PATTERN_NAME_MAX_CHARS} characters.`,
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

export function createCustomRedactionPatternAmbiguousAlternationIssue(): CustomRedactionPatternSafetyIssue {
  return {
    code: "custom_redaction_pattern_ambiguous_alternation",
    message: "Repeated custom redaction alternatives must begin with provably disjoint characters.",
  };
}

export function createCustomRedactionPatternAmbiguousRepetitionIssue(): CustomRedactionPatternSafetyIssue {
  return {
    code: "custom_redaction_pattern_ambiguous_repetition",
    message: "Custom redaction patterns must not combine repetitions with overlapping starting characters.",
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
  const boundedValue = value.slice(0, CUSTOM_REDACTION_PATTERN_NAME_MAX_CHARS);
  const normalized = trimUnderscores(boundedValue.toLowerCase().replace(/[^a-z0-9_]+/gu, "_"));
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
