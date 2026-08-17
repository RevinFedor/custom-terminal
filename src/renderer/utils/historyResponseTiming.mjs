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

/**
 * The tail describes the latest response, not merely the most recent row that
 * happens to carry timing metadata.  Returning null as soon as the newest
 * final assistant row has no timing prevents an older turn's duration from
 * masquerading as the duration of a newer response.
 */
export function latestCompletedHistoryResponseTiming(entries) {
  const source = Array.isArray(entries) ? entries : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const entry = source[index];
    if (entry?.role !== 'assistant' || entry?.textPhase === 'commentary') continue;
    const hasFinalText = !!String(entry?.content || '').trim() || entry?.hasContent === true;
    if (!hasFinalText) continue;
    const timing = entry?.responseTiming;
    if (!timing) return null;
    const startTs = Number(timing.startTs);
    const endTs = Number(timing.endTs);
    const durationMs = Number(timing.durationMs);
    if (!Number.isFinite(startTs)
      || !Number.isFinite(endTs)
      || !Number.isFinite(durationMs)
      || endTs < startTs
      || durationMs < 0) return null;
    return {
      state: 'completed',
      intervalId: Number.isFinite(Number(timing.intervalId))
        ? Number(timing.intervalId)
        : null,
      startTs,
      endTs,
      durationMs,
    };
  }
  return null;
}

/**
 * A live/pending app-owned interval always wins over durable transcript data.
 * `pending` is the short loader-end -> JSONL-binding handoff and is presented
 * as completed; once the exact row arrives, both sources describe the same
 * interval and the footer keeps identical geometry.
 */
export function resolveHistoryResponseTailTiming(activityTiming, entries) {
  if (activityTiming?.state === 'running') {
    const startTs = Number(activityTiming.startTs);
    if (Number.isFinite(startTs)) {
      return {
        ...activityTiming,
        state: 'running',
        startTs,
      };
    }
  }
  if (activityTiming?.state === 'pending') {
    const durationMs = Number(activityTiming.durationMs);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      return {
        ...activityTiming,
        state: 'completed',
        durationMs,
      };
    }
  }
  return latestCompletedHistoryResponseTiming(entries);
}

export function historyResponseTailLabel(timing, now = Date.now()) {
  if (!timing) return null;
  const duration = formatHistoryResponseDuration(
    elapsedHistoryResponseDurationMs(timing, now),
  );
  return timing.state === 'running'
    ? `Working · ${duration}`
    : `Worked for ${duration}`;
}
