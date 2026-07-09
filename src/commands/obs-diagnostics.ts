import { readDiagnosticMessage, sanitizeDiagnosticText } from "../diagnostics/sanitize.ts";

export interface ObsCommandRecoveryHint {
  readonly subsystem: string;
  readonly nextAction: string;
}

export function formatObsCommandFailure(prefix: string, error: unknown, hint: ObsCommandRecoveryHint): string {
  return `${prefix}: ${hint.subsystem}: ${sanitizeObsDiagnosticText(readObsDiagnosticMessage(error))} Next: ${hint.nextAction}`;
}

export function appendObsRecoveryHint(message: string, nextAction: string): string {
  return `${sanitizeObsDiagnosticText(message)} Next: ${nextAction}`;
}

export function readObsDiagnosticMessage(error: unknown): string {
  return readDiagnosticMessage(error);
}

export function sanitizeObsDiagnosticText(message: string): string {
  return sanitizeDiagnosticText(message);
}
