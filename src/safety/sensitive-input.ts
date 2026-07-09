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
const homeFilesystemPathPattern = /(?:^|[\s"'`=])~(?:\/|\b)\S*/u;
const relativeFilesystemPathPattern = /(?:^|[\s"'`=])\.{1,2}\/\S*/u;
const unixFilesystemPathPattern = /(?:^|[\s"'`=])\/(?:Users|home|tmp|var|etc|private|workspace|opt|Volumes)\b\S*/u;
const windowsDriveFilesystemPathPattern = /(?:^|[\s"'`=])[A-Za-z]:\\\S*/u;
const windowsUncFilesystemPathPattern = /(?:^|[\s"'`=])\\\\\S*/u;
const environmentAssignmentPattern = /\b[A-Z][A-Z0-9_]{2,}=[^\s"'`;,)]*/u;
const diagnosticEnvironmentAssignmentPattern = /\b[A-Z][A-Z0-9_]{2,}=[^\s"'`;,)]*/gu;
const unresolvedEnvironmentPlaceholderPattern = /\$\{[A-Z0-9_]+\}/u;
const diagnosticUnresolvedEnvironmentPlaceholderPattern = /\$\{[A-Z0-9_]+\}/gu;
const bearerCredentialPattern = /\bBearer\s+[^\s"'`;,)]+/iu;
const credentialAssignmentPatterns = [
  /\baccess[_-]?token\s*[:=]\s*["']?[^\s"'`;,)]*/iu,
  /\bapi[_-]?key\s*[:=]\s*["']?[^\s"'`;,)]*/iu,
  /\btoken\s*[:=]\s*["']?[^\s"'`;,)]*/iu,
  /\bpassword\s*[:=]\s*["']?[^\s"'`;,)]*/iu,
  /\bsecret\s*[:=]\s*["']?[^\s"'`;,)]*/iu,
  /\bauthorization\s*[:=]\s*["']?[^\s"'`;,)]*/iu,
] as const;
const safeObservMeSessionIdPattern = /^[A-Za-z0-9._:-]{1,256}$/u;
const sensitiveQueryInputPatterns = [
  rawContentMarkerPattern,
  shellCommandPattern,
  homeFilesystemPathPattern,
  relativeFilesystemPathPattern,
  unixFilesystemPathPattern,
  windowsDriveFilesystemPathPattern,
  windowsUncFilesystemPathPattern,
  environmentAssignmentPattern,
  unresolvedEnvironmentPlaceholderPattern,
  bearerCredentialPattern,
  ...credentialAssignmentPatterns,
] as const;
const diagnosticReplacements = [
  { pattern: /Bearer\s+[^\s;,)]+/giu, replacement: "Bearer [redacted]" },
  { pattern: /Basic\s+[^\s;,)]+/giu, replacement: "Basic [redacted]" },
  { pattern: /\b(token|password|secret|authorization)\s*[:=]\s*["']?[^"'\s;,)]+/giu, replacement: "$1=[redacted]" },
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
    pattern: /(^|[\s(["'`])(?:~|\.{2}\/|\.\/|\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\|\\\\)[^\s)"'`,;]*/gu,
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
    const atIndex = message.indexOf("@", credentialsStart);
    if (atIndex === -1 || atIndex >= authorityEnd) {
      searchFrom = authorityEnd + 1;
      continue;
    }

    const colonIndex = message.indexOf(":", credentialsStart);
    if (colonIndex === -1 || colonIndex >= atIndex || colonIndex === credentialsStart || colonIndex + 1 === atIndex) {
      searchFrom = atIndex + 1;
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
