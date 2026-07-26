export interface DiagnosticReplacement {
  readonly pattern: RegExp;
  readonly replacement: string;
}

export interface ObservMeSessionIdOptions {
  readonly emptyMessage: string;
}

export const SENSITIVE_QUERY_INPUT_DETAILS =
  "raw prompts, commands, paths, and inherited environment values are not query inputs.";
export const UNSAFE_OBSERVME_SESSION_ID_DETAILS =
  "only generated session IDs may be used; raw prompts, commands, paths, and environment values are not query inputs.";

const maximumDiagnosticLength = 360;
const rawContentMarkerPattern = /(?:^|[\s"'`|=(])(?:prompt|system prompt|user prompt|assistant response|thinking|raw content)\s*:/iu;
const shellCommandPattern = /(?:^|[\s"'`|=])(?:sudo|rm|mv|cp|curl|wget|npm|pnpm|yarn|node|python3?|bash|sh|git)\s+\S+/iu;
const localFilesystemPathPrefixPatternSource =
  String.raw`(?:~(?:[\\/]|\b)|\.{1,2}[\\/]|\/(?:Users|home|root|tmp|var|etc|private|workspace|opt|Volumes)(?:\/|\b)|[A-Za-z]:[\\/]|\\\\)`;
const localFilesystemPathPattern = new RegExp(
  `(?:^|[\\s"'\\x60=])${localFilesystemPathPrefixPatternSource}\\S*`,
  "u",
);
const diagnosticLocalFilesystemPathPattern = new RegExp(
  `(^|[\\s(\\["'\\x60=])${localFilesystemPathPrefixPatternSource}[^\\s)"'\\x60,;]*`,
  "gu",
);
const environmentAssignmentPattern = /\b[A-Z][A-Z0-9_]{2,}=[^\s"'`;,)]*/u;
const diagnosticEnvironmentAssignmentPattern = /\b[A-Z][A-Z0-9_]{2,}=[^\s"'`;,)]*/gu;
const unresolvedEnvironmentPlaceholderPattern = /\$\{[A-Z0-9_]+\}/u;
const diagnosticUnresolvedEnvironmentPlaceholderPattern = /\$\{[A-Z0-9_]+\}/gu;
const bearerCredentialPattern = /\bBearer\s+[^\s"'`;,)]+/iu;
const credentialAssignmentKeyPatternSource =
  String.raw`(access(?:[_-]|\s)?token|api(?:[_-]|\s)?key|client(?:[_-]|\s)?secret|token|password|secret|authorization)`;
const credentialAssignmentValuePatternSource = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'\x60;,)]+)`;
const credentialAssignmentPattern = new RegExp(
  String.raw`\b${credentialAssignmentKeyPatternSource}\s*[:=]\s*${credentialAssignmentValuePatternSource}`,
  "iu",
);
const diagnosticCredentialAssignmentPattern = new RegExp(
  String.raw`\b${credentialAssignmentKeyPatternSource}\s*[:=]\s*${credentialAssignmentValuePatternSource}`,
  "giu",
);
const safeObservMeSessionIdPattern = /^[A-Za-z0-9._:-]{1,256}$/u;
const sensitiveQueryInputPatterns = [
  rawContentMarkerPattern,
  shellCommandPattern,
  localFilesystemPathPattern,
  environmentAssignmentPattern,
  unresolvedEnvironmentPlaceholderPattern,
  bearerCredentialPattern,
  credentialAssignmentPattern,
] as const;
const diagnosticReplacements = [
  { pattern: /Bearer\s+[^\s;,)]+/giu, replacement: "Bearer [redacted]" },
  { pattern: /Basic\s+[^\s;,)]+/giu, replacement: "Basic [redacted]" },
  { pattern: diagnosticCredentialAssignmentPattern, replacement: "$1=[redacted]" },
  { pattern: diagnosticEnvironmentAssignmentPattern, replacement: "[redacted-env]" },
  { pattern: diagnosticUnresolvedEnvironmentPlaceholderPattern, replacement: "[redacted-env-placeholder]" },
  {
    pattern: /([?&](?:access_)?(?:token|password|secret|authorization)=)[^\s&#;,)]+/giu,
    replacement: "$1[redacted]",
  },
  {
    pattern: /(^|[\s(["'`])(?:prompt|system prompt|user prompt|assistant response|thinking|raw content)\s*:[^.;\n]*/giu,
    replacement: "$1[redacted-content]",
  },
  {
    pattern: /(^|[\s(["'`])(?:sudo|rm|mv|cp|curl|wget|npm|pnpm|yarn|node|python3?|bash|sh|git)\s+[^.;\n)]*/giu,
    replacement: "$1[redacted-command]",
  },
  {
    pattern: diagnosticLocalFilesystemPathPattern,
    replacement: "$1[redacted-path]",
  },
] as const satisfies readonly DiagnosticReplacement[];

export function assertNoSensitiveQueryInput(value: string, surface: string): void {
  if (!isSensitiveQueryInput(value)) return;

  throw new Error(`Unsafe ${surface}: ${SENSITIVE_QUERY_INPUT_DETAILS}`);
}

export function isSensitiveQueryInput(value: string): boolean {
  return sensitiveQueryInputPatterns.some(pattern => pattern.test(value));
}

export function normalizeObservMeSessionId(value: string | undefined, options: ObservMeSessionIdOptions): string {
  const sessionId = normalizeOptionalString(value);

  if (!sessionId) throw new Error(options.emptyMessage);
  if (isUnsafeObservMeSessionId(sessionId)) throw new Error(`Unsafe ObservMe session id: ${UNSAFE_OBSERVME_SESSION_ID_DETAILS}`);
  return sessionId;
}

export function isUnsafeObservMeSessionId(value: string): boolean {
  return !safeObservMeSessionIdPattern.test(value) || isSensitiveQueryInput(value);
}

export function hasUnresolvedEnvironmentPlaceholder(value: string): boolean {
  return unresolvedEnvironmentPlaceholderPattern.test(value);
}

export function readDiagnosticMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function sanitizeUiDiagnosticText(message: string): string {
  const normalized = normalizeDiagnosticWhitespace(message);
  const redactedUrlCredentials = redactUrlCredentials(normalized);
  const redacted = diagnosticReplacements.reduce(applyDiagnosticReplacement, redactedUrlCredentials);
  return truncateDiagnostic(redacted || "unknown error");
}

function applyDiagnosticReplacement(message: string, replacement: DiagnosticReplacement): string {
  return message.replace(replacement.pattern, replacement.replacement);
}

function redactUrlCredentials(message: string): string {
  let redacted = "";
  let cursor = 0;
  let searchFrom = 0;

  while (searchFrom < message.length) {
    const markerIndex = message.indexOf("://", searchFrom);
    if (markerIndex === -1) break;

    const schemeStart = findUrlSchemeStart(message, markerIndex);
    if (!isValidUrlScheme(message, schemeStart, markerIndex)) {
      searchFrom = markerIndex + 3;
      continue;
    }

    const credentialsStart = markerIndex + 3;
    const authorityEnd = findUrlAuthorityEnd(message, credentialsStart);
    const atIndex = message.lastIndexOf("@", authorityEnd - 1);
    if (atIndex < credentialsStart) {
      searchFrom = authorityEnd + 1;
      continue;
    }

    redacted += message.slice(cursor, credentialsStart);
    redacted += "[redacted]@";
    cursor = atIndex + 1;
    searchFrom = atIndex + 1;
  }

  return redacted + message.slice(cursor);
}

function findUrlSchemeStart(message: string, schemeEnd: number): number {
  let start = schemeEnd - 1;
  while (start > 0 && isUrlSchemeCharacter(message[start - 1])) start -= 1;
  return start;
}

function isValidUrlScheme(message: string, schemeStart: number, schemeEnd: number): boolean {
  if (schemeStart >= schemeEnd) return false;
  if (!isAsciiLetter(message[schemeStart])) return false;

  for (let index = schemeStart + 1; index < schemeEnd; index += 1) {
    if (!isUrlSchemeCharacter(message[index])) return false;
  }

  return true;
}

function findUrlAuthorityEnd(message: string, start: number): number {
  let index = start;
  while (index < message.length && !isUrlAuthorityTerminator(message[index])) index += 1;
  return index;
}

function isUrlAuthorityTerminator(value: string): boolean {
  return value === "/" || value === "?" || value === "#" || value === " ";
}

function isUrlSchemeCharacter(value: string): boolean {
  return isAsciiLetter(value) || isAsciiDigit(value) || value === "+" || value === "." || value === "-";
}

function isAsciiLetter(value: string): boolean {
  const code = value.codePointAt(0);
  return code !== undefined && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122));
}

function isAsciiDigit(value: string): boolean {
  const code = value.codePointAt(0);
  return code !== undefined && code >= 48 && code <= 57;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeDiagnosticWhitespace(message: string): string {
  return message.replace(/\s+/gu, " ").trim();
}

function truncateDiagnostic(message: string): string {
  if (message.length <= maximumDiagnosticLength) return message;
  return `${message.slice(0, maximumDiagnosticLength - 1)}…`;
}
