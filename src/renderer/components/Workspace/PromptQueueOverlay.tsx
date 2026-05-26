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
const HINT_RED = '#ef4444';       // red-500 — first-chip "don't forget to arm" hint
                                  // Previously #d97706 (amber) but that read as
                                  // "orange" and conflicted visually with the
                                  // active Run after state. True red is the
                                  // clearer "needs your attention" signal.
const PANEL_BG = 'rgba(20,20,20,0.92)';
const BORDER = 'rgba(255,255,255,0.08)';
const TEXT_MUTED = '#888';
const TEXT_DIM = '#555';

// Panel sizes itself to its content (`width: 'fit-content'`) but is clamped
// to a sensible range so it never gets pencil-thin on an empty queue and
// never eats half the terminal on a long post-prompt. Toggling button states
// MUST NOT change the panel's measured width — that's enforced inside the
// header row (e.g. the Stop/Close split-button uses a CSS grid to reserve
// the wider of the two labels' widths). PANEL_MIN_WIDTH ≈ the previous
// fixed value so existing layouts don't suddenly shrink.
const PANEL_MIN_WIDTH = 296;
const PANEL_MAX_WIDTH = 420;
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
  const chipLineClamp = useUIStore((s) => s.promptQueueChipLineClamp);
  const queue = usePromptQueueStore((s) => s.queues.get(tabId));
  const items = queue?.items ?? [];
  const autoRun = queue?.autoRun ?? false;
  const stopAfter = queue?.stopAfter ?? false;
  const closeAfter = queue?.closeAfter ?? false;
  const postPromptEnabled = queue?.postPromptEnabled ?? false;
  const postPromptText = queue?.postPromptText ?? '';
  const firstChipArmedHint = queue?.firstChipHintActive ?? false;
  const {
    addPrompt, removePrompt, updatePromptText, reorderPrompt,
    setAutoRun, setStopAfter, setCloseAfter,
    setPostPromptEnabled, setPostPromptText, consumeFirstChipHint,
    // popNext is consumed by hooks/usePromptQueueRunner.ts — not referenced here.
  } = usePromptQueueStore.getState();

  // ─── diagnostic: confirm overlay actually mounts + measure visibility ────
  // Logs once on mount and once on unmount. If gate=SHOWN in QueueGate logs but
  // we see no [Overlay:MOUNT] for the same tab — React did not render the JSX
  // (parent unmount or memo bailout). If we see MOUNT but the panel still does
  // not appear on screen — measure DOM rect on next frame to detect CSS clip /
  // covered by sibling.
  useEffect(() => {
    console.warn('[Overlay:MOUNT] tab=' + tabId.slice(-8) + ' items=' + items.length + ' autoRun=' + autoRun);
    const raf = requestAnimationFrame(() => {
      const el = panelRef.current;
      if (!el) {
        console.warn('[Overlay:MEASURE] tab=' + tabId.slice(-8) + ' panelRef=null (ref not yet bound)');
        return;
      }
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const parentRect = el.offsetParent ? (el.offsetParent as HTMLElement).getBoundingClientRect() : null;
      const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
      console.warn('[Overlay:MEASURE] tab=' + tabId.slice(-8) + ' rect=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' display=' + cs.display + ' visibility=' + cs.visibility + ' opacity=' + cs.opacity + ' zIndex=' + cs.zIndex + ' visible=' + visible + ' parent=' + (parentRect ? Math.round(parentRect.width) + 'x' + Math.round(parentRect.height) : 'null'));
    });
    return () => {
      cancelAnimationFrame(raf);
      console.warn('[Overlay:UNMOUNT] tab=' + tabId.slice(-8));
    };
  }, [tabId]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  // When true, the editor edits the per-tab post-prompt body (not a chip).
  // editingId is ignored in this mode. Save writes via setPostPromptText.
  const [isPostPromptMode, setIsPostPromptMode] = useState(false);
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

  // ─── first-chip blink ────────────────────────────────────────────────────
  // When firstChipArmedHint flips false → true (user added the first chip
  // into an empty queue while Run after was off), we play a short red blink
  // on the Run-after pill to draw the eye. Animation runs TWICE (2 × 0.7s =
  // 1.4s total) and then the hint is auto-consumed — the static red border
  // disappears at the same instant the animation ends, so the pill never
  // shows a frozen "still red but not blinking" state.
  //
  // (Hover still consumes the hint as a fast-path: if the user looks at the
  // pill within the 1.4s window, the blink ends immediately.)
  //
  // We can't put the animation directly on the pill (re-renders would
  // re-start it mid-cycle). Instead, increment a counter every time the
  // hint re-arms — `key={blinkKey}` on the overlay span unmounts/remounts
  // it, giving a fresh animation each time.
  const [blinkKey, setBlinkKey] = useState(0);
  // Keep the blink iteration count + cycle duration as constants so the
  // post-animation auto-consume timer (below) stays in sync if either is
  // tweaked. CSS animation uses `${BLINK_CYCLE_MS}ms ease-in-out
  // ${BLINK_ITERATIONS}` and the timer fires at the exact same instant.
  const BLINK_CYCLE_MS = 700;
  const BLINK_ITERATIONS = 2;
  // Per-chip Replay in-flight flag. Replay roundtrip is ~400-800ms (Ctrl+G grab
  // → helper write → main IPC → paste) and visually silent until the chip
  // disappears — without a per-button spinner the user double-clicks.
  // Set<chipId> instead of single string so multiple parallel replays don't
  // race (queue actions are independent per chip).
  const [replayingIds, setReplayingIds] = useState<Set<string>>(new Set());
  const prevHintRef = useRef(false);
  useEffect(() => {
    if (firstChipArmedHint && !prevHintRef.current) {
      setBlinkKey((k) => k + 1);
      // Schedule auto-consume at the EXACT moment the CSS animation ends.
      // Tight coupling between CSS animation total and JS timer keeps the
      // visual snap clean: blink ends → red state drops in the next frame,
      // no "frozen red" hangover.
      const t = setTimeout(() => {
        consumeFirstChipHint(tabId);
      }, BLINK_CYCLE_MS * BLINK_ITERATIONS);
      prevHintRef.current = firstChipArmedHint;
      return () => clearTimeout(t);
    }
    prevHintRef.current = firstChipArmedHint;
  }, [firstChipArmedHint, tabId, consumeFirstChipHint]);

  // Auto-runner moved to hooks/usePromptQueueRunner.ts — mounted at App root.
  // The runner subscribes to claude:busy-state IPC + queue store globally so
  // queued prompts auto-fire even when the user is on a different tab/project.
  // claudeBusy prop here is still used for the Run pill's pulsing indicator.

  // ─── handlers ────────────────────────────────────────────────────────────
  // Editor open/close UX rule: every trigger that opens the editor is also a
  // toggle. Clicking the SAME trigger a second time closes the editor (rather
  // than reopening identical content). Three triggers — chip body, "+ add"
  // footer button, ✎ post-prompt pencil — each defines its own "is this trigger
  // already active" predicate.
  //
  // Shared helper that closes the slideout and resets the buffer. Used by the
  // toggle paths and by Esc / cancel / × so they share one teardown sequence.
  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditorText('');
    setEditingId(null);
    setIsPostPromptMode(false);
  }, []);

  // Open the editor docked to the LEFT of the queue panel.
  //  - editing existing chip → anchor top to that chip's top
  //  - adding new           → anchor top to the panel header
  // Both align right-edge to the panel's left-edge so the modal feels like a slideout.
  // Toggle: if the editor is already open in the SAME mode/target, close it.
  const openEditor = useCallback((id?: string) => {
    // Toggle-close cases:
    //   id  given  → close when editing the same chip already.
    //   id  absent → close when "new chip" editor is open (no editingId, not post mode).
    if (editorOpen && !isPostPromptMode) {
      if (id && editingId === id) { closeEditor(); return; }
      if (!id && !editingId)      { closeEditor(); return; }
    }
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
    setIsPostPromptMode(false);
    // Same clamp as preview: prevent the editor from being pushed below the
    // viewport when the anchored chip is near the bottom of the queue.
    const margin = 8;
    const maxTop = window.innerHeight - PREVIEW_MAX_HEIGHT - margin;
    anchorTop = Math.max(margin, Math.min(anchorTop, maxTop));
    setEditorAnchor({ top: anchorTop, right: anchorRight });
    setEditorOpen(true);
  }, [items, editorOpen, isPostPromptMode, editingId, closeEditor]);

  // Same slideout pattern as openEditor — but loads the per-tab post-prompt
  // body into the textarea and saves back into the store on commit. Anchored
  // to the panel header (top-right) just like "add new chip".
  //
  // Toggle: second click on ✎ while the post-prompt editor is open closes it.
  //
  // Guard: if a chip-edit (or new-chip) editor is open with unsaved changes,
  // swapping its purpose silently would discard those edits. Confirm before
  // swapping. window.confirm is sufficient — losing 30 chars of draft is a
  // user-correctable annoyance, not a destructive operation worth a modal.
  const openPostPromptEditor = useCallback(() => {
    if (editorOpen && isPostPromptMode) { closeEditor(); return; }
    if (editorOpen && !isPostPromptMode) {
      const originalText = editingId
        ? (items.find((i) => i.id === editingId)?.text ?? '')
        : '';
      if (editorText !== originalText) {
        const ok = window.confirm('Открыт несохранённый промпт — переключиться на пост-промпт и потерять изменения?');
        if (!ok) return;
      }
    }
    const panelRect = panelRef.current?.getBoundingClientRect();
    if (!panelRect) return;
    const anchorRight = window.innerWidth - panelRect.left + 8;
    let anchorTop = panelRect.top;
    const margin = 8;
    const maxTop = window.innerHeight - PREVIEW_MAX_HEIGHT - margin;
    anchorTop = Math.max(margin, Math.min(anchorTop, maxTop));
    setEditorText(postPromptText);
    setEditingId(null);
    setIsPostPromptMode(true);
    setEditorAnchor({ top: anchorTop, right: anchorRight });
    setEditorOpen(true);
  }, [postPromptText, editorOpen, isPostPromptMode, editorText, editingId, items, closeEditor]);

  // Auto-arm was removed — adding a chip no longer flips Run after on.
  // The user is the sole arbiter of when the queue starts firing (one toggle).
  // History: earlier we auto-armed on the first chip ("queued something = wants
  // auto"), but that fought with the new firstDelay countdown which only makes
  // sense when the user explicitly hits Run with delay configured.

  const commitEditor = useCallback(() => {
    if (isPostPromptMode) {
      // Post-prompt: preserve user's exact text (including trailing newlines
      // they may want as a separator) — do NOT trim. Empty body is a valid
      // way to "clear" it; the runner treats empty postPromptText as no-op
      // even if postPromptEnabled is true.
      setPostPromptText(tabId, editorText);
      closeEditor();
      return;
    }
    const t = editorText.trim();
    if (!t) { closeEditor(); return; }
    if (editingId) {
      updatePromptText(tabId, editingId, t);
    } else {
      addPrompt(tabId, t);
    }
    closeEditor();
  }, [editorText, editingId, addPrompt, updatePromptText, tabId, isPostPromptMode, setPostPromptText, closeEditor]);

  // Helper: focus terminal so Ink's render loop stays hot and external-editor flow
  // (clear / grab tempfile re-read) completes in one frame instead of waiting for
  // user to click back into the terminal.
  const focusActiveTerminal = useCallback(() => {
    requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());
  }, [tabId]);

  // Replay handler — paste chip's text into Claude's current input WITHOUT
  // touching stash and WITHOUT submitting. On success the chip is removed
  // from the queue (the prompt has "moved" into Claude's input). On failure
  // chip stays so user can retry.
  const replayChip = useCallback(async (id: string, text: string) => {
    // Guard against double-click while the previous IPC roundtrip is still
    // in flight — second click would queue a second bracketed paste against
    // the same chip, then a second removePrompt against an already-gone id.
    setReplayingIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      const res = await ipcRenderer.invoke('claude:append-input', tabId, text);
      if (!res || !res.success) {
        const err = res?.error || 'unknown';
        showToast('Replay failed: ' + err, 'error');
        console.warn('[PromptQueue] replay failed:', err);
        return;
      }
      // Paste succeeded — chip has effectively moved into Claude input, drop
      // it from the queue so it cannot be double-fired by Run after later.
      removePrompt(tabId, id);
      // Focus terminal so the user sees the appended text immediately + can
      // submit with Enter. Without this, focus might be on the chip button
      // and the user has to click into the terminal first.
      focusActiveTerminal();
    } catch (e: unknown) {
      const m = (e as { message?: string })?.message || String(e);
      showToast('Replay failed: ' + m, 'error');
      console.error('[PromptQueue] replay error', e);
    } finally {
      setReplayingIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [tabId, showToast, focusActiveTerminal, removePrompt]);

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
        addPrompt(tabId, t, res.images || 0, Array.isArray(res.imagePaths) ? res.imagePaths : undefined);
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
          top: 8, right: 8,
          width: 'fit-content',
          minWidth: PANEL_MIN_WIDTH,
          maxWidth: PANEL_MAX_WIDTH,
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
        <div style={{ padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 6, rowGap: 6, borderBottom: `1px solid ${BORDER}`, flexWrap: 'wrap' }}>
          <FirstDelayInput tabId={tabId} autoRun={autoRun} />

          {items.length > 0 && (
            <span style={{ color: TEXT_DIM, fontSize: 10, userSelect: 'none', flexShrink: 0 }}>· {items.length}</span>
          )}

          <span style={{ flex: 1 }} />

          {/* Run-after pill.
              firstChipArmedHint: subtle red glow that appears when user adds
              the FIRST chip into an empty queue while Run after is OFF — visual
              nudge "don't forget to arm me". Cleared on first hover (handled
              by firstChipHintConsumed flag in store) and never re-shown until
              the queue empties again. */}
          <button
            onClick={toggleAutoRun}
            onMouseEnter={() => {
              if (firstChipArmedHint) consumeFirstChipHint(tabId);
            }}
            style={{
              position: 'relative', // anchor for the blink overlay
              padding: '2px 6px',
              background: autoRun ? `${PULSE}26` : (firstChipArmedHint ? `${HINT_RED}26` : 'transparent'),
              border: `1px solid ${autoRun ? PULSE : (firstChipArmedHint ? HINT_RED : BORDER)}`,
              borderRadius: 10,
              color: autoRun ? PULSE : (firstChipArmedHint ? HINT_RED : TEXT_MUTED),
              cursor: 'pointer', fontSize: 9, letterSpacing: 0.3,
              display: 'inline-flex', alignItems: 'center', gap: 4,
              whiteSpace: 'nowrap', flexShrink: 0,
              transition: 'all 0.15s',
              // The static glow that lingers AFTER the 2.5s blink finishes.
              // The blink itself is rendered by the absolute span below — its
              // animation overrides this glow while playing.
              boxShadow: armedFlash
                ? `0 0 6px ${PULSE}`
                : (firstChipArmedHint ? `0 0 6px ${HINT_RED}66` : 'none'),
            }}
          >
            {/* 2.5-second red blink overlay — only mounted while the hint is
                active. `key={blinkKey}` forces a remount on each re-arm so the
                animation starts from frame 0 every time. pointer-events:none
                keeps clicks landing on the button below. */}
            {firstChipArmedHint && (
              <span
                key={blinkKey}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: -1, // cover the border too
                  borderRadius: 10,
                  pointerEvents: 'none',
                  animation: `pq-hint-blink ${BLINK_CYCLE_MS}ms ease-in-out ${BLINK_ITERATIONS}`,
                }}
              />
            )}
            <span
              style={{
                width: 6, height: 6, borderRadius: '50%',
                background: autoRun ? PULSE : (firstChipArmedHint ? HINT_RED : '#555'),
                animation: autoRun && claudeBusy ? 'pq-pulse 1.4s ease-in-out infinite' : 'none',
              }}
            />
            Run after
          </button>

          {/* Stop/Close split-button — TWO independent toggles under one frame:
                Left zone  → stopAfter   (kill Claude after next turn ends).
                Right zone → closeAfter  (also remove the tab from TabBar).
              closeAfter implies stopAfter (you can't close a tab without killing
              its process), so toggling closeAfter ON auto-arms stopAfter in the
              store. Turning stopAfter OFF cascades closeAfter→OFF (no orphan
              "close-but-don't-stop" state).

              Visual states (single button, 4 combinations):
                neither           → grey frame, both zones grey
                stopAfter only    → orange frame, left zone orange-tinted,
                                    right zone stays grey (close not armed)
                closeAfter on     → red frame around BOTH zones, both red,
                                    left label switches to "Close after"
                (closeAfter+!stopAfter is impossible per cascade above)
              */}
          {(() => {
            // Derived colour roles. CLOSE_RED is the destructive accent used
            // both for the right-zone hover and for the full "Close after" state.
            const CLOSE_RED = '#ef4444';
            // ── Seam architecture (vertical line between left and right zones) ──
            // Old impl: left had `borderRight: 'none'`, right drew its own
            // `borderLeft` at BORDER (grey 0.08 alpha). That seam vanished on
            // re-mount because:
            //   (a) 0.08-alpha grey on dark bg + subpixel rounding on retina
            //       compositing → Chromium would discard the 1px draw, even
            //       though logically present. Re-toggling the state forced a
            //       full re-style which redrew it.
            //   (b) `transition: all 0.15s` animated border-color across
            //       tab-switches (overlay stays mounted, only tabId prop
            //       changes) — orange→grey fade over 150ms = the "подёргивание".
            // New impl: LEFT button owns the seam via its OWN `borderRight`
            // (full border, no `none`). Right button skips its left edge
            // (`borderLeft: 'none'`). Result: seam = leftBorder (orange when
            // stop, red when close, grey when idle) — always visible because
            // it's an integer-pixel border-right draw on a known-coloured
            // edge, not a 0.08-alpha grey shim. Plus the seam now reads as
            // "left zone owns it", which matches the visual semantics — the
            // active left zone projects its colour across the seam.
            //
            // Right zone outer borders (top/right/bottom) remain grey when
            // only stopAfter is armed — the right zone is NOT outlined orange,
            // satisfying the earlier constraint that "right power-off doesn't
            // claim stopAfter's colour".
            //
            // No `transition` on border/background here. Tab-switch must NOT
            // animate — instant snap to the new tab's state. Hover effects
            // on the right zone are still instant (JS onMouseEnter/Leave).
            const leftBorder = closeAfter
              ? CLOSE_RED
              : (stopAfter ? TINT : BORDER);
            const leftColor = closeAfter
              ? CLOSE_RED
              : (stopAfter ? TINT : TEXT_MUTED);
            const leftBg = closeAfter
              ? `${CLOSE_RED}26`
              : (stopAfter ? `${TINT}26` : 'transparent');
            // Right zone has its OWN palette — never inherits orange from
            // stopAfter. It is only red when closeAfter is on, grey otherwise.
            const rightBorder = closeAfter ? CLOSE_RED : BORDER;
            const rightColor = closeAfter ? CLOSE_RED : TEXT_MUTED;
            const rightBg = closeAfter ? `${CLOSE_RED}26` : 'transparent';
            return (
              <div style={{ display: 'inline-flex', flexShrink: 0 }}>
                <button
                  onClick={() => setStopAfter(tabId, !stopAfter)}
                  title="Stop Claude after the next turn ends (if queue is empty)"
                  onMouseEnter={(e) => {
                    // Hover policy (per user spec): when zone is INACTIVE,
                    // hover tints ONLY the label colour — no border or bg
                    // changes. When already active, hover is a no-op (the
                    // active state already paints the colour).
                    if (stopAfter || closeAfter) return;
                    (e.currentTarget as HTMLElement).style.color = TINT;
                  }}
                  onMouseLeave={(e) => {
                    if (stopAfter || closeAfter) return;
                    (e.currentTarget as HTMLElement).style.color = TEXT_MUTED;
                  }}
                  style={{
                    padding: '2px 6px',
                    background: leftBg,
                    // FULL border — including the right edge, which IS the
                    // seam between the two zones. This is the entire fix:
                    // the seam is now a single integer-pixel border-right
                    // owned by one element, not a fragile adjacency between
                    // two borders.
                    border: `1px solid ${leftBorder}`,
                    // Round only the left corners — the seam between left
                    // and right buttons stays flat, so visually we still
                    // read as one "split button".
                    borderTopLeftRadius: 10,
                    borderBottomLeftRadius: 10,
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                    color: leftColor,
                    cursor: 'pointer', fontSize: 9, letterSpacing: 0.3,
                    whiteSpace: 'nowrap',
                    // Width-reservation grid: both labels live in the same
                    // cell, the longest defines the column width, only the
                    // active one is visible. Result: clicking the right
                    // zone (which retypes the label) does NOT shift any
                    // pixel in the panel.
                    display: 'inline-grid',
                    gridTemplateColumns: 'auto',
                    alignItems: 'center',
                    justifyItems: 'start',
                  }}
                >
                  <span style={{ gridArea: '1 / 1', visibility: closeAfter ? 'visible' : 'hidden' }}>Close after</span>
                  <span style={{ gridArea: '1 / 1', visibility: closeAfter ? 'hidden' : 'visible' }}>Stop after</span>
                </button>
                <button
                  onClick={() => setCloseAfter(tabId, !closeAfter)}
                  title="Also close this tab after Claude stops"
                  style={{
                    padding: '2px 6px',
                    background: rightBg,
                    // Three-sided border. LEFT edge is intentionally OMITTED —
                    // the seam is owned by the left button's right border
                    // (see the comment block above). Drawing our own
                    // borderLeft here would either double-stroke at the seam
                    // (2px-wide line) or — worse — fight with the left
                    // button's borderRight on subpixel boundaries and one of
                    // the two would silently disappear at certain widths.
                    borderTop: `1px solid ${rightBorder}`,
                    borderRight: `1px solid ${rightBorder}`,
                    borderBottom: `1px solid ${rightBorder}`,
                    borderLeft: 'none',
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    borderTopRightRadius: 10,
                    borderBottomRightRadius: 10,
                    color: rightColor,
                    cursor: 'pointer', lineHeight: 1,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  onMouseEnter={(e) => {
                    // Same policy as the left zone: hover paints ONLY the
                    // icon colour. No bg, no border — those are reserved
                    // for the active-state palette.
                    if (closeAfter) return;
                    (e.currentTarget as HTMLElement).style.color = CLOSE_RED;
                  }}
                  onMouseLeave={(e) => {
                    if (closeAfter) return;
                    (e.currentTarget as HTMLElement).style.color = TEXT_MUTED;
                  }}
                >
                  {/* Power-off icon — minimal Lucide-style stroke SVG. */}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 2v10" />
                    <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
                  </svg>
                </button>
              </div>
            );
          })()}

          {/* Post-prompt split-button: left zone toggles, right zone (✏) opens
              the editor. Active = orange (matches "command attached to every
              send"). Both zones share one rounded border for a single visual
              control. */}
          <div
            style={{
              display: 'inline-flex',
              border: `1px solid ${postPromptEnabled ? TINT : BORDER}`,
              borderRadius: 10,
              overflow: 'hidden',
              flexShrink: 0,
              transition: 'border-color 0.15s',
            }}
          >
            <button
              onClick={() => setPostPromptEnabled(tabId, !postPromptEnabled)}
              title={postPromptText ? 'Post-prompt: ' + (postPromptText.length > 60 ? postPromptText.slice(0, 60) + '…' : postPromptText) : 'Post-prompt is empty — click ✏ to add'}
              style={{
                padding: '2px 6px',
                background: postPromptEnabled ? `${TINT}26` : 'transparent',
                border: 'none',
                color: postPromptEnabled ? TINT : TEXT_MUTED,
                cursor: 'pointer', fontSize: 9, letterSpacing: 0.3,
                display: 'inline-flex', alignItems: 'center', gap: 4,
                whiteSpace: 'nowrap',
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 11, lineHeight: 1 }}>▣</span>
              Post
            </button>
            <button
              onClick={openPostPromptEditor}
              title="Edit post-prompt text"
              style={{
                padding: '2px 6px',
                background: 'transparent',
                border: 'none',
                borderLeft: `1px solid ${postPromptEnabled ? TINT : BORDER}`,
                color: postPromptEnabled ? TINT : TEXT_MUTED,
                cursor: 'pointer', lineHeight: 1,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${TINT}1a`; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              {/* Pencil icon as SVG instead of "✎" U+270E — that glyph has a
                  large descender that gets vertically clipped by the parent
                  header's tight padding in this monospace font. SVG renders
                  at exactly the width/height we ask for, no font-metric
                  surprises. */}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          </div>
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
            // Multi-line mode: show the raw text clipped by CSS line-clamp instead
            // of the 1-line head+tail header. Tail (+N chars) is hidden because
            // overflowed content is already implied by the ellipsis on the last
            // visible line.
            const isMultiLine = chipLineClamp > 1;
            const isEditing = editorOpen && editingId === it.id;
            const isDragOver = dragOverIdx === idx;
            const isDragging = dragId === it.id;
            return (
              <div
                key={it.id}
                ref={(el) => { if (el) chipRefs.current.set(it.id, el); else chipRefs.current.delete(it.id); }}
                draggable
                onDragStart={onDragStart(it.id)}
                onDragOver={onDragOver(idx)}
                onDrop={onDrop(idx)}
                onDragEnd={onDragEnd}
                onClick={(e) => {
                  // Ignore clicks that originated on the replay/remove buttons
                  // (they call stopPropagation themselves, but defensively skip
                  // here too in case event ordering changes). Body click =
                  // open editor.
                  const target = e.target as HTMLElement;
                  if (target.closest('[data-chip-action]')) return;
                  openEditor(it.id);
                }}
                style={{
                  padding: '6px 8px',
                  borderBottom: `1px solid ${BORDER}`,
                  background: isEditing ? `${TINT}1a` : (isDragOver ? `${PULSE}22` : 'transparent'),
                  cursor: isDragging ? 'grabbing' : 'pointer',
                  display: 'flex',
                  // In multi-line mode the auxiliary controls (▶ replay, 📎N, ×)
                  // sit at the top of the chip so the text column can grow downward.
                  alignItems: isMultiLine ? 'flex-start' : 'center',
                  gap: 6,
                  transition: 'background 0.15s',
                  // Prevent native text selection while dragging — the synthetic
                  // selection that appears when the cursor moves over the chip
                  // body during a drag looks broken (blue highlight covers the
                  // chip text). Belt-and-braces: HTML drag should suppress
                  // selection on its own, but Electron + macOS sometimes shows
                  // a stale Safari-ish selection mid-drag.
                  // Chip body is click-as-toggle / drag-as-reorder — never an
                  // editable text region. Disable text selection always so
                  // double-clicks (or rapid clicks) don't highlight characters.
                  userSelect: 'none',
                  WebkitUserSelect: 'none',
                }}
              >
                {/* Replay (▶) — paste chip text into Claude input, no submit.
                    Sits where the ⋮⋮ drag-handle used to. Drag still works
                    from any point on the chip body — HTML5 draggable=true
                    captures the gesture regardless of click target as long
                    as the user holds + moves rather than clicking. */}
                <button
                  data-chip-action="replay"
                  disabled={replayingIds.has(it.id)}
                  onClick={(e) => { e.stopPropagation(); replayChip(it.id, it.text); }}
                  title={replayingIds.has(it.id) ? 'Replay in progress…' : 'Replay: paste into Claude input (no submit)'}
                  style={{
                    background: replayingIds.has(it.id) ? `${TINT}26` : 'transparent',
                    border: 'none',
                    color: replayingIds.has(it.id) ? TINT : TEXT_MUTED,
                    cursor: replayingIds.has(it.id) ? 'default' : 'pointer',
                    padding: 0, lineHeight: 1, fontSize: 10,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 14, height: 14, borderRadius: 3,
                    transition: 'all 0.12s',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    if (replayingIds.has(it.id)) return;
                    (e.currentTarget as HTMLElement).style.background = `${TINT}26`;
                    (e.currentTarget as HTMLElement).style.color = TINT;
                  }}
                  onMouseLeave={(e) => {
                    if (replayingIds.has(it.id)) return;
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                    (e.currentTarget as HTMLElement).style.color = TEXT_MUTED;
                  }}
                >{replayingIds.has(it.id) ? <span className="pq-spinner" /> : '▶'}</button>
                {isMultiLine ? (
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: 11, lineHeight: 1.35,
                    // -webkit-box + line-clamp is the only cross-Electron way
                    // to truncate at N lines with ellipsis. whiteSpace must be
                    // pre-wrap so newlines in the original prompt are preserved.
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical' as const,
                    WebkitLineClamp: chipLineClamp,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>{it.text || '(empty)'}</span>
                ) : (
                  <>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>{head}</span>
                    {tail && <span style={{ color: TEXT_DIM, fontSize: 9 }}>{tail}</span>}
                  </>
                )}
                {it.images > 0 && <span style={{ color: TINT, fontSize: 9 }}>📎{it.images}</span>}
                <button
                  data-chip-action="remove"
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
            <span>
              {isPostPromptMode
                ? 'Post-prompt · добавляется в конец каждого запуска'
                : (editingId ? 'Редактирование' : 'Новый промпт')}
              {' · ⌘↩ сохранить · Esc отмена'}
            </span>
            <button
              onClick={() => closeEditor()}
              style={{ background: 'transparent', border: 'none', color: TEXT_DIM, cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
            >×</button>
          </div>
          <textarea
            autoFocus
            value={editorText}
            onChange={(e) => setEditorText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeEditor()
              if (e.key === 'Enter' && e.metaKey) commitEditor();
            }}
            placeholder={isPostPromptMode
              ? 'Текст пост-промпта… приклеивается через пустую строку к каждому отправленному запросу.'
              : 'Введите или вставьте промпт…'}
            style={{
              flex: 1, minHeight: 180,
              background: '#0e0e0e', color: '#ddd',
              border: 'none', padding: 10,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
              resize: 'none', outline: 'none',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: 8, borderTop: `1px solid ${BORDER}` }}>
            <button onClick={() => closeEditor()} style={{ background: 'transparent', border: `1px solid ${BORDER}`, color: '#aaa', padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>Отмена</button>
            <button onClick={commitEditor} style={{ background: TINT, border: 'none', color: 'white', padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
              {isPostPromptMode ? 'Сохранить' : (editingId ? 'Сохранить' : 'Добавить')}
            </button>
          </div>
        </div>
      )}

      {/* Pulse animation keyframes + hide number-input spinner.
          The spinner adds ~16px to the right of the input which shifted layout
          when the input narrowed under flex pressure (Run/after wrap bug). */}
      <style>{`
        @keyframes pq-pulse {
          0%, 100% { box-shadow: 0 0 0 0 ${PULSE}88; }
          50%      { box-shadow: 0 0 0 6px ${PULSE}00; }
        }
        /* First-chip hint blink: red ring grows outward and fades. The pill
           runs this twice (2 × 700ms = 1.4s total), then a setTimeout in JS
           auto-consumes the hint in the SAME frame — so the static red
           border on the pill never lingers after the animation ends. */
        @keyframes pq-hint-blink {
          0%   { box-shadow: 0 0 0 0    ${HINT_RED}cc; background: ${HINT_RED}33; }
          70%  { box-shadow: 0 0 0 5px  ${HINT_RED}00; background: ${HINT_RED}11; }
          100% { box-shadow: 0 0 0 0    ${HINT_RED}00; background: transparent; }
        }
        .pq-no-spin::-webkit-inner-spin-button,
        .pq-no-spin::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .pq-no-spin {
          -moz-appearance: textfield;
          appearance: textfield;
        }
        /* Replay button spinner — rotating ring shown while claude:append-input
           IPC roundtrip is in flight (~400-800ms). Plain CSS rotation, no GPU
           hit because the SVG is 10×10 — but background-color of the chip body
           does NOT change, so the spinner stays detectable on video forensics. */
        @keyframes pq-spin {
          to { transform: rotate(360deg); }
        }
        .pq-spinner {
          width: 10px; height: 10px; border-radius: 50%;
          border: 1.5px solid currentColor;
          border-right-color: transparent;
          animation: pq-spin 0.7s linear infinite;
          display: inline-block;
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
      className="pq-no-spin"
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
