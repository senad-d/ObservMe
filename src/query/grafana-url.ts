export type GrafanaUrlSecurityFailureClass = "embedded_credentials";

const embeddedCredentialsFailureClass: GrafanaUrlSecurityFailureClass = "embedded_credentials";
const grafanaUrlSecurityFailureMessages = {
  embedded_credentials:
    "query.grafana.url is invalid (embedded_credentials). Configure authentication through query.grafana.token or query.grafana.username/password.",
} satisfies Readonly<Record<GrafanaUrlSecurityFailureClass, string>>;

export function classifyGrafanaUrlSecurityFailure(
  value: string | URL,
): GrafanaUrlSecurityFailureClass | undefined {
  const url = parseGrafanaUrl(value);
  if (!url || (!url.username && !url.password)) return undefined;
  return embeddedCredentialsFailureClass;
}

export function formatGrafanaUrlSecurityFailure(failureClass: GrafanaUrlSecurityFailureClass): string {
  return grafanaUrlSecurityFailureMessages[failureClass];
}

export function assertCredentialFreeGrafanaUrl(value: string | URL): void {
  const failureClass = classifyGrafanaUrlSecurityFailure(value);
  if (!failureClass) return;

  throw new Error(formatGrafanaUrlSecurityFailure(failureClass));
}

function parseGrafanaUrl(value: string | URL): URL | undefined {
  if (value instanceof URL) return value;

  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
