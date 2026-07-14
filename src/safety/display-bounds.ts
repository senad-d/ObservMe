export const OBS_BACKEND_LABEL_MAX_CHARS = 96;
export const OBS_COMMAND_OUTPUT_MAX_CHARS = 8192;
export const OBS_COMMAND_RENDER_ROW_LIMIT = 20;

const truncationMarker = "…";
const outputTruncationSuffix = "\n… output truncated";
const unsafeDisplayControlPattern = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const displayWhitespacePattern = /\s+/gu;

export interface BoundedObsCommandRows<T> {
  readonly rows: readonly T[];
  readonly omittedCount: number;
}

export function normalizeObsBackendLabel(value: string | undefined): string | undefined {
  const normalized = value?.replace(unsafeDisplayControlPattern, " ").replace(displayWhitespacePattern, " ").trim();
  if (!normalized) return undefined;
  return truncateUnicodeText(normalized, OBS_BACKEND_LABEL_MAX_CHARS, truncationMarker);
}

export function normalizeObsBackendLabelRecord(labels: Readonly<Record<string, string>>): Record<string, string> {
  const normalizedLabels: Record<string, string> = {};

  for (const [key, value] of Object.entries(labels)) {
    const normalizedKey = normalizeObsBackendLabel(key);
    const normalizedValue = normalizeObsBackendLabel(value);
    if (normalizedKey && normalizedValue !== undefined) normalizedLabels[normalizedKey] = normalizedValue;
  }

  return normalizedLabels;
}

export function selectObsCommandRows<T>(rows: readonly T[]): BoundedObsCommandRows<T> {
  if (rows.length <= OBS_COMMAND_RENDER_ROW_LIMIT) return { rows, omittedCount: 0 };

  return {
    rows: rows.slice(0, OBS_COMMAND_RENDER_ROW_LIMIT),
    omittedCount: rows.length - OBS_COMMAND_RENDER_ROW_LIMIT,
  };
}

export function boundObsCommandOutput(output: string): string {
  if (output.length <= OBS_COMMAND_OUTPUT_MAX_CHARS) return output;

  const prefixLimit = OBS_COMMAND_OUTPUT_MAX_CHARS - outputTruncationSuffix.length;
  return `${truncateUnicodeText(output, prefixLimit, "")}${outputTruncationSuffix}`;
}

function truncateUnicodeText(value: string, maximumChars: number, suffix: string): string {
  if (value.length <= maximumChars) return value;

  const prefixLimit = Math.max(0, maximumChars - suffix.length);
  let prefix = "";
  for (const codePoint of value) {
    if (prefix.length + codePoint.length > prefixLimit) break;
    prefix += codePoint;
  }

  return `${prefix}${suffix}`;
}
