import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultObservMeConfig } from "./defaults.ts";
import {
  isUnsafeProjectPathError,
  readCanonicalProjectLocalFileText,
  resolveProjectLocalFilePath,
} from "./project-paths.ts";
import type {
  ProjectLocalFileOperationHooks,
  ProjectLocalFilePathOptions,
} from "./project-paths.ts";
import type { ConfigLogSink, ConfigRejectionDiagnostic } from "./validate.ts";
import {
  ensureValidObservMeConfig,
  ensureValidObservMeConfigWithDiagnostics,
  normalizeConfigRejectionDiagnostic,
  validateObservMeConfig,
} from "./validate.ts";
import type { ObservMeConfig } from "./schema.ts";
import { registerTenantSaltEnvironment } from "../privacy/hash.ts";
import { RESOURCE_ATTRIBUTES } from "../semconv/attributes.ts";

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K];
};

type ConfigValue = null | boolean | number | string | ConfigObject | ConfigValue[];
type ConfigObject = { [key: string]: ConfigValue };

type ReadConfigText = (path: string) => Promise<string | undefined>;
type ConfigSourceIssueCode =
  | "config_source_malformed"
  | "config_source_rejected"
  | "config_source_unreadable"
  | "invalid_config_shape";

type BaseSessionConfigSourceStatus = "loaded" | "malformed" | "missing" | "rejected" | "unreadable";

interface ConfigSourceResult<T, TStatus extends string = BaseSessionConfigSourceStatus> {
  readonly status: TStatus;
  readonly value?: T;
  readonly issueCode?: ConfigSourceIssueCode;
}

export interface ProjectTrustContext {
  isProjectTrusted?: () => boolean | Promise<boolean>;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  runtimeOptions?: DeepPartial<ObservMeConfig>;
  globalConfigPath?: string;
  readText?: ReadConfigText;
  logger?: ConfigLogSink;
}

export interface ProjectFileOperationHooks {
  readonly projectConfig?: ProjectLocalFileOperationHooks;
  readonly environmentFile?: ProjectLocalFileOperationHooks;
}

export interface LoadSessionConfigOptions extends LoadConfigOptions {
  ctx?: ProjectTrustContext;
  cwd?: string;
  configDirName?: string;
  projectConfigPath?: string;
  envFilePath?: string;
  loadEnvFile?: boolean;
  isProjectTrusted?: boolean | (() => boolean | Promise<boolean>);
  projectFileOperationHooks?: ProjectFileOperationHooks;
}

export type SessionConfigProjectStatus = BaseSessionConfigSourceStatus | "skipped_untrusted";
export type SessionConfigEnvFileStatus = BaseSessionConfigSourceStatus | "skipped_disabled" | "skipped_untrusted";
export type SessionConfigEnvironmentStatus = "loaded" | "missing" | "rejected";
export type SessionConfigEffectiveSource = "runtime_options" | "environment" | "trusted_project" | "global" | "defaults";

export interface SessionConfigDiagnostics {
  readonly projectTrusted: boolean;
  readonly projectConfigStatus: SessionConfigProjectStatus;
  readonly globalConfigStatus?: BaseSessionConfigSourceStatus;
  readonly envFileStatus?: SessionConfigEnvFileStatus;
  readonly environmentStatus?: SessionConfigEnvironmentStatus;
  readonly effectiveSource: SessionConfigEffectiveSource;
  readonly globalConfigLoaded: boolean;
  readonly environmentOverrides: boolean;
  readonly runtimeOptionsApplied: boolean;
  readonly rejection?: ConfigRejectionDiagnostic;
}

export interface LoadSessionConfigResult {
  readonly config: ObservMeConfig;
  readonly diagnostics: SessionConfigDiagnostics;
}

interface ParsedYamlLine {
  indent: number;
  text: string;
}

const defaultEnvFileName = ".env";
const observmeYamlFileName = "observme.yaml";
const yamlIndentPattern = /^ */u;

export async function loadFactoryConfig(options: LoadConfigOptions = {}): Promise<ObservMeConfig> {
  const globalConfig = await readConfigFile(resolveGlobalConfigPath(options), options);
  const environment = options.env ?? process.env;
  const config = mergeConfigLayers([defaultObservMeConfig, globalConfig, envToConfig(options.env), options.runtimeOptions]);
  const validConfig = ensureValidObservMeConfig(config, { env: options.env, logger: options.logger });

  return registerTenantSaltEnvironment(validConfig, environment);
}

export async function loadSessionConfig(options: LoadSessionConfigOptions = {}): Promise<ObservMeConfig> {
  return (await loadSessionConfigWithDiagnostics(options)).config;
}

export async function loadSessionConfigWithDiagnostics(options: LoadSessionConfigOptions = {}): Promise<LoadSessionConfigResult> {
  const globalSource = classifyConfigSource(
    await readConfigSource(resolveGlobalConfigPath(options), options),
  );
  const projectTrusted = await resolveProjectTrust(options);
  const projectSource = classifyConfigSource(await readProjectConfigSource(projectTrusted, options));
  const envFileSource = await readTrustedProjectEnvSource(projectTrusted, options);
  const environment = options.env ?? process.env;
  const envFileConfig = envFileSource.value ? envToConfig(envFileSource.value) : undefined;
  const classifiedEnvFileSource = classifyConfigSource(envFileSource, envFileConfig);
  const environmentConfig = envToConfig(environment);
  const environmentSource = classifyEnvironmentSource(environment, environmentConfig);
  const effectiveEnvironment = mergeEnvironment(classifiedEnvFileSource.value, environment);
  const config = mergeConfigLayers([
    defaultObservMeConfig,
    globalSource.value,
    projectSource.value,
    envFileConfig,
    environmentConfig,
    options.runtimeOptions,
  ]);
  const validation = ensureValidObservMeConfigWithDiagnostics(config, {
    env: effectiveEnvironment,
    isProjectTrusted: projectTrusted,
    projectConfigWasRead: projectSource.value !== undefined,
  });
  const rejection = combineConfigRejections(validation.rejection, [
    globalSource,
    projectSource,
    classifiedEnvFileSource,
    environmentSource,
  ]);
  logSessionConfigRejection(rejection, options.logger);
  const diagnostics = createSessionConfigDiagnostics({
    globalSource,
    projectSource,
    envFileSource: classifiedEnvFileSource,
    environmentSource,
    projectTrusted,
    envFileConfig,
    environmentConfig,
    runtimeOptions: options.runtimeOptions,
    rejection,
  });

  return {
    config: registerTenantSaltEnvironment(validation.config, effectiveEnvironment),
    diagnostics,
  };
}

export function mergeConfigLayers(layers: Array<DeepPartial<ObservMeConfig> | undefined>): ObservMeConfig {
  let merged = cloneConfig(defaultObservMeConfig) as unknown as ConfigObject;

  for (const layer of layers.slice(1)) {
    if (layer) merged = deepMergeObjects(merged, layer as ConfigObject);
  }

  return merged as unknown as ObservMeConfig;
}

export function envToConfig(env: NodeJS.ProcessEnv = process.env): DeepPartial<ObservMeConfig> {
  const config: DeepPartial<ObservMeConfig> = {};

  setBoolean(config, ["enabled"], env.OBSERVME_ENABLED);
  setString(config, ["environment"], env.OBSERVME_ENVIRONMENT);
  setString(config, ["tenant"], env.OBSERVME_TENANT);
  setString(config, ["otlp", "endpoint"], env.OBSERVME_OTLP_ENDPOINT);
  setString(config, ["otlp", "protocol"], env.OBSERVME_OTLP_PROTOCOL);
  setString(config, ["otlp", "signalEndpoints", "traces"], env.OBSERVME_OTLP_TRACES_ENDPOINT);
  setString(config, ["otlp", "signalEndpoints", "metrics"], env.OBSERVME_OTLP_METRICS_ENDPOINT);
  setString(config, ["otlp", "signalEndpoints", "logs"], env.OBSERVME_OTLP_LOGS_ENDPOINT);
  setNumber(config, ["otlp", "timeoutMs"], env.OBSERVME_OTLP_TIMEOUT_MS);
  setNumber(config, ["metrics", "activeAgentLeaseDurationMillis"], env.OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS);
  setAuthorizationHeader(config, env.OBSERVME_OTLP_TOKEN);
  setNumber(config, ["workflow", "maxDepthWarning"], env.OBSERVME_WORKFLOW_MAX_DEPTH_WARNING);
  setNumber(config, ["workflow", "maxFanoutWarning"], env.OBSERVME_WORKFLOW_MAX_FANOUT_WARNING);
  setBoolean(config, ["agent", "propagateTraceContext"], env.OBSERVME_PROPAGATE_TRACE_CONTEXT);
  setBoolean(config, ["agent", "propagateToSubagents"], env.OBSERVME_PROPAGATE_TO_SUBAGENTS);
  setBoolean(config, ["agent", "writeCorrelationEntry"], env.OBSERVME_WRITE_CORRELATION_ENTRY);
  setString(config, ["query", "grafana", "url"], env.OBSERVME_GRAFANA_URL);
  setString(config, ["query", "grafana", "token"], env.OBSERVME_GRAFANA_TOKEN);
  setString(config, ["query", "grafana", "username"], env.OBSERVME_GRAFANA_USERNAME);
  setString(config, ["query", "grafana", "password"], env.OBSERVME_GRAFANA_PASSWORD);
  setString(config, ["query", "grafana", "datasourceUids", "tempo"], env.OBSERVME_GRAFANA_TEMPO_DATASOURCE_UID);
  setString(config, ["query", "grafana", "datasourceUids", "loki"], env.OBSERVME_GRAFANA_LOKI_DATASOURCE_UID);
  setString(config, ["query", "grafana", "datasourceUids", "prometheus"], env.OBSERVME_GRAFANA_PROMETHEUS_DATASOURCE_UID);
  setBoolean(config, ["query", "grafana", "tls", "insecureSkipVerify"], env.OBSERVME_GRAFANA_TLS_INSECURE_SKIP_VERIFY);
  setBoolean(config, ["query", "grafana", "transport", "preferIPv4"], env.OBSERVME_GRAFANA_PREFER_IPV4);
  setBoolean(config, ["capture", "prompts"], env.OBSERVME_CAPTURE_PROMPTS);
  setBoolean(config, ["capture", "responses"], env.OBSERVME_CAPTURE_RESPONSES);
  setBoolean(config, ["capture", "toolArguments"], env.OBSERVME_CAPTURE_TOOL_ARGUMENTS);
  setBoolean(config, ["capture", "toolResults"], env.OBSERVME_CAPTURE_TOOL_RESULTS);
  setBoolean(config, ["capture", "thinking"], env.OBSERVME_CAPTURE_THINKING);
  setBoolean(config, ["capture", "bashCommands"], env.OBSERVME_CAPTURE_BASH_COMMANDS);
  setBoolean(config, ["capture", "bashOutput"], env.OBSERVME_CAPTURE_BASH_OUTPUT);
  setBoolean(config, ["capture", "filePaths"], env.OBSERVME_CAPTURE_FILE_PATHS);
  setBoolean(config, ["privacy", "redactionEnabled"], env.OBSERVME_REDACTION_ENABLED);
  setBoolean(config, ["privacy", "allowUnsafeCapture"], env.OBSERVME_ALLOW_UNSAFE_CAPTURE);
  setBoolean(config, ["privacy", "allowInsecureTransport"], env.OBSERVME_ALLOW_INSECURE_TRANSPORT);

  if (env.OBSERVME_TENANT) {
    setString(config, ["resource", "attributes", RESOURCE_ATTRIBUTES.OBSERVME_TENANT_ID], env.OBSERVME_TENANT);
  }

  if (env.OBSERVME_ENVIRONMENT) {
    setString(config, ["resource", "attributes", RESOURCE_ATTRIBUTES.DEPLOYMENT_ENVIRONMENT_NAME], env.OBSERVME_ENVIRONMENT);
  }

  return config;
}

function createSessionConfigDiagnostics(options: {
  readonly globalSource: ConfigSourceResult<DeepPartial<ObservMeConfig>>;
  readonly projectSource: ConfigSourceResult<DeepPartial<ObservMeConfig>>;
  readonly envFileSource: ConfigSourceResult<NodeJS.ProcessEnv, SessionConfigEnvFileStatus>;
  readonly environmentSource: ConfigSourceResult<DeepPartial<ObservMeConfig>, SessionConfigEnvironmentStatus>;
  readonly projectTrusted: boolean;
  readonly envFileConfig?: DeepPartial<ObservMeConfig>;
  readonly environmentConfig: DeepPartial<ObservMeConfig>;
  readonly runtimeOptions?: DeepPartial<ObservMeConfig>;
  readonly rejection?: ConfigRejectionDiagnostic;
}): SessionConfigDiagnostics {
  const environmentOverrides = hasConfigLayer(options.envFileConfig) || hasConfigLayer(options.environmentConfig);
  const runtimeOptionsApplied = hasConfigLayer(options.runtimeOptions);

  return {
    projectTrusted: options.projectTrusted,
    projectConfigStatus: options.projectTrusted ? options.projectSource.status : "skipped_untrusted",
    globalConfigStatus: options.globalSource.status,
    envFileStatus: options.envFileSource.status,
    environmentStatus: options.environmentSource.status,
    effectiveSource: resolveSessionConfigEffectiveSource({
      globalConfig: options.globalSource.value,
      projectConfig: options.projectSource.value,
      environmentOverrides,
      runtimeOptionsApplied,
    }),
    globalConfigLoaded: options.globalSource.status === "loaded",
    environmentOverrides,
    runtimeOptionsApplied,
    rejection: options.rejection,
  };
}

function resolveSessionConfigEffectiveSource(options: {
  readonly globalConfig?: DeepPartial<ObservMeConfig>;
  readonly projectConfig?: DeepPartial<ObservMeConfig>;
  readonly environmentOverrides: boolean;
  readonly runtimeOptionsApplied: boolean;
}): SessionConfigEffectiveSource {
  if (options.runtimeOptionsApplied) return "runtime_options";
  if (options.environmentOverrides) return "environment";
  if (hasConfigLayer(options.projectConfig)) return "trusted_project";
  if (hasConfigLayer(options.globalConfig)) return "global";
  return "defaults";
}

function hasConfigLayer(layer: DeepPartial<ObservMeConfig> | undefined): boolean {
  return layer !== undefined && Object.keys(layer).length > 0;
}

function classifyConfigSource<T, TStatus extends string>(
  source: ConfigSourceResult<T, TStatus>,
  configLayer?: DeepPartial<ObservMeConfig>,
): ConfigSourceResult<T, TStatus> {
  if (source.status !== "loaded") return source;

  const layer = configLayer ?? (source.value as DeepPartial<ObservMeConfig> | undefined);
  if (!layer || !isConfigLayerStructurallyInvalid(layer)) return source;

  return {
    ...source,
    status: "rejected" as TStatus,
    issueCode: "invalid_config_shape",
  };
}

function classifyEnvironmentSource(
  environment: NodeJS.ProcessEnv,
  config: DeepPartial<ObservMeConfig>,
): ConfigSourceResult<DeepPartial<ObservMeConfig>, SessionConfigEnvironmentStatus> {
  if (!hasObservMeEnvironmentInput(environment)) return { status: "missing", value: config };
  if (isConfigLayerStructurallyInvalid(config)) {
    return { status: "rejected", value: config, issueCode: "invalid_config_shape" };
  }
  return { status: "loaded", value: config };
}

function hasObservMeEnvironmentInput(environment: NodeJS.ProcessEnv): boolean {
  return Object.keys(environment).some(name => name.startsWith("OBSERVME_"));
}

function isConfigLayerStructurallyInvalid(layer: DeepPartial<ObservMeConfig>): boolean {
  try {
    const candidate = mergeConfigLayers([defaultObservMeConfig, layer]);
    return validateObservMeConfig(candidate, { env: {}, isProjectTrusted: true }).issues.some(
      issue => issue.code === "invalid_config_shape",
    );
  } catch {
    return true;
  }
}

function combineConfigRejections(
  validationRejection: ConfigRejectionDiagnostic | undefined,
  sources: ReadonlyArray<ConfigSourceResult<unknown, string>>,
): ConfigRejectionDiagnostic | undefined {
  const sourceIssueCodes = sources.flatMap(source => (source.issueCode ? [source.issueCode] : []));
  if (sourceIssueCodes.length === 0) return validationRejection;

  const validationCodes = validationRejection?.issueCodes ?? [];
  const additionalIssueCount = sourceIssueCodes.filter(code => !validationCodes.includes(code)).length;
  return normalizeConfigRejectionDiagnostic({
    issueCodes: [...validationCodes, ...sourceIssueCodes],
    issueCount: (validationRejection?.issueCount ?? 0) + additionalIssueCount,
  });
}

function logSessionConfigRejection(
  rejection: ConfigRejectionDiagnostic | undefined,
  logger: ConfigLogSink | undefined,
): void {
  if (!rejection || !logger?.warn) return;

  try {
    logger.warn(
      `ObservMe config rejected (${rejection.issueCodes.join(", ")}); ${rejection.issueCount} issue(s), safe defaults applied.`,
    );
  } catch {
    return;
  }
}

function logConfigSourceFailure(
  label: string,
  source: ConfigSourceResult<unknown, string>,
  logger: ConfigLogSink | undefined,
): void {
  if (!source.issueCode || !logger?.warn) return;

  try {
    logger.warn(`ObservMe ${label} source was ignored (${source.issueCode}); safe defaults applied.`);
  } catch {
    return;
  }
}

export function parseObservMeConfigText(text: string): DeepPartial<ObservMeConfig> {
  const parsed = text.trimStart().startsWith("{") ? (JSON.parse(text) as ConfigObject) : parseSimpleYaml(text);
  const observmeConfig = parsed.observme;

  if (isPlainObject(observmeConfig)) return observmeConfig as unknown as DeepPartial<ObservMeConfig>;
  return parsed as unknown as DeepPartial<ObservMeConfig>;
}

async function readConfigFile(
  path: string,
  options: LoadConfigOptions,
): Promise<DeepPartial<ObservMeConfig> | undefined> {
  const source = classifyConfigSource(await readConfigSource(path, options));
  logConfigSourceFailure("global config", source, options.logger);
  return source.value;
}

async function readConfigSource(
  path: string,
  options: LoadConfigOptions,
): Promise<ConfigSourceResult<DeepPartial<ObservMeConfig>>> {
  const textResult = await readConfigSourceText(path, options);
  if (textResult.status !== "loaded") {
    return { status: textResult.status, issueCode: textResult.issueCode };
  }

  try {
    return { status: "loaded", value: parseObservMeConfigText(textResult.value!) };
  } catch {
    return { status: "malformed", issueCode: "config_source_malformed" };
  }
}

async function readProjectConfigSource(
  projectTrusted: boolean,
  options: LoadSessionConfigOptions,
): Promise<ConfigSourceResult<DeepPartial<ObservMeConfig>>> {
  if (!projectTrusted) return { status: "missing" };

  try {
    const pathOptions = createProjectConfigPathOptions(options);
    const readOptions = createProjectSourceReadOptions(
      options,
      pathOptions,
      options.projectFileOperationHooks?.projectConfig,
    );
    return await readConfigSource(resolveProjectLocalFilePath(pathOptions), readOptions);
  } catch {
    return { status: "rejected", issueCode: "config_source_rejected" };
  }
}

async function readTrustedProjectEnvSource(
  projectTrusted: boolean,
  options: LoadSessionConfigOptions,
): Promise<ConfigSourceResult<NodeJS.ProcessEnv, SessionConfigEnvFileStatus>> {
  if (!projectTrusted) return { status: "skipped_untrusted" };
  if (options.loadEnvFile === false) return { status: "skipped_disabled" };

  try {
    const pathOptions = createProjectEnvFilePathOptions(options);
    const readOptions = createProjectSourceReadOptions(
      options,
      pathOptions,
      options.projectFileOperationHooks?.environmentFile,
    );
    return await readEnvSource(resolveProjectLocalFilePath(pathOptions), readOptions);
  } catch {
    return { status: "rejected", issueCode: "config_source_rejected" };
  }
}

async function readEnvSource(
  path: string,
  options: LoadConfigOptions,
): Promise<ConfigSourceResult<NodeJS.ProcessEnv>> {
  const textResult = await readConfigSourceText(path, options);
  if (textResult.status !== "loaded") {
    return { status: textResult.status, issueCode: textResult.issueCode };
  }

  try {
    return { status: "loaded", value: parseEnvFileText(textResult.value!) };
  } catch {
    return { status: "malformed", issueCode: "config_source_malformed" };
  }
}

async function readConfigSourceText(
  path: string,
  options: LoadConfigOptions,
): Promise<ConfigSourceResult<string>> {
  try {
    const text = await readOptionalText(path, options.readText ?? defaultReadConfigText);
    if (text === undefined) return { status: "missing" };
    if (text.trim() === "") return { status: "malformed", issueCode: "config_source_malformed" };
    return { status: "loaded", value: text };
  } catch (error) {
    if (isUnsafeProjectPathError(error)) {
      return { status: "rejected", issueCode: "config_source_rejected" };
    }
    return { status: "unreadable", issueCode: "config_source_unreadable" };
  }
}

async function defaultReadConfigText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function readOptionalText(path: string, readText: ReadConfigText): Promise<string | undefined> {
  try {
    return await readText(path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function resolveGlobalConfigPath(options: LoadConfigOptions): string {
  return options.globalConfigPath ?? join(homedir(), CONFIG_DIR_NAME, "agent", observmeYamlFileName);
}

function createProjectSourceReadOptions(
  options: LoadSessionConfigOptions,
  pathOptions: ProjectLocalFilePathOptions,
  hooks: ProjectLocalFileOperationHooks | undefined,
): LoadConfigOptions {
  if (options.readText !== undefined) return options;
  return {
    ...options,
    readText: readCanonicalProjectLocalFileText.bind(undefined, pathOptions, hooks),
  };
}

function createProjectConfigPathOptions(options: LoadSessionConfigOptions): ProjectLocalFilePathOptions {
  return {
    cwd: options.cwd,
    configDirName: options.configDirName,
    defaultConfigDirName: CONFIG_DIR_NAME,
    fileName: observmeYamlFileName,
    overridePath: options.projectConfigPath,
    inputLabel: "project config path",
  };
}

function createProjectEnvFilePathOptions(options: LoadSessionConfigOptions): ProjectLocalFilePathOptions {
  return {
    cwd: options.cwd,
    fileName: defaultEnvFileName,
    overridePath: options.envFilePath ?? defaultEnvFileName,
    inputLabel: "project env path",
  };
}

async function resolveProjectTrust(options: LoadSessionConfigOptions): Promise<boolean> {
  if (typeof options.isProjectTrusted === "boolean") return options.isProjectTrusted;
  if (typeof options.isProjectTrusted === "function") return options.isProjectTrusted();
  if (typeof options.ctx?.isProjectTrusted === "function") return options.ctx.isProjectTrusted();
  return false;
}

function mergeEnvironment(envFile: NodeJS.ProcessEnv | undefined, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!envFile) return environment;
  return { ...envFile, ...environment };
}

function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

function deepMergeObjects(base: ConfigObject, overlay: ConfigObject): ConfigObject {
  const merged = cloneConfig(base);

  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const existing = Object.hasOwn(merged, key) ? merged[key] : undefined;
    if (isPlainObject(existing) && isPlainObject(value)) {
      assignConfigProperty(merged, key, deepMergeObjects(existing, value));
      continue;
    }
    assignConfigProperty(merged, key, cloneConfig(value));
  }

  return merged;
}

function parseEnvFileText(text: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const lines = text.split(/\r?\n/u);

  lines.forEach((line, index) => {
    const entry = parseEnvFileLine(line, index + 1);
    if (entry) env[entry.key] = entry.value;
  });

  return env;
}

function parseEnvFileLine(line: string, lineNumber: number): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const assignment = stripEnvExportPrefix(trimmed);
  const separatorIndex = assignment.indexOf("=");
  if (separatorIndex <= 0) throw new Error(`Invalid .env line ${lineNumber}: expected KEY=value.`);

  const key = assignment.slice(0, separatorIndex).trim();
  if (!isValidEnvKey(key)) throw new Error(`Invalid .env line ${lineNumber}: environment variable name is invalid.`);

  return { key, value: parseEnvValue(assignment.slice(separatorIndex + 1)) };
}

function stripEnvExportPrefix(line: string): string {
  if (!line.startsWith("export ")) return line;
  return line.slice("export ".length).trimStart();
}

function parseEnvValue(valueText: string): string {
  const trimmed = valueText.trimStart();
  if (!trimmed) return "";
  if (trimmed.startsWith("\"") || trimmed.startsWith("'")) return parseQuotedEnvValue(trimmed);
  return stripEnvInlineComment(valueText).trim();
}

function parseQuotedEnvValue(valueText: string): string {
  const closingIndex = findClosingEnvQuote(valueText);
  if (closingIndex === -1) throw new Error("Invalid .env quoted value.");
  if (!isValidQuotedEnvValueSuffix(valueText.slice(closingIndex + 1))) {
    throw new Error("Invalid .env quoted value suffix.");
  }
  return unquoteEnvValue(valueText.slice(0, closingIndex + 1));
}

function isValidQuotedEnvValueSuffix(suffix: string): boolean {
  if (suffix.trim() === "") return true;
  return /^\s+#/u.test(suffix);
}

function findClosingEnvQuote(valueText: string): number {
  const quote = valueText[0];

  for (let index = 1; index < valueText.length; index += 1) {
    if (valueText[index] === quote && valueText[index - 1] !== "\\") return index;
  }

  return -1;
}

function unquoteEnvValue(valueText: string): string {
  const quote = valueText[0];
  const value = valueText.slice(1, -1);
  if (quote === "'") return value;
  return value.replace(/\\([nrt"\\])/gu, (_match, escaped: string) => decodeEscapedEnvCharacter(escaped));
}

function decodeEscapedEnvCharacter(escaped: string): string {
  if (escaped === "n") return "\n";
  if (escaped === "r") return "\r";
  if (escaped === "t") return "\t";
  return escaped;
}

function stripEnvInlineComment(valueText: string): string {
  const commentIndex = valueText.search(/\s#/u);
  if (commentIndex === -1) return valueText;
  return valueText.slice(0, commentIndex);
}

function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_]\w*$/u.test(key);
}

function parseSimpleYaml(text: string): ConfigObject {
  const root: ConfigObject = {};
  const lines = normalizeYamlLines(text);
  const stack: Array<{ indent: number; value: ConfigObject | ConfigValue[] }> = [{ indent: -1, value: root }];

  lines.forEach((line, index) => {
    while (stack.length > 1 && line.indent <= stack.at(-1)!.indent) stack.pop();

    const parent = stack.at(-1)!.value;
    if (line.text.startsWith("- ")) {
      applyYamlArrayItem(parent, line, stack);
      return;
    }

    const { key, valueText } = splitYamlKeyValue(line.text);
    if (valueText === undefined) {
      const child = nextYamlContainer(lines, index);
      assignYamlProperty(parent, key, child);
      stack.push({ indent: line.indent, value: child });
      return;
    }

    assignYamlProperty(parent, key, parseYamlScalar(valueText));
  });

  return root;
}

function normalizeYamlLines(text: string): ParsedYamlLine[] {
  return text
    .split("\n")
    .map(line => ({ indent: yamlIndentPattern.exec(line)?.[0].length ?? 0, text: stripYamlComment(line).trim() }))
    .filter(line => line.text !== "");
}

function applyYamlArrayItem(
  parent: ConfigObject | ConfigValue[],
  line: ParsedYamlLine,
  stack: Array<{ indent: number; value: ConfigObject | ConfigValue[] }>,
) {
  if (!Array.isArray(parent)) throw new Error("Invalid YAML: array item is not nested under an array key.");

  const itemText = line.text.slice(2).trim();
  const keyValue = trySplitYamlKeyValue(itemText);
  if (!keyValue) {
    parent.push(parseYamlScalar(itemText));
    return;
  }

  const item: ConfigObject = {};
  parent.push(item);
  stack.push({ indent: line.indent, value: item });

  if (keyValue.valueText === undefined) {
    const child: ConfigObject = {};
    assignConfigProperty(item, keyValue.key, child);
    stack.push({ indent: line.indent + 2, value: child });
    return;
  }

  assignConfigProperty(item, keyValue.key, parseYamlScalar(keyValue.valueText));
}

function nextYamlContainer(lines: ParsedYamlLine[], index: number): ConfigObject | ConfigValue[] {
  const nextLine = lines[index + 1];
  return nextLine?.text.startsWith("- ") ? [] : {};
}

function assignYamlProperty(parent: ConfigObject | ConfigValue[], key: string, value: ConfigValue) {
  if (Array.isArray(parent)) throw new Error(`Invalid YAML: cannot assign key ${key} directly to an array.`);
  assignConfigProperty(parent, key, value);
}

function assignConfigProperty(parent: ConfigObject, key: string, value: ConfigValue) {
  Object.defineProperty(parent, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function splitYamlKeyValue(text: string): { key: string; valueText?: string } {
  const keyValue = trySplitYamlKeyValue(text);
  if (!keyValue) throw new Error(`Invalid YAML line: ${text}`);
  return keyValue;
}

function trySplitYamlKeyValue(text: string): { key: string; valueText?: string } | undefined {
  const separatorIndex = text.indexOf(":");
  if (separatorIndex === -1) return undefined;

  const key = text.slice(0, separatorIndex).trim();
  const rawValue = text.slice(separatorIndex + 1).trim();
  return { key, valueText: rawValue === "" ? undefined : rawValue };
}

function parseYamlScalar(valueText: string): ConfigValue {
  if (valueText === "true") return true;
  if (valueText === "false") return false;
  if (valueText === "null") return null;
  if (valueText === "{}") return {};
  if (valueText === "[]") return [];
  if (/^-?\d+(?:\.\d+)?$/.test(valueText)) return Number(valueText);
  if (isQuoted(valueText)) return valueText.slice(1, -1);
  return valueText;
}

function stripYamlComment(line: string): string {
  let quote: string | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
    }
    if (char === "#" && quote === undefined) return line.slice(0, index);
  }

  return line;
}

function isQuoted(text: string): boolean {
  return (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"));
}

function setAuthorizationHeader(config: DeepPartial<ObservMeConfig>, token: string | undefined) {
  if (!token) return;
  setString(config, ["otlp", "headers", "Authorization"], `Bearer ${token}`);
}

function setString(target: DeepPartial<ObservMeConfig>, path: string[], value: string | undefined) {
  if (value === undefined) return;
  setPathValue(target as Record<string, unknown>, path, value);
}

function setNumber(target: DeepPartial<ObservMeConfig>, path: string[], value: string | undefined) {
  if (value === undefined) return;
  const normalized = value.trim();
  const parsed = Number(normalized);
  const parsedValue = normalized !== "" && Number.isFinite(parsed) ? parsed : value;
  setPathValue(target as Record<string, unknown>, path, parsedValue);
}

function setBoolean(target: DeepPartial<ObservMeConfig>, path: string[], value: string | undefined) {
  if (value === undefined) return;
  const parsed = parseBooleanEnv(value);
  setPathValue(target as Record<string, unknown>, path, parsed ?? value);
}

function setPathValue(target: Record<string, unknown>, path: string[], value: unknown) {
  let current = target;

  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (!isPlainObject(existing)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }

  current[path.at(-1)!] = value;
}

function parseBooleanEnv(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isPlainObject(error) && error.code === "ENOENT";
}
