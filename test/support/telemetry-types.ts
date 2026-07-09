export type TestAttributes = Record<string, unknown>;

export interface TestMetricRecord {
  readonly type: string;
  readonly name: string;
  readonly value: number;
  readonly attributes: TestAttributes;
}

export interface TestSpanContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

export interface TestSpanEvent {
  readonly name: string;
  readonly attributes: TestAttributes;
}

export interface TestSpan {
  readonly name: string;
  readonly parentSpan?: unknown;
  readonly events: TestSpanEvent[];
  attributes: TestAttributes;
  status?: unknown;
  ended: boolean;
  addEvent: (eventName: string, attributesOrStartTime?: unknown, startTime?: unknown) => TestSpan;
  setAttribute: (key: string, value: unknown) => TestSpan;
  setAttributes: (values: TestAttributes) => TestSpan;
  setStatus: (status: unknown) => TestSpan;
  spanContext: () => TestSpanContext;
  addLink: (...args: unknown[]) => TestSpan;
  addLinks: (...args: unknown[]) => TestSpan;
  updateName: (...args: unknown[]) => TestSpan;
  isRecording: () => boolean;
  recordException: () => undefined;
  end: () => void;
}

export interface TestLogRecord {
  readonly body?: unknown;
  readonly attributes?: TestAttributes;
  readonly [key: string]: unknown;
}

export interface TestLogger {
  readonly records: TestLogRecord[];
  readonly emit: (record: unknown) => void;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeRecordConfig<T extends Record<string, unknown>>(base: T, overlay: Record<string, unknown>): T {
  const mutableBase = base as Record<string, unknown>;

  for (const [key, value] of Object.entries(overlay)) {
    const baseValue = mutableBase[key];

    if (isPlainRecord(baseValue) && isPlainRecord(value)) {
      mergeRecordConfig(baseValue, value);
      continue;
    }

    mutableBase[key] = value;
  }

  return base;
}
