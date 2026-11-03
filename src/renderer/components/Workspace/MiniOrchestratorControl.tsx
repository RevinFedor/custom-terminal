import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Bot, CircleAlert, CircleHelp, Clock3, X } from 'lucide-react';
import { PANE_LAYER_PRESENTATION_EVENT } from '../../utils/paneLayerPresentation.mjs';
import { HistoryTranscriptPresentation, type HistoryTranscriptStep } from './HistoryTranscriptPresentation';
import { GEMINI_MODEL_OPTIONS, legacyGeminiModelLabel } from '../../constants/geminiModels';
import { useUIStore } from '../../store/useUIStore';
import { usePointerGesture } from '../../hooks/usePointerGesture';
import { fitMiniPanel, resizeMiniPanel, moveMiniPanel, createMiniPanelPersistence } from '../../utils/miniOrchestratorGeometry.mjs';
import { historyResponseTailLabel } from '../../utils/historyResponseTiming.mjs';
import { ComposerChip, ConversationMessage } from '@noted/claude-blocks';
import PastedContentPreview from './AIConversation/PastedContentPreview';
import { jumpToTerminalMessageTarget } from '../../utils/tabMessageSourceJump';
import { miniReviewTarget, navigateMiniReview } from '../../utils/miniOrchestratorGeometry.mjs';
import { RunAfterTabPicker } from './RunAfterTabPicker';
import './MiniOrchestratorControl.css';

const { ipcRenderer } = window.require('electron');
// Edge-row palette, matched to the Post/Loop split buttons this control sits
// beside in PromptQueueOverlay so the row reads as one band.
const BORDER_MUTED = 'rgba(255,255,255,.08)';
const PANEL_BG_MUTED = 'rgba(20,20,20,.92)';
const CARD_WIDTH = 268;
type ReviewMeta = { model: string; requestedModel?: string; modelSource?: 'request' | 'response'; thinkingLevel: string; startedAt: number; finishedAt: number; durationMs: number };
type ReviewSource = { provider: string; sessionId: string; generation: string; turnId: string; answerId: string; jobId: string; requestIds: string[]; navigationRequestId?: string; archived?: boolean; verificationNotes?: string[] };
type Entry = { id: string; type: 'instruction' | 'request' | 'answer' | 'review' | 'tool' | 'notice'; text: string; name?: string; filePath?: string; promptRevision?: string | number; status?: string; reviewMeta?: ReviewMeta; receipt?: { status?: string; handoffId?: string; operationKey?: string; attemptId?: string; error?: string; sessionId?: string; turnId?: string; requestCount?: number }; round?: number };
export type MiniSnapshot = { tabId: string; enabled: boolean; revision: number; viewRevision?: number; phase: 'off' | 'idle' | 'collecting' | 'reviewing' | 'sending' | 'complete' | 'error' | 'unknown'; jobId?: string; error?: string; entries: Entry[];
  autoReturn?: boolean; correctionState?: 'no-progress';
  activeReview?: { model: string; thinkingLevel: string; startedAt: number };
  reviewSource?: ReviewSource;
  roundSources?: Record<string, ReviewSource>;
  forward?: { reviewerTabId: string; reviewerName: string; reviewerAvailable: boolean; instructionCustom: boolean; revision: string };
  settings?: { model?: string; thinkingLevel?: string; revision?: string; thinkingLevels?: string[]; error?: string } };

/** Entries carry a round number once a turn completes; older presentation
 * snapshots have none, so they are a single implicit round. */
export function miniEntriesByRound(entries: Entry[]): Array<{ round: number | undefined; entries: Entry[] }> {
  const order: Array<number | undefined> = [];
  const byRound = new Map<number | undefined, Entry[]>();
  for (const entry of entries) {
    if (!byRound.has(entry.round)) { byRound.set(entry.round, []); order.push(entry.round); }
    byRound.get(entry.round)!.push(entry);
  }
  return order.map(round => ({ round, entries: byRound.get(round)! }));
}

const bounded = (value: unknown) => typeof value === 'string' ? value.slice(0, 240) : '';
export function miniEntriesToSteps(entries: Entry[]): HistoryTranscriptStep[] {
  // Input attachments are rendered ONCE by MiniReviewInput. Source answer and
  // internal lifecycle notices are never Gemini-authored messages.
  return entries.filter(entry => entry.type === 'review' || entry.type === 'tool').map((entry) => {
    if (entry.type === 'tool') {
      if (entry.name === 'read_review_iteration') return { id: entry.id, kind: 'tool',
        tool: 'read_review_iteration', family: 'read',
        args: { sessionId: bounded(entry.receipt?.sessionId), turnId: bounded(entry.receipt?.turnId) },
        result: entry.status === 'read' ? 'Прочитан закреплённый снимок итерации · только чтение' : undefined };
      const receipt = entry.receipt;
      const result = [bounded(receipt?.status || entry.status), receipt?.handoffId && `handoff: ${bounded(receipt.handoffId)}`, receipt?.operationKey && `operation: ${bounded(receipt.operationKey)}`, receipt?.attemptId && `attempt: ${bounded(receipt.attemptId)}`, receipt?.error && `error: ${bounded(receipt.error)}`].filter(Boolean).join(' · ');
      return { id: entry.id, kind: 'tool', text: entry.text, tool: 'mcp__terminal__send_prompt',
        family: 'mcp', mcpServer: 'terminal', mcpMethod: 'send_prompt', args: { prompt: entry.text },
        result: entry.status === 'sending' ? undefined : result || undefined };
    }
    const meta = entry.reviewMeta;
    return { id: entry.id, kind: 'message', role: 'assistant', text: entry.text,
      ...(meta ? { footerText: `${historyResponseTailLabel({ state: 'completed', durationMs: meta.durationMs })} / ${meta.model} / ${meta.thinkingLevel === 'NONE' ? 'auto' : meta.thinkingLevel.toLowerCase()}`,
        footerTitle: `${meta.modelSource === 'response' ? 'Модель из ответа API' : 'Модель запроса'}; thinking — параметр запроса. ${new Date(meta.finishedAt).toLocaleString()}` } : {}) };
  });
}

export function MiniReviewInput({ entries, source, tabId, onCopy, preview, setPreview, onNavigated }: { entries: Entry[]; source?: ReviewSource; tabId: string; onCopy?: (text: string) => void; preview: boolean; setPreview: (open: boolean) => void; onNavigated?: () => void }) {
  const instruction = entries.find(entry => entry.type === 'instruction');
  const target = miniReviewTarget(tabId, source);
  return <>
    <MiniReviewInputContent entries={entries} source={source} onInstruction={() => setPreview(true)} onIteration={() => {
      void navigateMiniReview(target, value => jumpToTerminalMessageTarget(value, 'mini:' + value.messageId.slice(0, 96)), onNavigated,
        () => useUIStore.getState().showToast(target ? 'Не удалось показать итерацию в History' : 'Точная ссылка на итерацию недоступна', 'warning'));
    }} />
    {preview && instruction && createPortal(<div data-mini-instruction-preview data-run-after-satellite="true" onMouseDown={event => { event.stopPropagation(); setPreview(false); }}
      onClick={event => event.stopPropagation()} style={{ position: 'fixed', zIndex: 120, inset: 0, display: 'grid', placeItems: 'center' }}>
      <div onMouseDown={event => event.stopPropagation()} style={{ width: 'min(600px, calc(100vw - 32px))' }}>
        <PastedContentPreview text={instruction.text} onCopy={onCopy} onClose={() => setPreview(false)} maxHeight="min(60vh, 500px)" />
      </div>
    </div>, document.body)}
  </>;
}

export function MiniReviewInputContent({ entries, source, onInstruction, onIteration }: {
  entries: Entry[]; source?: ReviewSource;
  onInstruction: () => void; onIteration: () => void;
}) {
  const instruction = entries.find(entry => entry.type === 'instruction');
  const requests = entries.filter(entry => entry.type === 'request');
  const answer = entries.find(entry => entry.type === 'answer');
  if (!instruction || !requests.length || !answer) return null;
  const revision = String(instruction.promptRevision || '?'), version = revision.split(':').at(-1)!.slice(0, 6);
  const title = source ? [source.archived && 'Архив headless-проверки', `${source.provider} · session ${source.sessionId}`, `turn ${source.turnId}`].filter(Boolean).join('\n') : 'Исторический снимок: точные source IDs не записаны';
  return <ConversationMessage layout="user" entryUuid={source?.jobId} contentClassName="mini-review-input">
    <div className="mini-review-input-chips" data-mini-review-input>
      <ComposerChip kind="prompt" label="Инструкция" meta={`v${version}`} title={[instruction.name, instruction.filePath, revision].filter(Boolean).join('\n')}
        onClick={onInstruction} />
      <ComposerChip kind="paste" className="mini-review-iteration-chip" label="Итерация" meta={source?.turnId.slice(0, 8) || '—'}
        title={title} onClick={onIteration} />
    </div>
  </ConversationMessage>;
}

export function useMiniOrchestrator(tabId: string, active: boolean) {
  const [snapshot, setSnapshot] = useState<MiniSnapshot | null>(null);
  const [error, setError] = useState('');
  const [requestedForTab, setRequestedForTab] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const settingsPendingRef = useRef(false);
  const actionPending = useRef(false);
  const owner = useRef({ tabId, revision: -1 });
  // Invalidate old replies synchronously when React changes the owner.
  if (owner.current.tabId !== tabId) owner.current = { tabId, revision: -1 };
  useEffect(() => {
    // Default OFF adds no per-retained-tab startup IPC/subscription. Resolve
    // this small role only after the user opens its chat or settings.
    if (!active || requestedForTab !== tabId) return;
    let live = true;
    const adopt = (next: MiniSnapshot) => {
      if (!live || !next || next.tabId !== tabId || owner.current.tabId !== tabId || (next.viewRevision ?? next.revision) < owner.current.revision) return;
      owner.current.revision = next.viewRevision ?? next.revision;
      setSnapshot(next);
      setError('');
    };
    const changed = (_event: unknown, payload: { tabId: string; snapshot: MiniSnapshot }) => {
      if (payload?.tabId === tabId) adopt(payload.snapshot);
    };
    ipcRenderer.on('mini-orchestrator:changed', changed);
    void ipcRenderer.invoke('mini-orchestrator:get', { tabId }).then((result: any) => {
      if (result?.success) adopt(result.snapshot);
      else if (live) setError(result?.error || 'Не удалось загрузить состояние');
    }).catch(() => { if (live) setError('Не удалось загрузить состояние'); });
    return () => { live = false; ipcRenderer.removeListener('mini-orchestrator:changed', changed); };
  }, [tabId, active, requestedForTab]);
  const invoke = async (channel: string, args: object) => {
    const actionOwner = tabId;
    try {
      const result = await ipcRenderer.invoke(channel, { tabId, ...args });
      if (owner.current.tabId !== actionOwner) return null;
      if (result?.snapshot?.tabId === tabId && (result.snapshot.viewRevision ?? result.snapshot.revision) >= owner.current.revision) {
        owner.current.revision = result.snapshot.viewRevision ?? result.snapshot.revision;
        setSnapshot(result.snapshot); setError('');
      }
      if (result?.success) return (result.snapshot.viewRevision ?? result.snapshot.revision) >= owner.current.revision ? result.snapshot as MiniSnapshot : null;
      const messages = { mini_settings_busy: 'Настройки заблокированы до завершения запроса.', mini_settings_changed: 'Настройки обновились. Выберите значение ещё раз.', mini_settings_unconfirmed: 'Сохранение настроек не подтверждено. Повторите сохранение.' };
      setError(messages[result?.error as keyof typeof messages] || result?.error || 'Операция не выполнена');
    } catch { if (owner.current.tabId === actionOwner) setError('Операция не выполнена'); }
    return null;
  };
  const changeEnabled = async (enabled?: boolean) => {
    if (!active || actionPending.current) return;
    const actionOwner = tabId;
    actionPending.current = true; setPending(true); setRequestedForTab(tabId);
    try {
      const current = snapshot?.tabId === tabId ? snapshot : await invoke('mini-orchestrator:get', {});
      if (!current || owner.current.tabId !== actionOwner) return;
      await invoke('mini-orchestrator:set-enabled', { enabled: enabled ?? !current.enabled });
    } finally { actionPending.current = false; setPending(false); }
  };
  const setSettings = async (model: string, thinkingLevel: string) => {
    if (settingsPendingRef.current || !snapshot?.settings?.revision) return;
    settingsPendingRef.current = true; setSettingsPending(true);
    try { await invoke('mini-orchestrator:set-settings', { model, thinkingLevel, expectedRevision: snapshot.settings.revision }); }
    finally { settingsPendingRef.current = false; setSettingsPending(false); }
  };
  const setForward = async (reviewerTabId: string | null, instruction?: string) => {
    if (!active) return;
    setRequestedForTab(tabId);
    await invoke('mini-orchestrator:set-forward', { reviewerTabId, instruction,
      expectedRevision: snapshot?.forward?.revision ?? 'forward:none' });
  };
  return { tabId, snapshot: snapshot?.tabId === tabId ? snapshot : null, error, pending, settingsPending, setSettings,
    ensureLoaded: () => setRequestedForTab(tabId),
    setForward,
    readInstruction: async (): Promise<{ text: string; custom: boolean; defaultFile: string } | null> => {
      const result = await ipcRenderer.invoke('mini-orchestrator:read-instruction', { tabId });
      return result?.success ? result.instruction : null;
    },
    setEnabled: (enabled: boolean) => changeEnabled(enabled), toggleEnabled: () => changeEnabled(), clear: () => invoke('mini-orchestrator:clear', {}) };
}

export type MiniController = ReturnType<typeof useMiniOrchestrator>;

// Restored verbatim: an interrupted refactor (03.11 09:39) removed this export
// while PromptQueueOverlay still imports it, which broke `electron-vite build`.
// The unfinished MiniOrchestratorEdgeControl below is its intended successor;
// it is not wired anywhere yet, so both coexist until that work is completed.
export function MiniOrchestratorToggle({ controller }: { controller: MiniController }) {
  const enabled = controller.snapshot?.enabled === true;
  return <button type="button" role="switch" aria-checked={enabled}
    data-mini-orchestrator-toggle data-active={enabled} aria-label={`Мини-оркестратор · ${enabled ? 'включён' : 'выключен'}`}
    title={controller.error || `${enabled ? 'Выключить' : 'Включить'} проверку ответов мини-оркестратором${controller.snapshot?.autoReturn ? ' · не более одной корректировки на ответ в DEV' : ''}`}
    disabled={controller.pending} onClick={() => void controller.toggleEnabled()}
    style={{ height: 26, padding: '0 6px', display: 'inline-flex', alignItems: 'center', gap: 4,
      borderRadius: 5, border: `1px solid ${enabled ? '#39854b' : '#444'}`, background: enabled ? '#193922' : '#171717',
      color: enabled ? '#80db92' : '#aaa', fontSize: 10, whiteSpace: 'nowrap', cursor: controller.pending ? 'default' : 'pointer' }}>
    <Bot size={13} />
  </button>;
}

/** Reviewer choice, opened by right-click on the edge control. The trigger is
 * the control itself, so the menu reuses RunAfterTabPicker's existing anchoring
 * and workflow inventory instead of a second tab list. */
function MiniReviewerPicker({ controller, panelRef, anchor, onClose }:
  { controller: MiniController; panelRef?: RefObject<HTMLDivElement | null>;
    anchor: RefObject<HTMLDivElement | null>; onClose: () => void }) {
  // positionMenu() dereferences panelRef and bails out when it has neither a
  // panel nor a trigger rect, which silently produced "right click does
  // nothing". The control itself is a valid anchor, so fall back to it.
  const host = panelRef?.current ? panelRef : anchor;
  // The picker retires an open request only after handleOpen() succeeds, and
  // handleOpen needs a measurable anchor. Issuing the key during the first
  // render raced that measurement and the request was dropped with no retry,
  // so the key is published from an effect — by then the anchor is laid out.
  const [openKey, setOpenKey] = useState(0);
  const [closeKey, setCloseKey] = useState(0);
  useEffect(() => { setOpenKey(Date.now()); }, []);
  // The request must be retired by the caller, exactly like the on-tab picker
  // in PromptQueueOverlay: the picker only marks its own ref, so a key left in
  // place keeps re-running the effect against an already-consumed ref.
  const retire = useCallback((consumed: number) => {
    setOpenKey(current => (current === consumed ? 0 : current));
  }, []);
  const forward = controller.snapshot?.forward;
  return <RunAfterTabPicker tabId={controller.tabId} autoRun={false}
    runAfterTabId={forward?.reviewerTabId || null}
    setRunAfterTab={(_tabId, target) => { void controller.setForward(target); setCloseKey(key => key + 1); onClose(); }}
    panelRef={host} hideTrigger externalTriggerRef={anchor}
    openRequestKey={openKey} onOpenRequestConsumed={retire} closeRequestKey={closeKey}
    closeOnSelect title="Проверяющая вкладка" emptyLabel="Выберите вкладку-проверяющего"
    accentColor="#17261b" accentTextColor="#69c67d" showRuntimeDot zIndex={121} />;
}

/** Retires a spent picker mount once its menu is gone. The picker reports a
 * choice but not an outside dismiss, so the mount would otherwise survive with
 * an already-consumed open key and swallow the next right click. */
function MiniPickerDismissWatch({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    let frame = 0;
    // The menu renders in a portal on the next frame; only treat its absence
    // as a dismiss once it has actually appeared and then gone.
    let seen = false;
    const poll = () => {
      const open = !!document.querySelector('[data-run-after-picker-menu]');
      if (open) seen = true;
      else if (seen) { onDismiss(); return; }
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frame);
  }, [onDismiss]);
  return null;
}

/** Hover card: what this robot will do and where it last sent. Deliberately not
 * a chat — the delivered remarks live in History as ordinary messages, and a
 * second copy of that history would drift from the first. Each row navigates. */
function MiniEdgeCard({ controller, anchor, onClose }:
  { controller: MiniController; anchor: RefObject<HTMLDivElement | null>; onClose: () => void }) {
  const snapshot = controller.snapshot;
  const forward = snapshot?.forward;
  const rect = anchor.current?.getBoundingClientRect();
  const lastTool = snapshot?.entries.filter(entry => entry.type === 'tool').at(-1);
  const lastRound = snapshot?.entries.filter(entry => entry.round !== undefined).at(-1)?.round;
  const source = lastRound !== undefined ? snapshot?.roundSources?.[String(lastRound)] : snapshot?.reviewSource;
  const target = miniReviewTarget(controller.tabId, source);
  if (!rect || !forward) return null;
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, width: '100%',
    padding: '3px 4px', background: 'transparent', border: 0, borderRadius: 3,
    color: '#ccc', fontSize: 11, textAlign: 'left', cursor: 'pointer' };
  return createPortal(<div data-mini-edge-card data-run-after-satellite="true"
    onMouseDown={event => event.stopPropagation()}
    // The control sits at the far right of the window, so anchoring the card
    // to its left edge pushed it off-screen. Clamp to the viewport on both
    // axes: the card keeps its width and simply opens leftwards there.
    style={{ position: 'fixed',
      left: Math.max(8, Math.min(rect.left, window.innerWidth - CARD_WIDTH - 8)),
      top: Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 140)),
      zIndex: 121,
      width: CARD_WIDTH, maxWidth: 'calc(100vw - 16px)',
      padding: 5, background: '#151515', border: '1px solid #3a3a3a', borderRadius: 6,
      boxShadow: '0 10px 28px #0008', display: 'flex', flexDirection: 'column', gap: 1 }}>
    <div style={{ ...row, cursor: 'default', color: '#69c67d' }} title="Вкладка-проверяющий">
      <Bot size={12} aria-hidden />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{forward.reviewerName || forward.reviewerTabId}</span>
      {!forward.reviewerAvailable && <CircleAlert size={12} color="#d97706" aria-label="Вкладка недоступна" />}
    </div>
    <MiniForwardInstructionRow controller={controller} style={row} />
    {target && <button type="button" style={row} title="Перейти к проверенной итерации"
      onClick={() => {
        void navigateMiniReview(target, value => jumpToTerminalMessageTarget(value, 'mini:' + value.messageId.slice(0, 96)),
          onClose, () => useUIStore.getState().showToast('Не удалось показать итерацию в History', 'warning'));
      }}>
      <Clock3 size={12} aria-hidden style={{ color: '#888' }} />
      <span style={{ color: '#888' }}>Итерация</span>
      <span style={{ marginLeft: 'auto', color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{source?.turnId}</span>
    </button>}
    {lastTool?.receipt && <div style={{ ...row, cursor: 'default', color: '#888', fontSize: 10 }}>
      <span>последняя отправка</span>
      <span style={{ marginLeft: 'auto', color: lastTool.receipt.status === 'sent' ? '#69c67d' : '#d97706' }}>
        {lastTool.receipt.status === 'sent' ? 'доставлено' : lastTool.receipt.status || 'не подтверждено'}
      </span>
    </div>}
  </div>, document.body);
}

/** Instruction row of the hover card: opens the same editor the popup uses. */
function MiniForwardInstructionRow({ controller, style }: { controller: MiniController; style: React.CSSProperties }) {
  const forward = controller.snapshot?.forward;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [defaultFile, setDefaultFile] = useState('');
  if (!forward) return null;
  const open = async () => {
    const current = await controller.readInstruction();
    setDraft(current?.text || ''); setDefaultFile(current?.defaultFile || ''); setEditing(true);
  };
  return <>
    <button type="button" style={style} title={forward.instructionCustom ? 'Своя инструкция для этой вкладки' : 'Инструкция по умолчанию из общего файла'}
      onClick={() => void open()}>
      <CircleHelp size={12} aria-hidden style={{ color: '#888' }} />
      <span style={{ color: '#888' }}>Инструкция</span>
      <span style={{ marginLeft: 'auto', color: forward.instructionCustom ? '#69c67d' : '#aaa' }}>
        {forward.instructionCustom ? 'своя' : 'общая'}
      </span>
    </button>
    {editing && createPortal(<div data-mini-forward-editor data-run-after-satellite="true"
      onMouseDown={event => { event.stopPropagation(); setEditing(false); }} onClick={event => event.stopPropagation()}
      style={{ position: 'fixed', inset: 0, zIndex: 122, display: 'grid', placeItems: 'center' }}>
      <div onMouseDown={event => event.stopPropagation()} style={{ width: 'min(700px, calc(100vw - 32px))',
        background: '#151515', border: '1px solid #3a3a3a', borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, color: '#999' }}>Инструкция проверяющего. По умолчанию берётся из {defaultFile || 'общего файла'}; сохранённый здесь текст действует только для этой вкладки.</div>
        <textarea value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false}
          style={{ minHeight: 320, resize: 'vertical', background: '#101010', color: '#ddd', border: '1px solid #333',
            borderRadius: 4, padding: 6, fontSize: 12, fontFamily: 'inherit' }} />
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => { void controller.setForward(forward.reviewerTabId, ''); setEditing(false); }}>Вернуть общую</button>
          <button type="button" onClick={() => setEditing(false)}>Отмена</button>
          <button type="button" onClick={() => { void controller.setForward(forward.reviewerTabId, draft); setEditing(false); }}>Сохранить</button>
        </div>
      </div>
    </div>, document.body)}
  </>;
}

// One control, not three. The robot used to be a bare header toggle plus a
// separate popup that imitated a chat; the reviewer tab was only visible after
// opening that popup. Here the same button carries the state the user actually
// needs at a glance — is it on, and who reviews — while the picker and the
// read-only card stay one gesture away. It lives on the Run After edge row
// because "forward every finished answer to tab X" is the same kind of
// queue-wide policy as Loop, not a separate entity.
export function MiniOrchestratorEdgeControl({ controller, compact = false, panelRef }:
  { controller: MiniController; compact?: boolean; panelRef?: RefObject<HTMLDivElement | null> }) {
  const snapshot = controller.snapshot;
  const enabled = snapshot?.enabled === true;
  const forward = snapshot?.forward;
  const [picking, setPicking] = useState(false);
  const [card, setCard] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const accent = enabled ? '#69c67d' : '#888';
  const border = enabled ? '#31553c' : BORDER_MUTED;
  // Hover opens the read-only card; a geometric check keeps it alive while the
  // cursor travels into it (see сценарии-багов-design 2.7 — onMouseLeave on a
  // conditionally mounted portal unmounts it before mouseenter can fire).
  useEffect(() => {
    if (!card) return;
    const move = (event: MouseEvent) => {
      const trigger = root.current?.getBoundingClientRect();
      const panel = document.querySelector('[data-mini-edge-card]')?.getBoundingClientRect();
      const inside = (rect?: DOMRect | null) => !!rect && event.clientX >= rect.left - 2 && event.clientX <= rect.right + 2
        && event.clientY >= rect.top - 2 && event.clientY <= rect.bottom + 2;
      if (!inside(trigger) && !inside(panel)) setCard(false);
    };
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, [card]);
  const label = forward?.reviewerName || forward?.reviewerTabId || null;
  return <div ref={root} data-mini-orchestrator-edge style={{ display: 'inline-flex', height: compact ? 20 : 22,
    minWidth: 0, flexShrink: 1,
    border: `1px solid ${border}`, borderRadius: 6, overflow: 'hidden', background: PANEL_BG_MUTED }}>
    <button type="button" role="switch" aria-checked={enabled}
      data-mini-orchestrator-toggle data-active={enabled}
      aria-label={`Мини-оркестратор · ${enabled ? 'включён' : 'выключен'}`}
      title={controller.error || (!forward ? 'Правый клик — выбрать вкладку-проверяющего'
        : `${enabled ? 'Выключить' : 'Включить'} проверку ответов · ${label}`)}
      disabled={controller.pending}
      onMouseEnter={() => { controller.ensureLoaded(); if (forward) setCard(true); }}
      onClick={() => void controller.toggleEnabled()}
      // Each right click is its own open request. Remounting the picker is
      // what issues a fresh key: keeping the old mount alive after the menu
      // was dismissed without a choice left a spent key in place, so only the
      // first right click ever worked.
      onContextMenu={event => {
        event.preventDefault(); controller.ensureLoaded(); setCard(false);
        setPicking(false);
        requestAnimationFrame(() => setPicking(true));
      }}
      style={{ height: compact ? 18 : 20, padding: '0 6px', display: 'inline-flex', alignItems: 'center', gap: 3,
        background: enabled ? '#69c67d22' : 'transparent', border: 0, color: accent,
        fontSize: compact ? 7 : 9, fontFamily: 'inherit', whiteSpace: 'nowrap',
        cursor: controller.pending ? 'default' : 'pointer' }}>
      <Bot size={compact ? 11 : 12} aria-hidden />
      {label && !compact && <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>}
      {!forward && !compact && <span style={{ color: '#888' }}>—</span>}
    </button>
    {picking && <MiniReviewerPicker controller={controller} panelRef={panelRef} anchor={root}
      onClose={() => setPicking(false)} />}
    {/* Dismissing the menu by clicking elsewhere does not notify the caller,
        so the spent mount is retired here; without it the next right click
        had nothing to remount. */}
    {picking && <MiniPickerDismissWatch onDismiss={() => setPicking(false)} />}
    {card && forward && <MiniEdgeCard controller={controller} anchor={root} onClose={() => setCard(false)} />}
  </div>;
}

export function miniStatusPresentation(snapshot: MiniSnapshot | null) {
  if (!snapshot?.enabled) return null;
  switch (snapshot.phase) {
    case 'collecting': return { kind: 'waiting', label: 'Ожидаем завершения основного ответа', color: '#d97706' };
    case 'reviewing': return { kind: 'running', label: 'Проверяем завершённый ответ', color: '#69c67d' };
    case 'sending': return { kind: 'running', label: 'Отправляем замечание через MCP', color: '#69c67d' };
    case 'error': return { kind: 'error', label: 'Ошибка проверки — откройте чат', color: '#ef7777' };
    case 'unknown': return { kind: 'unknown', label: 'Результат не подтверждён — откройте чат', color: '#d97706' };
    default: return null;
  }
}

export function miniPhaseLabel(snapshot: MiniSnapshot | null) {
  if (snapshot?.enabled && snapshot.correctionState === 'no-progress') return 'Повтор не отправлен';
  if (snapshot?.phase === 'complete' && snapshot.reviewSource?.archived) return 'Готово · архив';
  return { off: 'Inactive', idle: 'Готов', collecting: 'Ожидаем завершения', reviewing: 'Проверяет', sending: 'MCP-отправка', complete: 'Готово', error: 'Ошибка', unknown: 'Не подтверждено' }[snapshot?.phase || 'off'];
}

export function MiniOrchestratorStatus({ snapshot }: { snapshot: MiniSnapshot | null }) {
  const status = miniStatusPresentation(snapshot);
  if (!status) return null;
  return <span data-mini-orchestrator-status={status.kind} role="status" aria-label={status.label} title={status.label}
    style={{ width: 14, height: 14, flexShrink: 0, display: 'grid', placeItems: 'center', color: status.color }}>
    {status.kind === 'running' ? <span className="pq-spinner noted-infinite-animation" aria-hidden="true"
      style={{ width: 12, height: 12, borderWidth: 1.5, willChange: 'transform' }} />
      : status.kind === 'waiting' ? <Clock3 size={13} />
        : status.kind === 'error' ? <CircleAlert size={13} /> : <CircleHelp size={13} />}
  </span>;
}

export function miniPopupLayout(anchor: { right: number; bottom: number }, viewport: { width: number; height: number }, preferred?: { width: number; height: number }) {
  const width = Math.max(0, Math.min(preferred?.width || 420, viewport.width - 16));
  const left = Math.max(8, Math.min(anchor.right - width, viewport.width - width - 8));
  const top = Math.max(8, Math.min(anchor.bottom, viewport.height - 8));
  return { left, top, width, height: Math.max(0, Math.min(preferred?.height || 500, viewport.height - top - 8)) };
}

type PanelFrame = ReturnType<typeof miniPopupLayout>;
const panelMemory = new Map<string, { frame: PanelFrame; detached: boolean }>();
const panelPersistence = createMiniPanelPersistence((channel: string, value: unknown) => ipcRenderer.invoke(channel, value));
const rememberPanel = (tabId: string, frame: PanelFrame, detached: boolean) => {
  panelMemory.delete(tabId); panelMemory.set(tabId, { frame, detached });
  if (panelMemory.size > 60) panelMemory.delete(panelMemory.keys().next().value!);
};

export function MiniModelControls({ controller }: { controller: MiniController }) {
  const snapshot = controller.snapshot, settings = snapshot?.settings;
  const active = snapshot?.activeReview;
  const model = active?.model || settings?.model || '';
  const thinking = active?.thinkingLevel || settings?.thinkingLevel || '';
  const busy = snapshot?.phase === 'reviewing' || snapshot?.phase === 'sending';
  const disabled = busy || controller.settingsPending || !settings?.revision || !!settings?.error;
  const models: Array<{ value: string; label: string }> = [...GEMINI_MODEL_OPTIONS];
  if (model && !models.some(item => item.value === model)) models.push({ value: model, label: legacyGeminiModelLabel(model) || model });
  const levels = settings?.thinkingLevels || ['LOW', 'MEDIUM', 'HIGH'];
  const title = busy ? 'Настройки заблокированы до завершения запроса' : 'Для следующих проверок этой вкладки';
  return <div data-mini-orchestrator-model-controls style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
    <select className="mini-orchestrator-model-select" data-agent-setting-trigger="model" aria-label="Gemini model" title={title}
      value={model} disabled={disabled} onChange={e => void controller.setSettings(e.target.value, levels.includes(thinking) ? thinking : 'LOW')}
      style={{ maxWidth: 240 }}>
      {!model && <option value="">Модель —</option>}
      {models.map(item => <option key={item.value} value={item.value}>{item.label.startsWith('gemini-') ? item.label : `Gemini ${item.label}`}</option>)}
    </select>
    <span style={{ color: '#666' }}>/</span>
    <select className="mini-orchestrator-model-select" data-agent-setting-trigger="effort" aria-label="Gemini effort" title={title}
      value={thinking} disabled={disabled} onChange={e => void controller.setSettings(model, e.target.value)}>
      {!levels.includes(thinking) && <option value={thinking} disabled>{thinking === 'NONE' ? 'auto' : thinking || '—'}</option>}
      {levels.map(level => <option key={level} value={level}>{level.toLowerCase()}</option>)}
    </select>
  </div>;
}

// Forward mode header: the reviewer tab picker replaces the Gemini model pair,
// because a real reviewer tab owns its own model and effort.
export function MiniForwardControls({ controller, panelRef }: { controller: MiniController; panelRef: RefObject<HTMLDivElement | null> }) {
  const forward = controller.snapshot?.forward;
  const busy = ['reviewing', 'sending'].includes(controller.snapshot?.phase || '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [defaultFile, setDefaultFile] = useState('');
  const openEditor = async () => {
    const current = await controller.readInstruction();
    setDraft(current?.text || ''); setDefaultFile(current?.defaultFile || ''); setEditing(true);
  };
  return <div data-mini-forward-controls style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
    <RunAfterTabPicker tabId={controller.tabId} autoRun={false}
      runAfterTabId={forward?.reviewerTabId || null}
      setRunAfterTab={(_tabId, target) => { void controller.setForward(target); }}
      panelRef={panelRef} triggerVariant="pill" closeOnSelect
      title="Проверяющая вкладка" emptyLabel="Выберите вкладку-проверяющего"
      triggerLabel={forward?.reviewerName || forward?.reviewerTabId || 'Проверяющий —'}
      accentColor="#17261b" accentTextColor="#69c67d" showRuntimeDot zIndex={121} />
    {forward && <button type="button" data-mini-forward-instruction aria-label="Инструкция проверяющего"
      disabled={busy} title={forward.instructionCustom ? 'Своя инструкция для этой вкладки' : 'Инструкция по умолчанию из общего файла'}
      onClick={() => void openEditor()}
      style={{ height: 22, padding: '0 5px', border: '1px solid #333', borderRadius: 4, background: '#171717',
        color: forward.instructionCustom ? '#69c67d' : '#aaa', fontSize: 10, cursor: busy ? 'default' : 'pointer' }}>
      Инструкция{forward.instructionCustom ? ' ·' : ''}
    </button>}
    {!forward?.reviewerAvailable && forward && <span role="status" title="Выбранная вкладка недоступна" style={{ color: '#d97706' }}><CircleAlert size={13} /></span>}
    {editing && createPortal(<div data-mini-forward-editor data-run-after-satellite="true"
      onMouseDown={event => { event.stopPropagation(); setEditing(false); }} onClick={event => event.stopPropagation()}
      style={{ position: 'fixed', inset: 0, zIndex: 122, display: 'grid', placeItems: 'center' }}>
      <div onMouseDown={event => event.stopPropagation()} style={{ width: 'min(700px, calc(100vw - 32px))',
        background: '#151515', border: '1px solid #3a3a3a', borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, color: '#999' }}>Инструкция проверяющего. По умолчанию берётся из {defaultFile || 'общего файла'}; сохранённый здесь текст действует только для этой вкладки.</div>
        <textarea value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false}
          style={{ minHeight: 320, resize: 'vertical', background: '#101010', color: '#ddd', border: '1px solid #333',
            borderRadius: 4, padding: 6, fontSize: 12, fontFamily: 'inherit' }} />
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => { void controller.setForward(forward!.reviewerTabId, ''); setEditing(false); }}>Вернуть общую</button>
          <button type="button" onClick={() => setEditing(false)}>Отмена</button>
          <button type="button" onClick={() => { void controller.setForward(forward!.reviewerTabId, draft); setEditing(false); }}>Сохранить</button>
        </div>
      </div>
    </div>, document.body)}
  </div>;
}

export function MiniOrchestratorControl({ controller }: { controller: MiniController }) {
  const { snapshot, error, clear } = controller;
  const [open, setOpen] = useState(false);
  // undefined/'legacy' identify which round's instruction chip opened the preview.
  const [instructionPreviewRound, setInstructionPreviewRoundState] = useState<number | 'legacy' | null>(null);
  const instructionPreviewRef = useRef<number | 'legacy' | null>(null);
  const setInstructionPreviewRound = (value: number | 'legacy' | null) => { instructionPreviewRef.current = value; setInstructionPreviewRoundState(value); };
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<ReturnType<typeof miniPopupLayout> | null>(null);
  const { start: startGesture, stop: stopGesture } = usePointerGesture();
  const gestureActive = useRef(false), frameRef = useRef<PanelFrame | null>(null);
  const geometryEdit = useRef(0);
  const detached = useRef(panelMemory.get(controller.tabId)?.detached || false);
  const body = useRef<HTMLDivElement>(null), followBottom = useRef(true);
  const historyFontSize = useUIStore(s => s.historyFontSize);
  const historyLetterSpacing = useUIStore(s => s.historyLetterSpacing);
  const historyHorizontalPadding = useUIStore(s => s.historyHorizontalPadding);
  const historyMarkdownCodeMaxLines = useUIStore(s => s.historyMarkdownCodeMaxLines);
  const copyTranscript = useCallback((text: string) => window.require('electron').clipboard.writeText(text), []);
  const previewRaf = useRef<number | null>(null);
  const applyFrame = (frame: PanelFrame) => { frameRef.current = frame; setLayout(frame); };
  const beginGesture = (edge: 'left' | 'bottom' | 'left-bottom' | 'move', event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || edge === 'move' && (event.target as HTMLElement).closest('button,select,input,a')) return;
    const bounds = popup.current?.getBoundingClientRect(); if (!bounds) return;
    let frame = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    let lastX = event.clientX, lastY = event.clientY, moved = false;
    const handle = event.currentTarget;
    handle.setAttribute('data-resize-handle-active', 'true'); gestureActive.current = true;
    startGesture(event, { cursor: edge === 'move' ? 'move' : edge === 'left' ? 'ew-resize' : edge === 'bottom' ? 'ns-resize' : 'nesw-resize',
      onMove: move => {
        const dx = move.clientX - lastX, dy = move.clientY - lastY; lastX = move.clientX; lastY = move.clientY;
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        frame = edge === 'move' ? moveMiniPanel(frame, dx, dy, viewport) : resizeMiniPanel(frame, edge, dx, dy, viewport);
        if (dx || dy) { moved = true; if (edge === 'move') detached.current = true; }
        frameRef.current = frame;
        if (previewRaf.current === null) previewRaf.current = requestAnimationFrame(() => { previewRaf.current = null; if (frameRef.current) setLayout(frameRef.current); });
      }, onEnd: () => {
        if (previewRaf.current !== null) { cancelAnimationFrame(previewRaf.current); previewRaf.current = null; }
        gestureActive.current = false; handle.removeAttribute('data-resize-handle-active');
        if (moved) { geometryEdit.current++; applyFrame(frame); rememberPanel(controller.tabId, frame, detached.current); panelPersistence.write(controller.tabId, { frame, detached: detached.current }); }
      } });
  };
  useEffect(() => {
    // A chip that opens this panel is also the way back out of it: clicking the
    // same chip twice used to re-issue `setOpen(true)` and leave the panel up,
    // so the only exit was ✕ or clicking outside. `toggle` keeps that chip
    // deterministic; callers that genuinely must open (a late receipt arriving
    // while the panel is closed) send the event without it.
    const requestOpen = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.tabId !== controller.tabId) return;
      controller.ensureLoaded();
      setOpen(current => detail.toggle ? !current : true);
    };
    window.addEventListener('mini-orchestrator:open', requestOpen);
    return () => window.removeEventListener('mini-orchestrator:open', requestOpen);
  }, [controller.tabId]);
  useLayoutEffect(() => {
    if (!open) return;
    let live = true;
    const editAtRead = geometryEdit.current;
    const update = () => {
      if (gestureActive.current) return;
      const bounds = root.current?.getBoundingClientRect();
      if (!bounds) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const saved = panelMemory.get(controller.tabId);
      if (saved?.detached) { detached.current = true; applyFrame(fitMiniPanel(saved.frame, viewport)); }
      else {
        detached.current = false;
        applyFrame(miniPopupLayout(bounds, viewport, saved?.frame));
      }
    };
    // The control rail is fixed relative to its composer. Do not read layout
    // on every wheel event inside the retained History/reviewer transcript.
    update(); window.addEventListener('resize', update);
    void panelPersistence.read(controller.tabId).then(saved => {
      if (!live || !saved || gestureActive.current || geometryEdit.current !== editAtRead) return;
      rememberPanel(controller.tabId, saved.frame, saved.detached); update();
    });
    const outside = (event: MouseEvent) => {
      if (instructionPreviewRef.current !== null) { setInstructionPreviewRound(null); return; }
      if (!root.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (instructionPreviewRef.current !== null) setInstructionPreviewRound(null); else setOpen(false); } };
    const presentation = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.tabId === controller.tabId) { if (detail.presented === false) setOpen(false); else update(); }
    };
    const rail = root.current?.closest('[data-prompt-queue-instance]');
    const resize = new ResizeObserver(update);
    if (root.current) resize.observe(root.current);
    if (rail?.parentElement) resize.observe(rail.parentElement);
    const moved = new MutationObserver(update);
    if (rail) moved.observe(rail, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('mousedown', outside);
    window.addEventListener('keydown', key);
    window.addEventListener(PANE_LAYER_PRESENTATION_EVENT, presentation);
    return () => { live = false; setInstructionPreviewRound(null); stopGesture(); resize.disconnect(); moved.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('mousedown', outside); window.removeEventListener('keydown', key); window.removeEventListener(PANE_LAYER_PRESENTATION_EVENT, presentation); };
  }, [open, controller.tabId]);
  useLayoutEffect(() => {
    if (open && followBottom.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [open, snapshot?.entries]);
  const rounds = useMemo(() => open ? miniEntriesByRound(snapshot?.entries || []) : [], [open, snapshot]);
  const busy = snapshot?.phase === 'reviewing' || snapshot?.phase === 'sending';
  const phaseLabel = miniPhaseLabel(snapshot);
  // This component now owns only the popup and the phase indicator. Its own
  // robot button was the third copy of the same control (header toggle, edge
  // control, this one) and the only one that showed neither the on/off state
  // nor the reviewer; the edge control replaced it. The popup is still reached
  // from the «Рецензент» chip and from the hover card.
  return <div ref={root} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
    <MiniOrchestratorStatus snapshot={snapshot} />
    {open && layout && createPortal(<div ref={popup} role="dialog" aria-label="Мини-оркестратор" data-mini-orchestrator-popup data-run-after-satellite="true"
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', ...layout, boxSizing: 'border-box', zIndex: 119, background: '#151515', color: '#ddd', border: '1px solid #3a3a3a', borderRadius: 6, boxShadow: '0 10px 28px #0008', display: 'flex', flexDirection: 'column' }}>
      {(['left', 'bottom', 'left-bottom'] as const).map(edge => <div key={edge} className="mini-orchestrator-resize" data-edge={edge}
        aria-label={`Resize ${edge}`} onPointerDown={event => beginGesture(edge, event)} />)}
      <div data-mini-orchestrator-drag-handle onPointerDown={event => beginGesture('move', event)}
        style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: '5px 8px', borderBottom: '1px solid #333', fontSize: 11, flexShrink: 0, cursor: 'move' }}>
        <Bot size={13} /><MiniForwardControls controller={controller} panelRef={popup} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <span style={{ color: busy ? '#69c67d' : '#888' }}>{snapshot ? phaseLabel : 'загрузка'}</span>
          <button type="button" disabled={busy || !snapshot?.entries.length} onClick={() => void clear()}>Clear</button>
          <button type="button" aria-label="Закрыть" onClick={() => setOpen(false)}><X size={13} /></button>
        </div>
      </div>
      <div ref={body} className="scrollbar-thin mini-orchestrator-transcript"
        onScroll={event => { const el = event.currentTarget; followBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 12; }}
        style={{ overflowY: 'auto', overflowX: 'hidden', minHeight: 0, flex: 1, padding: 6, fontSize: historyFontSize, letterSpacing: historyLetterSpacing,
          ['--hp-horizontal-padding' as any]: `${historyHorizontalPadding}px`,
          ['--cb-markdown-code-max-height' as any]: Math.ceil(historyFontSize * 0.92 * 1.5 * historyMarkdownCodeMaxLines + 20) + 'px' }}>
        {(error || snapshot?.error || snapshot?.settings?.error) && <div role="alert" style={{ fontSize: 11, color: '#ef7777' }}>{error || snapshot?.error || snapshot?.settings?.error}
          {snapshot?.settings?.error === 'mini_settings_unconfirmed' && <button type="button" onClick={() => void controller.setSettings(snapshot.settings!.model!, snapshot.settings!.thinkingLevel!)}>Retry save</button>}
        </div>}
        {!rounds.length && <div style={{ color: '#999', fontSize: 11 }}>{
          !snapshot?.forward ? 'Выберите вкладку-проверяющего в шапке: её выбор включает автоматическую передачу завершённых ответов этой вкладки.'
            : snapshot?.enabled ? 'Ожидаем новый запрос и завершённый ответ основной сессии. Замечание появится в выбранной вкладке.'
              : 'Включите проверку кнопкой с роботом в полосе управления, затем отправьте новый запрос.'}</div>}
        {rounds.map(({ round, entries: roundEntries }) => {
          const source = round !== undefined ? snapshot?.roundSources?.[round] : snapshot?.reviewSource;
          const isLastRound = round === rounds.at(-1)?.round;
          const roundKey = round ?? 'legacy';
          return <React.Fragment key={roundKey}>
            <MiniReviewInput tabId={controller.tabId} entries={roundEntries} source={source} onCopy={copyTranscript}
              preview={instructionPreviewRound === roundKey} setPreview={open => setInstructionPreviewRound(open ? roundKey : null)} onNavigated={() => setOpen(false)} />
            <HistoryTranscriptPresentation steps={miniEntriesToSteps(roundEntries)} isTurnBusy={busy && isLastRound} className="mini-orchestrator-transcript"
              onCopy={copyTranscript} />
          </React.Fragment>;
        })}
      </div>
    </div>, document.body)}
  </div>;
}
