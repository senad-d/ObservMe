import type { GrafanaDatasourceUidsConfig, ObservMeConfig } from "../config/schema.ts";
import { hasUnresolvedEnvironmentPlaceholder, normalizeConfiguredGrafanaSecret } from "./grafana-transport.ts";

export type GrafanaQueryDatasourceKey = keyof GrafanaDatasourceUidsConfig;
export type GrafanaQueryReadinessStatus = "ready" | "disabled" | "not_ready";

export interface GrafanaQueryReadinessIssue {
  readonly code: string;
  readonly key: string;
  readonly message: string;
}

export interface GrafanaQueryReadinessResult {
  readonly status: GrafanaQueryReadinessStatus;
  readonly issues: readonly GrafanaQueryReadinessIssue[];
}

export function getGrafanaQueryReadiness(
  config: ObservMeConfig,
  datasourceKey?: GrafanaQueryDatasourceKey,
): GrafanaQueryReadinessResult {
  if (!config.query.enabled) return { status: "disabled", issues: [] };

  const issues = [
    ...validateGrafanaUrl(config.query.grafana.url),
    ...validateGrafanaAuth(config),
    ...validateGrafanaDatasourceUid(config, datasourceKey),
  ];

  return { status: issues.length === 0 ? "ready" : "not_ready", issues };
}

export function assertGrafanaQueryReady(config: ObservMeConfig, datasourceKey?: GrafanaQueryDatasourceKey): void {
  const readiness = getGrafanaQueryReadiness(config, datasourceKey);
  if (readiness.status !== "not_ready") return;

  throw new Error(formatGrafanaQueryReadiness(readiness));
}

export function formatGrafanaQueryReadiness(readiness: GrafanaQueryReadinessResult): string {
  if (readiness.status === "ready") return "Grafana query configuration is ready.";
  if (readiness.status === "disabled") return "Grafana query integration is disabled (query.enabled=false).";

  return `Grafana query configuration is not ready: ${readiness.issues.map(formatGrafanaQueryReadinessIssue).join(" ")}`;
}

function validateGrafanaUrl(url: string): GrafanaQueryReadinessIssue[] {
  const trimmed = url.trim();
  if (!trimmed) {
    return [createGrafanaReadinessIssue("missing_grafana_url", "query.grafana.url", "query.grafana.url is not configured.")];
  }

  if (hasUnresolvedEnvironmentPlaceholder(trimmed)) {
    return [
      createGrafanaReadinessIssue(
        "unresolved_grafana_url",
        "query.grafana.url",
        "query.grafana.url is unresolved. Set the referenced environment variable before running Grafana-backed queries.",
      ),
    ];
  }

  return validateGrafanaUrlProtocol(trimmed);
}

function validateGrafanaUrlProtocol(url: string): GrafanaQueryReadinessIssue[] {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return [];
  } catch (error) {
    return [createInvalidGrafanaUrlIssue(readUrlParseFailureKind(error))];
  }

  return [createInvalidGrafanaUrlIssue()];
}

function createInvalidGrafanaUrlIssue(failureKind?: string): GrafanaQueryReadinessIssue {
  const failureDetail = failureKind ? ` URL parser failed with ${failureKind}.` : "";
  return createGrafanaReadinessIssue(
    "invalid_grafana_url",
    "query.grafana.url",
    `query.grafana.url must be a valid http:// or https:// URL.${failureDetail}`,
  );
}

function readUrlParseFailureKind(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

function validateGrafanaAuth(config: ObservMeConfig): GrafanaQueryReadinessIssue[] {
  const token = config.query.grafana.token.trim();
  const username = config.query.grafana.username.trim();
  const password = config.query.grafana.password.trim();

  if (normalizeConfiguredGrafanaSecret(token)) return [];
  if (normalizeConfiguredGrafanaSecret(username) && normalizeConfiguredGrafanaSecret(password)) return [];
  if (hasUnresolvedEnvironmentPlaceholder(token)) return [createUnresolvedGrafanaTokenIssue()];
  if (hasUnresolvedEnvironmentPlaceholder(username) || hasUnresolvedEnvironmentPlaceholder(password)) {
    return [createUnresolvedGrafanaBasicAuthIssue()];
  }
  if (username || password) return [createIncompleteGrafanaBasicAuthIssue()];
  return [createMissingGrafanaAuthIssue()];
}

function createUnresolvedGrafanaTokenIssue(): GrafanaQueryReadinessIssue {
  return createGrafanaReadinessIssue(
    "unresolved_grafana_token",
    "query.grafana.token",
    "query.grafana.token is unresolved. Set the referenced environment variable or configure query.grafana.username/password.",
  );
}

function createUnresolvedGrafanaBasicAuthIssue(): GrafanaQueryReadinessIssue {
  return createGrafanaReadinessIssue(
    "unresolved_grafana_basic_auth",
    "query.grafana.username/password",
    "query.grafana.username/password contains an unresolved environment placeholder. Set the referenced environment variables or configure query.grafana.token.",
  );
}

function createIncompleteGrafanaBasicAuthIssue(): GrafanaQueryReadinessIssue {
  return createGrafanaReadinessIssue(
    "incomplete_grafana_basic_auth",
    "query.grafana.username/password",
    "query.grafana.username/password is incomplete. Configure both values or configure query.grafana.token.",
  );
}

function createMissingGrafanaAuthIssue(): GrafanaQueryReadinessIssue {
  return createGrafanaReadinessIssue(
    "missing_grafana_auth",
    "query.grafana.token",
    "query.grafana.token is missing and query.grafana.username/password are not configured.",
  );
}

function validateGrafanaDatasourceUid(
  config: ObservMeConfig,
  datasourceKey: GrafanaQueryDatasourceKey | undefined,
): GrafanaQueryReadinessIssue[] {
  if (!datasourceKey) return [];

  const key = `query.grafana.datasourceUids.${datasourceKey}`;
  const uid = config.query.grafana.datasourceUids[datasourceKey].trim();
  if (!uid) return [createGrafanaReadinessIssue("missing_grafana_datasource_uid", key, `${key} is not configured.`)];
  if (!hasUnresolvedEnvironmentPlaceholder(uid)) return [];

  return [
    createGrafanaReadinessIssue(
      "unresolved_grafana_datasource_uid",
      key,
      `${key} is unresolved. Set the referenced environment variable before running Grafana-backed queries.`,
    ),
  ];
}

function formatGrafanaQueryReadinessIssue(issue: GrafanaQueryReadinessIssue): string {
  return issue.message;
}

function createGrafanaReadinessIssue(code: string, key: string, message: string): GrafanaQueryReadinessIssue {
  return { code, key, message };
}
