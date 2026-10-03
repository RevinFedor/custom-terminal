import { useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { adjustRgbaAlpha, flattenRgbaOnTabbarPanel, getTabChromeColorConfig } from './tabChrome';
import { resolveTabCardBackground } from '../../utils/tabCardVisual.mjs';

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
export function TabMessageSourceChip({ source, onNavigate }: { source: Source; onNavigate?: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const projectId = useWorkspaceStore(s => findSourceProject(s, source));
  const color = useWorkspaceStore(s => projectId ? s.openProjects.get(projectId)?.tabs.get(source.sourceTabId)?.color : undefined);
  const tabType = useWorkspaceStore(s => projectId ? s.openProjects.get(projectId)?.tabs.get(source.sourceTabId)?.tabType : undefined);
  const chrome = getTabChromeColorConfig({ color, tabType });
  const name = source.sourceTabName || source.sourceTabId;
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
      latest.activateCenterTab(currentProjectId, source.sourceTabId);
      onNavigate?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setOpening(false); }
  };
  return <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0, maxWidth: '100%' }}>
    <button type="button" data-tab-message-source={source.sourceTabId} aria-label={`Открыть источник: ${name}`} disabled={opening}
      title={`${name}\n${source.sourceProjectId || '-'}\n${source.sourceTabId}`}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onMouseDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); void navigate(); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%', padding: '2px 6px', border: `1px solid ${/^#[\da-f]{6}$/i.test(chrome.borderColor) ? chrome.borderColor + '55' : '#555'}`, borderRadius: 4, fontSize: 11, lineHeight: 1.3, textAlign: 'left', color: hovered ? '#fff' : '#d0d0d4', cursor: opening ? 'wait' : 'pointer', background: flattenRgbaOnTabbarPanel(resolveTabCardBackground({ bgColor: chrome.bgColor, hasColor: !!color && color !== 'default', hovered }, adjustRgbaAlpha)) }}>
      <SquareTerminal size={11} style={{ flexShrink: 0, color: chrome.borderColor }} />
      <span style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{name}</span>
    </button>
    {error && <span role="alert" style={{ color: '#fca5a5', fontSize: 10, overflowWrap: 'anywhere' }}>{error}</span>}
  </span>;
}
