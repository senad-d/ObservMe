import type { ObservMeConfig } from "../config/schema.ts";
import { COMMON_SPAN_ATTRIBUTES } from "../semconv/attributes.ts";
import { createEnvTenantSaltSource } from "./hash.ts";
import { redactValue } from "./redact.ts";
import type { ContentLimitKind, TruncationAttributes } from "./truncate.ts";
import { limitForContentKind, truncateContent } from "./truncate.ts";

export type ContentCaptureMode = "omitted" | "redacted" | "unsafe" | "dropped";

export interface ContentCapturePolicyRequest {
  readonly captureEnabled: boolean;
  readonly value?: string;
  readonly kind: ContentLimitKind;
  readonly config: ObservMeConfig;
}

export interface ContentCapturePolicyResult {
  readonly mode: ContentCaptureMode;
  readonly value?: string;
  readonly captured: boolean;
  readonly redactionFailures: number;
  readonly truncated: boolean;
  readonly originalLength?: number;
  readonly attributes: TruncationAttributes;
  readonly errors: readonly string[];
}

export function applyContentCapturePolicy(request: ContentCapturePolicyRequest): ContentCapturePolicyResult {
  if (!request.captureEnabled || request.value === undefined || request.value.length === 0) return omittedContentCapture();
  if (request.config.privacy.redactionEnabled) return redactedContentCapture(request.value, request.kind, request.config);
  if (request.config.privacy.allowUnsafeCapture) return unsafeContentCapture(request.value, request.kind, request.config);
  return droppedContentCapture(["content capture requires redaction unless privacy.allowUnsafeCapture is true"], 1);
}

export function redactedContentCapture(value: string, kind: ContentLimitKind, config: ObservMeConfig): ContentCapturePolicyResult {
  const result = redactValue(value, {
    pathMode: config.privacy.pathMode,
    customRedactionPatterns: config.privacy.customRedactionPatterns,
    maxOutputChars: limitForContentKind(kind, config.limits),
    tenantSaltSource: createEnvTenantSaltSource(config),
  });

  if (result.dropped || result.value === undefined) return droppedContentCapture(result.errors, result.failureMetrics.redactionFailures || 1);

  return {
    mode: "redacted",
    value: result.value,
    captured: true,
    redactionFailures: 0,
    truncated: result.truncated,
    originalLength: result.originalLength,
    attributes: truncationAttributes(result.truncated, result.originalLength),
    errors: [],
  };
}

export function unsafeContentCapture(value: string, kind: ContentLimitKind, config: ObservMeConfig): ContentCapturePolicyResult {
  const result = truncateContent(value, kind, config.limits);
  return {
    mode: "unsafe",
    value: result.value,
    captured: true,
    redactionFailures: 0,
    truncated: result.truncated,
    originalLength: result.originalLength,
    attributes: result.attributes,
    errors: [],
  };
}

export function omittedContentCapture(): ContentCapturePolicyResult {
  return {
    mode: "omitted",
    captured: false,
    redactionFailures: 0,
    truncated: false,
    attributes: {},
    errors: [],
  };
}

export function droppedContentCapture(errors: readonly string[], redactionFailures: number): ContentCapturePolicyResult {
  return {
    mode: "dropped",
    captured: false,
    redactionFailures: normalizeRedactionFailures(redactionFailures),
    truncated: false,
    attributes: {},
    errors,
  };
}

function truncationAttributes(truncated: boolean, originalLength: number | undefined): TruncationAttributes {
  if (!truncated) return {};
  return {
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED]: true,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH]: originalLength,
  };
}

function normalizeRedactionFailures(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.trunc(value);
}
