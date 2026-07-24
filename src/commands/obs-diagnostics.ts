import { readDiagnosticMessage, sanitizeDiagnosticText } from "../diagnostics/sanitize.ts";
import {
  GRAFANA_QUERY_DISABLED_NEXT_ACTION,
  isGrafanaQueryDisabledError,
} from "../query/grafana-readiness.ts";

export interface ObsCommandRecoveryHint {
  readonly subsystem: string;
  readonly nextAction: string;
}

export function formatObsCommandFailure(prefix: string, error: unknown, hint: ObsCommandRecoveryHint): string {
  return `${prefix}: ${hint.subsystem}: ${formatObsCommandDiagnostic(error, hint.nextAction)}`;
}

export function formatObsCommandDiagnostic(error: unknown, fallbackNextAction: string): string {
  const nextAction = isGrafanaQueryDisabledError(error) ? GRAFANA_QUERY_DISABLED_NEXT_ACTION : fallbackNextAction;
  return appendObsRecoveryHint(readObsDiagnosticMessage(error), nextAction);
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
