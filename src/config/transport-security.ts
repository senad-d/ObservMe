import type { ObservMeConfig } from "./schema.ts";

const tlsVerificationEnabled = "TLS certificate verification enabled";
const tlsVerificationDisabled = "TLS certificate verification disabled";
const plaintextHttp = "plaintext HTTP";
const inactiveObservMe = "inactive (ObservMe disabled)";
const inactiveSignals = "inactive (all OTLP signals disabled)";
const inactiveGrafana = "inactive (Grafana queries disabled)";
const unknownTransport = "unknown or invalid transport";

interface OtlpSignalTransport {
  readonly name: "traces" | "metrics" | "logs";
  readonly endpoint: string;
  readonly enabled: boolean;
}

export interface ObsTransportSecuritySnapshot {
  readonly collector: string;
  readonly grafana: string;
}

export function describeOtlpTransportSecurity(config: ObservMeConfig): string {
  if (!config.enabled) return inactiveObservMe;

  const signals = getOtlpSignalTransports(config).filter(signal => signal.enabled);
  if (signals.length === 0) return inactiveSignals;

  const descriptions = signals.map(signal => ({
    name: signal.name,
    description: describeEndpointTransportSecurity(
      signal.endpoint,
      config.otlp.tls.insecureSkipVerify,
      config.privacy.allowInsecureTransport,
    ),
  }));
  const uniqueDescriptions = new Set(descriptions.map(signal => signal.description));
  if (uniqueDescriptions.size === 1) return descriptions[0]?.description ?? unknownTransport;

  return descriptions.map(signal => `${signal.name}: ${signal.description}`).join(", ");
}

export function describeGrafanaTransportSecurity(config: ObservMeConfig): string {
  if (!config.query.enabled) return inactiveGrafana;
  return describeEndpointTransportSecurity(
    config.query.grafana.url,
    config.query.grafana.tls.insecureSkipVerify,
    config.privacy.allowInsecureTransport,
  );
}

export function createObsTransportSecuritySnapshot(config: ObservMeConfig): ObsTransportSecuritySnapshot {
  return {
    collector: describeEndpointTransportSecurity(
      config.otlp.endpoint,
      config.otlp.tls.insecureSkipVerify,
      config.privacy.allowInsecureTransport,
    ),
    grafana: describeGrafanaTransportSecurity(config),
  };
}

export function describeEndpointTransportSecurity(
  endpoint: string,
  insecureSkipVerify: boolean,
  allowInsecureTransport: boolean,
): string {
  const protocol = readEndpointProtocol(endpoint);
  if (protocol === "https:") {
    return insecureSkipVerify
      ? describeAcknowledgedInsecurity(tlsVerificationDisabled, allowInsecureTransport)
      : tlsVerificationEnabled;
  }
  if (protocol === "http:") return describeAcknowledgedInsecurity(plaintextHttp, allowInsecureTransport);
  return unknownTransport;
}

function getOtlpSignalTransports(config: ObservMeConfig): OtlpSignalTransport[] {
  return [
    {
      name: "traces",
      endpoint: config.otlp.signalEndpoints?.traces ?? config.otlp.endpoint,
      enabled: config.traces.enabled,
    },
    {
      name: "metrics",
      endpoint: config.otlp.signalEndpoints?.metrics ?? config.otlp.endpoint,
      enabled: config.metrics.enabled,
    },
    {
      name: "logs",
      endpoint: config.otlp.signalEndpoints?.logs ?? config.otlp.endpoint,
      enabled: config.logs.enabled,
    },
  ];
}

function readEndpointProtocol(endpoint: string): string | undefined {
  try {
    return new URL(endpoint.trim()).protocol;
  } catch {
    return undefined;
  }
}

function describeAcknowledgedInsecurity(description: string, allowInsecureTransport: boolean): string {
  return allowInsecureTransport ? `${description} (explicitly acknowledged)` : description;
}
