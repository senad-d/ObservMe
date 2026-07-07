import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import { request as requestHttp } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { request as requestHttps } from "node:https";
import type { ObservMeConfig } from "../config/schema.ts";

export type GrafanaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type GrafanaAuthMode = "bearer" | "basic" | "none";

export interface GrafanaTransportOptions {
  readonly fetch?: GrafanaFetch;
  readonly timeoutMs?: number;
}

export interface GrafanaTransportFetchOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMessage?: string;
}

interface GrafanaAuthReadiness {
  readonly mode: GrafanaAuthMode;
  readonly detail?: string;
}

interface ErrorWithCode {
  readonly code?: unknown;
  readonly cause?: unknown;
}

const minimumTimeoutMs = 1;
const unresolvedEnvironmentPlaceholderPattern = /\$\{[A-Z0-9_]+\}/u;
const tlsErrorCodes = new Set<string>([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
]);
const dnsErrorCodes = new Set<string>(["ENOTFOUND", "EAI_AGAIN"]);
const connectionTimeoutErrorCodes = new Set<string>(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

export class GrafanaTransportClient {
  readonly #config: ObservMeConfig;
  readonly #fetcher: GrafanaFetch;
  readonly #timeoutMs: number;

  constructor(config: ObservMeConfig, options: GrafanaTransportOptions = {}) {
    this.#config = config;
    this.#fetcher = resolveGrafanaFetch(config, options.fetch);
    this.#timeoutMs = resolveGrafanaTimeoutMs(config, options.timeoutMs);
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  apiUrl(apiPath: string): URL {
    return buildGrafanaApiUrl(this.#config.query.grafana.url, apiPath);
  }

  datasourceApiUrl(datasourceUid: string, apiPath: string): URL {
    return buildGrafanaDatasourceApiUrl(this.#config.query.grafana.url, datasourceUid, apiPath);
  }

  datasourceProxyUrl(datasourceUid: string, proxyPath: string): URL {
    return buildGrafanaDatasourceProxyUrl(this.#config.query.grafana.url, datasourceUid, proxyPath);
  }

  async fetch(input: string | URL, options: GrafanaTransportFetchOptions = {}): Promise<Response> {
    return fetchGrafanaRequest(
      this.#fetcher,
      input,
      createGrafanaRequestInit(this.#config, options),
      this.#timeoutMs,
      options.timeoutMessage,
    );
  }

  formatHttpFailure(response: Response): string {
    return formatGrafanaHttpFailure(response, this.#config);
  }
}

export function createGrafanaTransport(
  config: ObservMeConfig,
  options: GrafanaTransportOptions = {},
): GrafanaTransportClient {
  return new GrafanaTransportClient(config, options);
}

export function buildGrafanaApiUrl(baseUrl: string, apiPath: string): URL {
  const url = new URL(baseUrl.trim());
  const basePath = url.pathname.replace(/\/+$/u, "");
  const path = apiPath.replace(/^\/+/, "");
  url.pathname = `${basePath}/${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

export function buildGrafanaDatasourceApiUrl(baseUrl: string, datasourceUid: string, apiPath: string): URL {
  return buildGrafanaApiUrl(
    baseUrl,
    joinGrafanaApiPath(`/api/datasources/uid/${encodeURIComponent(datasourceUid)}`, apiPath),
  );
}

export function buildGrafanaDatasourceProxyUrl(baseUrl: string, datasourceUid: string, proxyPath: string): URL {
  return buildGrafanaApiUrl(
    baseUrl,
    joinGrafanaApiPath(`/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}`, proxyPath),
  );
}

export function resolveGrafanaTimeoutMs(config: ObservMeConfig, overrideMs?: number): number {
  const timeoutMs = overrideMs ?? config.query.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < minimumTimeoutMs) return minimumTimeoutMs;
  return Math.trunc(timeoutMs);
}

export function createGrafanaHeaders(config: ObservMeConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const authorization = createGrafanaAuthorizationHeader(config);

  if (authorization) headers.Authorization = authorization;
  return headers;
}

export function resolveGrafanaFetch(config: ObservMeConfig, fetcher?: GrafanaFetch): GrafanaFetch {
  if (fetcher) return fetcher;
  if (requiresCustomGrafanaTransport(config)) return (input, init) => fetchGrafanaWithNode(config, input, init);
  return defaultGrafanaFetch;
}

export function requiresCustomGrafanaTransport(config: ObservMeConfig): boolean {
  return Boolean(config.query.grafana.transport.preferIPv4 || config.query.grafana.tls.insecureSkipVerify);
}

export function formatGrafanaHttpFailure(response: Response, config: ObservMeConfig): string {
  const status = formatHttpStatus(response);
  if (!isGrafanaAuthFailure(response.status)) return status;

  const readiness = getGrafanaAuthReadiness(config);
  if (readiness.mode === "none") return `${status}; ${readiness.detail ?? "Grafana authentication is not configured."}`;
  return `${status}; Grafana authentication failed. Check query.grafana credentials without exposing token or password values.`;
}

export function formatGrafanaFetchFailure(error: unknown): string {
  if (isAbortError(error)) return "timed out";

  const code = readErrorCode(error);
  if (code && tlsErrorCodes.has(code)) {
    return "TLS certificate verification failed for Grafana. Trust the local certificate or set query.grafana.tls.insecureSkipVerify=true for local development only.";
  }

  if (code && dnsErrorCodes.has(code)) {
    return "DNS lookup failed for Grafana. Configure query.grafana.url with a resolvable host or enable query.grafana.transport.preferIPv4 for local development.";
  }

  if (code === "ECONNREFUSED") {
    return "Grafana connection refused. Verify the local observability stack is running and query.grafana.url points at it.";
  }

  if (code && connectionTimeoutErrorCodes.has(code)) return "Grafana connection timed out.";
  return formatError(error);
}

export function hasUnresolvedEnvironmentPlaceholder(value: string): boolean {
  return unresolvedEnvironmentPlaceholderPattern.test(value);
}

export function normalizeConfiguredGrafanaSecret(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || hasUnresolvedEnvironmentPlaceholder(trimmed)) return undefined;
  return trimmed;
}

async function fetchGrafanaRequest(
  fetcher: GrafanaFetch,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } catch (error) {
    throw normalizeGrafanaTransportError(error, timeoutMessage);
  } finally {
    clearTimeout(timeout);
  }
}

function createGrafanaRequestInit(config: ObservMeConfig, options: GrafanaTransportFetchOptions): RequestInit {
  return {
    method: options.method ?? "GET",
    headers: { ...createGrafanaHeaders(config), ...options.headers },
  };
}

function normalizeGrafanaTransportError(error: unknown, timeoutMessage: string | undefined): Error {
  if (timeoutMessage && isAbortError(error)) return new Error(timeoutMessage);
  return new Error(formatGrafanaFetchFailure(error));
}

function joinGrafanaApiPath(prefix: string, path: string): string {
  const normalizedPrefix = prefix.replace(/\/+$/u, "");
  const normalizedPath = path.replace(/^\/+/, "");
  if (!normalizedPath) return normalizedPrefix;
  return `${normalizedPrefix}/${normalizedPath}`;
}

export async function fetchGrafanaWithNode(
  config: ObservMeConfig,
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input);
  assertSupportedGrafanaUrl(url);

  const requestOptions = createNodeRequestOptions(config, init);
  const body = normalizeRequestBody(init?.body);
  return requestNodeUrl(url, requestOptions, body, init?.signal);
}

function createGrafanaAuthorizationHeader(config: ObservMeConfig): string | undefined {
  const token = normalizeConfiguredGrafanaSecret(config.query.grafana.token);
  if (token) return `Bearer ${token}`;

  const username = normalizeConfiguredGrafanaSecret(config.query.grafana.username);
  const password = normalizeConfiguredGrafanaSecret(config.query.grafana.password);
  if (username && password) return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  return undefined;
}

function getGrafanaAuthReadiness(config: ObservMeConfig): GrafanaAuthReadiness {
  if (normalizeConfiguredGrafanaSecret(config.query.grafana.token)) return { mode: "bearer" };

  const username = normalizeConfiguredGrafanaSecret(config.query.grafana.username);
  const password = normalizeConfiguredGrafanaSecret(config.query.grafana.password);
  if (username && password) return { mode: "basic" };

  return { mode: "none", detail: describeMissingGrafanaAuth(config) };
}

function describeMissingGrafanaAuth(config: ObservMeConfig): string {
  const token = config.query.grafana.token.trim();
  const username = config.query.grafana.username.trim();
  const password = config.query.grafana.password.trim();

  if (hasUnresolvedEnvironmentPlaceholder(token)) {
    return "Grafana authentication is not configured because query.grafana.token is unresolved. Set the referenced environment variable or configure query.grafana.username/password.";
  }

  if (hasUnresolvedEnvironmentPlaceholder(username) || hasUnresolvedEnvironmentPlaceholder(password)) {
    return "Grafana authentication is not configured because query.grafana.username/password contains an unresolved environment placeholder.";
  }

  if (username || password) {
    return "Grafana authentication is incomplete. Configure both query.grafana.username and query.grafana.password, or configure query.grafana.token.";
  }

  return "Grafana authentication is not configured. Configure query.grafana.token or query.grafana.username/password.";
}

function createNodeRequestOptions(config: ObservMeConfig, init: RequestInit | undefined): HttpRequestOptions | HttpsRequestOptions {
  const options: HttpRequestOptions | HttpsRequestOptions = {
    method: init?.method ?? "GET",
    headers: normalizeRequestHeaders(init?.headers),
  };

  if (config.query.grafana.transport.preferIPv4) options.family = 4;
  if (config.query.grafana.tls.insecureSkipVerify) {
    (options as HttpsRequestOptions).rejectUnauthorized = false;
  }

  return options;
}

function normalizeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) normalized[key] = value;
    return normalized;
  }

  for (const [key, value] of Object.entries(headers)) normalized[key] = String(value);
  return normalized;
}

function normalizeRequestBody(body: BodyInit | null | undefined): string | Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("Grafana custom transport supports string or binary request bodies only.");
}

function assertSupportedGrafanaUrl(url: URL): void {
  if (url.protocol === "http:" || url.protocol === "https:") return;
  throw new Error(`Grafana custom transport supports http:// and https:// URLs only: ${url.protocol}`);
}

async function requestNodeUrl(
  url: URL,
  options: HttpRequestOptions | HttpsRequestOptions,
  body: string | Buffer | undefined,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? requestHttps : requestHttp;
    const request = client(url, options, response => {
      readNodeResponse(response).then(resolve, reject);
    });
    const removeAbortListener = attachAbortSignal(request, signal);

    request.on("error", error => {
      removeAbortListener();
      reject(error);
    });
    request.on("close", removeAbortListener);
    if (body) request.write(body);
    request.end();
  });
}

function attachAbortSignal(request: ClientRequest, signal: AbortSignal | null | undefined): () => void {
  if (!signal) return noop;

  const abortRequest = () => request.destroy(createAbortError());
  if (signal.aborted) {
    abortRequest();
    return noop;
  }

  signal.addEventListener("abort", abortRequest, { once: true });
  return () => signal.removeEventListener("abort", abortRequest);
}

async function readNodeResponse(response: IncomingMessage): Promise<Response> {
  const body = await readNodeResponseBody(response);
  const status = normalizeResponseStatus(response.statusCode);
  const statusText = response.statusMessage ?? "";
  return new Response(body.toString("utf8"), { status, statusText, headers: normalizeResponseHeaders(response.headers) });
}

async function readNodeResponseBody(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function normalizeResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const normalized = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) normalized.append(name, item);
      continue;
    }

    if (value !== undefined) normalized.append(name, String(value));
  }

  return normalized;
}

function normalizeResponseStatus(status: number | undefined): number {
  if (status !== undefined && status >= 200 && status <= 599) return status;
  return 500;
}

async function defaultGrafanaFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function isGrafanaAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

function formatHttpStatus(response: Response): string {
  const statusText = response.statusText.trim();
  return statusText ? `HTTP ${response.status} ${statusText}` : `HTTP ${response.status}`;
}

function readErrorCode(error: unknown): string | undefined {
  const code = readOwnErrorCode(error);
  if (code) return code;

  const cause = readErrorCause(error);
  return cause ? readErrorCode(cause) : undefined;
}

function readOwnErrorCode(error: unknown): string | undefined {
  if (!isErrorWithCode(error) || typeof error.code !== "string") return undefined;
  return error.code;
}

function readErrorCause(error: unknown): unknown {
  if (!isErrorWithCode(error)) return undefined;
  return error.cause;
}

function isErrorWithCode(error: unknown): error is ErrorWithCode {
  return typeof error === "object" && error !== null;
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return isNamedError(error) && error.name === "AbortError";
}

function isNamedError(error: unknown): error is { name: string } {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noop(): void {}
