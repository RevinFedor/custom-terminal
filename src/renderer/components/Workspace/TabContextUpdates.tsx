import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, Check, RefreshCw, X } from 'lucide-react';
import { ComposerChip } from '@noted/claude-blocks';
import { buildPromptChipWrapper } from '../../utils/composerChips.mjs';
import { useUIStore } from '../../store/useUIStore';
import {
  dismissTabContextUpdate, TabContextUpdate, WORK_CONTEXT_COLOR,
} from '../../utils/tabWorkContext';

export function TabContextUpdateChip({ tabId, update }: { tabId: string; update: TabContextUpdate }) {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  useEffect(() => {
    if (!open) return;
    setRect(anchor.current?.getBoundingClientRect() || null);
    const outside = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside, true);
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', outside, true); window.removeEventListener('resize', close); };
  }, [open]);
  const dismiss = async () => {
    if (!armed) { setArmed(true); setOpen(false); return; }
    setBusy(true);
    try { await dismissTabContextUpdate(tabId, update.id); }
    catch (error: any) { useUIStore.getState().showToast(error.message, 'error'); }
    finally { setBusy(false); setArmed(false); }
  };
  return <>
    <span ref={anchor} className="hp-context-update-chip-slot" style={{ position: 'relative', display: 'inline-flex' }}
      onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); void dismiss(); } }}
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
      onKeyDown={(event) => { if (event.key === 'Escape') { setArmed(false); setOpen(false); } }}>
      <ComposerChip kind="prompt" label={update.title} leading={<RefreshCw size={12} />}
        title={update.path || 'Обновление рабочего состояния'}
        style={{ color: WORK_CONTEXT_COLOR, borderColor: '#8d612c', background: '#2c2419', opacity: armed ? 0.16 : 1, transition: 'opacity 120ms ease' }}
        onClick={() => setOpen((value) => !value)}
        trailing={<>
          <button type="button" className="hp-composer-chip-action" title="Перенести в input" aria-label="Перенести обновление в input"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              const store = useUIStore.getState();
              const draft = store.historyPromptDrafts[tabId] || '';
              const wrapper = buildPromptChipWrapper({ label: update.title, text: update.text, contextUpdateId: update.id });
              if (!draft.includes('context-update-id="' + update.id + '"')) {
                store.setHistoryPromptDraft(tabId, [draft, wrapper].filter(Boolean).join('\n\n'), { preserveChips: true, preserveImages: true });
              }
              setOpen(false);
            }}><ArrowDownToLine size={11} /></button>
          <button type="button" className="hp-composer-chip-action hp-composer-chip-action-danger" title="Убрать обновление" aria-label="Убрать обновление"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => { event.stopPropagation(); void dismiss(); }}><X size={11} /></button>
        </>} />
      {armed && <button type="button" disabled={busy} aria-label="Подтвердить удаление обновления"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => { event.stopPropagation(); void dismiss(); }}
        style={{ position: 'absolute', inset: 0, border: '1px solid #ad7939', borderRadius: 4, background: '#2c2419e6', color: WORK_CONTEXT_COLOR, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, font: 'inherit' }}>
        <Check size={12} /> Sure?
      </button>}
    </span>
    {open && rect && createPortal(<div ref={popover} role="dialog" aria-label={update.title}
      style={{ position: 'fixed', zIndex: 30000,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(600, window.innerWidth - 16) - 8)),
        top: rect.top < 180 ? rect.bottom + 6 : undefined,
        bottom: rect.top >= 180 ? window.innerHeight - rect.top + 6 : undefined,
        width: 'min(600px, calc(100vw - 16px))', boxSizing: 'border-box',
        maxHeight: Math.max(60, Math.min(window.innerHeight * 0.55, rect.top >= 180 ? rect.top - 16 : window.innerHeight - rect.bottom - 16)),
        overflow: 'auto', background: '#191919', color: '#ddd', border: '1px solid #8d612c',
        borderRadius: 5, padding: 12, boxShadow: '0 6px 25px #0008' }}>
      <div style={{ color: WORK_CONTEXT_COLOR, marginBottom: 8 }}>{update.title}</div>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, lineHeight: 1.5, margin: 0 }}>{update.text}</pre>
    </div>, document.body)}
  </>;
}
