import { archiveRecordKey } from './globalTabArchive.mjs';

export const ARCHIVE_PRESENTATION_KEY = 'noted-terminal-global-history-view-v1';
export const ARCHIVE_LIST_WIDTH_KEY = 'noted-terminal-project-home-list-col-width';
export const ARCHIVE_LIST_DEFAULT_WIDTH = 420;
export const archiveListWidth = value => Math.max(300, Math.min(620, Number(value) || ARCHIVE_LIST_DEFAULT_WIDTH));

// SQL archive dates are Unix seconds; transcript hits may carry milliseconds
// or ISO dates. Missing dates must not turn into a visible January 1970 stamp.
export function archiveTimestampMillis(value) {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value));
  const timestamp = numeric
    ? Number(value) * (Number(value) < 1e11 ? 1000 : 1)
    : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function archiveHitKey(kind, row) {
  return JSON.stringify([archiveRecordKey(kind,row), typeof row.entryUuid === 'string' ? row.entryUuid : '']);
}

const hitFields = ['entryUuid','score','summary','content','iterationIndex','timestamp'];
export function archiveHitPresentation(row) {
  return Object.fromEntries(hitFields.filter(key => row[key] !== undefined).map(key => [key,row[key]]));
}

// Cached search hits are presentation only. Every action gets current durable
// metadata, exact session identity and protection state from the fresh read.
export function reconcileArchiveHits(hits, history) {
  const current = new Map(history.map(row => [archiveRecordKey('history',row),row]));
  return (hits || []).flatMap(hit => {
    try {
      const row = current.get(archiveRecordKey('history',hit));
      return row ? [{...row,...archiveHitPresentation(hit),__notedArchiveSourceV1:row}] : [];
    } catch { return []; }
  });
}

export function loadArchivePresentation(storage) {
  try {
    const value = JSON.parse(storage.getItem(ARCHIVE_PRESENTATION_KEY) || '{}');
    if (value.version !== 1) return {};
    return {
      kind:value.kind === 'favorite' ? 'favorite' : 'history',
      query:typeof value.query === 'string' ? value.query : '',
      workflow:typeof value.workflow === 'string' ? value.workflow : '',
      cwd:typeof value.cwd === 'string' ? value.cwd : '',
      target:typeof value.target === 'string' ? value.target : '',
      mode:value.mode === 'iterations' ? 'iterations' : 'titles',
      dateFrom:typeof value.dateFrom === 'string' ? value.dateFrom : '',
      provider:['all','codex','claude','gemini'].includes(value.provider) ? value.provider : 'all',
      selectedHit:typeof value.selectedHit === 'string' ? value.selectedHit : '',
      hits:Array.isArray(value.hits) ? value.hits.slice(0,120) : null,
    };
  } catch { return {}; }
}

export function saveArchivePresentation(storage, value) {
  try {
    storage.setItem(ARCHIVE_PRESENTATION_KEY,JSON.stringify({...value,version:1,
      // Match the previous history page's persisted search-result bound. Do
      // not persist raw notes/session snapshots as authority for later actions.
      hits:value.hits?.slice(0,120).map(row => ({namespace:row.namespace,id:row.id,...archiveHitPresentation(row)})) ?? null,
    }));
  } catch { /* A full/unavailable UI storage must not prevent archive actions. */ }
}
