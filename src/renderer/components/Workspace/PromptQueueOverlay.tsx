import { useEffect, useRef, useState, useCallback } from 'react';
import { usePromptQueueStore } from '../../store/usePromptQueueStore';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';

const { ipcRenderer } = window.require('electron');

// Map main-process error codes from claude:grab-input → user-facing toast strings.
// English for consistency with the button labels.
const GRAB_ERROR_TOASTS: Record<string, string> = {
  no_terminal: 'No terminal for this tab',
  no_claude_session: 'No Claude session running in this tab',
  claude_busy: 'Claude is busy — wait for the response to finish',
  already_in_progress: 'Grab already in progress',
  wrong_editor: 'Restart Claude in this tab — grab needs our editor helper, current $EDITOR is wrong',
  stale_pid: 'Claude was restarted outside our control — close & reopen this tab',
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
  const {
    addPrompt, removePrompt, updatePromptText, reorderPrompt,
    setAutoRun, setStopAfter,
    // popNext is consumed by hooks/usePromptQueueRunner.ts — not referenced here.
  } = usePromptQueueStore.getState();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [armedFlash, setArmedFlash] = useState(false);
  // Anchor for the editor modal — when set, the modal aligns its right edge to this rect's left edge
  // and its top edge to this rect's top edge. null = anchor to the whole panel's top-right corner.
  const [editorAnchor, setEditorAnchor] = useState<{ top: number; right: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

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
    // Same clamp as preview: prevent the editor from being pushed below the
    // viewport when the anchored chip is near the bottom of the queue.
    const margin = 8;
    const maxTop = window.innerHeight - PREVIEW_MAX_HEIGHT - margin;
    anchorTop = Math.max(margin, Math.min(anchorTop, maxTop));
    setEditorAnchor({ top: anchorTop, right: anchorRight });
    setEditorOpen(true);
  }, [items]);

  // Auto-arm was removed — adding a chip no longer flips Run after on.
  // The user is the sole arbiter of when the queue starts firing (one toggle).
  // History: earlier we auto-armed on the first chip ("queued something = wants
  // auto"), but that fought with the new firstDelay countdown which only makes
  // sense when the user explicitly hits Run with delay configured.

  const commitEditor = useCallback(() => {
    const t = editorText.trim();
    if (!t) { setEditorOpen(false); return; }
    if (editingId) {
      updatePromptText(tabId, editingId, t);
    } else {
      addPrompt(tabId, t);
    }
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

  // Toggle Run-after. If user disarms while a first-delay countdown is running,
  // freeze the remaining seconds back into firstDelaySeconds via the store so
  // the input shows "what's left" (not the original value).
  const toggleAutoRun = useCallback(() => {
    const next = !autoRun;
    const q = usePromptQueueStore.getState().getQueue(tabId);
    if (!next && q.firstDelayCountdownAt !== null) {
      usePromptQueueStore.getState().cancelFirstDelayCountdown(tabId);
    }
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

  // chipRefs is still used: openEditor() needs each chip's top coordinate to
  // anchor the editor slideout next to the clicked chip.
  const chipRefs = useRef<Map<string, HTMLDivElement>>(new Map());

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
        {/* Header row: first-delay timer input on left, Run/Stop pills on right.
            The title "Очередь" was removed — context is obvious from the panel.
            Timer input doubles as a countdown display when armed:
              idle  → shows configured firstDelaySeconds, editable.
              armed → shows live remaining seconds, read-only.
            "Run after" toggles autoRun. Arming with delay > 0 starts the countdown.
            Disarming mid-countdown freezes the remaining seconds back into the input.
            "Stop after" — SIGTERM claude after the next turn ends (independent). */}
        <div style={{ padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: `1px solid ${BORDER}` }}>
          <FirstDelayInput tabId={tabId} autoRun={autoRun} />

          {items.length > 0 && (
            <span style={{ color: TEXT_DIM, fontSize: 10, userSelect: 'none' }}>· {items.length}</span>
          )}

          <span style={{ flex: 1 }} />

          {/* Run-after pill */}
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

          {/* Stop-after pill (independent, single-shot) */}
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
        </div>

        {/* Clear-all row — only when queue has items */}
        {items.length > 0 && (
          <div style={{ padding: '2px 8px 4px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => items.forEach((i) => removePrompt(tabId, i.id))}
              style={{ background: 'transparent', border: 'none', color: TEXT_DIM, cursor: 'pointer', fontSize: 9, padding: 0 }}
            >clear all</button>
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
            const isEditing = editorOpen && editingId === it.id;
            const isDragOver = dragOverIdx === idx;
            return (
              <div
                key={it.id}
                ref={(el) => { if (el) chipRefs.current.set(it.id, el); else chipRefs.current.delete(it.id); }}
                draggable
                onDragStart={onDragStart(it.id)}
                onDragOver={onDragOver(idx)}
                onDrop={onDrop(idx)}
                onDragEnd={onDragEnd}
                onClick={() => openEditor(it.id)}
                style={{
                  padding: '6px 8px',
                  borderBottom: `1px solid ${BORDER}`,
                  background: isEditing ? `${TINT}1a` : (isDragOver ? `${PULSE}22` : 'transparent'),
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                  transition: 'background 0.15s',
                }}
              >
                <span style={{ color: TEXT_DIM, fontSize: 9, lineHeight: 1, userSelect: 'none' }}>⋮⋮</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>{head}</span>
                {tail && <span style={{ color: TEXT_DIM, fontSize: 9 }}>{tail}</span>}
                {it.images > 0 && <span style={{ color: TINT, fontSize: 9 }}>📎{it.images}</span>}
                <button
                  onClick={(e) => { e.stopPropagation(); removePrompt(tabId, it.id); }}
                  style={{ background: 'transparent', border: 'none', color: TEXT_DIM, cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: 12 }}
                >×</button>
              </div>
            );
          })}
        </div>

        {/* Footer — grab + add. "Copy prompt" lives in InfoPanel next to Copy Session
            (single canonical location for clipboard ops, avoids duplicate buttons). */}
        <div style={{ display: 'flex', borderTop: `1px solid ${BORDER}` }}>
          <button
            onClick={grabCurrent}
            style={{ flex: 1, padding: '6px 4px', background: 'transparent', border: 'none', borderRight: `1px solid ${BORDER}`, color: '#aaa', cursor: 'pointer', fontSize: 10 }}
          >+ grab</button>
          <button
            onClick={() => openEditor()}
            style={{ flex: 1, padding: '6px 4px', background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 10 }}
          >+ add</button>
        </div>
      </div>

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

// ─── FirstDelayInput ────────────────────────────────────────────────────────
// Replaces the old "Очередь" header text. Two modes driven by store state:
//   idle      — number input with placeholder "сек", user types desired delay.
//   counting  — read-only countdown display ticking from N → 0 once per second.
// When countdown reaches 0 the runner pops + fires (we just stop ticking here).
// Disarming Run while counting freezes "what's left" back into firstDelaySeconds
// — that bookkeeping happens in the store, this component just re-reads it.
type FirstDelayInputProps = { tabId: string; autoRun: boolean };
function FirstDelayInput({ tabId, autoRun }: FirstDelayInputProps) {
  const cfg = usePromptQueueStore((s) => s.queues.get(tabId)?.firstDelaySeconds ?? 0);
  const countdownAt = usePromptQueueStore((s) => s.queues.get(tabId)?.firstDelayCountdownAt ?? null);
  const setFirstDelaySeconds = usePromptQueueStore((s) => s.setFirstDelaySeconds);
  const [text, setText] = useState<string>(cfg === 0 ? '' : String(cfg));

  // External writes (countdown finished, cancel-edit, etc) → mirror into local
  // input only when we're NOT counting (counting mode renders from `remaining`).
  useEffect(() => {
    if (countdownAt !== null) return;
    setText(cfg === 0 ? '' : String(cfg));
  }, [cfg, countdownAt]);

  // Tick once per second while counting. State is fully derivable from store
  // (firstDelaySeconds + firstDelayCountdownAt), no local timer state needed.
  const [, force] = useState(0);
  useEffect(() => {
    if (countdownAt === null) return;
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [countdownAt]);

  const remaining = countdownAt !== null
    ? Math.max(0, cfg - Math.floor((Date.now() - countdownAt) / 1000))
    : null;

  // Counting display — read-only, monochrome to fit the dark panel.
  if (remaining !== null) {
    return (
      <span
        style={{
          width: 56,
          padding: '2px 6px',
          background: 'transparent',
          border: `1px solid ${PULSE}`,
          borderRadius: 4,
          color: PULSE,
          fontSize: 11,
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'center',
          userSelect: 'none',
        }}
        title="Countdown to first prompt — toggle Run after to cancel"
      >
        {remaining}s
      </span>
    );
  }

  // Editable input — number, "сек" placeholder, theme-matched dark.
  // Disabled while autoRun is on but countdown hasn't started yet (delay=0
  // immediate-fire path) — kept readable, just locked out so the user doesn't
  // race the runner with a mid-arm edit.
  const disabled = autoRun;
  return (
    <input
      type="number"
      min={0}
      max={3600}
      value={text}
      placeholder="сек"
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text);
        if (!Number.isFinite(n) || n < 0) {
          setText(cfg === 0 ? '' : String(cfg));
          return;
        }
        const clamped = Math.max(0, Math.min(3600, Math.floor(n)));
        setFirstDelaySeconds(tabId, clamped);
        setText(clamped === 0 ? '' : String(clamped));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(cfg === 0 ? '' : String(cfg));
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{
        width: 56,
        padding: '2px 6px',
        background: '#1a1a1a',
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        color: disabled ? TEXT_DIM : '#ddd',
        fontSize: 11,
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'center',
        outline: 'none',
        cursor: disabled ? 'not-allowed' : 'text',
      }}
    />
  );
}
