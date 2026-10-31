import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, CircleAlert, CircleHelp, Clock3, X } from 'lucide-react';
import { PANE_LAYER_PRESENTATION_EVENT } from '../../utils/paneLayerPresentation.mjs';
import { HistoryTranscriptPresentation, type HistoryTranscriptStep } from './HistoryTranscriptPresentation';
import { GEMINI_MODEL_OPTIONS, legacyGeminiModelLabel } from '../../constants/geminiModels';
import { useUIStore } from '../../store/useUIStore';
import { usePointerGesture } from '../../hooks/usePointerGesture';
import { fitMiniPanel, resizeMiniPanel, moveMiniPanel } from '../../utils/miniOrchestratorGeometry.mjs';
import { historyResponseTailLabel } from '../../utils/historyResponseTiming.mjs';
import { ComposerChip, ConversationMessage } from '@noted/claude-blocks';
import './MiniOrchestratorControl.css';

const { ipcRenderer } = window.require('electron');
type ReviewMeta = { model: string; requestedModel?: string; modelSource?: 'request' | 'response'; thinkingLevel: string; startedAt: number; finishedAt: number; durationMs: number };
type ReviewSource = { provider: string; sessionId: string; generation: string; turnId: string; answerId: string; jobId: string; requestIds: string[]; archived?: boolean; verificationNotes?: string[] };
type Entry = { id: string; type: 'instruction' | 'request' | 'answer' | 'review' | 'tool' | 'notice'; text: string; name?: string; filePath?: string; promptRevision?: string | number; status?: string; reviewMeta?: ReviewMeta; receipt?: { status?: string; handoffId?: string; operationKey?: string; attemptId?: string; error?: string; sessionId?: string; turnId?: string; requestCount?: number } };
export type MiniSnapshot = { tabId: string; enabled: boolean; revision: number; viewRevision?: number; phase: 'off' | 'idle' | 'collecting' | 'reviewing' | 'sending' | 'complete' | 'error' | 'unknown'; jobId?: string; error?: string; entries: Entry[];
  activeReview?: { model: string; thinkingLevel: string; startedAt: number };
  reviewSource?: ReviewSource;
  settings?: { model?: string; thinkingLevel?: string; revision?: string; thinkingLevels?: string[]; error?: string } };

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

export function MiniReviewInput({ entries, source, onCopy }: { entries: Entry[]; source?: ReviewSource; onCopy?: (text: string) => void }) {
  const [expanded, setExpanded] = useState<'instruction' | 'iteration' | null>(null);
  return <MiniReviewInputContent entries={entries} source={source} onCopy={onCopy} expanded={expanded}
    onToggle={kind => setExpanded(value => value === kind ? null : kind)} />;
}

export function MiniReviewInputContent({ entries, source, onCopy, expanded, onToggle }: {
  entries: Entry[]; source?: ReviewSource; onCopy?: (text: string) => void;
  expanded: 'instruction' | 'iteration' | null; onToggle: (kind: 'instruction' | 'iteration') => void;
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
        aria-expanded={expanded === 'instruction'} onClick={() => onToggle('instruction')} />
      <ComposerChip kind="paste" className="mini-review-iteration-chip" label="Итерация" meta={source?.turnId.slice(0, 8) || '—'}
        title={title} aria-expanded={expanded === 'iteration'} onClick={() => onToggle('iteration')} />
    </div>
    {expanded === 'instruction' && <div className="mini-review-input-preview" data-mini-review-instruction>
      <div className="mini-review-source-meta">{[instruction.filePath, 'Версия: ' + revision].filter(Boolean).join('\n')}</div>
      <pre>{instruction.text}</pre>
    </div>}
    {expanded === 'iteration' && <div className="mini-review-input-preview" data-mini-review-iteration>
      <div className="mini-review-source-meta">{[title, 'Запросов: ' + requests.length, source?.requestIds.join('\n'),
        ...((source?.verificationNotes || []).slice(0, 8).map(note => bounded(note)))].filter(Boolean).join('\n')}</div>
      <HistoryTranscriptPresentation onCopy={onCopy} steps={[
        ...requests.map(entry => ({ id: entry.id, kind: 'message' as const, role: 'user' as const, text: entry.text, contextLabel: 'Запрос исходной итерации' })),
        { id: answer.id, kind: 'message', role: 'assistant', text: answer.text, contextLabel: 'Ответ основной модели · объект проверки' },
      ]} />
    </div>}
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
  return { tabId, snapshot: snapshot?.tabId === tabId ? snapshot : null, error, pending, settingsPending, setSettings,
    ensureLoaded: () => setRequestedForTab(tabId),
    setEnabled: (enabled: boolean) => changeEnabled(enabled), toggleEnabled: () => changeEnabled(), clear: () => invoke('mini-orchestrator:clear', {}) };
}

export type MiniController = ReturnType<typeof useMiniOrchestrator>;

export function MiniOrchestratorToggle({ controller }: { controller: MiniController }) {
  const enabled = controller.snapshot?.enabled === true;
  return <button type="button" role="switch" aria-checked={enabled}
    data-mini-orchestrator-toggle aria-label={`Мини-оркестратор · ${enabled ? 'Active' : 'Inactive'}`}
    title={controller.error || `${enabled ? 'Выключить' : 'Включить'} проверку ответов мини-оркестратором`}
    disabled={controller.pending} onClick={() => void controller.toggleEnabled()}
    style={{ height: 26, padding: '0 6px', display: 'inline-flex', alignItems: 'center', gap: 4,
      borderRadius: 5, border: `1px solid ${enabled ? '#39854b' : '#444'}`, background: enabled ? '#193922' : '#171717',
      color: enabled ? '#80db92' : '#aaa', fontSize: 10, whiteSpace: 'nowrap', cursor: controller.pending ? 'default' : 'pointer' }}>
    <Bot size={13} /><span>{enabled ? 'On' : 'Off'}</span>
  </button>;
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

export function MiniOrchestratorControl({ controller }: { controller: MiniController }) {
  const { snapshot, error, clear } = controller;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<ReturnType<typeof miniPopupLayout> | null>(null);
  const { start: startGesture, stop: stopGesture } = usePointerGesture();
  const gestureActive = useRef(false), frameRef = useRef<PanelFrame | null>(null);
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
        if (moved) { applyFrame(frame); rememberPanel(controller.tabId, frame, detached.current); }
      } });
  };
  useEffect(() => {
    const requestOpen = (event: Event) => {
      if ((event as CustomEvent).detail?.tabId === controller.tabId) { controller.ensureLoaded(); setOpen(true); }
    };
    window.addEventListener('mini-orchestrator:open', requestOpen);
    return () => window.removeEventListener('mini-orchestrator:open', requestOpen);
  }, [controller.tabId]);
  useLayoutEffect(() => {
    if (!open) return;
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
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
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
    return () => { stopGesture(); resize.disconnect(); moved.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('mousedown', outside); window.removeEventListener('keydown', key); window.removeEventListener(PANE_LAYER_PRESENTATION_EVENT, presentation); };
  }, [open, controller.tabId]);
  useLayoutEffect(() => {
    if (open && followBottom.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [open, snapshot?.entries]);
  const steps = useMemo(() => open ? miniEntriesToSteps(snapshot?.entries || []) : [], [open, snapshot]);
  const busy = snapshot?.phase === 'reviewing' || snapshot?.phase === 'sending';
  const phaseLabel = miniPhaseLabel(snapshot);
  return <div ref={root} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
    <MiniOrchestratorStatus snapshot={snapshot} />
    <button type="button" aria-label="Мини-оркестратор" aria-expanded={open} onClick={() => { controller.ensureLoaded(); setOpen(!open); }} style={{ border: '1px solid #31553c', borderRadius: 5, background: '#17261b', color: '#69c67d', height: 20, minWidth: 27, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, cursor: 'pointer' }}><Bot size={12} /><span style={{ fontSize: 9 }}>1</span></button>
    {open && layout && createPortal(<div ref={popup} role="dialog" aria-label="Мини-оркестратор" data-mini-orchestrator-popup data-run-after-satellite="true"
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', ...layout, boxSizing: 'border-box', zIndex: 119, background: '#151515', color: '#ddd', border: '1px solid #3a3a3a', borderRadius: 6, boxShadow: '0 10px 28px #0008', display: 'flex', flexDirection: 'column' }}>
      {(['left', 'bottom', 'left-bottom'] as const).map(edge => <div key={edge} className="mini-orchestrator-resize" data-edge={edge}
        aria-label={`Resize ${edge}`} onPointerDown={event => beginGesture(edge, event)} />)}
      <div data-mini-orchestrator-drag-handle onPointerDown={event => beginGesture('move', event)}
        style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: '5px 8px', borderBottom: '1px solid #333', fontSize: 11, flexShrink: 0, cursor: 'move' }}>
        <Bot size={13} /><MiniModelControls controller={controller} />
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
        {!steps.length && !snapshot?.entries.some(entry => entry.type === 'answer') && <div style={{ color: '#999', fontSize: 11 }}>{snapshot?.enabled ? 'Ожидаем новый запрос и завершённый ответ основной сессии.' : 'Включите «🤖 Off» в полосе над кнопкой робота, затем отправьте новый запрос.'}</div>}
        <MiniReviewInput key={snapshot?.reviewSource?.jobId || snapshot?.entries.find(entry => entry.type === 'answer')?.id}
          entries={snapshot?.entries || []} source={snapshot?.reviewSource} onCopy={copyTranscript} />
        <HistoryTranscriptPresentation steps={steps} isTurnBusy={busy} className="mini-orchestrator-transcript"
          onCopy={copyTranscript} />
      </div>
    </div>, document.body)}
  </div>;
}
