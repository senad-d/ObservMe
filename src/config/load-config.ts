import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultObservMeConfig } from "./defaults.ts";
import type { ConfigLogSink } from "./validate.ts";
import { ensureValidObservMeConfig } from "./validate.ts";
import type { ObservMeConfig } from "./schema.ts";

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

export interface LoadSessionConfigOptions extends LoadConfigOptions {
  ctx?: ProjectTrustContext;
  cwd?: string;
  configDirName?: string;
  projectConfigPath?: string;
  isProjectTrusted?: boolean | (() => boolean | Promise<boolean>);
}

interface ParsedYamlLine {
  indent: number;
  text: string;
}

const defaultConfigDirName = ".pi";
const observmeYamlFileName = "observme.yaml";

export async function loadFactoryConfig(options: LoadConfigOptions = {}): Promise<ObservMeConfig> {
  const globalConfig = await readConfigFile(resolveGlobalConfigPath(options), options);
  const config = mergeConfigLayers([defaultObservMeConfig, globalConfig, envToConfig(options.env), options.runtimeOptions]);

  return ensureValidObservMeConfig(config, { env: options.env, logger: options.logger });
}

export async function loadSessionConfig(options: LoadSessionConfigOptions = {}): Promise<ObservMeConfig> {
  const globalConfig = await readConfigFile(resolveGlobalConfigPath(options), options);
  const projectTrusted = await resolveProjectTrust(options);
  const projectConfig = projectTrusted ? await readConfigFile(resolveProjectConfigPath(options), options) : undefined;
  const config = mergeConfigLayers([
    defaultObservMeConfig,
    globalConfig,
    projectConfig,
    envToConfig(options.env),
    options.runtimeOptions,
  ]);

  return ensureValidObservMeConfig(config, {
    env: options.env,
    isProjectTrusted: projectTrusted,
    projectConfigWasRead: Boolean(projectConfig),
    logger: options.logger,
  });
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
  setBoolean(config, ["replayOnStart"], env.OBSERVME_REPLAY_ON_START);
  setString(config, ["otlp", "endpoint"], env.OBSERVME_OTLP_ENDPOINT);
  setString(config, ["otlp", "protocol"], env.OBSERVME_OTLP_PROTOCOL);
  setString(config, ["otlp", "signalEndpoints", "traces"], env.OBSERVME_OTLP_TRACES_ENDPOINT);
  setString(config, ["otlp", "signalEndpoints", "metrics"], env.OBSERVME_OTLP_METRICS_ENDPOINT);
  setString(config, ["otlp", "signalEndpoints", "logs"], env.OBSERVME_OTLP_LOGS_ENDPOINT);
  setNumber(config, ["otlp", "timeoutMs"], env.OBSERVME_OTLP_TIMEOUT_MS);
  setAuthorizationHeader(config, env.OBSERVME_OTLP_TOKEN);
  setNumber(config, ["workflow", "maxDepthWarning"], env.OBSERVME_WORKFLOW_MAX_DEPTH_WARNING);
  setNumber(config, ["workflow", "maxFanoutWarning"], env.OBSERVME_WORKFLOW_MAX_FANOUT_WARNING);
  setBoolean(config, ["agent", "propagateTraceContext"], env.OBSERVME_PROPAGATE_TRACE_CONTEXT);
  setBoolean(config, ["agent", "propagateToSubagents"], env.OBSERVME_PROPAGATE_TO_SUBAGENTS);
  setBoolean(config, ["agent", "writeCorrelationEntry"], env.OBSERVME_WRITE_CORRELATION_ENTRY);
  setString(config, ["query", "grafana", "url"], env.OBSERVME_GRAFANA_URL);
  setString(config, ["query", "grafana", "token"], env.OBSERVME_GRAFANA_TOKEN);
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
    setString(config, ["resource", "attributes", "observme.tenant.id"], env.OBSERVME_TENANT);
  }

  if (env.OBSERVME_ENVIRONMENT) {
    setString(config, ["resource", "attributes", "deployment.environment.name"], env.OBSERVME_ENVIRONMENT);
  }

  return config;
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
  try {
    const text = await readOptionalText(path, options.readText ?? defaultReadConfigText);
    if (!text || text.trim() === "") return undefined;
    return parseObservMeConfigText(text);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    options.logger?.warn?.(`ObservMe config file ${path} was ignored: ${formatError(error)}`);
    return undefined;
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
  return options.globalConfigPath ?? join(homedir(), ".pi", "agent", observmeYamlFileName);
}

function resolveProjectConfigPath(options: LoadSessionConfigOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const configDirName = options.configDirName ?? defaultConfigDirName;
  return options.projectConfigPath ?? join(cwd, configDirName, observmeYamlFileName);
}

async function resolveProjectTrust(options: LoadSessionConfigOptions): Promise<boolean> {
  if (typeof options.isProjectTrusted === "boolean") return options.isProjectTrusted;
  if (typeof options.isProjectTrusted === "function") return options.isProjectTrusted();
  if (typeof options.ctx?.isProjectTrusted === "function") return options.ctx.isProjectTrusted();
  return false;
}

function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

function deepMergeObjects(base: ConfigObject, overlay: ConfigObject): ConfigObject {
  const merged = cloneConfig(base);

  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = deepMergeObjects(existing, value);
      continue;
    }
    merged[key] = cloneConfig(value);
  }

  return merged;
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
    .map(line => ({ indent: line.match(/^ */)?.[0].length ?? 0, text: stripYamlComment(line).trim() }))
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
    item[keyValue.key] = child;
    stack.push({ indent: line.indent + 2, value: child });
    return;
  }

  item[keyValue.key] = parseYamlScalar(keyValue.valueText);
}

function nextYamlContainer(lines: ParsedYamlLine[], index: number): ConfigObject | ConfigValue[] {
  const nextLine = lines[index + 1];
  return nextLine?.text.startsWith("- ") ? [] : {};
}

function assignYamlProperty(parent: ConfigObject | ConfigValue[], key: string, value: ConfigValue) {
  if (Array.isArray(parent)) throw new Error(`Invalid YAML: cannot assign key ${key} directly to an array.`);
  parent[key] = value;
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
  if (value === undefined || value === "") return;
  setPathValue(target as Record<string, unknown>, path, value);
}

function setNumber(target: DeepPartial<ObservMeConfig>, path: string[], value: string | undefined) {
  if (value === undefined || value === "") return;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return;
  setPathValue(target as Record<string, unknown>, path, parsed);
}

function setBoolean(target: DeepPartial<ObservMeConfig>, path: string[], value: string | undefined) {
  const parsed = parseBooleanEnv(value);
  if (parsed === undefined) return;
  setPathValue(target as Record<string, unknown>, path, parsed);
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

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const normalized = value.toLowerCase();
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
