export type OtlpEndpointFailureClass =
  | "unresolved_placeholder"
  | "malformed_url"
  | "unsupported_protocol"
  | "embedded_credentials"
  | "query_not_supported"
  | "fragment_not_supported";

export function classifyOtlpEndpointFailure(endpoint: string): OtlpEndpointFailureClass | undefined {
  if (endpoint.includes("${")) return "unresolved_placeholder";
  if (/\s/u.test(endpoint)) return "malformed_url";

  const parsedEndpoint = parseEndpoint(endpoint);
  if (!parsedEndpoint) return "malformed_url";
  if (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:") return "unsupported_protocol";
  if (parsedEndpoint.username || parsedEndpoint.password) return "embedded_credentials";
  if (endpoint.includes("?")) return "query_not_supported";
  if (endpoint.includes("#")) return "fragment_not_supported";
  return undefined;
}

export function appendOtlpSignalPath(baseEndpoint: string, signalPath: string): string {
  const failureClass = classifyOtlpEndpointFailure(baseEndpoint);
  if (failureClass) throw new TypeError(`OTLP endpoint is invalid (${failureClass}).`);

  const endpoint = new URL(baseEndpoint);
  endpoint.pathname = `${removeTrailingSlashes(endpoint.pathname)}${normalizeSignalPath(signalPath)}`;
  return endpoint.href;
}

function parseEndpoint(endpoint: string): URL | undefined {
  try {
    return new URL(endpoint);
  } catch {
    return undefined;
  }
}

function normalizeSignalPath(signalPath: string): string {
  let start = 0;
  while (start < signalPath.length && signalPath[start] === "/") start += 1;
  return `/${signalPath.slice(start)}`;
}

function removeTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
