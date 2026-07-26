import { getEnabledOtlpSignalDestinations } from "../otel/otlp-endpoint.ts";
import type { ObservMeConfig } from "./schema.ts";

const tlsVerificationEnabled = "TLS certificate verification enabled";
const tlsVerificationDisabled = "TLS certificate verification disabled";
const plaintextHttp = "plaintext HTTP";
const inactiveObservMe = "inactive (ObservMe disabled)";
const inactiveSignals = "inactive (all OTLP signals disabled)";
const inactiveGrafana = "inactive (Grafana queries disabled)";
const unknownTransport = "unknown or invalid transport";

export interface ObsTransportSecuritySnapshot {
  readonly collector: string;
  readonly grafana: string;
}

export function describeOtlpTransportSecurity(config: ObservMeConfig): string {
  if (!config.enabled) return inactiveObservMe;

  const signals = getEnabledOtlpSignalDestinations(config);
  if (signals.length === 0) return inactiveSignals;

  const descriptions = signals.map(signal => ({
    name: signal.signal,
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
    collector: describeOtlpTransportSecurity(config),
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
