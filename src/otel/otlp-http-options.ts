import type { ObservMeConfig } from "../config/schema.ts";

export interface OtlpHttpAgentOptions {
  readonly rejectUnauthorized: boolean;
}

export function buildOtlpHttpAgentOptions(config: ObservMeConfig): OtlpHttpAgentOptions {
  return {
    rejectUnauthorized: !config.otlp.tls.insecureSkipVerify,
  };
}
