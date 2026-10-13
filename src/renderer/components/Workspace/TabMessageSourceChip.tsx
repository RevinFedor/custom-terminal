import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, CircleAlert, Globe, SquareTerminal } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { adjustRgbaAlpha, flattenRgbaOnTabbarPanel, getTabChromeColorConfig } from './tabChrome';
import { resolveTabCardBackground } from '../../utils/tabCardVisual.mjs';
import { requestRowLinkStyle } from './RequestTrackerRow';
import { cancelTabMessageSourceJump, jumpToTabMessageSource } from '../../utils/tabMessageSourceJump';
import { useUIStore } from '../../store/useUIStore';
import './TabMessageSourceChip.css';
import scDesktopIcon from '../../assets/sc-desktop.png';
import { currentUIActionId, uiPerformancePhaseForAction } from '../../utils/uiPerformanceDiagnostics.mjs';
const { ipcRenderer } = window.require('electron');

type Source = { sourceTabId: string; sourceTabName?: string | null; sourceProjectId?: string | null; messageId?: string };

/** The existing saved-job jump, shared by History's arrow and Timeline's label. */
export function ResearchSourceAction({ runId, label, iconOnly = false, researchIcon = false, onNavigate, destination = 'desktop' }: {
  runId: string; label?: string; iconOnly?: boolean; researchIcon?: boolean; onNavigate?: () => void;
  destination?: 'desktop' | 'browser';
}) {
  const [navigation, setNavigation] = useState<{ runId: string; state: 'idle' | 'opening' | 'opened' | 'failed'; jobId?: string }>({ runId, state: 'idle' });
  const opening = navigation.runId === runId && navigation.state === 'opening';
  const openingRef = useRef(false);
  const browser = destination === 'browser';
  const actionPhase = browser ? 'history-research-browser-open' : 'history-research-open';
  const open = async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    const actionId = currentUIActionId(), started = performance.now();
    cancelTabMessageSourceJump();
    setNavigation({ runId, state: 'opening' });
    uiPerformancePhaseForAction(actionId, actionPhase, { run: runId, stage: 'begin' });
    try {
      const result = await ipcRenderer.invoke(browser ? 'orchestration:open-research-browser' : 'orchestration:open-research-job',
        { runId, ...(browser ? { actionId } : {}) });
      if (result?.success !== true || typeof result.jobId !== 'string'
        || (browser && (!Number.isInteger(result.tabId) || result.tabId < 0))) throw new Error(result?.error
        || (browser ? 'Не удалось открыть разговор в браузере' : 'Не удалось открыть задачу в SC Desktop'));
      setNavigation({ runId, state: 'opened', jobId: result.jobId });
      uiPerformancePhaseForAction(actionId, actionPhase, { run: runId, stage: 'opened', ms: performance.now() - started });
      onNavigate?.();
    } catch (error) {
      setNavigation({ runId, state: 'failed' });
      uiPerformancePhaseForAction(actionId, actionPhase, { run: runId, stage: 'failed', ms: performance.now() - started });
      useUIStore.getState().showToast(error instanceof Error ? error.message : String(error), 'error', 5000);
    } finally { openingRef.current = false; }
  };
  return <button type="button" data-external-research-source={runId}
    data-external-research-open-state={navigation.runId === runId ? navigation.state : 'idle'}
    data-external-research-opened-job={navigation.runId === runId ? navigation.jobId : undefined}
    data-external-research-destination={destination}
    title={browser ? 'Открыть разговор в браузере' : iconOnly ? 'Open saved task in SC Desktop' : 'Открыть задачу в SC Desktop'}
    aria-label={browser ? 'Открыть разговор в браузере' : iconOnly ? `Open in SC Desktop${label ? ': ' + label : ''}` : `Открыть задачу в SC Desktop: ${label}`}
    aria-busy={opening} disabled={opening}
    onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void open(); }}
    className={iconOnly ? 'hp-research-source-action' : 'history-research-source'}
    style={iconOnly ? undefined : { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0,
      maxWidth: '100%', overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 11, color: '#eee',
      background: 'transparent', border: 0, padding: '2px 3px', borderRadius: 4,
      cursor: opening ? 'default' : 'pointer', textAlign: 'left' }}>
    {iconOnly ? browser ? <Globe size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" /> : <>
      {researchIcon && <img src={scDesktopIcon} alt="SC Desktop" width={16} height={16} style={{ flexShrink: 0 }} />}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </>}
  </button>;
}

export function HistoryPromptSource({ source, phase, onNavigate, researchIcon = false }: {
  source: Partial<Source> & { label?: string; researchRunId?: string }; phase?: string; onNavigate?: () => void;
  researchIcon?: boolean;
}) {
  const incoming = phase === 'question' || phase === 'request';
  const response = phase === 'reply' || phase === 'completion' || phase === 'failure';
  const Icon = incoming ? ArrowDownLeft : response ? ArrowUpRight : null;
  const [jumping, setJumping] = useState(false);
  const jump = async () => {
    setJumping(true);
    try {
      if (await jumpToTabMessageSource(source)) onNavigate?.();
    } catch (error) {
      useUIStore.getState().showToast('Не удалось найти исходный вызов MCP', 'error', 4000,
        false, undefined, undefined, undefined, undefined, undefined, error instanceof Error ? error.message : String(error));
    } finally { setJumping(false); }
  };
  const direction = incoming ? 'incoming-request' : 'response';
  const iconStyle = { display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0 };
  return <div data-history-tab-message-source style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 6 }}>
    {Icon && (source.messageId && source.sourceTabId ? <button type="button" className="history-message-source-jump"
      data-history-source-direction={direction} data-tab-message-source-jump={source.messageId}
      aria-label={`Перейти к вызову MCP: ${source.sourceTabName || source.sourceTabId}`} aria-busy={jumping}
      title="Перейти к исходному вызову MCP" onMouseDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); void jump(); }}
      style={{ ...iconStyle, padding: 0, border: 0, borderRadius: 4, cursor: 'pointer' }}>
      <Icon size={14} strokeWidth={2.2} aria-hidden="true" />
    </button> : <span data-history-source-direction={direction}
      title={incoming ? 'Запрос к вам' : 'Ответ на ваш запрос'}
      style={{ ...iconStyle, color: '#a3a3a3' }}>
      <Icon size={14} strokeWidth={2.2} aria-hidden="true" />
    </span>)}
    {source.sourceTabId ? <TabMessageSourceChip source={source as Source} onNavigate={onNavigate} />
      : source.researchRunId ? <ResearchSourceAction runId={source.researchRunId} label={source.label}
        researchIcon={researchIcon} onNavigate={onNavigate} />
      : <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: '#c4b5fd' }}>{source.label}</span>}
  </div>;
}

function findSourceProject(state: Pick<ReturnType<typeof useWorkspaceStore.getState>, 'openProjects'>, source: Source) {
  if (source.sourceProjectId && state.openProjects.get(source.sourceProjectId)?.tabs.has(source.sourceTabId)) {
    return source.sourceProjectId;
  }
  for (const [projectId, workspace] of state.openProjects) {
    if (workspace.tabs.has(source.sourceTabId)) return projectId;
  }
  return null;
}

// Keep the stored label/provenance, but follow this exact tab ID if it moved.
// Neither the focused project nor another tab with the same name is a match.
export function TabMessageSourceChip({ source, onNavigate, variant = 'chip', incoming = false, leadingIcon, rowColor }: {
  source: Source; onNavigate?: () => void; variant?: 'chip' | 'row'; incoming?: boolean;
  leadingIcon?: ReactNode; rowColor?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const projectId = useWorkspaceStore(s => findSourceProject(s, source));
  const color = useWorkspaceStore(s => projectId ? s.openProjects.get(projectId)?.tabs.get(source.sourceTabId)?.color : undefined);
  const tabType = useWorkspaceStore(s => projectId ? s.openProjects.get(projectId)?.tabs.get(source.sourceTabId)?.tabType : undefined);
  const chrome = getTabChromeColorConfig({ color, tabType });
  const name = source.sourceTabName || source.sourceTabId;
  const row = variant === 'row';
  const Icon = error ? CircleAlert : row ? incoming ? ArrowDownLeft : ArrowUpRight : SquareTerminal;
  const navigate = async () => {
    if (opening) return;
    cancelTabMessageSourceJump();
    setError('');
    setOpening(true);
    try {
      const opened = await useWorkspaceStore.getState().openTabById(source.sourceTabId, {
        projectId: source.sourceProjectId, reason: 'tab-message-source',
      });
      if (!opened) throw new Error('Вкладка источника закрыта или недоступна');
      onNavigate?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setOpening(false); }
  };
  return <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0, maxWidth: '100%', ...(row ? { flex: 1, height: '100%' } : {}) }}>
    <button type="button" data-tab-message-source={source.sourceTabId} aria-label={`Открыть источник: ${name}`} disabled={opening}
      title={error || `${name}\n${source.sourceProjectId || '-'}\n${source.sourceTabId}`}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onMouseDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); void navigate(); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%', padding: '2px 6px', border: row ? 0 : `1px solid ${/^#[\da-f]{6}$/i.test(chrome.borderColor) ? chrome.borderColor + '55' : '#555'}`, borderRadius: 4, fontSize: 11, lineHeight: 1.3, textAlign: 'left', ...(row ? { ...requestRowLinkStyle, width: '100%' } : {}), color: hovered ? '#fff' : '#d4d4d4', cursor: opening ? 'wait' : 'pointer', background: row ? hovered ? '#303030' : 'transparent' : flattenRgbaOnTabbarPanel(resolveTabCardBackground({ bgColor: chrome.bgColor, hasColor: !!color && color !== 'default', hovered }, adjustRgbaAlpha)) }}>
      {leadingIcon}
      <Icon size={row ? 12 : 11} strokeWidth={row ? 2.2 : undefined} style={{ flexShrink: 0, color: error ? '#f87171' : row ? rowColor || (incoming ? '#93c5fd' : '#aaa') : chrome.borderColor }} />
      <span style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{name}</span>
    </button>
    {error && !row && <span role="alert" style={{ color: '#fca5a5', fontSize: 10, overflowWrap: 'anywhere' }}>{error}</span>}
  </span>;
}
