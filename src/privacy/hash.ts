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

const registeredTenantSaltEnvironments = new WeakMap<TenantSaltConfig, Readonly<Record<string, string | undefined>>>();

export function registerTenantSaltEnvironment<T extends TenantSaltConfig>(
  config: T,
  env: Readonly<Record<string, string | undefined>>,
): T {
  registeredTenantSaltEnvironments.set(config, env);
  return config;
}

export function inheritTenantSaltEnvironment<T extends TenantSaltConfig>(target: T, source: TenantSaltConfig): T {
  return registerTenantSaltEnvironment(target, tenantSaltEnvironmentForConfig(source));
}

export function sha256(value: string, source: TenantSaltSource): string {
  return createHash("sha256").update(`${resolveTenantSalt(source)}\0${value}`).digest("hex");
}

export function hmac_sha256(value: string, source: TenantSaltSource): string {
  return createHmac("sha256", resolveTenantSalt(source)).update(value).digest("hex");
}

export function createEnvTenantSaltSource(
  config: TenantSaltConfig,
  env: Readonly<Record<string, string | undefined>> = tenantSaltEnvironmentForConfig(config),
): EnvTenantSaltSource {
  return { env, envName: config.privacy.tenantSaltEnv };
}

export function trySha256(
  value: string,
  config: TenantSaltConfig,
  env: Readonly<Record<string, string | undefined>> = tenantSaltEnvironmentForConfig(config),
): string | undefined {
  const salt = readOptionalTenantSaltFromEnv(createEnvTenantSaltSource(config, env));
  if (salt === undefined) return undefined;
  return createHash("sha256").update(`${salt}\0${value}`).digest("hex");
}

function tenantSaltEnvironmentForConfig(config: TenantSaltConfig): Readonly<Record<string, string | undefined>> {
  return registeredTenantSaltEnvironments.get(config) ?? process.env;
}

function readOptionalTenantSaltFromEnv(source: EnvTenantSaltSource): string | undefined {
  if (source.envName.length === 0) return undefined;

  const salt = source.env[source.envName];
  if (salt === undefined || salt.length === 0) return undefined;
  return salt;
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
