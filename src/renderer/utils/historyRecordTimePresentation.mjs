import recordTimes from '../../shared/history-record-time.cjs';
import { formatHistoryResponseCompletedAt } from './historyResponseTiming.mjs';

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
