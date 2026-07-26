export const NODE_TIMER_MAX_MILLISECONDS = 2_147_483_647;

export function normalizeNodeTimerMilliseconds(value: number, minimum = 1): number {
  if (!Number.isFinite(value) || value < minimum) return minimum;
  return Math.max(minimum, Math.min(Math.trunc(value), NODE_TIMER_MAX_MILLISECONDS));
}
