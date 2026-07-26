import { hasUnresolvedEnvironmentPlaceholder } from "../safety/sensitive-input.ts";

export type GrafanaUrlFailureClass =
  | "missing_url"
  | "unresolved_placeholder"
  | "malformed_url"
  | "unsupported_protocol"
  | "embedded_credentials";

export type GrafanaUrlIssueCode =
  | "missing_grafana_url"
  | "unresolved_grafana_url"
  | "invalid_grafana_url"
  | "embedded_grafana_url_credentials";

const grafanaUrlFailureIssueCodes = {
  missing_url: "missing_grafana_url",
  unresolved_placeholder: "unresolved_grafana_url",
  malformed_url: "invalid_grafana_url",
  unsupported_protocol: "invalid_grafana_url",
  embedded_credentials: "embedded_grafana_url_credentials",
} as const satisfies Readonly<Record<GrafanaUrlFailureClass, GrafanaUrlIssueCode>>;

const grafanaUrlFailureMessages = {
  missing_url: "query.grafana.url is not configured. Configure an absolute http:// or https:// URL.",
  unresolved_placeholder:
    "query.grafana.url is unresolved. Set the referenced environment variable before running Grafana-backed queries.",
  malformed_url: "query.grafana.url must be a valid http:// or https:// URL (malformed_url).",
  unsupported_protocol: "query.grafana.url must be a valid http:// or https:// URL (unsupported_protocol).",
  embedded_credentials:
    "query.grafana.url is invalid (embedded_credentials). Configure authentication through query.grafana.token or query.grafana.username/password.",
} satisfies Readonly<Record<GrafanaUrlFailureClass, string>>;

export function classifyGrafanaUrlFailure(value: string | URL): GrafanaUrlFailureClass | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "missing_url";
    if (hasUnresolvedEnvironmentPlaceholder(trimmed)) return "unresolved_placeholder";

    const parsed = parseGrafanaUrl(trimmed);
    return parsed ? classifyParsedGrafanaUrlFailure(parsed) : "malformed_url";
  }

  return classifyParsedGrafanaUrlFailure(value);
}

export function getGrafanaUrlIssueCode(failureClass: GrafanaUrlFailureClass): GrafanaUrlIssueCode {
  return grafanaUrlFailureIssueCodes[failureClass];
}

export function formatGrafanaUrlFailure(failureClass: GrafanaUrlFailureClass): string {
  return grafanaUrlFailureMessages[failureClass];
}

export function assertValidGrafanaUrl(value: string | URL): void {
  const failureClass = classifyGrafanaUrlFailure(value);
  if (!failureClass) return;

  throw new Error(formatGrafanaUrlFailure(failureClass));
}

function classifyParsedGrafanaUrlFailure(url: URL): GrafanaUrlFailureClass | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "unsupported_protocol";
  if (url.username || url.password) return "embedded_credentials";
  return undefined;
}

function parseGrafanaUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
