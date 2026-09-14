import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelsTopLeft } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { paneSlots } from '../../utils/splitPanesModel.mjs';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { getTabChromeColorConfig } from './tabChrome';
import { TabProcessBar, useTabActivitySignals } from './TabSignals';

type PreviewTab = { id: string; name: string; color?: string; tabType?: string; chooser?: boolean };
function WindowTabActivity({ tabId }: { tabId: string }) {
  const activity = useTabActivitySignals(tabId);
  return <TabProcessBar {...activity} radius={4} />;
}
function WindowTabPreview({ tab, shown }: { tab: PreviewTab; shown: boolean }) {
  const chrome = getTabChromeColorConfig(tab as any);
  return <span style={{ position: 'relative', fontSize: 11, padding: '2px 6px',
    borderRadius: 4, border: `1px solid ${chrome.borderColor}`, background: chrome.bgColor,
    color: shown ? '#eee' : '#aaa' }}>
    {!tab.chooser && <WindowTabActivity tabId={tab.id} />}{tab.name}
  </span>;
}

/** First click chooses this physical slot; second chooses an entire window. */
export default function HiddenWindowPicker({ paneIndex, spaceId }: { paneIndex: number; spaceId: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ windowId: string; spaceId: string; displayKey: string | null } | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const key = useWorkspaceStore(state => {
    if (state.activeSpaceId !== spaceId) return '[]';
    return JSON.stringify(state.splitPanes.filter(p => p.displayHidden).map(pane => ({
      id: pane.windowId,
      shownTabId: pane.selectedSlotId || pane.tabId,
      tabs: paneSlots(pane).map((tab: any) => tab.slotId ? {
        id: tab.slotId, name: 'Новая вкладка', chooser: true,
      } : ({
        id: tab.tabId,
        name: state.openProjects.get(tab.projectId)?.tabs.get(tab.tabId)?.name || 'Вкладка',
        color: state.openProjects.get(tab.projectId)?.tabs.get(tab.tabId)?.color,
        tabType: state.openProjects.get(tab.projectId)?.tabs.get(tab.tabId)?.tabType,
      })),
    })));
  });
  const windows: Array<{ id: string; shownTabId: string; tabs: PreviewTab[] }> = JSON.parse(key);
  const activeSpaceId = useWorkspaceStore(state => state.activeSpaceId);
  const displayKey = useWorkspaceStore(state => state.windowDisplayKey);
  useEffect(() => { setTarget(null); }, [activeSpaceId, displayKey]);
  useEffect(() => {
    if (!target) return;
    const dismiss = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setTarget(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setTarget(null); button.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [target]);
  useLayoutEffect(() => {
    if (!target || !button.current || !popup.current) return;
    const anchor = button.current.getBoundingClientRect();
    const rect = popup.current.getBoundingClientRect();
    const next = clampMenuToViewport({ x: anchor.right - rect.width, y: anchor.bottom + 4,
      width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    setPosition(previous => previous.left === next.x && previous.top === next.y
      ? previous : { left: next.x, top: next.y });
  }, [target, key]);
  if (!windows.length) return null;
  return <>
    <button ref={button} type="button" data-hidden-window-picker-button data-split-button
      aria-label={`Скрытые окна: ${windows.length}`} aria-expanded={!!target} aria-haspopup="dialog"
      title={`Показать другое окно · скрытых ${windows.length}`}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        if (target) { setTarget(null); return; }
        const state = useWorkspaceStore.getState();
        const pane = state.splitPanes[paneIndex];
        if (state.activeSpaceId === spaceId && pane?.windowId && !pane.displayHidden) {
          setTarget({ windowId: pane.windowId, spaceId, displayKey: state.windowDisplayKey });
        }
      }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'stretch', flexShrink: 0,
        padding: '0 6px', border: 0, borderRadius: 4, cursor: 'pointer', fontSize: 11,
        background: target ? '#34343a' : 'transparent', color: '#b8b8c2' }}>
      <PanelsTopLeft size={14} /><span>{windows.length}</span>
    </button>
    {target && createPortal(<div ref={popup} role="dialog" aria-label="Скрытые окна"
      data-hidden-window-picker style={{ position: 'fixed', ...position, zIndex: 100060,
        width: 'min(360px, calc(100vw - 16px))', maxHeight: 'min(560px, calc(100vh - 16px))',
        overflowY: 'auto', padding: 5, background: '#242427', border: '1px solid #444', borderRadius: 7,
        boxShadow: '0 8px 24px #0008' }}>
      {windows.map(candidate => <button key={candidate.id} type="button" data-hidden-window-id={candidate.id}
        onClick={event => {
          event.stopPropagation();
          const state = useWorkspaceStore.getState();
          const index = state.splitPanes.findIndex(p => p.windowId === target.windowId && !p.displayHidden);
          if (state.activeSpaceId === target.spaceId && state.windowDisplayKey === target.displayKey && index >= 0) state.showHiddenWindow(index, candidate.id);
          setTarget(null);
        }}
        style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', padding: 8,
          border: '1px solid #414148', borderRadius: 5, margin: '3px 0', color: '#ddd', background: '#1b1b1f' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
          {candidate.tabs.find(tab => tab.id === candidate.shownTabId)?.name || 'Нет вкладки'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {candidate.tabs.map(tab => <WindowTabPreview key={tab.id} tab={tab} shown={tab.id === candidate.shownTabId} />)}
        </div>
      </button>)}
    </div>, document.body)}
  </>;
}
