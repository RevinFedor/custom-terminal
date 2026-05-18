// Dictation-history dropdown for the project toolbar. Lives next to
// CopySessionWithChips and mimics its visual style — a small rounded chip
// that opens a popover with the list of past Soniox transcripts. Each row
// is one entry; click → copy to clipboard. The mic button writes here on
// every successful Stop (see MicButton.tsx onStopped handler).
//
// Wires into the global `dictation-history-updated` event so the open
// dropdown refreshes when a new transcript arrives without us prop-drilling
// state down from MicButton.

import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import {
  DictationHistoryEntry,
  loadDictationHistory,
  clearDictationHistory,
} from '../../utils/dictationHistory';

// Electron clipboard (main process) — navigator.clipboard rejects without
// active document focus / on cross-origin frames, gives "permission denied"
// in renderer. The Electron clipboard always works (CLAUDE.md anti-pattern).
const { clipboard } = (window as any).require('electron');

function formatTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sameDay = (() => {
    const now = new Date();
    return now.getFullYear() === d.getFullYear()
      && now.getMonth() === d.getMonth()
      && now.getDate() === d.getDate();
  })();
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function DictationHistoryButton() {
  const showToast = useUIStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DictationHistoryEntry[]>(() => loadDictationHistory());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Refresh when MicButton (or anything else) writes a new entry.
  useEffect(() => {
    const refresh = () => setEntries(loadDictationHistory());
    window.addEventListener('dictation-history-updated', refresh);
    return () => window.removeEventListener('dictation-history-updated', refresh);
  }, []);

  // Click-outside / Esc to close. Geometric hit-test rather than onMouseLeave
  // (per project pattern — onMouseLeave on lazy-mounted popover is unreliable).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const copyEntry = (entry: DictationHistoryEntry) => {
    try {
      clipboard.writeText(entry.text);
      setCopiedId(entry.id);
      showToast('Dictation copied', 'success', 1200);
      setTimeout(() => setCopiedId(null), 1000);
    } catch (e: any) {
      showToast('Copy failed: ' + (e?.message || e), 'error');
    }
  };

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={entries.length ? `Dictation history (${entries.length})` : 'Dictation history (empty)'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 26,
          padding: '0 8px',
          background: open ? 'rgba(218,119,86,0.12)' : 'transparent',
          color: open ? '#FF9466' : '#bbb',
          border: `1px solid ${open ? 'rgba(218,119,86,0.45)' : 'rgba(255,255,255,0.12)'}`,
          borderRadius: 4,
          fontSize: 11,
          cursor: 'pointer',
          transition: 'background-color 0.12s, color 0.12s, border-color 0.12s',
        }}
        onMouseEnter={(e) => {
          if (open) return;
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
          (e.currentTarget as HTMLButtonElement).style.color = '#fff';
        }}
        onMouseLeave={(e) => {
          if (open) return;
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          (e.currentTarget as HTMLButtonElement).style.color = '#bbb';
        }}
      >
        <Clock size={13} />
        <span>history</span>
        {entries.length > 0 && (
          <span style={{
            fontSize: 10,
            color: '#888',
            fontVariantNumeric: 'tabular-nums',
          }}>{entries.length}</span>
        )}
      </button>

      {open && (
        <div
          // Opens DOWN (project toolbar lives at the top), right-anchored so it
          // doesn't clip the viewport. 320 px wide — enough for ~50 chars of
          // transcript preview at 12 px font.
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            width: 340,
            maxHeight: 380,
            background: '#161616',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 10px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            fontSize: 11,
            color: '#aaa',
          }}>
            <span>Dictation history</span>
            {entries.length > 0 && (
              <button
                onClick={() => {
                  if (confirm('Clear all dictation history?')) {
                    clearDictationHistory();
                    setEntries([]);
                  }
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#888',
                  fontSize: 10,
                  cursor: 'pointer',
                  padding: 0,
                  textDecoration: 'underline',
                }}
              >clear</button>
            )}
          </div>
          <div style={{ overflowY: 'auto', maxHeight: 340 }}>
            {entries.length === 0 ? (
              <div style={{
                padding: '24px 12px',
                color: '#666',
                fontSize: 12,
                textAlign: 'center',
              }}>
                No dictation captured yet. Press the mic in the bottom bar to start.
              </div>
            ) : entries.map((entry, idx) => {
              const hovered = hoverIdx === idx;
              const copied = copiedId === entry.id;
              return (
                <button
                  key={entry.id}
                  onMouseEnter={() => setHoverIdx(idx)}
                  onMouseLeave={() => setHoverIdx(prev => prev === idx ? null : prev)}
                  onClick={() => copyEntry(entry)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    border: 'none',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    background: hovered ? 'rgba(218,119,86,0.08)' : 'transparent',
                    color: '#ddd',
                    cursor: 'pointer',
                    fontSize: 12,
                    lineHeight: 1.4,
                    transition: 'background-color 0.12s',
                  }}
                  title="Click to copy"
                >
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 2,
                  }}>
                    <span style={{
                      fontSize: 10,
                      color: copied ? '#4ade80' : '#888',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {copied ? '✓ copied' : formatTime(entry.createdAt)}
                    </span>
                    <span style={{ fontSize: 10, color: '#666' }}>
                      {entry.text.length} chars
                    </span>
                  </div>
                  <div style={{
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {entry.text}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
