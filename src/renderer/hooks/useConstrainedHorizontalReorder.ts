import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import {
  createHorizontalDragGeometryCache,
  horizontalDragAutoScrollDelta,
} from '../utils/horizontalDragGeometry.mjs';
import { moveEntriesToIndex, sameHorizontalOrder } from '../utils/horizontalReorder.mjs';

type HorizontalPreviewController = {
  previewRef: MutableRefObject<string[] | null>;
  updatePreview: (nextIds: string[] | null) => void;
  clearPreview: (animate?: boolean) => void;
};

type ConstrainedHorizontalReorderOptions = {
  sourceType: string;
  ownerKey: string;
  baseIds: string[];
  containerRef: MutableRefObject<HTMLElement | null>;
  itemSelector: string;
  idAttribute: string;
  preview: HorizontalPreviewController;
  onCommit: (nextIds: string[]) => void;
};

/**
 * Sort a one-dimensional row while allowing the physical pointer to leave it.
 *
 * Project and workflow chips never have a meaningful vertical destination:
 * their only legal owner is the row they started in. The native pointer can be
 * far above/below the row, but only clientX participates in slot resolution.
 * Geometry is leased once per gesture so the animated preview cannot move its
 * own midpoint and reverse itself under a stationary pointer.
 */
export function useConstrainedHorizontalReorder({
  sourceType,
  ownerKey,
  baseIds,
  containerRef,
  itemSelector,
  idAttribute,
  preview,
  onCommit,
}: ConstrainedHorizontalReorderOptions) {
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const geometryRef = useRef(createHorizontalDragGeometryCache());
  const baseIdsRef = useRef(baseIds);
  const dragBaseIdsRef = useRef<string[]>([]);
  const previewRef = useRef(preview);
  const commitRef = useRef(onCommit);
  const activeSourceRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const lastAtRef = useRef<number | null>(null);

  baseIdsRef.current = baseIds;
  previewRef.current = preview;
  commitRef.current = onCommit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const begin = (sourceId: string) => {
      if (!sourceId || activeSourceRef.current === sourceId) return;
      geometryRef.current.clear(ownerKey);
      dragBaseIdsRef.current = baseIdsRef.current.slice();
      activeSourceRef.current = sourceId;
      cancelledRef.current = false;
      lastAtRef.current = null;
      setActiveSourceId(sourceId);
      console.log(`[HorizontalRowDnd:start] owner=${ownerKey} source=${sourceId.slice(-16)} axis=x`);
    };

    const finish = (sourceId: string) => {
      if (!sourceId || activeSourceRef.current !== sourceId) return;
      const controller = previewRef.current;
      const next = controller.previewRef.current;
      const base = dragBaseIdsRef.current;
      const changed = !!next && !sameHorizontalOrder(next, base);
      const committed = !cancelledRef.current && changed;
      if (committed && next) commitRef.current(next);
      controller.clearPreview(committed ? false : true);
      console.log(`[HorizontalRowDnd:drop] owner=${ownerKey} source=${sourceId.slice(-16)}`
        + ` cancelled=${cancelledRef.current ? 1 : 0}`
        + ` changed=${changed ? 1 : 0} committed=${committed ? 1 : 0}`);
      geometryRef.current.clear(ownerKey);
      activeSourceRef.current = null;
      dragBaseIdsRef.current = [];
      cancelledRef.current = false;
      lastAtRef.current = null;
      setActiveSourceId(null);
    };

    const cleanupDnd = combine(
      dropTargetForElements({
        element: container,
        getData: () => ({ type: 'CONSTRAINED_HORIZONTAL_ROW', ownerKey }),
        canDrop: ({ source }) => source.data.type === sourceType,
      }),
      monitorForElements({
        canMonitor: ({ source }) => source.data.type === sourceType,
        onDragStart: ({ source }) => {
          begin(String(source.data.id || ''));
        },
        onDrag: ({ source, location }) => {
          const sourceId = String(source.data.id || '');
          begin(sourceId);
          if (!sourceId || cancelledRef.current) return;
          const base = dragBaseIdsRef.current;
          if (!base.includes(sourceId)) return;

          const rect = container.getBoundingClientRect();
          const clientX = Number(location.current.input.clientX) || 0;
          const clientY = Number(location.current.input.clientY) || 0;
          const autoScrollDelta = horizontalDragAutoScrollDelta({
            clientX,
            viewportLeft: rect.left,
            viewportRight: rect.right,
            scrollLeft: container.scrollLeft,
            scrollWidth: container.scrollWidth,
            clientWidth: container.clientWidth,
          });
          if (autoScrollDelta) container.scrollLeft += autoScrollDelta;

          const at = geometryRef.current.resolve({
            ownerKey,
            excludedIds: [sourceId],
            clientX,
            viewportLeft: rect.left,
            scrollLeft: container.scrollLeft,
            readChips: () => Array.from(container.querySelectorAll<HTMLElement>(itemSelector)).map((node) => {
              const chipRect = node.getBoundingClientRect();
              return {
                id: node.getAttribute(idAttribute) || '',
                left: chipRect.left,
                right: chipRect.right,
              };
            }),
          });
          const next = moveEntriesToIndex(base, [sourceId], at, (id) => id);
          previewRef.current.updatePreview(next);
          if (lastAtRef.current !== at) {
            lastAtRef.current = at;
            const rowCenterY = rect.top + rect.height / 2;
            console.log(`[HorizontalRowDnd:resolve] owner=${ownerKey} source=${sourceId.slice(-16)}`
              + ` at=${at} centerX=${clientX.toFixed(1)}`
              + ` pointerY=${clientY.toFixed(1)} rowCenterY=${rowCenterY.toFixed(1)}`
              + ` yIgnored=1 scrollLeft=${container.scrollLeft.toFixed(1)}`
              + ` autoScroll=${autoScrollDelta.toFixed(1)}`);
          }
        },
        onDrop: ({ source }) => {
          finish(String(source.data.id || ''));
        },
      }),
    );

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !activeSourceRef.current) return;
      cancelledRef.current = true;
      previewRef.current.clearPreview(true);
      geometryRef.current.clear(ownerKey);
      console.log(`[HorizontalRowDnd:cancel] owner=${ownerKey} source=${activeSourceRef.current.slice(-16)}`);
    };
    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      cleanupDnd();
      window.removeEventListener('keydown', onKeyDown, true);
      geometryRef.current.clear(ownerKey);
    };
  }, [containerRef, idAttribute, itemSelector, ownerKey, sourceType]);

  return {
    active: activeSourceId !== null,
    activeSourceId,
  };
}
