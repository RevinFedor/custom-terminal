import React, { Profiler, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { useOutlineDnd } from '@noted/structured-dnd/react';
import TabDragNavigationController from '../../src/renderer/components/Workspace/TabDragNavigationController';
import SidebarTabDragCursorChip from '../../src/renderer/components/Workspace/SidebarTabDragCursorChip';
import { useOutlineDragCursor } from '../../src/renderer/hooks/useOutlineDragCursor';
import { setTabDragNavigationTarget, clearTabDragNavigationTarget, getTabDragNavigationSnapshot } from '../../src/renderer/utils/tabDragNavigationBridge';
import { beginSidebarTabDrag, endSidebarTabDrag, updateSidebarTabDragPointer,
  getSidebarTabDragSessionSnapshot, subscribeSidebarTabDragSession } from '../../src/renderer/utils/sidebarTabDragBridge.mjs';

const w = window as any;
w.calls = []; w.commits = []; w.counts = { outline: 0, observers: 0, indicator: 0 };
const sourceNode = { id: 'a', label: 'Parent + children', kind: 'file', expanded: true, children: [] };
function Observer() {
  useSyncExternalStore(subscribeSidebarTabDragSession, getSidebarTabDragSessionSnapshot, getSidebarTabDragSessionSnapshot);
  w.counts.observers++;
  return null;
}
function Fixture() {
  w.counts.outline++;
  const [outline, setOutline] = useState([sourceNode, { id: 'b', kind: 'file', children: [] },
    { id: 'folder', label: 'Folder', kind: 'folder', collapsible: true, hasChildren: true, expanded: false,
      children: [{ id: 'child', kind: 'file', children: [] }] }]);
  const dnd = useOutlineDnd({ outline, outsidePointerPolicy: 'horizontal-corridor', layoutAnimation: { duration: 0 },
    folderDwellInterval: 500,
    resolveExternalTarget: p => {
      const chip = document.elementFromPoint(p.clientX, p.clientY)?.closest<HTMLElement>('[data-target]');
      return p.metaKey && chip ? { id: chip.dataset.target, kind: chip.dataset.kind,
        clientX: p.clientX, clientY: p.clientY, blocked: chip.dataset.blocked === 'true' } : null;
    },
    onExpansionRequest: ({ nodeId, expanded }) => setOutline(rows => rows.map(r => r.id === nodeId ? { ...r, expanded } : r)),
    onCommit: p => { w.commits.push('outline'); setOutline(p.previewOutline); return true; },
    onExternalCommit: () => false,
  });
  useOutlineDragCursor(dnd.dragState, dnd.scrollerRef);
  useLayoutEffect(() => { w.state = dnd.dragState; w.order = dnd.rows.map(r => r.id); });
  useEffect(() => {
    const drag = dnd.dragState;
    if (drag?.phase !== 'dragging') { clearTabDragNavigationTarget('sidebar'); return; }
    beginSidebarTabDrag({ sessionId: drag.sessionId, sourceProjectId: 'fixture', sourceId: 'a',
      sourceNode, rootTabId: 'a', tabIds: ['a', 'a-child'], pointerId: drag.pointerId,
      clientX: drag.pointerX, clientY: drag.pointerY, metaKey: drag.navigationMode });
    if (drag.externalTarget) setTabDragNavigationTarget('sidebar', drag.externalTarget);
    else clearTabDragNavigationTarget('sidebar');
  }, [dnd.dragState]);
  return <>
    <div ref={dnd.scrollerRef} id="sidebar" style={{ position: 'absolute', left: 20, top: 100, width: 300, height: 360,
      overflow: 'auto', userSelect: 'none', touchAction: 'none' }}>
      {dnd.rows.map(row => <div key={row.id} {...dnd.getRowProps(row)} data-row={row.id}
        style={{ height: 40, border: '1px solid #575', boxSizing: 'border-box', paddingLeft: row.depth * 14 }}>{row.id}</div>)}
      <div {...dnd.scrollSpacerProps}/>
    </div>
    <button data-target="workflow-b" data-kind="workflow" style={{ left: 370 }}>Workflow B</button>
    <button data-target="project-b" data-kind="project" style={{ left: 580 }}>Project B</button>
    <button data-target="blocked" data-kind="project" data-blocked="true" style={{ left: 790 }}>Current project</button>
    {Array.from({ length: 20 }, (_, i) => <Observer key={i}/>)}
    <SidebarTabDragCursorChip enabled/>
    <Profiler id="indicator" onRender={() => w.counts.indicator++}>
      <TabDragNavigationController onNavigateProject={id => { w.calls.push({ kind: 'project', id, at: performance.now() }); }}/>
    </Profiler>
  </>;
}
const host = createRoot(document.getElementById('fixture')!);
host.render(<Fixture/>);
w.cleanup = () => { clearTabDragNavigationTarget(); endSidebarTabDrag(); };
w.snapshot = getTabDragNavigationSnapshot;
w.unmount = () => host.unmount();
// Controlled causal input: same resolver/bridge packets, actual indicator and
// subscribers. Separate trusted pointer cases exercise the outline below.
w.motion = async () => {
  const before = { ...w.counts };
  beginSidebarTabDrag({ sessionId: 'motion', sourceProjectId: 'fixture', sourceId: 'a', sourceNode,
    rootTabId: 'a', tabIds: ['a', 'a-child'], clientX: 400, clientY: 45, metaKey: true });
  for (let i = 0; i < 45; i++) {
    updateSidebarTabDragPointer({ sessionId: 'motion', clientX: 400 + i, clientY: 45 });
    setTabDragNavigationTarget('pane', { kind: 'workflow', id: 'motion', clientX: 400 + i, clientY: 45 });
    await new Promise(r => requestAnimationFrame(r));
  }
  const indicator = document.querySelector('[data-tab-drag-navigation-indicator]')!;
  const rect = indicator.getBoundingClientRect();
  const result = { counts: Object.fromEntries(Object.entries(w.counts).map(([k, v]) => [k, Number(v) - before[k]])),
    point: { x: rect.x + 12, y: rect.y + 12 }, latest: getTabDragNavigationSnapshot().target };
  w.cleanup();
  return result;
};
