export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** UTC calendar date `YYYY-MM-DD` of an epoch-ms timestamp (the Nansen date format). */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysBefore(ms: number, days: number): string {
  return utcDate(ms - days * DAY_MS);
}
