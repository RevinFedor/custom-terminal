'use strict';

function normalizePositiveInt(value, fallback = null, max = 20_000) {
  if (value == null || value === '') return fallback;
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

/**
 * One shared bounded-history contract for main, HTTP and renderer consumers.
 * Topology may still be resolved over the full branch, but expensive
 * presentation/dehydration and transport happen only for this window.
 */
function applyHistoryEntryWindow(entries, bounds = null) {
  const all = Array.isArray(entries) ? entries : [];
  const total = all.length;
  const aroundUuid = typeof bounds?.aroundUuid === 'string' && bounds.aroundUuid
    ? bounds.aroundUuid
    : null;
  const afterUuid = typeof bounds?.afterUuid === 'string' && bounds.afterUuid
    ? bounds.afterUuid
    : null;
  const beforeUuid = typeof bounds?.beforeUuid === 'string' && bounds.beforeUuid
    ? bounds.beforeUuid
    : null;
  const last = normalizePositiveInt(bounds?.last, null, 20_000);
  const radius = normalizePositiveInt(bounds?.radius, 80, 500);
  const boundsApplied = Boolean(aroundUuid || afterUuid || beforeUuid || last);
  if (!boundsApplied) {
    return {
      entries: all,
      total,
      dropped: 0,
      truncated: false,
      boundsApplied: false,
      firstUuid: all[0]?.uuid || null,
      lastUuid: all[all.length - 1]?.uuid || null,
    };
  }

  let selected = all;
  if (aroundUuid) {
    const index = all.findIndex((entry) => entry?.uuid === aroundUuid);
    selected = index < 0
      ? []
      : all.slice(Math.max(0, index - radius), Math.min(total, index + radius + 1));
  } else {
    if (afterUuid) {
      const index = selected.findIndex((entry) => entry?.uuid === afterUuid);
      selected = index < 0 ? [] : selected.slice(index + 1);
    }
    if (beforeUuid) {
      const index = selected.findIndex((entry) => entry?.uuid === beforeUuid);
      selected = index < 0 ? [] : selected.slice(0, index);
    }
    if (last && selected.length > last) selected = selected.slice(selected.length - last);
  }

  const dropped = Math.max(0, total - selected.length);
  return {
    entries: selected,
    total,
    dropped,
    truncated: dropped > 0,
    boundsApplied: true,
    firstUuid: selected[0]?.uuid || null,
    lastUuid: selected[selected.length - 1]?.uuid || null,
  };
}

module.exports = { applyHistoryEntryWindow };
