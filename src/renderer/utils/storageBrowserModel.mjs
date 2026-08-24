export const STORAGE_SECTIONS = Object.freeze([
  { id: 'sessions', label: 'Sessions' },
  { id: 'builds', label: 'Codex builds' },
  { id: 'app', label: 'Noted Terminal data' },
]);

export const STORAGE_PROVIDER_FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
]);

export const STORAGE_GROUPS = Object.freeze({
  open: {
    label: 'Open now',
    description: 'Sessions open in Noted Terminal, plus physical source files required by an open fork. Never auto-deleted.',
  },
  regular: {
    label: 'Regular sessions',
    description: 'Closed fresh or resumed sessions created by Noted Terminal.',
  },
  fork: {
    label: 'Forks',
    description: 'Closed branches created by an explicit Fork or provider-created child session.',
  },
  rewrite: {
    label: 'Rewinds & edits',
    description: 'Closed full-copy sessions created by Rewind, Edit Range, or Delete Range.',
  },
  subagent: {
    label: 'Subagents',
    description: 'Closed child-agent transcripts. Open parents keep required children protected.',
  },
  outside: {
    label: 'Outside Noted Terminal',
    description: 'Sessions found on disk without an open tab, Home History row, or favorite in this Noted Terminal database.',
  },
  recovery: {
    label: 'Recovery copies',
    description: 'Manual recovery snapshots and failed or abandoned temporary copies.',
  },
  build: {
    label: 'Build files',
    description: 'Regenerable Codex Cargo targets and packaged app output. Installed runtime remains protected.',
  },
  'app-backup': {
    label: 'Database backups',
    description: 'Older Noted Terminal database recovery points. Active databases are always protected.',
  },
  'app-active': {
    label: 'Active databases',
    description: 'Production and development databases currently owned by Noted Terminal.',
  },
  'app-cache': {
    label: 'App caches & images',
    description: 'Chromium caches and prompt images. Their existing owners decide garbage collection.',
  },
});

export const STORAGE_GROUP_ORDER = Object.freeze({
  sessions: ['open', 'regular', 'fork', 'rewrite', 'subagent', 'outside', 'recovery'],
  builds: ['build'],
  app: ['app-backup', 'app-active', 'app-cache'],
});

export const RETENTION_DAY_OPTIONS = Object.freeze([
  { value: 1, label: '1 day' },
  { value: 3, label: '3 days' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: null, label: 'Never' },
]);

export function formatStorageBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[index]}`;
}

export function formatStorageDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(timestamp));
}

export function formatDeleteCountdown(deleteAfter, now = Date.now()) {
  if (deleteAfter == null) return 'kept forever';
  const target = Number(deleteAfter);
  if (!Number.isFinite(target)) return 'kept forever';
  const remaining = target - now;
  if (remaining <= 0) return 'ready to delete';
  const hours = Math.ceil(remaining / (60 * 60 * 1000));
  if (hours < 24) return `deletes in ${hours}h`;
  return `deletes in ${Math.ceil(hours / 24)}d`;
}

export function storageRetentionKey(item) {
  if (item?.section === 'builds') return 'build';
  if (item?.group === 'app-backup') return 'appBackup';
  return item?.group || 'regular';
}

function queryMatches(item, rawQuery) {
  const query = String(rawQuery || '').trim().toLocaleLowerCase();
  if (!query) return true;
  return [item.title, item.sessionId, item.project, item.cwd, item.path, item.forkMode]
    .some((value) => String(value || '').toLocaleLowerCase().includes(query));
}

export function selectStorageItems(items, {
  section = 'sessions',
  provider = 'all',
  group = null,
  query = '',
  sort = 'size',
} = {}) {
  const selected = (Array.isArray(items) ? items : [])
    .filter((item) => item?.section === section)
    .filter((item) => section !== 'sessions' || provider === 'all' || item.provider === provider)
    .filter((item) => !group || item.group === group)
    .filter((item) => queryMatches(item, query));
  selected.sort((a, b) => {
    if (sort === 'date') return Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0) || b.sizeBytes - a.sizeBytes;
    if (sort === 'iterations') return Number(b.iterations ?? -1) - Number(a.iterations ?? -1) || b.sizeBytes - a.sizeBytes;
    return Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0) || Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0);
  });
  return selected;
}

export function summarizeStorageGroups(items, section, provider = 'all') {
  const order = STORAGE_GROUP_ORDER[section] || [];
  const summary = new Map(order.map((group) => [group, { group, items: 0, bytes: 0, eligibleBytes: 0 }]));
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.section !== section) continue;
    if (section === 'sessions' && provider !== 'all' && item.provider !== provider) continue;
    const current = summary.get(item.group) || { group: item.group, items: 0, bytes: 0, eligibleBytes: 0 };
    current.items += 1;
    current.bytes += Number(item.sizeBytes) || 0;
    if (item.eligible) current.eligibleBytes += Number(item.sizeBytes) || 0;
    summary.set(item.group, current);
  }
  return [...summary.values()].filter((group) => group.items > 0);
}
