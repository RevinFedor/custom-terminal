// Volatile side of dictation chips (see dictationChips.mjs for the durable
// text-marker half). Module singleton, same pattern as composerControlsHost:
// the marker lives in the draft TEXT, this registry only remembers what cannot
// be re-derived from it — the label recognised so far, the pending/error
// status, and whether auto-send is armed. Losing this registry (restart) is
// designed to be safe: reconcile() re-adopts orphan markers as `stale`.

import { reconcileDictationEntries } from './dictationChips.mjs';

/** @type {Map<string, {id: string, tabId: string|null, status: 'pending'|'error'|'stale', label: string, autoSend: boolean, error?: string, createdAt: number}>} */
const entries = new Map();

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
    status: 'pending',
    label: String(label || '').trim(),
    autoSend: autoSend === true,
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

export function armDictationChip(chipId, armed = true) {
  const entry = entries.get(String(chipId || ''));
  if (!entry || entry.autoSend === armed) return false;
  entry.autoSend = armed;
  emit();
  return true;
}

/** Arm every pending chip in one tab (Enter pressed while dictation runs). */
export function armDictationChipsForTab(tabId) {
  let changed = false;
  for (const entry of entries.values()) {
    if (entry.tabId === tabId && entry.status === 'pending' && !entry.autoSend) {
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
    if (entry.tabId === tabId && entry.autoSend) {
      entry.autoSend = false;
      changed = true;
    }
  }
  if (changed) emit();
  return changed;
}

export function dropDictationChip(chipId) {
  const removed = entries.delete(String(chipId || ''));
  if (removed) emit();
  return removed;
}

/**
 * Align the registry with one tab's draft text: adopt orphan markers as
 * `stale` retryable chips, drop entries whose marker was deleted, stamp
 * tabId on entries that arrived before the tab was known.
 */
export function reconcileDictationChipsForTab(tabId, text) {
  const mine = Array.from(entries.values()).filter((e) => e.tabId === tabId || e.tabId === null);
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
      entries.set(entry.id, { ...entry, tabId, autoSend: false });
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
  entries.clear();
  deferredSubmits.clear();
  snapshot = { rev: 0, entries: [] };
}
