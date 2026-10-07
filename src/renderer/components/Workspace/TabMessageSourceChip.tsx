import { useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, CircleAlert, SquareTerminal } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { adjustRgbaAlpha, flattenRgbaOnTabbarPanel, getTabChromeColorConfig } from './tabChrome';
import { resolveTabCardBackground } from '../../utils/tabCardVisual.mjs';
import { requestRowLinkStyle } from './RequestTrackerRow';
import { cancelTabMessageSourceJump, jumpToTabMessageSource } from '../../utils/tabMessageSourceJump';
import { useUIStore } from '../../store/useUIStore';

type Source = { sourceTabId: string; sourceTabName?: string | null; sourceProjectId?: string | null; messageId?: string };

export function HistoryPromptSource({ source, phase, onNavigate }: {
  source: Partial<Source> & { label?: string }; phase?: string; onNavigate?: () => void;
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
  const iconStyle = { display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0, color: '#a3a3a3' };
  return <div data-history-tab-message-source style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 6 }}>
    {Icon && (source.messageId && source.sourceTabId ? <button type="button"
      data-history-source-direction={direction} data-tab-message-source-jump={source.messageId}
      aria-label={`Перейти к вызову MCP: ${source.sourceTabName || source.sourceTabId}`} aria-busy={jumping}
      title="Перейти к исходному вызову MCP" onMouseDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); void jump(); }}
      style={{ ...iconStyle, padding: 0, border: 0, borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>
      <Icon size={14} strokeWidth={2.2} aria-hidden="true" />
    </button> : <span data-history-source-direction={direction}
      title={incoming ? 'Запрос к вам' : 'Ответ на ваш запрос'}
      style={iconStyle}>
      <Icon size={14} strokeWidth={2.2} aria-hidden="true" />
    </span>)}
    {source.sourceTabId ? <TabMessageSourceChip source={source as Source} onNavigate={onNavigate} />
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
