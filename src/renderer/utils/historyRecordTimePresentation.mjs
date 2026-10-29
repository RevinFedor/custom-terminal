import recordTimes from '../../shared/history-record-time.cjs';
import { formatHistoryResponseCompletedAt } from './historyResponseTiming.mjs';

/** A local handoff is a saved message snapshot, not an arbitrary sort timestamp.
 * Prefer its exact canonical audit when present; never fabricate time on hover. */
export function historyEntryRecordTime(entry) {
  const canonical = recordTimes.normalizeHistoryRecordTime(entry?.recordTime);
  if (canonical) return canonical;
  if (entry?.role !== 'queued' || !String(entry.uuid || '').startsWith('local-prompt-')
    || typeof entry.handoffId !== 'string' || !entry.handoffId) return undefined;
  if (entry.auditEntryUuid || entry.sourceIdentity) {
    const audit = recordTimes.normalizeHistoryRecordTime({ version: 1, kind: 'message', scope: 'record',
      timestamp: entry.auditTimestamp });
    if (audit) return audit;
  }
  const at = entry.optimisticAt;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > 8.64e15) return undefined;
  return recordTimes.normalizeHistoryRecordTime({ version: 1, kind: 'message', scope: 'record',
    timestamp: new Date(at).toISOString() });
}

export const historyRecordTimeAttributes = (value, key, kind) => {
  const time = recordTimes.normalizeHistoryRecordTime(value);
  if (!time || !key) return {};
  return {
    'data-history-time-key': key,
    'data-history-time-kind': kind,
    'data-history-time-at': time.timestamp,
    'data-history-time-scope': time.scope,
    'data-history-time-source-kind': time.kind,
  };
};

export const historyRecordTimeLabel = (value, now = Date.now()) => {
  const time = recordTimes.normalizeHistoryRecordTime(value);
  return time ? `| ${formatHistoryResponseCompletedAt(Date.parse(time.timestamp), now)}` : '';
};

export function historyRecordTimeRangeLabel(first, last, now = Date.now()) {
  const start = recordTimes.normalizeHistoryRecordTime(first), end = recordTimes.normalizeHistoryRecordTime(last);
  if (!start || !end || Date.parse(end.timestamp) < Date.parse(start.timestamp)) return '';
  if (start.timestamp === end.timestamp) return historyRecordTimeLabel(start, now);
  const a = formatHistoryResponseCompletedAt(Date.parse(start.timestamp), now);
  const b = formatHistoryResponseCompletedAt(Date.parse(end.timestamp), now);
  const day = label => label.slice(0, label.lastIndexOf(', '));
  return `| ${a} — ${day(a) === day(b) ? b.slice(b.lastIndexOf(', ') + 2) : b}`;
}

/** Inspect only published metadata of this group; no body scans or History read.
 * An unknown member cannot silently become a complete-looking time interval. */
export function historyGroupRecordTimeAttributes(entries, key) {
  if (!Array.isArray(entries) || !entries.length || typeof key !== 'string' || !key) return {};
  let first, last;
  const take = time => {
    if (!time) return;
    if (!first || Date.parse(time.timestamp) < Date.parse(first.timestamp)) first = time;
    if (!last || Date.parse(time.timestamp) > Date.parse(last.timestamp)) last = time;
  };
  for (const entry of entries) {
    const own = historyEntryRecordTime(entry);
    let known = !!own;
    take(own);
    // A dehydrated row carries the same record times in actionSummary.
    const actions = Array.isArray(entry?.actions) && entry.actions.length ? entry.actions
      : Array.isArray(entry?.actionSummary) ? entry.actionSummary : [];
    for (const action of actions) {
      const time = recordTimes.normalizeHistoryRecordTime(action?.rawTool?.recordTime)
        || recordTimes.normalizeHistoryRecordTime(action?.recordTime);
      if (time) { known = true; take(time); }
      else if (!own) return {};
    }
    if (!known) return {};
  }
  return first && last ? { ...historyRecordTimeAttributes(first, key + ':time-range', 'group'),
    'data-history-time-end-at': last.timestamp } : {};
}

export const rectsIntersect = (a, b, gap = 0) => a.left < b.right + gap
  && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;
export const rectInside = (a, b) => a.left >= b.left && a.right <= b.right
  && a.top >= b.top && a.bottom <= b.bottom;
export const intersectRect = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

// Geometry is read-only. This function never reserves space or writes scroll.
export function placeHistoryRecordTime({ anchor, clip, pane, size, obstacles = [], safeTop }) {
  const box = (left, top) => ({ left, top, right: left + size.width, bottom: top + size.height });
  if (anchor) {
    const inline = box(anchor.right + 8, anchor.top + (anchor.bottom - anchor.top - size.height) / 2);
    if (size.height <= anchor.bottom - anchor.top + 4 && rectInside(inline, clip)
      && !obstacles.some(rect => rectsIntersect(inline, rect, 3))) return { ...inline, placement: 'inline' };
  }
  const area = intersectRect(pane, { left: 6, top: 6, right: Infinity, bottom: safeTop - 6 });
  for (const left of [Math.max(area.left + 4, area.right - size.width - 6), area.left + 4]) {
    const fallback = box(left, area.bottom - size.height);
    if (rectInside(fallback, area) && !obstacles.some(rect => rectsIntersect(fallback, rect, 3))) {
      return { ...fallback, placement: 'fallback' };
    }
  }
  return null;
}
