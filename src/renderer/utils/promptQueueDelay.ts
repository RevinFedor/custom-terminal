export const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;
export const MAX_FIRST_DELAY_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

export type FirstDelayParts = {
  hours: number;
  minutes: number;
  seconds: number;
};

export function normalizeFirstDelaySeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_FIRST_DELAY_SECONDS, Math.floor(value)));
}

export function splitFirstDelaySeconds(value: number): FirstDelayParts {
  const total = normalizeFirstDelaySeconds(value);
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

export function combineFirstDelayParts(hours: number, minutes: number, seconds: number): number {
  const safeHours = Number.isFinite(hours) ? Math.max(0, Math.floor(hours)) : 0;
  const safeMinutes = Number.isFinite(minutes) ? Math.max(0, Math.min(59, Math.floor(minutes))) : 0;
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.min(59, Math.floor(seconds))) : 0;
  return normalizeFirstDelaySeconds((safeHours * 3600) + (safeMinutes * 60) + safeSeconds);
}

export function getFirstDelayRemainingMs(
  value: number,
  startedAt: number,
  now: number = Date.now(),
): number {
  const elapsedMs = Math.max(0, now - startedAt);
  return Math.max(0, (normalizeFirstDelaySeconds(value) * 1000) - elapsedMs);
}

export function getFirstDelayRemainingSeconds(
  value: number,
  startedAt: number,
  now: number = Date.now(),
): number {
  return Math.ceil(getFirstDelayRemainingMs(value, startedAt, now) / 1000);
}

export function formatFirstDelayCountdown(value: number): string {
  const { hours, minutes, seconds } = splitFirstDelaySeconds(value);
  const paddedMinutes = String(minutes).padStart(2, '0');
  const paddedSeconds = String(seconds).padStart(2, '0');
  return hours > 0
    ? `${hours}:${paddedMinutes}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`;
}
