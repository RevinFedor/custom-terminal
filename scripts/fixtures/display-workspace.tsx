// Standalone renderer only. The runner installs an in-memory IPC shim before
// this bundle executes. No production modules are replaced by aliases.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TerminalArea from '../../src/renderer/components/Workspace/TerminalArea';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { useProjectsStore } from '../../src/renderer/store/useProjectsStore';
import { paneColumns, paneGridRects, paneTabs, paneChooserSlots } from '../../src/renderer/utils/splitPanesModel.mjs';
import { buildSessionSnapshot } from '../../src/renderer/utils/sessionSnapshot.mjs';
import { emptySpaceLayout } from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import { installSurfaceFontShortcuts, pickDisplaySizes } from '../../src/renderer/utils/displayProfiles.mjs';
import { commitDisplayProfileChange } from '../../src/renderer/utils/displayProfileCommit.mjs';
import { beginPaneTabDrag, endPaneTabDrag, getPaneTabDragSnapshot,
  resolvePaneTabDropTarget, paneTabDropTargetContainsPoint } from '../../src/renderer/utils/paneTabDragBridge';
import '../../src/renderer/styles/globals.css';
import '@noted/claude-blocks/styles.css';

const fixture = (window as any).__displayFixture;
const { projectId, cwd, spaceId, displays, restart } = fixture.boot;
const copy = (value: any) => JSON.parse(JSON.stringify(value));
const ids = ['a', 'b', 'c', 'd'];
const tabId = (window: string, index = 1) => `fixture-${window}-${index}`;
const tabs = new Map(ids.flatMap(id => [1, 2].map(index => {
  const id2 = tabId(id, index);
  return [id2, {
    id: id2, name: `${id.toUpperCase()} · ${index}`, cwd,
    tabType: 'file', filePath: `${cwd}/${id2}.md`,
    // Same no-PTY History transport pattern as history-rewrite-prefix.tsx.
    ...(id2 === tabId('a') ? { commandType: 'codex', codexSessionId: 'fixture-history-session', aiBusy: false } : {}),
  }] as const;
})));
const dormantTabId = 'fixture-dormant-1';
tabs.set(dormantTabId, { id: dormantTabId, name: 'Dormant', cwd,
  tabType: 'file', filePath: `${cwd}/${dormantTabId}.md` });
const initialPanes = ids.map((id, i) => ({
  projectId, tabId: tabId(id), column: Math.min(i, 2),
  tabs: [1, 2].map(index => ({ projectId, tabId: tabId(id, index) })),
}));
const initialSizes = { cols: [0.27, 0.31, 0.42], rows: [[1], [1], [0.37, 0.63]] };
const layout = {
  ...emptySpaceLayout(), activeProjectId: projectId, focusedProjectId: projectId,
  activeSpaceTab: { projectId, tabId: tabId('a') }, splitPanes: initialPanes,
  splitFocusedIndex: 0, splitSizes: initialSizes,
};

// Seed fixture-owned durable records only. Every action after setup remains
// the actual Zustand action, including saveSession/restoreSession/placeTab.
useWorkspaceStore.setState({
  view: 'workspace', activeProjectId: projectId, focusedProjectId: projectId,
  openProjects: new Map([[projectId, {
    projectId, projectPath: cwd, tabs, activeTabId: tabId('a'), tabGroups: [],
    currentView: 'terminal', selectedTabIds: [], tabHistory: [], tabCounter: 9,
    activeGroupId: null, sidebarOpen: false, openFilePath: null,
    sidebarExpandedDirs: null, sidebarScrollTop: 0, tabListScrollTop: 0, viewingSubAgentTabId: null,
  } as any]]),
  activeSpaceId: spaceId,
  spaces: [
    { id: spaceId, name: 'Display fixture', projectIds: [projectId], layout },
    { id: `${spaceId}-dormant`, name: 'Dormant fixture', projectIds: [projectId], layout: {
      ...layout, activeSpaceTab: { projectId, tabId: dormantTabId }, splitSizes: null,
      splitPanes: [{ projectId, tabId: dormantTabId }],
    } },
  ] as any,
  splitPanes: initialPanes, splitFocusedIndex: 0, splitSizes: initialSizes,
  isRestoring: false, workspaceDisplay: null, windowDisplayKey: null, windowDisplayLayouts: {},
});
useProjectsStore.setState({ projects: { [projectId]: { id: projectId, path: cwd, name: 'Display fixture' } } });
useUIStore.setState({ terminalHistoryStreamingEnabled: true, activeArea: 'workspace' });

function setDisplay(key: 'big' | 'small') {
  const display = displays[key];
  // Exactly App's boundary: every History captures before BOTH the font and
  // workspace geometry changes. The fixture host width follows the same commit.
  commitDisplayProfileChange(() => {
    useUIStore.getState().setDisplayContext({ current: display, displays: Object.values(displays) });
    useWorkspaceStore.getState().setWorkspaceDisplay(display);
  }, 'window-display-change');
}
fixture.setDisplay = setDisplay;
fixture.prepareReadingProfiles = () => {
  useUIStore.getState().setDisplayProfileSizes(displays.big.key, { historyFontSize: 16 });
  useUIStore.getState().setDisplayProfileSizes(displays.small.key, { historyFontSize: 18 });
};
fixture.beginDragProbe = () => beginPaneTabDrag({
  owner: 'pane', entries: [{ projectId, tabId: tabId('a', 2) }], rootTabId: tabId('a', 2),
  sourcePaneKey: 'pane:0', sourceSpaceId: spaceId,
});
fixture.endDragProbe = () => endPaneTabDrag(tabId('a', 2));
fixture.dragProbe = () => ({
  active: getPaneTabDragSnapshot().active,
  zones: [...document.querySelectorAll('#fixture-workspace [data-pane-tab-drop-host] > [data-pane-key]')].map(el => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      owner: el.closest('[data-terminal-pane-chrome-host]')?.getAttribute('data-terminal-pane-chrome-host'),
      space: el.getAttribute('data-space-id'), pane: el.getAttribute('data-pane-key'),
      zone: el.getAttribute('data-pane-tab-drop-zone'), pointerEvents: getComputedStyle(el).pointerEvents,
      hitReady: el === hit || (!!hit && el.contains(hit)),
    };
  }),
  strips: [...document.querySelectorAll<HTMLElement>('#fixture-workspace [data-terminal-pane-chrome-host] [data-pane-tab-strip]')].map(el => {
    const rect = el.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    // Pass the real strip even when it is hidden. This probes the actual
    // resolver guard rather than relying on another window covering it.
    const target = resolvePaneTabDropTarget(el, x, [tabId('a', 2)], y);
    return {
      owner: el.closest('[data-terminal-pane-chrome-host]')?.getAttribute('data-terminal-pane-chrome-host'),
      isolated: !!el.closest('[data-pane-focus-isolated="1"]'),
      target, containsPoint: target ? paneTabDropTargetContainsPoint(target, x, y) : false,
    };
  }),
});

const nodeIds = new WeakMap<Element, number>();
let nextNode = 0;
function domRecord(element: Element) {
  if (!nodeIds.has(element)) nodeIds.set(element, ++nextNode);
  const el = element as HTMLElement;
  const r = el.getBoundingClientRect();
  const css = getComputedStyle(el);
  return {
    node: nodeIds.get(el), owner: el.getAttribute('data-terminal-pane-chrome-host'),
    tabId: el.getAttribute('data-terminal-pane-wrapper'),
    presented: el.getAttribute('data-terminal-surface-presented'),
    isolated: el.getAttribute('data-pane-focus-isolated'), ariaHidden: el.getAttribute('aria-hidden'),
    text: el.textContent?.slice(0, 350),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    opacity: css.opacity, display: css.display, pointerEvents: css.pointerEvents,
    tabs: [...el.querySelectorAll('[data-pane-tab-strip] [data-tab-id]')].map(n => n.getAttribute('data-tab-id')),
    chooserCount: el.querySelectorAll('[data-pane-chooser-chip]').length,
  };
}

fixture.snapshot = () => {
  const state = useWorkspaceStore.getState();
  const rects = paneGridRects(state.splitPanes, state.splitSizes);
  return copy({
    display: state.workspaceDisplay, focus: state.splitFocusedIndex,
    activeTab: state.openProjects.get(projectId)?.activeTabId,
    panes: state.splitPanes.map((pane: any, index) => ({
      windowId: pane.windowId, shown: pane.tabId, hidden: pane.displayHidden === true,
      column: pane.column, rect: rects[index],
      tabs: paneTabs(pane).map((tab: any) => tab.tabId),
      chooser: paneChooserSlots(pane), selectedSlotId: pane.selectedSlotId || null,
    })),
    columns: paneColumns(state.splitPanes).map((rows: any[]) => rows.map(({ pane }) => pane.windowId)),
    sizes: state.splitSizes, profiles: state.windowDisplayLayouts,
    chrome: [...document.querySelectorAll('#fixture-workspace [data-terminal-pane-chrome-host]')].map(domRecord),
    surfaces: [...document.querySelectorAll('#fixture-workspace [data-terminal-pane-wrapper]')].map(domRecord),
    fonts: pickDisplaySizes(useUIStore.getState()),
    fontProfiles: useUIStore.getState().displayProfiles,
    viewport: { width: innerWidth, height: innerHeight, visibility: document.visibilityState, frames: fixture.frames },
  });
};
fixture.serialize = () => {
  useWorkspaceStore.getState().saveSessionImmediate({ reason: 'fixture-restart' });
  return copy({
    session: buildSessionSnapshot(useWorkspaceStore.getState()),
    localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
    displayKey: useWorkspaceStore.getState().workspaceDisplay?.key,
  });
};
fixture.historyMetrics = () => [...document.querySelectorAll('#fixture-history .cb-row')].map(row => {
  const bubble = row.querySelector('.cb-user-bubble');
  const col = row.querySelector('.cb-user-col');
  const css = getComputedStyle(row);
  return {
    text: row.textContent?.slice(0, 160), width: row.getBoundingClientRect().width,
    paddingLeft: css.paddingLeft, paddingRight: css.paddingRight, fontSize: css.fontSize,
    bubblePaddingLeft: bubble ? getComputedStyle(bubble).paddingLeft : null,
    bubblePaddingRight: bubble ? getComputedStyle(bubble).paddingRight : null,
    colMaxWidth: col ? getComputedStyle(col).maxWidth : null,
    colWidth: col?.getBoundingClientRect().width,
    actionSize: getComputedStyle(row).getPropertyValue('--cb-message-action-size').trim(),
    collapseLeft: [...row.querySelectorAll('.cb-collapse-top, .cb-collapse-bottom')].map(n => getComputedStyle(n).left),
    visibleInViewport: row.getBoundingClientRect().top >= 0 && row.getBoundingClientRect().bottom <= innerHeight,
  };
});

// Independent oracle: Blink hit-testing identifies a glyph; DOM Range then
// measures that exact UTF-16 position in the identical paragraph. None of the
// production History anchor/capture/measure helpers are used by this oracle.
const readerSelector = '#fixture-history [data-uuid="fixture-reading-row"]';
fixture.captureReading = () => {
  const scroller = document.querySelector('#fixture-history [data-virtuoso-scroller]') as HTMLElement;
  const row = document.querySelector(readerSelector) as HTMLElement;
  const paragraph = row?.querySelector('p');
  if (!scroller || !paragraph) throw new Error('The actual long History paragraph must be mounted');
  const viewport = scroller.getBoundingClientRect();
  const hit = (document as any).caretRangeFromPoint(paragraph.getBoundingClientRect().left + 1, viewport.top + 1) as Range;
  if (!hit || hit.startContainer.nodeType !== Node.TEXT_NODE || !paragraph.contains(hit.startContainer)) {
    throw new Error('Blink caret did not hit the intended History paragraph');
  }
  const node = hit.startContainer as Text;
  const text = node.textContent!;
  const offset = hit.startOffset;
  if (!text.includes('reading0000') || offset < text.length * 0.25 || offset > text.length * 0.75) {
    throw new Error(`Caret must identify the middle of the long paragraph: ${offset}/${text.length}`);
  }
  const selection = window.getSelection()!;
  if (selection.isCollapsed || !row.contains(selection.anchorNode) || !row.contains(selection.focusNode)) {
    throw new Error('Trusted double-click must select text inside the reader row');
  }
  fixture.reading = {
    scroller, row, text, offset,
    glyph: text.slice(offset, offset + 1),
    selection: { anchorNode: selection.anchorNode, focusNode: selection.focusNode,
      anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset, text: selection.toString() },
  };
  fixture.reading.reference = fixture.measureReading();
  return { ...fixture.reading.reference, textLength: text.length, offset,
    excerpt: text.slice(Math.max(0, offset - 40), offset + 80) };
};
fixture.measureReading = () => {
  const source = fixture.reading;
  if (!source) throw new Error('Capture the reading glyph first');
  const scroller = document.querySelector('#fixture-history [data-virtuoso-scroller]') as HTMLElement | null;
  const row = document.querySelector(readerSelector) as HTMLElement | null;
  let node: Node | null = null;
  if (row) {
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    while ((node = walk.nextNode())) if (node.textContent === source.text) break;
  }
  const selection = window.getSelection()!;
  const sameSelection = selection.anchorNode === source.selection.anchorNode
    && selection.focusNode === source.selection.focusNode
    && selection.anchorOffset === source.selection.anchorOffset
    && selection.focusOffset === source.selection.focusOffset
    && selection.toString() === source.selection.text;
  const viewport = scroller?.getBoundingClientRect();
  let glyphRect: DOMRect | null = null;
  if (node) {
    const range = document.createRange();
    range.setStart(node, source.offset); range.setEnd(node, source.offset + 1);
    glyphRect = range.getBoundingClientRect();
  }
  let painted = !!glyphRect?.height;
  for (let el: HTMLElement | null = row; el; el = el.parentElement) {
    const css = getComputedStyle(el);
    if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0) painted = false;
  }
  const loader = !!document.querySelector('#fixture-history [data-history-viewport-loader]');
  if (loader) painted = false;
  return {
    at: performance.now(), sameScroller: scroller === source.scroller, sameRow: row === source.row,
    sameSelection, selection: selection.toString(), exactText: !!node,
    glyph: node?.textContent?.slice(source.offset, source.offset + 1), offset: source.offset,
    screenTop: glyphRect?.top ?? null, screenLeft: glyphRect?.left ?? null,
    viewportOffset: glyphRect && viewport ? glyphRect.top - viewport.top : null,
    scrollerTop: viewport?.top, width: scroller?.clientWidth, scrollTop: scroller?.scrollTop,
    hostWidth: document.querySelector('#fixture-history')?.getBoundingClientRect().width,
    scrollHeight: scroller?.scrollHeight, rowTop: row && viewport ? row.getBoundingClientRect().top - viewport.top : null,
    rowHeight: row?.getBoundingClientRect().height,
    fontSize: row ? parseFloat(getComputedStyle(row).fontSize) : null,
    locked: !!document.querySelector('#fixture-history [data-history-resize-locked]'), loader, painted,
    warningCount: fixture.browserWarnings?.length || 0,
  };
};
fixture.startReadingSamples = () => {
  fixture.readingSamples = [];
  fixture.readingRecording = true;
  const tick = () => {
    if (!fixture.readingRecording || fixture.readingSamples.length > 900) return;
    fixture.readingSamples.push({ phase: 'raf', ...fixture.measureReading() });
    setTimeout(() => {
      if (fixture.readingRecording) fixture.readingSamples.push({ phase: 'post-paint', ...fixture.measureReading() });
    }, 0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
fixture.settleReading = () => new Promise((resolve, reject) => {
  let previous = '', stable = 0, frames = 0;
  const tick = () => {
    const reading = fixture.measureReading();
    const key = JSON.stringify([reading.screenTop, reading.width, reading.fontSize, reading.scrollTop, reading.scrollHeight]);
    stable = !reading.locked && !reading.loader && reading.exactText && key === previous ? stable + 1 : 0;
    previous = key;
    if (stable >= 8) return resolve(reading);
    if (++frames >= 300) return reject(new Error('History did not settle within 300 painted frames'));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

function Controls() {
  const [showHistory, setShowHistory] = useState(false);
  const stateKey = useWorkspaceStore(state => `${state.workspaceDisplay?.key}:${state.splitFocusedIndex}`);
  const historyWidth = useWorkspaceStore(state => state.workspaceDisplay?.internal ? 520 : 820);
  const rightIndex = () => useWorkspaceStore.getState().splitPanes.findIndex((pane, i) => i > 0 && !pane.displayHidden);
  return <>
    <div id="fixture-controls" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, height: 52 }}>
      <b>Per-monitor fixture</b>
      <button data-fixture-display="big" onClick={() => setDisplay('big')}>Big monitor</button>
      <button data-fixture-display="small" onClick={() => setDisplay('small')}>Laptop</button>
      <button data-fixture-chooser onClick={() => useWorkspaceStore.getState().openWindowTabChooser(rightIndex())}>Open chooser</button>
      <button data-fixture-close-chooser onClick={() => {
        const state = useWorkspaceStore.getState();
        const i = rightIndex();
        const slot = paneChooserSlots(state.splitPanes[i])[0];
        if (slot) state.closeWindowTabChooser(i, slot.slotId);
      }}>Close chooser</button>
      <button data-fixture-history onClick={() => setShowHistory(value => !value)}>History probe</button>
      <small data-fixture-state>{stateKey}</small>
    </div>
    <aside id="fixture-sidebar" style={{ position: 'absolute', top: 52, bottom: 0, width: 152, padding: 8, borderRight: '1px solid #444' }}>
      <p>Sidebar → real placeTab</p>
      {Array.from(tabs.values()).map(tab => <button key={tab.id} data-fixture-sidebar-tab={tab.id}
        style={{ display: 'block', width: '100%', marginTop: 6 }}
        onClick={() => useWorkspaceStore.getState().placeTab(projectId, tab.id)}>{tab.name}</button>)}
    </aside>
    <main id="fixture-workspace" style={{ position: 'absolute', display: 'flex', top: 52, left: 160, right: 0, bottom: 0 }}>
      <TerminalArea projectId={projectId} />
    </main>
    {showHistory && <section id="fixture-history" style={{ position: 'absolute', zIndex: 1000, top: 64, left: 178, width: historyWidth, bottom: 12, background: '#19191b' }}>
      <HistoryPanel tabId={tabId('a')} projectId={projectId} sessionId="fixture-history-session"
        cwd={cwd} width={historyWidth} notesPanelWidth={0} isOpen embedded embeddedFill toolType="codex"
        presented preservePresentationGeometry />
    </section>}
  </>;
}

installSurfaceFontShortcuts(window, () => {
  const workspace = useWorkspaceStore.getState();
  const focused = workspace.splitPanes[workspace.splitFocusedIndex];
  return {
    view: workspace.view, activeArea: useUIStore.getState().activeArea,
    tabId: focused?.tabId || null, fallbackSurface: 'file', blocked: false,
  };
}, (surface: any, delta: any) => {
  fixture.fontActions.push({ surface, delta });
  useUIStore.getState().adjustSurfaceFontSizes(surface, delta);
});

async function start() {
  if (restart) {
    // The real restore sanitizes panes and profiles. The fixture's durable
    // project is preloaded above, so this never asks a main process for PTYs.
    await useWorkspaceStore.getState().restoreSession();
    setDisplay(restart.displayKey === displays.small.key ? 'small' : 'big');
  } else setDisplay('big');
  createRoot(document.getElementById('root')!).render(<Controls />);
  requestAnimationFrame(function tick() { fixture.frames++; requestAnimationFrame(tick); });
  fixture.ready = true;
}
start().catch(error => { fixture.bootError = String(error?.stack || error); });
