import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, RefreshCw, SquareTerminal, X } from 'lucide-react';
import { ComposerChip } from '@noted/claude-blocks';
import { buildPromptChipWrapper } from '../../utils/composerChips.mjs';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { requestTabPrimaryInputFocus } from '../../utils/tabPrimaryInputFocus';
import {
  adjustRgbaAlpha, flattenRgbaOnTabbarPanel, getTabChromeColorConfig,
} from './tabChrome';
import {
  resolveTabCardBackground, resolveTabCardMetrics, TAB_CARD_LINE_HEIGHT,
} from '../../utils/tabCardVisual.mjs';
import { type TabContextUpdate, WORK_CONTEXT_COLOR } from '../../utils/tabWorkContext';

type ContextSourceTab = NonNullable<TabContextUpdate['sourceTabs']>[number];

function ContextSourceTabChip({ source, onNavigate }: {
  source: ContextSourceTab;
  onNavigate: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const projectId = useWorkspaceStore((state) => {
    if (source.projectId && state.openProjects.get(source.projectId)?.tabs.has(source.tabId)) {
      return source.projectId;
    }
    for (const [candidateId, workspace] of state.openProjects) {
      if (workspace.tabs.has(source.tabId)) return candidateId;
    }
    return '';
  });
  const tabExists = useWorkspaceStore((state) => (
    !!projectId && state.openProjects.get(projectId)?.tabs.has(source.tabId)
  ));
  const tabName = useWorkspaceStore((state) => (
    (projectId && state.openProjects.get(projectId)?.tabs.get(source.tabId)?.name) || source.tabName
  ));
  const tabColor = useWorkspaceStore((state) => (
    projectId ? state.openProjects.get(projectId)?.tabs.get(source.tabId)?.color : undefined
  ));
  const tabType = useWorkspaceStore((state) => (
    projectId ? state.openProjects.get(projectId)?.tabs.get(source.tabId)?.tabType : undefined
  ));
  const tabGeometry = useUIStore((state) => state.tabGeometry);
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);
  const metrics = resolveTabCardMetrics(tabGeometry, { fontSize: tabsFontSize });
  const chrome = getTabChromeColorConfig({ color: tabColor, tabType });
  const hasColor = !!tabColor && tabColor !== 'default';
  const background = flattenRgbaOnTabbarPanel(resolveTabCardBackground({
    bgColor: chrome.bgColor,
    hasColor,
    hovered,
  }, adjustRgbaAlpha));
  const navigate = () => {
    if (!tabExists || !projectId) return;
    useUIStore.getState().setActiveArea('workspace');
    useWorkspaceStore.getState().activateCenterTab(projectId, source.tabId);
    requestTabPrimaryInputFocus(source.tabId, 'context-source-tab-click');
    onNavigate();
  };
  return (
    <button
      type="button"
      data-context-source-tab={source.tabId}
      disabled={!tabExists}
      aria-label={tabExists ? `Открыть вкладку ${tabName}` : `Вкладка ${tabName} закрыта`}
      title={tabExists ? `${tabName}\n${source.tabId}` : `${tabName}\nВкладка закрыта`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={navigate}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        maxWidth: '100%',
        padding: metrics.padding,
        border: `1px solid ${chrome.borderColor}55`,
        borderRadius: metrics.borderRadius,
        background,
        color: tabExists ? (hovered ? '#fff' : '#d0d0d4') : '#777',
        fontSize: metrics.fontSize,
        lineHeight: TAB_CARD_LINE_HEIGHT,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        cursor: tabExists ? 'pointer' : 'default',
        opacity: tabExists ? 1 : 0.65,
      }}
    >
      <SquareTerminal size={11} style={{ flexShrink: 0, color: chrome.borderColor }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {tabName}
      </span>
    </button>
  );
}

function contextUpdateBody(update: TabContextUpdate) {
  if (!(update.sourceTabs?.length || update.hasUnknownSource)) return update.text;
  return update.text.replace(/^Sources:[^\n]*\n\n/, '');
}

export function TabContextUpdateChip({ tabId, update, onDismiss }: {
  tabId: string;
  update: TabContextUpdate;
  onDismiss: (update: TabContextUpdate) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!open) return;
    setRect(anchor.current?.getBoundingClientRect() || null);
    const outside = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside, true);
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', outside, true); window.removeEventListener('resize', close); };
  }, [open]);
  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    try { await onDismiss(update); }
    catch (error: any) { useUIStore.getState().showToast(error.message, 'error'); }
    finally { setBusy(false); }
  };
  const sources = update.sourceTabs?.length
    ? update.sourceTabs
    : update.sourceTabId
      ? [{ tabId: update.sourceTabId, tabName: update.sourceTabId }]
      : [];
  return <>
    <span ref={anchor} className="hp-context-update-chip-slot" data-context-update-id={update.id}
      style={{ position: 'relative', display: 'inline-flex' }}
      onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); void dismiss(); } }}
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
      onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
      <ComposerChip kind="prompt" label={update.title} leading={<RefreshCw size={12} />}
        title={[update.title, update.path].filter(Boolean).join('\n') || 'Обновление рабочего состояния'}
        style={{ color: WORK_CONTEXT_COLOR, borderColor: '#8d612c', background: '#2c2419', opacity: busy ? 0.55 : 1, transition: 'opacity 120ms ease' }}
        onClick={() => setOpen((value) => !value)}
        trailing={<>
          <button type="button" className="hp-composer-chip-action" title="Перенести в input" aria-label="Перенести обновление в input"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              const store = useUIStore.getState();
              const draft = store.historyPromptDrafts[tabId] || '';
              const wrapper = buildPromptChipWrapper({ label: update.title, text: update.text, contextUpdateId: update.id });
              if (!draft.includes('context-update-id="' + update.id + '"')) {
                store.setHistoryPromptDraft(tabId, [draft, wrapper].filter(Boolean).join('\n\n'), { preserveChips: true, preserveImages: true });
              }
              setOpen(false);
            }}><ArrowDownToLine size={11} /></button>
          <button type="button" className="hp-composer-chip-action hp-composer-chip-action-danger" title="Убрать обновление" aria-label="Убрать обновление"
            disabled={busy}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => { event.stopPropagation(); void dismiss(); }}><X size={11} /></button>
        </>} />
    </span>
    {open && rect && createPortal(<div ref={popover} role="dialog" aria-label={update.title}
      style={{ position: 'fixed', zIndex: 30000,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(600, window.innerWidth - 16) - 8)),
        top: rect.top < 180 ? rect.bottom + 6 : undefined,
        bottom: rect.top >= 180 ? window.innerHeight - rect.top + 6 : undefined,
        width: 'min(600px, calc(100vw - 16px))', boxSizing: 'border-box',
        maxHeight: Math.max(60, Math.min(window.innerHeight * 0.55, rect.top >= 180 ? rect.top - 16 : window.innerHeight - rect.bottom - 16)),
        overflow: 'auto', background: '#191919', color: '#ddd', border: '1px solid #8d612c',
        borderRadius: 5, padding: 12, boxShadow: '0 6px 25px #0008' }}>
      <div data-context-update-summary style={{ color: WORK_CONTEXT_COLOR, marginBottom: 8 }}>{update.title}</div>
      {(sources.length > 0 || update.hasUnknownSource) && (
        <div data-context-update-sources style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {sources.map((source) => (
            <ContextSourceTabChip key={source.tabId} source={source} onNavigate={() => setOpen(false)} />
          ))}
          {update.hasUnknownSource && (
            <span data-context-source-external style={{
              display: 'inline-flex', alignItems: 'center', minHeight: 24, padding: '2px 7px',
              border: '1px dashed #8d612c', borderRadius: 5, color: '#b9a27e',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: 12,
            }}>
              Внешнее изменение
            </span>
          )}
        </div>
      )}
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, lineHeight: 1.5, margin: 0 }}>{contextUpdateBody(update)}</pre>
    </div>, document.body)}
  </>;
}
