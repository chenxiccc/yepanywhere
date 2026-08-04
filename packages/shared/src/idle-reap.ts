export const DEFAULT_IDLE_REAP_HOURS = 24;
export const NEVER_IDLE_REAP_HOURS = -1;
export const MAX_IDLE_REAP_HOURS = 72;

export function isIdleReapHours(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (value < 0 || value <= MAX_IDLE_REAP_HOURS)
  );
}

export function normalizeIdleReapHours(value: number): number {
  return value < 0 ? NEVER_IDLE_REAP_HOURS : value;
}

export function idleReapHoursToMs(hours: number): number {
  return hours < 0 ? NEVER_IDLE_REAP_HOURS : hours * 60 * 60 * 1000;
}

export function idleReapMsToHours(timeoutMs: number): number {
  return timeoutMs < 0 ? NEVER_IDLE_REAP_HOURS : timeoutMs / (60 * 60 * 1000);
}
