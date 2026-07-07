import type { LimitsConfig } from "../config/schema.ts";
import { COMMON_SPAN_ATTRIBUTES } from "../semconv/attributes.ts";

export type ContentLimitKind = "prompt" | "response" | "toolArgument" | "toolResult" | "bashOutput" | "logBody";

export type ContentLimitKey =
  | "maxPromptChars"
  | "maxResponseChars"
  | "maxToolArgumentChars"
  | "maxToolResultChars"
  | "maxBashOutputChars"
  | "maxLogBodyChars";

export type ContentLimits = Pick<LimitsConfig, ContentLimitKey>;

export type TruncationAttributes = Partial<
  Record<
    typeof COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED | typeof COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH,
    boolean | number
  >
>;

export interface TruncationResult {
  readonly value: string;
  readonly truncated: boolean;
  readonly originalLength?: number;
  readonly attributes: TruncationAttributes;
}

export const CONTENT_LIMIT_KEYS = {
  prompt: "maxPromptChars",
  response: "maxResponseChars",
  toolArgument: "maxToolArgumentChars",
  toolResult: "maxToolResultChars",
  bashOutput: "maxBashOutputChars",
  logBody: "maxLogBodyChars",
} as const satisfies Record<ContentLimitKind, ContentLimitKey>;

export function truncateContent(value: string, kind: ContentLimitKind, limits: ContentLimits): TruncationResult {
  const limit = limitForContentKind(kind, limits);
  if (value.length <= limit) return untruncatedContent(value);
  return truncatedContent(value, limit);
}

export function limitForContentKind(kind: ContentLimitKind, limits: ContentLimits): number {
  const limit = limits[CONTENT_LIMIT_KEYS[kind]];
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid content limit for ${kind}`);
  return limit;
}

export function untruncatedContent(value: string): TruncationResult {
  return {
    value,
    truncated: false,
    attributes: {},
  };
}

export function truncatedContent(value: string, limit: number): TruncationResult {
  return {
    value: value.slice(0, limit),
    truncated: true,
    originalLength: value.length,
    attributes: {
      [COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED]: true,
      [COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH]: value.length,
    },
  };
}
