export const QUERY_RESULT_COUNT_MINIMUM = 1;
export const QUERY_RESULT_COUNT_MAXIMUM = 100;

export function normalizeQueryResultCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < QUERY_RESULT_COUNT_MINIMUM) {
    return QUERY_RESULT_COUNT_MINIMUM;
  }

  return Math.min(Math.trunc(value), QUERY_RESULT_COUNT_MAXIMUM);
}
