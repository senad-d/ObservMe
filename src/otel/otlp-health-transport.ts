import type { IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import { request as requestHttp } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { request as requestHttps } from "node:https";
import type { ObservMeConfig } from "../config/schema.ts";
import { buildOtlpHttpTransportPolicy } from "./otlp-http-options.ts";

export type OtlpHealthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface OtlpHealthRequestOperationOptions {
  readonly input: string | URL;
  readonly requestOptions: HttpsRequestOptions;
}

export function createOtlpHealthFetch(config: ObservMeConfig): OtlpHealthFetch {
  const transport = new OtlpHealthTransport(config);
  return transport.fetch.bind(transport);
}

export function createOtlpHealthRequestInit(config: ObservMeConfig, signal: AbortSignal): RequestInit {
  const policy = buildOtlpHttpTransportPolicy(config);
  return {
    method: "GET",
    headers: policy.headers,
    redirect: policy.redirect,
    signal,
  };
}

export function createOtlpHealthNodeRequestOptions(
  config: ObservMeConfig,
  init: RequestInit = {},
): HttpsRequestOptions {
  const policy = buildOtlpHttpTransportPolicy(config);
  return {
    method: init.method ?? "GET",
    headers: normalizeRequestHeaders(init.headers ?? policy.headers),
    rejectUnauthorized: policy.rejectUnauthorized,
    signal: init.signal ?? undefined,
  };
}

class OtlpHealthTransport {
  readonly #config: ObservMeConfig;

  constructor(config: ObservMeConfig) {
    this.#config = config;
  }

  fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const operation = new OtlpHealthRequestOperation({
      input,
      requestOptions: createOtlpHealthNodeRequestOptions(this.#config, init),
    });
    return new Promise(operation.start.bind(operation));
  }
}

class OtlpHealthRequestOperation {
  readonly #input: string | URL;
  readonly #requestOptions: HttpsRequestOptions;
  #resolve: ((response: Response) => void) | undefined;
  #reject: ((error: unknown) => void) | undefined;

  constructor(options: OtlpHealthRequestOperationOptions) {
    this.#input = options.input;
    this.#requestOptions = options.requestOptions;
  }

  start(resolve: (response: Response) => void, reject: (error: unknown) => void): void {
    this.#resolve = resolve;
    this.#reject = reject;

    try {
      const url = new URL(this.#input);
      const request = this.createRequest(url);
      request.once("error", this.handleError.bind(this));
      request.end();
    } catch (error) {
      this.handleError(error);
    }
  }

  createRequest(url: URL) {
    const handleResponse = this.handleResponse.bind(this);
    if (url.protocol === "https:") return requestHttps(url, this.#requestOptions, handleResponse);
    return requestHttp(url, this.#requestOptions as HttpRequestOptions, handleResponse);
  }

  handleResponse(incoming: IncomingMessage): void {
    const status = normalizeHttpResponseStatus(incoming.statusCode);
    const response = new Response(null, {
      status,
      statusText: incoming.statusMessage,
    });
    incoming.destroy();
    this.#resolve?.(response);
  }

  handleError(error: unknown): void {
    this.#reject?.(error);
  }
}

function normalizeRequestHeaders(headers: HeadersInit): Record<string, string> {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function normalizeHttpResponseStatus(status: number | undefined): number {
  if (status !== undefined && status >= 200 && status <= 599) return status;
  return 502;
}
