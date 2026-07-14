import type { ObservMeConfig } from "../config/schema.ts";
import { assertNoSensitiveQueryInput } from "../safety/sensitive-input.ts";

interface TraceTemplateReplacement {
  readonly pattern: RegExp;
  readonly key: TraceTemplateValueKey;
}

type TraceTemplateValueKey = "traceId" | "tempoDatasourceUid";
type TraceTemplateValues = Record<TraceTemplateValueKey, string>;

interface GrafanaExploreDatasourceRef {
  readonly type: "tempo";
  readonly uid: string;
}

interface GrafanaTraceQuery {
  readonly refId: "A";
  readonly datasource: GrafanaExploreDatasourceRef;
  readonly queryType: "traceId";
  readonly query: string;
}

interface GrafanaExplorePane {
  readonly datasource: string;
  readonly queries: readonly GrafanaTraceQuery[];
  readonly range: {
    readonly from: "now-1h";
    readonly to: "now";
  };
}

type GrafanaExplorePanes = Record<string, GrafanaExplorePane>;

export const TRACE_LINK_CONFIGURATION_ERROR =
  "Grafana trace link configuration is invalid: use an absolute HTTP(S) traceUrlTemplate with {traceId}, {{traceId}}, ${traceId}, or %TRACE_ID%, or use the ellipsis fallback with an absolute query.grafana.url.";

const maximumTraceLinkLength = 4096;
const traceIdPattern = /^[a-f0-9]{32}$/iu;
const zeroTraceIdPattern = /^0{32}$/u;
const traceIdTemplatePattern = /\{\{\s*traceId\s*\}\}|\{traceId\}|\$\{traceId\}|%TRACE_ID%/u;
const fallbackTraceTemplateMarkerPattern = /\.\.\./u;
const unresolvedTemplatePlaceholderPattern =
  /\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}|\$\{[A-Za-z][A-Za-z0-9_]*\}|\{[A-Za-z][A-Za-z0-9_]*\}|%[A-Z][A-Z0-9_]*%|\$traceId\b|__TRACE_ID__/u;
const traceTemplateReplacements: readonly TraceTemplateReplacement[] = [
  { pattern: /\{\{\s*traceId\s*\}\}/gu, key: "traceId" },
  { pattern: /\$\{traceId\}/gu, key: "traceId" },
  { pattern: /\{traceId\}/gu, key: "traceId" },
  { pattern: /%TRACE_ID%/gu, key: "traceId" },
  { pattern: /\{\{\s*tempoDatasourceUid\s*\}\}/gu, key: "tempoDatasourceUid" },
  { pattern: /\$\{tempoDatasourceUid\}/gu, key: "tempoDatasourceUid" },
  { pattern: /\{tempoDatasourceUid\}/gu, key: "tempoDatasourceUid" },
  { pattern: /%TEMPO_DATASOURCE_UID%/gu, key: "tempoDatasourceUid" },
];

export function buildGrafanaTraceLink(config: ObservMeConfig, traceId: string): string {
  const normalizedTraceId = normalizeTraceId(traceId);
  const template = config.query.links.traceUrlTemplate.trim();

  if (isFallbackTraceTemplate(template)) return buildDefaultGrafanaTraceLink(config, normalizedTraceId);
  if (!hasTraceIdTemplatePlaceholder(template)) throw new Error(TRACE_LINK_CONFIGURATION_ERROR);

  return renderTraceUrlTemplate(template, config, normalizedTraceId);
}

function buildDefaultGrafanaTraceLink(config: ObservMeConfig, traceId: string): string {
  const url = parseTraceLinkUrl(config.query.grafana.url.trim());
  const basePath = removeTrailingSlashes(url.pathname);
  url.pathname = `${basePath}/explore`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("schemaVersion", "1");
  url.searchParams.set("panes", JSON.stringify(createDefaultExplorePanes(config, traceId)));
  return formatTraceLinkUrl(url);
}

function removeTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function createDefaultExplorePanes(config: ObservMeConfig, traceId: string): GrafanaExplorePanes {
  const tempoUid = config.query.grafana.datasourceUids.tempo;
  return {
    observmeTrace: {
      datasource: tempoUid,
      queries: [
        {
          refId: "A",
          datasource: { type: "tempo", uid: tempoUid },
          queryType: "traceId",
          query: traceId,
        },
      ],
      range: { from: "now-1h", to: "now" },
    },
  };
}

function renderTraceUrlTemplate(template: string, config: ObservMeConfig, traceId: string): string {
  const values = createTraceTemplateValues(config, traceId);
  let rendered = template;

  for (const replacement of traceTemplateReplacements) {
    rendered = rendered.replace(replacement.pattern, values[replacement.key]);
  }

  if (unresolvedTemplatePlaceholderPattern.test(rendered)) throw new Error(TRACE_LINK_CONFIGURATION_ERROR);
  return formatTraceLinkUrl(parseTraceLinkUrl(rendered));
}

function createTraceTemplateValues(config: ObservMeConfig, traceId: string): TraceTemplateValues {
  return {
    traceId: encodeURIComponent(traceId),
    tempoDatasourceUid: encodeURIComponent(config.query.grafana.datasourceUids.tempo),
  };
}

function normalizeTraceId(traceId: string): string {
  const trimmed = traceId.trim();
  assertNoSensitiveQueryInput(trimmed, "Grafana traceId");

  if (!traceIdPattern.test(trimmed) || zeroTraceIdPattern.test(trimmed)) {
    throw new Error(
      "Unsafe Grafana traceId: expected a non-zero 32-character hexadecimal OpenTelemetry trace id; raw prompts, commands, paths, and environment values are not query inputs.",
    );
  }

  return trimmed.toLowerCase();
}

function hasTraceIdTemplatePlaceholder(template: string): boolean {
  return traceIdTemplatePattern.test(template);
}

function isFallbackTraceTemplate(template: string): boolean {
  return template === "" || fallbackTraceTemplateMarkerPattern.test(template);
}

function parseTraceLinkUrl(value: string): URL {
  if (!value || value.length > maximumTraceLinkLength || hasUnsafeUrlCharacters(value)) {
    throw new Error(TRACE_LINK_CONFIGURATION_ERROR);
  }

  try {
    const url = new URL(value);
    if (!isSupportedTraceLinkProtocol(url.protocol) || url.username || url.password) {
      throw new Error(TRACE_LINK_CONFIGURATION_ERROR);
    }
    return url;
  } catch {
    throw new Error(TRACE_LINK_CONFIGURATION_ERROR);
  }
}

function formatTraceLinkUrl(url: URL): string {
  const link = url.toString();
  if (link.length > maximumTraceLinkLength) throw new Error(TRACE_LINK_CONFIGURATION_ERROR);
  return link;
}

function hasUnsafeUrlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

function isSupportedTraceLinkProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}
