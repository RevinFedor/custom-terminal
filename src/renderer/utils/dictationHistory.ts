// LocalStorage-backed dictation history. Each entry is an immutable transcript
// the user captured via the mic; the toolbar dropdown lets them copy any past
// entry to the clipboard. Cap at 100 entries to bound storage growth.

export interface DictationHistoryEntry {
  id: string;
  text: string;
  createdAt: number;  // ms epoch
}

const KEY = 'noted-terminal-dictation-history';
const MAX_ENTRIES = 100;

export function loadDictationHistory(): DictationHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(e => e && typeof e.text === 'string' && typeof e.createdAt === 'number');
  } catch { return []; }
}

export function appendDictationEntry(text: string): DictationHistoryEntry | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const entry: DictationHistoryEntry = {
    id: 'd-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: trimmed,
    createdAt: Date.now(),
  };
  const list = [entry, ...loadDictationHistory()].slice(0, MAX_ENTRIES);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
  // Fire a dom event so any open dropdown can refresh without prop-drilling.
  try { window.dispatchEvent(new CustomEvent('dictation-history-updated')); } catch {}
  return entry;
}

export function clearDictationHistory(): void {
  try { localStorage.removeItem(KEY); } catch {}
  try { window.dispatchEvent(new CustomEvent('dictation-history-updated')); } catch {}
}
