import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { acquireInteractionCursor } from './interactionCursor';
import { createHorizontalRowDragPreview } from './horizontalRowDragPreview';
import { historyForegroundPriority } from './historyForegroundPriority.mjs';
import { beginPaneTabDrag, endPaneTabDrag, getPaneTabDragSnapshot,
  paneTabDropTargetContainsPoint, resolvePaneTabDropTarget, setPaneTabDragTarget,
  claimPaneTabDragDrop,
  type PaneTabDragSource } from './paneTabDragBridge';
import { cancelPaneTabPointer, finishPaneTabPointer, updatePaneTabPointer } from './paneTabPointerBridge';
import { commitPaintedPaneTabDrop } from './paneTabDropCommit';
import { clearTabDragNavigationTarget, setTabDragNavigationTarget } from './tabDragNavigationBridge';
import { captureWorkflowDrag,workflowDragRequest,workflowDragSourceValid } from './workflowDragModel.mjs';

type Point = { clientX: number; clientY: number; metaKey: boolean; pointerId: number };
type Gesture = {
  source: PaneTabDragSource; point: Point; frame: number;
  preview: ReturnType<typeof createHorizontalRowDragPreview>;
  releaseCursor: () => void; cleanup: () => void; owner: string;
};
let gesture: Gesture | null = null;
let suppressClick = false;
let clickGuardInstalled = false;

function installClickGuard() {
  if (clickGuardInstalled) return;
  clickGuardInstalled = true;
  window.addEventListener('pointerdown', () => { suppressClick = false; }, true);
  window.addEventListener('click', event => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function finish(cancelled: boolean, reason: string) {
  const drag = gesture;
  if (!drag) return false;
  gesture = null;
  cancelAnimationFrame(drag.frame);
  drag.cleanup();
  // Release consumes the last painted slot. It never resolves an unseen final
  // pointer coordinate. Source DOM may have disappeared during host adoption.
  const target = getPaneTabDragSnapshot().target;
  const inside = !cancelled && target && paneTabDropTargetContainsPoint(target, drag.point.clientX, drag.point.clientY);
  try {
    const adopted = !cancelled && finishPaneTabPointer(drag.point);
    let result:any=null;
    if(inside && !adopted) {
      if(drag.source.workflowDrag) {
        const claimed=claimPaneTabDragDrop(drag.source.rootTabId);
        const request=claimed && workflowDragRequest(drag.source.workflowDrag,{workflowId:target.spaceId || useWorkspaceStore.getState().activeSpaceId,target});
        if(request)void useWorkspaceStore.getState().commitWorkflowDrag(request).then(accepted=>
          console.log('[PaneTabDnd:durable-release] gesture='+drag.source.gestureId+' committed='+Number(accepted)));
      } else result=commitPaintedPaneTabDrop(drag.source.rootTabId);
    }
    if (cancelled) cancelPaneTabPointer();
    console.log('[PaneTabDnd:pointer-release] reason=' + reason + ' source=' + drag.source.rootTabId.slice(-12)
      + ' committed=' + Number(result?.committed || false) + ' at=' + (result?.target?.at ?? '-'));
  } finally {
    endPaneTabDrag(drag.source.rootTabId,drag.source.gestureId);
    clearTabDragNavigationTarget('pane');
    drag.preview.remove();
    drag.releaseCursor();
    historyForegroundPriority.endInteraction(drag.owner);
  }
  return true;
}

export const cancelPaneTabPointerDrag = (reason = 'cancel') => finish(true, reason);

function start(sourceElement: HTMLElement, source: PaneTabDragSource, point: Point) {
  cancelPaneTabPointerDrag('replaced');
  installClickGuard();
  const owner = `pane-pointer-drag:${source.rootTabId}`;
  const gestureId=crypto.randomUUID(),state=useWorkspaceStore.getState();
  const workflowDrag=state.organizationReady ? captureWorkflowDrag(state,{gestureId,origin:'pane',
    sourceId:`reserve-tab:${source.rootTabId}`,entries:source.entries,sourcePaneKey:source.sourcePaneKey}) : null;
  if(state.organizationReady && !workflowDrag)return;
  const drag: Gesture = {
    source: { ...source, input: 'pointer', pointerId: point.pointerId,gestureId,workflowDrag }, point, frame: 0, owner,
    preview: createHorizontalRowDragPreview(sourceElement),
    releaseCursor: acquireInteractionCursor('grabbing', { target: sourceElement, pointerId: point.pointerId }),
    cleanup: () => {},
  };
  gesture = drag;
  let metaHeld=point.metaKey;
  drag.preview.element.dataset.paneTabPointerDragPreview = '1';
  // Navigation progress remains visible above the centred floating chip.
  drag.preview.element.style.zIndex = '99999';
  suppressClick = true;
  beginPaneTabDrag(drag.source);
  historyForegroundPriority.beginInteraction(owner);
  drag.preview.move(point.clientX, point.clientY);

  const paint = () => {
    drag.frame = 0;
    if (gesture !== drag) return;
    const p = drag.point;
    drag.preview.move(p.clientX, p.clientY);
    const pointed = document.elementFromPoint(p.clientX, p.clientY);
    const state = useWorkspaceStore.getState();
    const workflowId = pointed?.closest<HTMLElement>('[data-space-chip]')?.dataset.spaceChip;
    const projectId = pointed?.closest<HTMLElement>('[data-structured-project-drop-target]')?.dataset.projectId;
    if (workflowId || projectId) {
      setPaneTabDragTarget(null);
      setTabDragNavigationTarget('pane', {
        kind: workflowId ? 'workflow' : 'project', id: workflowId || projectId!,
        clientX: p.clientX, clientY: p.clientY,
        blocked: workflowId ? workflowId === state.activeSpaceId
          : projectId === (state.getFocusedProjectId() || state.activeProjectId),
      });
    } else {
      clearTabDragNavigationTarget('pane');
      setPaneTabDragTarget(resolvePaneTabDropTarget(pointed, p.clientX,
        drag.source.entries.map(entry => entry.tabId), p.clientY));
    }
  };
  const schedule = () => { if (!drag.frame) drag.frame = requestAnimationFrame(paint); };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== drag.point.pointerId) return;
    if (!(event.buttons & 1)) { finish(true, 'buttons-zero'); return; }
    event.preventDefault();
    drag.point = { clientX: event.clientX, clientY: event.clientY, metaKey: event.metaKey || metaHeld, pointerId: event.pointerId };
    updatePaneTabPointer(drag.source, drag.point);
    schedule();
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== drag.point.pointerId) return;
    drag.point = { ...drag.point, clientX: event.clientX, clientY: event.clientY };
    finish(false, 'pointerup');
  };
  const cancel = (event: PointerEvent) => { if (event.pointerId === drag.point.pointerId) finish(true, 'pointercancel'); };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(true, 'escape'); return; }
    if (event.key !== 'Meta') return;
    metaHeld=event.type==='keydown';
    drag.point = { ...drag.point, metaKey: metaHeld };
    updatePaneTabPointer(drag.source, drag.point);
    schedule();
  };
  const blur = () => finish(true, 'blur');
  const resize = () => finish(true, 'resize');
  const lostRelease = (event: MouseEvent) => { if (event.buttons === 0) finish(true, 'buttons-zero'); };
  // A projected sidebar row may take capture, and a reflow may replace the
  // original chip. Neither ends this renderer-wide physical gesture.
  const unsubscribe = useWorkspaceStore.subscribe(state => {
    if(drag.source.workflowDrag && !workflowDragSourceValid(drag.source.workflowDrag,state)) {finish(true,'source-admission-changed');return;}
    if (!state.openProjects.get(drag.source.entries[0].projectId)?.tabs.has(drag.source.rootTabId)) finish(true, 'source-removed');
  });
  window.addEventListener('pointermove', move, { capture: true, passive: false });
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('keyup', key, true);
  window.addEventListener('blur', blur);
  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', lostRelease, true);
  drag.cleanup = () => {
    unsubscribe();
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('keyup', key, true);
    window.removeEventListener('blur', blur);
    window.removeEventListener('resize', resize);
    window.removeEventListener('mousemove', lostRelease, true);
  };
  updatePaneTabPointer(drag.source, drag.point);
  schedule();
  console.log('[PaneTabDnd:start] input=pointer tab=' + source.rootTabId.slice(-12) + ' pane=' + source.sourcePaneKey);
}

/** Pending capture belongs to the chip; the active gesture survives its host. */
export function bindPaneTabPointerDrag(element: HTMLElement, getSource: () => PaneTabDragSource, onActivate?: () => void) {
  let pending: Point | null = null;
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if ((event.target as Element)?.closest('button,input,textarea,select,[contenteditable="true"],[data-no-drag]')) return;
    clear();
    pending = { clientX: event.clientX, clientY: event.clientY, metaKey: event.metaKey, pointerId: event.pointerId };
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', clear, true);
    window.addEventListener('pointercancel', clear, true);
    window.addEventListener('blur', clear);
  };
  const move = (event: PointerEvent) => {
    if (!pending || event.pointerId !== pending.pointerId) return;
    if (!(event.buttons & 1)) { pending = null; return; }
    if (Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) < 5) return;
    pending = null;
    clear();
    event.preventDefault();
    onActivate?.();
    start(element, getSource(), { clientX: event.clientX, clientY: event.clientY, metaKey: event.metaKey, pointerId: event.pointerId });
  };
  const clear = () => {
    pending = null;
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', clear, true);
    window.removeEventListener('pointercancel', clear, true);
    window.removeEventListener('blur', clear);
  };
  const noNative = (event: DragEvent) => { event.preventDefault(); };
  element.addEventListener('pointerdown', down);
  element.addEventListener('dragstart', noNative);
  return () => {
    clear();
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('dragstart', noNative);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', clear, true);
    window.removeEventListener('pointercancel', clear, true);
    window.removeEventListener('blur', clear);
  };
}
