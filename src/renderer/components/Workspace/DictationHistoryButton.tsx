// Dictation-history popover. No longer a standalone toolbar chip — it is now
// opened by Cmd+click on the bottom-bar mic button (MicButton.tsx). The panel
// renders into a Portal anchored ABOVE the mic button (same rAF-anchoring
// technique as the live FloatingTranscript), so the control bar's
// overflow:hidden ancestors don't clip it.
//
// Each row is one past Soniox transcript; click → copy to clipboard. The mic
// button writes here on every successful Stop (MicButton.tsx onStopped).
// Wires into the global `dictation-history-updated` event so an open popover
// refreshes when a new transcript arrives.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

// Popover panel, controlled by the mic button. Anchored above `anchorRef`.
export function DictationHistoryPopover({ anchorRef, open, onClose }: {
  anchorRef: React.RefObject<HTMLButtonElement>;
  open: boolean;
  onClose: () => void;
}) {
  const showToast = useUIStore((s) => s.showToast);
  const [entries, setEntries] = useState<DictationHistoryEntry[]>(() => loadDictationHistory());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Refresh list + snapshot fresh when (re)opened, and whenever a new entry is
  // written elsewhere.
  useEffect(() => {
    if (open) setEntries(loadDictationHistory());
    const refresh = () => setEntries(loadDictationHistory());
    window.addEventListener('dictation-history-updated', refresh);
    return () => window.removeEventListener('dictation-history-updated', refresh);
  }, [open]);

  // Anchor the panel above the mic button; re-read every rAF so it follows
  // layout shifts (same technique as FloatingTranscript). Opens UP because the
  // control bar sits near the bottom of the window.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    let raf = 0;
    const tick = () => {
      const el = anchorRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const width = 340;
        let left = r.left;
        if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
        if (left < 8) left = 8;
        const bottom = window.innerHeight - r.top + 6;
        setPos((prev) => (prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.bottom - bottom) < 0.5) ? prev : { left, bottom });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, anchorRef]);

  // Click-outside / Esc to close. Geometric hit-test against panel + anchor so
  // a click on the mic button itself (which toggles) doesn't double-fire.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, anchorRef, onClose]);

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

  if (!open || !pos) return null;

  return createPortal(
        <div
          ref={panelRef}
          // Anchored ABOVE the mic button (control bar is near the window
          // bottom). Left-aligned to the button, clamped to viewport.
          style={{
            position: 'fixed',
            left: pos.left,
            bottom: pos.bottom,
            width: 340,
            maxHeight: 380,
            background: '#161616',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
            zIndex: 9999,
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
        </div>,
    document.body
  );
}
