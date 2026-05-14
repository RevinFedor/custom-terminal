import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { usePromptQueueStore, QueuedPrompt } from '../../store/usePromptQueueStore';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import Tooltip from '../UI/Tooltip';

const { ipcRenderer } = window.require('electron');

// Map main-process error codes from claude:grab-input → user-facing toast strings.
// English for consistency with the button labels.
const GRAB_ERROR_TOASTS: Record<string, string> = {
  no_terminal: 'No terminal for this tab',
  no_claude_session: 'No Claude session running in this tab',
  claude_busy: 'Claude is busy — wait for the response to finish',
  already_in_progress: 'Grab already in progress',
  wrong_editor: 'Restart Claude in this tab — grab needs our editor helper, current $EDITOR is wrong',
  editor_not_wired: 'Helper never reported back — check ~/.claude/hooks/noted-code-grab.js',
  tab_cleared: 'Tab was closed before grab finished',
  timeout: 'Grab timed out',
};

// ─── visual constants ──────────────────────────────────────────────────────
const TINT = '#DA7756';           // Claude orange tint for active states
const PULSE = '#a78bfa';          // purple — armed/waiting auto-run indicator
const PANEL_BG = 'rgba(20,20,20,0.92)';
const BORDER = 'rgba(255,255,255,0.08)';
const TEXT_MUTED = '#888';
const TEXT_DIM = '#555';

const PANEL_WIDTH = 240;
const PREVIEW_WIDTH = 380;
const PREVIEW_MAX_HEIGHT = 420;

// First line of the prompt → chip header. Tail is the rest as +chars indicator.
function chipParts(text: string): { head: string; tail: string } {
  const firstLineEnd = text.indexOf('\n');
  const head = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const restLen = firstLineEnd === -1 ? 0 : (text.length - firstLineEnd - 1);
  const trimmedHead = head.length > 40 ? head.slice(0, 40) + '…' : head;
  return { head: trimmedHead || '(empty)', tail: restLen > 0 ? `+${restLen}` : '' };
}

type Props = {
  tabId: string;
  // Existing per-tab Claude busy state from claude:busy-state. We hold the loader's truth.
  claudeBusy: boolean;
};

export function PromptQueueOverlay({ tabId, claudeBusy }: Props) {
  const queue = usePromptQueueStore((s) => s.queues.get(tabId));
  const items = queue?.items ?? [];
  const autoRun = queue?.autoRun ?? false;
  const stopAfter = queue?.stopAfter ?? false;
  const previewId = queue?.previewId ?? null;
  const {
    addPrompt, removePrompt, updatePromptText, reorderPrompt,
    setAutoRun, setStopAfter, setPreviewId,
    // popNext is consumed by hooks/usePromptQueueRunner.ts — not referenced here.
  } = usePromptQueueStore.getState();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cmdDown, setCmdDown] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [armedFlash, setArmedFlash] = useState(false);
  // Anchor for the editor modal — when set, the modal aligns its right edge to this rect's left edge
  // and its top edge to this rect's top edge. null = anchor to the whole panel's top-right corner.
  const [editorAnchor, setEditorAnchor] = useState<{ top: number; right: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Track ⌘ for the "Cmd-hold opens preview" UX (matches existing pattern in the project)
  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.metaKey) setCmdDown(true); };
    const up = (e: KeyboardEvent) => { if (!e.metaKey) setCmdDown(false); };
    const blur = () => setCmdDown(false);
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', dn);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Toast handle — single getState() at top so both grabCurrent and the auto-runner share it
  // without re-declaring (which TS catches as duplicate identifier).
  const showToast = useUIStore.getState().showToast;

  // Auto-runner moved to hooks/usePromptQueueRunner.ts — mounted at App root.
  // The runner subscribes to claude:busy-state IPC + queue store globally so
  // queued prompts auto-fire even when the user is on a different tab/project.
  // claudeBusy prop here is still used for the Run pill's pulsing indicator.

  // ─── handlers ────────────────────────────────────────────────────────────
  // Open the editor docked to the LEFT of the queue panel.
  //  - editing existing chip → anchor top to that chip's top
  //  - adding new           → anchor top to the panel header
  // Both align right-edge to the panel's left-edge so the modal feels like a slideout.
  const openEditor = useCallback((id?: string) => {
    const panelRect = panelRef.current?.getBoundingClientRect();
    if (!panelRect) return;
    const anchorRight = window.innerWidth - panelRect.left + 8; // 8px gap
    let anchorTop = panelRect.top;
    if (id) {
      const it = items.find((i) => i.id === id);
      if (!it) return;
      const chipRect = chipRefs.current.get(id)?.getBoundingClientRect();
      if (chipRect) anchorTop = chipRect.top;
      setEditorText(it.text);
      setEditingId(id);
    } else {
      setEditorText('');
      setEditingId(null);
    }
    setEditorAnchor({ top: anchorTop, right: anchorRight });
    setEditorOpen(true);
  }, [items]);

  const commitEditor = useCallback(() => {
    const t = editorText.trim();
    if (!t) { setEditorOpen(false); return; }
    if (editingId) updatePromptText(tabId, editingId, t);
    else addPrompt(tabId, t);
    setEditorOpen(false);
    setEditorText('');
    setEditingId(null);
  }, [editorText, editingId, addPrompt, updatePromptText, tabId]);

  // Helper: focus terminal so Ink's render loop stays hot and external-editor flow
  // (clear / grab tempfile re-read) completes in one frame instead of waiting for
  // user to click back into the terminal.
  const focusActiveTerminal = useCallback(() => {
    requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());
  }, [tabId]);

  const grabCurrent = useCallback(async () => {
    try {
      const res = await ipcRenderer.invoke('claude:grab-input', tabId);
      if (res && res.success && typeof res.text === 'string') {
        const t = res.text.trim();
        if (!t) {
          showToast('Claude input is empty', 'warning');
          focusActiveTerminal();
          return;
        }
        addPrompt(tabId, t, res.images || 0);
        const oneLine = t.replace(/\s+/g, ' ').trim();
        const preview = oneLine.length > 20 ? oneLine.slice(0, 20) + '…' : oneLine;
        showToast(`Queued: "${preview}"`, 'success', 1500);
        // Refocus so Claude re-reads the (now empty) tempfile immediately — without
        // this the input visually keeps the old text until user clicks the terminal.
        focusActiveTerminal();
      } else {
        const code = res?.error || 'timeout';
        const msg = GRAB_ERROR_TOASTS[code] || `Grab failed: ${code}`;
        showToast(msg, 'error');
        console.warn('[PromptQueue] grab-input failed:', code);
      }
    } catch (e: unknown) {
      const m = (e as { message?: string })?.message || String(e);
      showToast(`Grab failed: ${m}`, 'error');
      console.error('[PromptQueue] grab-input error', e);
    }
  }, [tabId, addPrompt, showToast, focusActiveTerminal]);

  // Copy moved to InfoPanel — see Copy prompt button next to Copy Session.

  const toggleAutoRun = useCallback(() => {
    const next = !autoRun;
    setAutoRun(tabId, next);
    if (next) {
      setArmedFlash(true);
      setTimeout(() => setArmedFlash(false), 600);
    }
  }, [autoRun, tabId, setAutoRun]);

  // ─── drag-and-drop reorder ───────────────────────────────────────────────
  const onDragStart = (id: string) => (e: React.DragEvent) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragOverIdx !== idx) setDragOverIdx(idx);
  };
  const onDrop = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragId) return;
    const fromIdx = items.findIndex((i) => i.id === dragId);
    if (fromIdx < 0) return;
    reorderPrompt(tabId, fromIdx, idx);
    setDragId(null);
    setDragOverIdx(null);
  };
  const onDragEnd = () => { setDragId(null); setDragOverIdx(null); };

  // ─── preview slideout positioning ────────────────────────────────────────
  const chipRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const previewItem: QueuedPrompt | null = useMemo(
    () => items.find((i) => i.id === previewId) ?? null,
    [items, previewId],
  );
  const previewTop = previewItem ? (chipRefs.current.get(previewItem.id)?.getBoundingClientRect().top ?? 0) : 0;

  // ─── render ──────────────────────────────────────────────────────────────
  return (
    <>
      {/* Main overlay — top-right, absolute over the Claude terminal area */}
      <div
        ref={panelRef}
        style={{
          position: 'absolute',
          top: 8, right: 8, width: PANEL_WIDTH,
          background: PANEL_BG,
          border: `1px solid ${BORDER}`,
          borderRadius: 6,
          backdropFilter: 'blur(8px)',
          zIndex: 50,
          fontSize: 11,
          color: '#ddd',
          maxHeight: 'calc(100% - 16px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header row: title left, two pill toggles right.
            "Run after" — auto-send next queued prompt after each Claude turn ends.
            "Stop after" — SIGTERM claude after the next turn ends (works without queue too).
            Both pills are independent; the dot inside Run pulses while claude is busy. */}
        <div style={{ padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: `1px solid ${BORDER}` }}>
          <span style={{ color: '#ccc', fontSize: 11, fontWeight: 500, flex: 1, userSelect: 'none' }}>
            Очередь {items.length > 0 && <span style={{ color: TEXT_DIM, fontWeight: 400 }}>· {items.length}</span>}
          </span>

          {/* Run-after pill */}
          <Tooltip content={autoRun ? (claudeBusy ? 'Active — queue runs after Claude responds' : 'Active — next prompt sends when Claude is idle') : 'Auto-send queued prompts after each turn'}>
          <button
            onClick={toggleAutoRun}
            style={{
              padding: '2px 6px',
              background: autoRun ? `${PULSE}26` : 'transparent',
              border: `1px solid ${autoRun ? PULSE : BORDER}`,
              borderRadius: 10,
              color: autoRun ? PULSE : TEXT_MUTED,
              cursor: 'pointer', fontSize: 9, letterSpacing: 0.3,
              display: 'inline-flex', alignItems: 'center', gap: 4,
              transition: 'all 0.15s',
              boxShadow: armedFlash ? `0 0 6px ${PULSE}` : 'none',
            }}
          >
            <span
              style={{
                width: 6, height: 6, borderRadius: '50%',
                background: autoRun ? PULSE : '#555',
                animation: autoRun && claudeBusy ? 'pq-pulse 1.4s ease-in-out infinite' : 'none',
              }}
            />
            Run after
          </button>
          </Tooltip>

          {/* Stop-after pill (independent, single-shot) */}
          <Tooltip content={stopAfter ? 'Armed — Claude will be stopped after the next turn ends' : 'Stop Claude after the next response (one-shot)'}>
          <button
            onClick={() => setStopAfter(tabId, !stopAfter)}
            style={{
              padding: '2px 6px',
              background: stopAfter ? `${TINT}26` : 'transparent',
              border: `1px solid ${stopAfter ? TINT : BORDER}`,
              borderRadius: 10,
              color: stopAfter ? TINT : TEXT_MUTED,
              cursor: 'pointer', fontSize: 9, letterSpacing: 0.3,
              display: 'inline-flex', alignItems: 'center', gap: 4,
              transition: 'all 0.15s',
            }}
          >
            <span style={{ fontSize: 11, lineHeight: 1 }}>×</span>
            Stop after
          </button>
          </Tooltip>
        </div>

        {/* Clear-all row — only when queue has items */}
        {items.length > 0 && (
          <div style={{ padding: '2px 8px 4px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'flex-end' }}>
            <Tooltip content="Remove all queued prompts">
            <button
              onClick={() => items.forEach((i) => removePrompt(tabId, i.id))}
              style={{ background: 'transparent', border: 'none', color: TEXT_DIM, cursor: 'pointer', fontSize: 9, padding: 0 }}
            >clear all</button>
            </Tooltip>
          </div>
        )}

        {/* Chip list */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {items.length === 0 && (
            <div style={{ padding: '4px 8px', fontSize: 9, color: TEXT_DIM, textAlign: 'center', lineHeight: 1.2 }}>
              empty
            </div>
          )}
          {items.map((it, idx) => {
            const { head, tail } = chipParts(it.text);
            const isPreview = previewId === it.id;
            const isDragOver = dragOverIdx === idx;
            return (
              <Tooltip key={it.id} content={cmdDown ? 'Клик: редактировать' : 'Клик: превью · ⌘+Клик: редактировать · Drag: переупорядочить'}>
              <div
                ref={(el) => { if (el) chipRefs.current.set(it.id, el); else chipRefs.current.delete(it.id); }}
                draggable
                onDragStart={onDragStart(it.id)}
                onDragOver={onDragOver(idx)}
                onDrop={onDrop(idx)}
                onDragEnd={onDragEnd}
                onClick={() => {
                  if (cmdDown) { openEditor(it.id); return; }
                  setPreviewId(tabId, isPreview ? null : it.id);
                }}
                style={{
                  padding: '6px 8px',
                  borderBottom: `1px solid ${BORDER}`,
                  background: isPreview ? `${TINT}1a` : (isDragOver ? `${PULSE}22` : 'transparent'),
                  cursor: cmdDown ? 'text' : 'grab',
                  display: 'flex', alignItems: 'center', gap: 6,
                  transition: 'background 0.15s',
                }}
              >
                <span style={{ color: TEXT_DIM, fontSize: 9, lineHeight: 1, userSelect: 'none' }}>⋮⋮</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>{head}</span>
                {tail && <span style={{ color: TEXT_DIM, fontSize: 9 }}>{tail}</span>}
                {it.images > 0 && <Tooltip content={`${it.images} image(s) detached`}><span style={{ color: TINT, fontSize: 9 }}>📎{it.images}</span></Tooltip>}
                <Tooltip content="Удалить">
                <button
                  onClick={(e) => { e.stopPropagation(); removePrompt(tabId, it.id); }}
                  style={{ background: 'transparent', border: 'none', color: TEXT_DIM, cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: 12 }}
                >×</button>
                </Tooltip>
              </div>
              </Tooltip>
            );
          })}
        </div>

        {/* Footer — grab + add. "Copy prompt" lives in InfoPanel next to Copy Session
            (single canonical location for clipboard ops, avoids duplicate buttons). */}
        <div style={{ display: 'flex', borderTop: `1px solid ${BORDER}` }}>
          <Tooltip content="Grab the current Claude input into the queue (clears the input)">
          <button
            onClick={grabCurrent}
            style={{ flex: 1, padding: '6px 4px', background: 'transparent', border: 'none', borderRight: `1px solid ${BORDER}`, color: '#aaa', cursor: 'pointer', fontSize: 10 }}
          >+ grab</button>
          </Tooltip>
          <Tooltip content="Open editor for a new prompt">
          <button
            onClick={() => openEditor()}
            style={{ flex: 1, padding: '6px 4px', background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 10 }}
          >+ add</button>
          </Tooltip>
        </div>
      </div>

      {/* Preview slideout — to the LEFT of the panel, top edge aligned with chip top edge */}
      {previewItem && (
        <div
          style={{
            position: 'fixed',
            top: previewTop,
            right: PANEL_WIDTH + 16,
            width: PREVIEW_WIDTH,
            maxHeight: PREVIEW_MAX_HEIGHT,
            background: PANEL_BG,
            border: `1px solid ${BORDER}`,
            borderRadius: 6,
            zIndex: 51,
            backdropFilter: 'blur(8px)',
            fontSize: 12,
            color: '#ddd',
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '6px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${BORDER}` }}>
            <span style={{ color: TEXT_MUTED, fontSize: 10 }}>{previewItem.text.length} chars{previewItem.images ? ` · ${previewItem.images} 📎` : ''}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <Tooltip content="Edit">
              <button
                onClick={() => openEditor(previewItem.id)}
                style={{ background: 'transparent', border: `1px solid ${BORDER}`, color: '#aaa', cursor: 'pointer', fontSize: 10, padding: '2px 6px', borderRadius: 3 }}
              >edit</button>
              </Tooltip>
              <button
                onClick={() => setPreviewId(tabId, null)}
                style={{ background: 'transparent', border: 'none', color: TEXT_DIM, cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
              >×</button>
            </div>
          </div>
          <div style={{ padding: 10, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, lineHeight: 1.5 }}>
            {previewItem.text}
          </div>
        </div>
      )}

      {/* Editor slideout — docked to the LEFT of the queue panel, no scrim.
          Anchored by editorAnchor: top aligned to chip top (edit) or panel top (new). */}
      {editorOpen && editorAnchor && (
        <div
          style={{
            position: 'fixed',
            top: editorAnchor.top,
            right: editorAnchor.right,
            width: PREVIEW_WIDTH,
            maxHeight: PREVIEW_MAX_HEIGHT,
            background: PANEL_BG,
            border: `1px solid ${BORDER}`,
            borderRadius: 6,
            backdropFilter: 'blur(8px)',
            zIndex: 60,
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ padding: '6px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${BORDER}`, fontSize: 10, color: TEXT_MUTED }}>
            <span>{editingId ? 'Редактирование' : 'Новый промпт'} · ⌘↩ сохранить · Esc отмена</span>
            <button
              onClick={() => setEditorOpen(false)}
              style={{ background: 'transparent', border: 'none', color: TEXT_DIM, cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
            >×</button>
          </div>
          <textarea
            autoFocus
            value={editorText}
            onChange={(e) => setEditorText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditorOpen(false);
              if (e.key === 'Enter' && e.metaKey) commitEditor();
            }}
            placeholder="Введите или вставьте промпт…"
            style={{
              flex: 1, minHeight: 180,
              background: '#0e0e0e', color: '#ddd',
              border: 'none', padding: 10,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
              resize: 'none', outline: 'none',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: 8, borderTop: `1px solid ${BORDER}` }}>
            <button onClick={() => setEditorOpen(false)} style={{ background: 'transparent', border: `1px solid ${BORDER}`, color: '#aaa', padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>Отмена</button>
            <button onClick={commitEditor} style={{ background: TINT, border: 'none', color: 'white', padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>{editingId ? 'Сохранить' : 'Добавить'}</button>
          </div>
        </div>
      )}

      {/* Pulse animation keyframes */}
      <style>{`
        @keyframes pq-pulse {
          0%, 100% { box-shadow: 0 0 0 0 ${PULSE}88; }
          50%      { box-shadow: 0 0 0 6px ${PULSE}00; }
        }
      `}</style>
    </>
  );
}
