export interface ObsCommandRecoveryHint {
  readonly subsystem: string;
  readonly nextAction: string;
}

interface DiagnosticReplacement {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const maximumDiagnosticLength = 360;
const diagnosticReplacements = [
  { pattern: /Bearer\s+[^\s;,)]+/giu, replacement: "Bearer [redacted]" },
  { pattern: /Basic\s+[^\s;,)]+/giu, replacement: "Basic [redacted]" },
  { pattern: /\b(token|password|secret|authorization)\s*[:=]\s*["']?[^"'\s;,)]+/giu, replacement: "$1=[redacted]" },
  { pattern: /\b[A-Z][A-Z0-9_]{2,}=[^\s;,)]+/gu, replacement: "[redacted-env]" },
  {
    pattern: /(^|[\s(["'`])(?:prompt|system prompt|user prompt|assistant response|thinking|raw content)\s*:[^.;\n]*/giu,
    replacement: "$1[redacted-content]",
  },
  {
    pattern: /(^|[\s(["'`])(?:sudo|rm|mv|cp|curl|wget|npm|pnpm|yarn|node|python3?|bash|sh|git)\s+[^.;\n)]*/giu,
    replacement: "$1[redacted-command]",
  },
  {
    pattern: /(^|[\s(["'`])(?:~|\.{1,2}\/|\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\|\\\\)[^\s)"'`,;]*/gu,
    replacement: "$1[redacted-path]",
  },
] as const satisfies readonly DiagnosticReplacement[];

export function formatObsCommandFailure(prefix: string, error: unknown, hint: ObsCommandRecoveryHint): string {
  return `${prefix}: ${hint.subsystem}: ${sanitizeObsDiagnosticText(readObsDiagnosticMessage(error))} Next: ${hint.nextAction}`;
}

export function appendObsRecoveryHint(message: string, nextAction: string): string {
  return `${sanitizeObsDiagnosticText(message)} Next: ${nextAction}`;
}

export function readObsDiagnosticMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function sanitizeObsDiagnosticText(message: string): string {
  const normalized = normalizeDiagnosticWhitespace(message);
  const redacted = diagnosticReplacements.reduce(applyDiagnosticReplacement, normalized);
  return truncateDiagnostic(redacted || "unknown error");
}

function applyDiagnosticReplacement(message: string, replacement: DiagnosticReplacement): string {
  return message.replace(replacement.pattern, replacement.replacement);
}

function normalizeDiagnosticWhitespace(message: string): string {
  return message.replace(/\s+/gu, " ").trim();
}

function truncateDiagnostic(message: string): string {
  if (message.length <= maximumDiagnosticLength) return message;
  return `${message.slice(0, maximumDiagnosticLength - 1)}…`;
}
