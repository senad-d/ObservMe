import { createHash, createHmac } from "node:crypto";

export interface EnvTenantSaltSource {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly envName: string;
}

export interface TenantSaltConfig {
  readonly privacy: {
    readonly tenantSaltEnv: string;
  };
}

export interface SecureRuntimeTenantSaltSource {
  readonly secureRuntimeConfig: {
    readonly tenantSalt: string;
  };
}

export type TenantSaltSource = EnvTenantSaltSource | SecureRuntimeTenantSaltSource;

export function sha256(value: string, source: TenantSaltSource): string {
  return createHash("sha256").update(`${resolveTenantSalt(source)}\0${value}`).digest("hex");
}

export function hmac_sha256(value: string, source: TenantSaltSource): string {
  return createHmac("sha256", resolveTenantSalt(source)).update(value).digest("hex");
}

export function createEnvTenantSaltSource(
  config: TenantSaltConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnvTenantSaltSource {
  return { env, envName: config.privacy.tenantSaltEnv };
}

export function trySha256(
  value: string,
  config: TenantSaltConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  try {
    return sha256(value, createEnvTenantSaltSource(config, env));
  } catch (_error) {
    return undefined;
  }
}

export function resolveTenantSalt(source: TenantSaltSource): string {
  const salt = readTenantSalt(source);
  if (salt.length === 0) throw new Error("tenant salt must not be empty");
  return salt;
}

export function readTenantSalt(source: TenantSaltSource): string {
  if (isEnvTenantSaltSource(source)) return readTenantSaltFromEnv(source);
  return source.secureRuntimeConfig.tenantSalt;
}

export function readTenantSaltFromEnv(source: EnvTenantSaltSource): string {
  if (source.envName.length === 0) throw new Error("tenant salt env name must not be empty");
  const salt = source.env[source.envName];
  if (salt === undefined) throw new Error(`tenant salt env var ${source.envName} is not set`);
  return salt;
}

export function isEnvTenantSaltSource(source: TenantSaltSource): source is EnvTenantSaltSource {
  return "env" in source;
}
