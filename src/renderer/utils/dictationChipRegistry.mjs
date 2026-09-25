// Volatile side of dictation chips (see dictationChips.mjs for the durable
// text-marker half). Module singleton, same pattern as composerControlsHost:
// the marker lives in the draft TEXT, this registry only remembers what cannot
// be re-derived from it — the label recognised so far, the pending/error
// status, and whether auto-send is armed. Losing this registry (restart) is
// designed to be safe: reconcile() re-adopts orphan markers as `stale`.

import { reconcileDictationEntries } from './dictationChips.mjs';

/** @type {Map<string, {id: string, tabId: string|null, surface: 'history'|'run-after', queueItemId?: string|null, status: 'pending'|'error'|'stale'|'done', label: string, autoSend: boolean, error?: string, createdAt: number, completedAt?: number}>} */
const entries = new Map();
const completionTimers = new Map();

/** tabId -> { text } — a resolved+armed draft whose submit could not be
 * handled right away because no mounted HistoryPanel owned that tab. Fires
 * once on mount IF the draft text is still exactly the same. */
const deferredSubmits = new Map();

const listeners = new Set();
let snapshot = { rev: 0, entries: [] };

function emit() {
  snapshot = { rev: snapshot.rev + 1, entries: Array.from(entries.values()) };
  for (const fn of listeners) fn();
}

export function subscribeDictationChips(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDictationChipsSnapshot() {
  return snapshot;
}

export function beginDictationChip({ id, tabId = null, label = '', autoSend = false }) {
  const chipId = String(id || '').trim();
  if (!chipId) return null;
  const entry = {
    id: chipId,
    tabId,
    surface: 'history',
    queueItemId: null,
    status: 'pending',
    label: String(label || '').trim(),
    autoSend: autoSend === true,
    voiceAutoSend: autoSend === true,
    createdAt: Date.now(),
  };
  entries.set(chipId, entry);
  emit();
  return entry;
}

export function getDictationChip(chipId) {
  return entries.get(String(chipId || '')) || null;
}

export function setDictationChipStatus(chipId, status, { error } = {}) {
  const entry = entries.get(String(chipId || ''));
  if (!entry) return false;
  entry.status = status;
  if (error !== undefined) entry.error = String(error || '');
  emit();
  return true;
}

/** Keep a short presentation-only success beat after the durable marker has
 * resolved. Consumers see one green check, then the volatile entry disappears.
 * Queue/automation never reads this state as work — its text marker is already
 * gone at this point. */
export function completeDictationChip(chipId, { ttlMs = 700 } = {}) {
  const id = String(chipId || '');
  const entry = entries.get(id);
  if (!entry) return false;
  const oldTimer = completionTimers.get(id);
  if (oldTimer) clearTimeout(oldTimer);
  entry.status = 'done';
  entry.autoSend = false;
  entry.completedAt = Date.now();
  emit();
  const timer = setTimeout(() => {
    completionTimers.delete(id);
    if (entries.get(id)?.status === 'done') {
      entries.delete(id);
      emit();
    }
  }, Math.max(100, Math.min(Number(ttlMs) || 700, 950)));
  completionTimers.set(id, timer);
  return true;
}

/**
 * Live tail of a still-committing take: Voice Record streams the END of the
 * recognised text and the chip label follows it in real time. Label-only —
 * the marker in the draft text never changes, so this cannot race an edit.
 * Only a pending chip listens: error/stale labels are frozen evidence.
 */
export function updateDictationChipLabel(chipId, label) {
  const entry = entries.get(String(chipId || ''));
  if (!entry || entry.status !== 'pending') return false;
  const next = String(label || '').trim();
  if (!next || entry.label === next) return false;
  entry.label = next;
  emit();
  return true;
}

export function armDictationChip(chipId, armed = true) {
  const entry = entries.get(String(chipId || ''));
  if (!entry || entry.autoSend === armed) return false;
  entry.autoSend = armed;
  emit();
  return true;
}

/** A click on a pending History chip changes only that take's send intent.
 * null means the marker belongs to another tab/surface or is retryable/done. */
export function togglePendingDictationChipAutoSend(chipId, tabId) {
  const entry = entries.get(String(chipId || ''));
  if (!entry || entry.tabId !== tabId || entry.surface !== 'history' || entry.status !== 'pending') return null;
  entry.autoSend = !entry.autoSend;
  emit();
  return entry.autoSend;
}

/** Voice Record repeats its last choice with the final text. That repeat is
 * not a new user command: it must not undo Enter/Option+1 or manual typing in
 * History since begin. Keep the last remote choice separately from the
 * effective local choice, applying only a changed remote value. */
export function updateDictationChipAutoSendFromVoice(chipId, armed) {
  const entry = entries.get(String(chipId || ''));
  if (!entry || entry.status === 'done' || entry.surface === 'run-after') return false;
  const next = armed === true;
  const previous = entry.voiceAutoSend;
  entry.voiceAutoSend = next;
  // After a restart only the marker survived; a retry's default value cannot
  // override a send intent explicitly chosen in the newly opened composer.
  if (previous === undefined || previous === next) return false;
  const changed = armDictationChip(chipId, next);
  console.log('[DictationChip] voice-auto-send chip=' + chipId
    + ' previous=' + previous + ' remote=' + next + ' armed=' + entry.autoSend);
  return changed;
}

/** Arm every pending chip in one tab (Enter pressed while dictation runs). */
export function armDictationChipsForTab(tabId) {
  let changed = false;
  for (const entry of entries.values()) {
    if (entry.tabId === tabId && entry.surface !== 'run-after'
      && entry.status === 'pending' && !entry.autoSend) {
      entry.autoSend = true;
      changed = true;
    }
  }
  if (changed) emit();
  return changed;
}

/** The user typing in the draft disarms auto-send: the take may resolve at an
 * unpredictable moment and must not submit a half-written thought. */
export function disarmDictationChipsForTab(tabId) {
  let changed = false;
  for (const entry of entries.values()) {
    if (entry.tabId === tabId && entry.surface !== 'run-after' && entry.autoSend) {
      entry.autoSend = false;
      changed = true;
    }
  }
  if (changed) emit();
  return changed;
}

export function dropDictationChip(chipId) {
  const id = String(chipId || '');
  const timer = completionTimers.get(id);
  if (timer) clearTimeout(timer);
  completionTimers.delete(id);
  const removed = entries.delete(id);
  if (removed) emit();
  return removed;
}

/** Move unresolved markers together with the History snapshot that was added
 * to Run After. The queue item becomes the async result owner; History no
 * longer has permission to drop or resolve those entries after clearing its
 * source draft. Auto-send is deliberately disarmed because Run After now owns
 * WHEN this prompt may fire. */
export function moveDictationChipsToRunAfter({ tabId, queueItemId, text }) {
  const itemId = String(queueItemId || '');
  if (!itemId) return [];
  const markerIds = new Set(reconcileDictationEntries(text, []).entries.map((entry) => entry.id));
  const moved = [];
  for (const id of markerIds) {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        id,
        tabId,
        surface: 'run-after',
        queueItemId: itemId,
        status: 'stale',
        label: '',
        autoSend: false,
        createdAt: Date.now(),
      };
      entries.set(id, entry);
    } else if (entry.tabId === tabId || entry.tabId === null) {
      entry.tabId = tabId;
      entry.surface = 'run-after';
      entry.queueItemId = itemId;
      entry.autoSend = false;
    } else {
      continue;
    }
    moved.push(id);
  }
  if (moved.length > 0) emit();
  return moved;
}

export function reconcileDictationChipsForRunAfterItem(tabId, queueItemId, text) {
  const itemId = String(queueItemId || '');
  if (!itemId) return false;
  const present = new Set(reconcileDictationEntries(text, []).entries.map((entry) => entry.id));
  let changed = false;
  for (const entry of Array.from(entries.values())) {
    if (entry.surface !== 'run-after' || entry.tabId !== tabId || entry.queueItemId !== itemId
      || entry.status === 'done') continue;
    if (!present.has(entry.id)) {
      entries.delete(entry.id);
      changed = true;
    }
  }
  for (const id of present) {
    const existing = entries.get(id);
    if (existing) continue;
    entries.set(id, {
      id,
      tabId,
      surface: 'run-after',
      queueItemId: itemId,
      status: 'stale',
      label: '',
      autoSend: false,
      createdAt: Date.now(),
    });
    changed = true;
  }
  if (changed) emit();
  return changed;
}

/**
 * Align the registry with one tab's draft text: adopt orphan markers as
 * `stale` retryable chips, drop entries whose marker was deleted, stamp
 * tabId on entries that arrived before the tab was known.
 */
export function reconcileDictationChipsForTab(tabId, text) {
  const mine = Array.from(entries.values()).filter((e) => e.surface !== 'run-after'
    && e.status !== 'done' && (e.tabId === tabId || e.tabId === null));
  const { entries: next, changed } = reconcileDictationEntries(text, mine);
  const nextIds = new Set(next.map((e) => e.id));
  let mutated = false;
  for (const entry of mine) {
    if (!nextIds.has(entry.id)) {
      // Marker gone from this draft. Only drop if the entry did not migrate
      // to another tab (tabId matches or was unknown).
      if (entry.tabId === tabId || entry.tabId === null) {
        entries.delete(entry.id);
        mutated = true;
      }
    }
  }
  for (const entry of next) {
    const existing = entries.get(entry.id);
    if (!existing) {
      entries.set(entry.id, { ...entry, tabId, surface: 'history', queueItemId: null, autoSend: false });
      mutated = true;
    } else if (existing.tabId !== tabId) {
      existing.tabId = tabId;
      mutated = true;
    }
  }
  if (mutated || changed) emit();
  return mutated || changed;
}

export function listDictationChipsForTab(tabId) {
  return Array.from(entries.values()).filter((e) => e.tabId === tabId);
}

export function listDictationChipsForRunAfterItem(tabId, queueItemId) {
  return Array.from(entries.values()).filter((entry) => entry.tabId === tabId
    && entry.surface === 'run-after' && entry.queueItemId === queueItemId);
}

export function deferDictationSubmit(tabId, text) {
  deferredSubmits.set(tabId, { text: String(text || ''), at: Date.now() });
}

/** One-shot: returns the deferral and forgets it. */
export function takeDeferredDictationSubmit(tabId) {
  const value = deferredSubmits.get(tabId) || null;
  deferredSubmits.delete(tabId);
  return value;
}

// Программная замена маркера текстом не должна читаться как «пользователь
// печатает»: набор текста руками снимает взведённую авто-отправку, а замена
// маркера — нет. Синхронный флаг достаточен: onChange редактора вызывается
// внутри того же dispatch.
let programmaticEdit = false;
export function runProgrammaticDictationEdit(fn) {
  programmaticEdit = true;
  try { return fn(); } finally { programmaticEdit = false; }
}
export function isProgrammaticDictationEdit() {
  return programmaticEdit;
}

/** Test-only teardown. */
export function __resetDictationChips() {
  for (const timer of completionTimers.values()) clearTimeout(timer);
  completionTimers.clear();
  entries.clear();
  deferredSubmits.clear();
  snapshot = { rev: 0, entries: [] };
}
