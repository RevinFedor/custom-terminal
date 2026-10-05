import { useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, CircleAlert, SquareTerminal } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { adjustRgbaAlpha, flattenRgbaOnTabbarPanel, getTabChromeColorConfig } from './tabChrome';
import { resolveTabCardBackground } from '../../utils/tabCardVisual.mjs';
import { requestRowLinkStyle } from './RequestTrackerRow';

type Source = { sourceTabId: string; sourceTabName?: string | null; sourceProjectId?: string | null };
const { ipcRenderer } = window.require('electron');

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
    setError('');
    setOpening(true);
    try {
      const state = useWorkspaceStore.getState();
      const candidateProjectId = findSourceProject(state, source) || source.sourceProjectId;
      if (!candidateProjectId) throw new Error('Проект источника недоступен');
      if (!state.openProjects.has(candidateProjectId)) {
        const project = await ipcRenderer.invoke('project:getById', candidateProjectId);
        if (!project?.path) throw new Error('Проект источника не найден');
        await state.openProject(candidateProjectId, project.path, { background: true });
      }
      const latest = useWorkspaceStore.getState();
      const currentProjectId = findSourceProject(latest, source);
      if (!currentProjectId) throw new Error('Вкладка источника закрыта');
      latest.placeTab(currentProjectId, source.sourceTabId);
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
