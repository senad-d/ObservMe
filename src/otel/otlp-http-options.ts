import type { ObservMeConfig } from "../config/schema.ts";

export type OtlpRedirectPolicy = "manual";

export interface OtlpHttpAgentOptions {
  readonly rejectUnauthorized: boolean;
}

export interface OtlpHttpTransportPolicy {
  readonly headers: Record<string, string>;
  readonly redirect: OtlpRedirectPolicy;
  readonly rejectUnauthorized: boolean;
}

export function buildOtlpHttpTransportPolicy(config: ObservMeConfig): OtlpHttpTransportPolicy {
  return {
    headers: { ...config.otlp.headers },
    redirect: "manual",
    rejectUnauthorized: !config.otlp.tls.insecureSkipVerify,
  };
}

export function buildOtlpHttpAgentOptions(config: ObservMeConfig): OtlpHttpAgentOptions {
  return {
    rejectUnauthorized: buildOtlpHttpTransportPolicy(config).rejectUnauthorized,
  };
}

export function buildOtlpHttpHeaders(config: ObservMeConfig): Record<string, string> {
  return buildOtlpHttpTransportPolicy(config).headers;
}
