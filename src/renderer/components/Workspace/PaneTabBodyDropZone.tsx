import React, { useEffect, useRef } from 'react';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import {
  beginPaneTabDrag,
  endPaneTabDrag,
  getPaneTabDragSnapshot,
  paneStripKey,
  paneTabSourceFromDragData,
  PANE_TAB_DND_TYPE,
  setPaneTabDragTarget,
  usePaneTabDragSnapshot,
  type PaneTabDropTarget,
} from '../../utils/paneTabDragBridge';
import { commitPaintedPaneTabDrop } from '../../utils/paneTabDropCommit';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

export default function PaneTabBodyDropZone({ paneIndex }: { paneIndex: number | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = usePaneTabDragSnapshot();
  const key = paneStripKey(paneIndex);
  const activeSpaceId = useWorkspaceStore((state) => state.activeSpaceId);
  const target: PaneTabDropTarget = {
    zone: 'body',
    paneKey: key,
    paneIndex,
    spaceId: activeSpaceId,
    at: Number.POSITIVE_INFINITY,
  };
  const targeted = drag.active
    && drag.target?.paneKey === key
    && drag.target?.zone === 'body';

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    return dropTargetForElements({
      element,
      getData: () => ({ type: 'PANE_TAB_BODY_TARGET', paneKey: key, paneIndex }),
      canDrop: ({ source }) => source.data.type === PANE_TAB_DND_TYPE,
      onDragEnter: ({ source }) => {
        const sourceState = paneTabSourceFromDragData(source.data as Record<string, unknown>);
        if (!sourceState) return;
        beginPaneTabDrag(sourceState);
        setPaneTabDragTarget(target);
      },
      onDrag: ({ source }) => {
        const sourceState = paneTabSourceFromDragData(source.data as Record<string, unknown>);
        if (!sourceState) return;
        beginPaneTabDrag(sourceState);
        setPaneTabDragTarget(target);
      },
      onDragLeave: () => {
        const current = getPaneTabDragSnapshot();
        if (current.target?.paneKey === key && current.target?.zone === 'body') setPaneTabDragTarget(null);
      },
      onDrop: ({ source }) => {
        const sourceState = paneTabSourceFromDragData(source.data as Record<string, unknown>);
        const result = sourceState ? commitPaintedPaneTabDrop(sourceState.rootTabId) : null;
        if (sourceState) {
          console.log('[PaneTabDnd:drop] source=' + sourceState.rootTabId.slice(-12)
            + ' owner=body pane=' + key
            + ' claimed=' + (result?.claimed ? 1 : 0)
            + ' committed=' + (result?.committed ? 1 : 0));
        }
        endPaneTabDrag(sourceState?.rootTabId);
      },
    });
  }, [activeSpaceId, key, paneIndex]);

  return (
    <div
      ref={ref}
      data-pane-tab-drop-zone="body"
      data-pane-key={key}
      data-space-id={activeSpaceId}
      data-pane-drop-active={targeted ? '1' : undefined}
      aria-hidden
      style={{
        position: 'absolute',
        inset: 6,
        zIndex: 260,
        pointerEvents: drag.active ? 'auto' : 'none',
        border: targeted ? '2px dashed #a78bfa' : '2px dashed transparent',
        borderRadius: 10,
        background: targeted ? 'rgba(124,58,237,0.10)' : 'transparent',
        boxShadow: targeted ? 'inset 0 0 0 1px rgba(255,255,255,0.06)' : 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: targeted ? '#ddd6fe' : 'transparent',
        fontSize: 12,
        fontWeight: 650,
        letterSpacing: 0.2,
        transition: 'border-color 80ms ease-out, background 80ms ease-out, color 80ms ease-out',
      }}
    >
      {targeted ? 'В конец окна' : ''}
    </div>
  );
}
