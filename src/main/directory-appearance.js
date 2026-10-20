'use strict';

// Cosmetic read only. Renderer useUIStore owns edits; persistedStorage mirrors
// these exact keys into Main app_state. No renderer bridge or namespace read.
const { processBarValue } = require('./public-tab-activity');
const KEYS = Object.freeze({ sessionStatuses: 'noted-terminal-session-statuses',
  statusMarker: 'noted-terminal-status-marker', processBar: 'noted-terminal-process-bar' });
// Exact useUIStore defaults; normalization parity is checked against its actual
// load functions. Missing storage is different from unreadable/malformed storage.
const DEFAULT_STATUSES = [
  { id: 'dev', label: 'Идёт разработка', color: '#FACC15' },
  { id: 'bugfix', label: 'Отложенный багфикс', color: '#F43F5E' },
  { id: 'knowledge', label: 'Отложенные знания', color: '#10B981' },
];
const DEFAULT_MARKER = { shape: 'dot', sizePx: 8 };
const DEFAULT_BAR = { colorA: '#155E75', shimmerColor: '#FFFFFF', inheritedColor: '#A855F7',
  shimmerSpacingPct: 50, shimmerOpacityPct: 55, position: 'left' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const sources = { sessionStatuses: 'desktop-sessionStatuses', statusMarker: 'desktop-statusMarker', processBar: 'desktop-processBar' };
const unknown = (field, reason) => ({ known: false, stale: false, source: sources[field],
  settingsSource: 'unavailable', value: null, reason });
function unknownDirectoryAppearance(reason = 'not-observed') {
  return { version: 1, ...Object.fromEntries(Object.keys(KEYS).map(field => [field, unknown(field, reason)])) };
}
function statuses(value) {
  if (!Array.isArray(value)) return null;
  const ids = new Set(), result = [];
  for (const row of value) {
    if (!object(row) || !['id','label','color'].every(key => typeof row[key] === 'string')
      || !row.id || !row.color || ids.has(row.id)) return null;
    ids.add(row.id); result.push({ id: row.id, label: row.label, color: row.color });
  }
  return result;
}
function marker(value) {
  if (!object(value) || owns(value, 'shape') && !['dot','square'].includes(value.shape)
    || owns(value, 'sizePx') && !Number.isFinite(value.sizePx)) return null;
  return { shape: value.shape === 'square' ? 'square' : 'dot',
    sizePx: owns(value, 'sizePx') ? Math.max(4, Math.min(16, Math.round(value.sizePx))) : DEFAULT_MARKER.sizePx };
}
function bar(value) {
  if (!object(value)) return null;
  for (const key of ['colorA','shimmerColor','inheritedColor']) {
    if (owns(value, key) && (typeof value[key] !== 'string' || !value[key] || value[key].length > 128)) return null;
  }
  for (const key of ['shimmerSpacingPct','shimmerOpacityPct']) {
    if (owns(value, key) && !Number.isFinite(value[key])) return null;
  }
  if (owns(value, 'position') && !['left','right'].includes(value.position)) return null;
  // Legacy colorB is NOT shimmerColor. Missing newer fields use desktop defaults.
  return processBarValue({ ...DEFAULT_BAR, ...Object.fromEntries(Object.keys(DEFAULT_BAR)
    .filter(key => owns(value, key)).map(key => [key, value[key]])),
    shimmerSpacingPct: Math.max(20, Math.min(200, Math.round(value.shimmerSpacingPct ?? DEFAULT_BAR.shimmerSpacingPct))),
    shimmerOpacityPct: Math.max(5, Math.min(100, Math.round(value.shimmerOpacityPct ?? DEFAULT_BAR.shimmerOpacityPct))) });
}
function readDirectoryAppearance(database) {
  const result = { version: 1 }, normalize = { sessionStatuses: statuses, statusMarker: marker, processBar: bar };
  const defaults = { sessionStatuses: DEFAULT_STATUSES, statusMarker: DEFAULT_MARKER, processBar: DEFAULT_BAR };
  for (const [field, key] of Object.entries(KEYS)) {
    let row;
    try {
      // Exact small rows, not getAllAppStateRaw/getProjectById. A present JSON
      // null or bad JSON must not masquerade as an absent key/default or [].
      row = database.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
    } catch { result[field] = unknown(field, 'settings-read-failed'); continue; }
    let input;
    try { input = row ? JSON.parse(row.value) : defaults[field]; }
    catch { result[field] = unknown(field, 'malformed-setting'); continue; }
    const value = normalize[field](input);
    result[field] = value === null ? unknown(field, 'malformed-setting')
      : { known: true, stale: false, source: sources[field], settingsSource: row ? 'persisted' : 'desktop-defaults', value, reason: null };
  }
  return result;
}
module.exports = { readDirectoryAppearance, unknownDirectoryAppearance };
