export function normalizeHistoryResponseDurationMs(value) {
  const durationMs = Number(value);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.floor(durationMs);
}

export function elapsedHistoryResponseDurationMs(timing, now = Date.now()) {
  if (!timing) return 0;
  if (timing.state === 'running') {
    const startTs = Number(timing.startTs);
    const currentTs = Number(now);
    if (!Number.isFinite(startTs) || !Number.isFinite(currentTs)) return 0;
    return Math.max(0, currentTs - startTs);
  }
  return normalizeHistoryResponseDurationMs(timing.durationMs);
}

export function formatHistoryResponseDuration(value) {
  const totalSeconds = Math.floor(normalizeHistoryResponseDurationMs(value) / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (part) => String(part).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}
