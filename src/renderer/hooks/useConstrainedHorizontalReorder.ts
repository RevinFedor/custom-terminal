import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { flushSync } from 'react-dom';
import { horizontalDragAutoScrollDelta } from '../utils/horizontalDragGeometry.mjs';
import { horizontalInsertIndex, moveEntriesToIndex, sameHorizontalOrder } from '../utils/horizontalReorder.mjs';
import { historyForegroundPriority } from '../utils/historyForegroundPriority.mjs';
import { createHorizontalRowDragPreview } from '../utils/horizontalRowDragPreview';
import { acquireInteractionCursor } from '../utils/interactionCursor';

export const HORIZONTAL_ROW_DRAG_START = 'horizontal-row-drag-start';
export const HORIZONTAL_ROW_DRAG_END = 'horizontal-row-drag-end';

type Options = {
  ownerKey: string;
  baseIds: string[];
  containerRef: MutableRefObject<HTMLElement | null>;
  itemSelector: string;
  idAttribute: string;
  onCommit: (nextIds: string[]) => void;
  /** Re-arm when a conditionally rendered row appears after this hook mounted. */
  enabled?: boolean;
};

/** One row owns the pointer. Live movement never renders App or writes store. */
export function useConstrainedHorizontalReorder(options: Options) {
  const { ownerKey, containerRef, itemSelector, idAttribute } = options;
  const enabled = options.enabled !== false;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const activeRef = useRef(false);
  const cancelRef = useRef<() => void>(() => {});
  const baseKey = options.baseIds.join('\u0000');

  // Concurrent close/reorder invalidates the geometry; metadata updates do not.
  useLayoutEffect(() => { cancelRef.current(); }, [baseKey]);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;
    const interactionOwner = 'horizontal-row-drag:' + ownerKey;
    type Chip = { id: string; node: HTMLElement; left: number; right: number; translate: string; transition: string };
    type Gesture = {
      source: HTMLElement; sourceId: string; pointerId: number;
      startX: number; startY: number; x: number; y: number;
      base: string[]; next: string[]; chips: Chip[];
      originLeft: number; viewportLeft: number; viewportRight: number;
      clientWidth: number; scrollWidth: number; gap: number;
      opacity: string; willChange: string; releaseCursor: (() => void) | null;
      preview: ReturnType<typeof createHorizontalRowDragPreview> | null;
      frame: number; lastAt: number; startedAt: number;
      lastFrameAt: number; maxFrameGap: number; resolves: number;
    };
    let gesture: Gesture | null = null;
    let suppressClick = false;

    const finish = (cancelled: boolean, reason: string, eventTime?: number) => {
      const drag = gesture;
      if (!drag) return;
      gesture = null;
      const wasActive = activeRef.current;
      activeRef.current = false;
      cancelAnimationFrame(drag.frame);
      drag.preview?.remove();
      drag.releaseCursor?.();
      if (container.hasPointerCapture(drag.pointerId)) container.releasePointerCapture(drag.pointerId);
      if (!wasActive) return;
      drag.source.style.opacity = drag.opacity;
      drag.source.style.willChange = drag.willChange;
      delete container.dataset.horizontalRowDragging;
      const changed = !sameHorizontalOrder(drag.next, drag.base);
      const committed = !cancelled && changed && sameHorizontalOrder(optionsRef.current.baseIds, drag.base);
      const releaseAt = performance.now();
      try {
        // One durable render, then remove translations before paint. No
        // native drop animation or a timer between release and its result.
        if (committed) flushSync(() => optionsRef.current.onCommit(drag.next));
      } finally {
        drag.chips.forEach(({ node, translate, transition }) => {
          node.style.transition = transition;
          node.style.translate = translate;
        });
        historyForegroundPriority.endInteraction(interactionOwner);
        container.dispatchEvent(new Event(HORIZONTAL_ROW_DRAG_END));
        console.log('[HorizontalRowDnd:drop] owner=' + ownerKey + ' source=' + drag.sourceId.slice(-16)
          + ' input=pointer reason=' + reason + ' cancelled=' + Number(cancelled) + ' committed=' + Number(committed)
          + ' releaseDelayMs=' + Math.max(0, releaseAt - (eventTime ?? releaseAt)).toFixed(1)
          + ' commitMs=' + (performance.now() - releaseAt).toFixed(1)
          + ' maxFrameGapMs=' + drag.maxFrameGap.toFixed(1) + ' resolves=' + drag.resolves);
      }
    };
    cancelRef.current = () => finish(true, 'base-changed');

    const paint = (now: number) => {
      const drag = gesture;
      if (!drag || !activeRef.current) return;
      drag.frame = 0;
      const frameMs = now - drag.lastFrameAt;
      drag.maxFrameGap = Math.max(drag.maxFrameGap, frameMs);
      drag.lastFrameAt = now;
      drag.preview?.move(drag.x, drag.y);
      const autoScroll = horizontalDragAutoScrollDelta({
        clientX: drag.x, viewportLeft: drag.viewportLeft, viewportRight: drag.viewportRight,
        scrollLeft: container.scrollLeft, scrollWidth: drag.scrollWidth, clientWidth: drag.clientWidth,
      });
      if (autoScroll) container.scrollLeft += autoScroll * Math.min(2, Math.max(0.25, frameMs / (1000 / 60)));
      const x = drag.x - drag.viewportLeft + container.scrollLeft;
      const at = horizontalInsertIndex(drag.chips, x, [drag.sourceId]);
      if (at !== drag.lastAt) {
        drag.lastAt = at;
        drag.resolves += 1;
        drag.next = moveEntriesToIndex(drag.base, [drag.sourceId], at, (id: string) => id);
        const byId = new Map(drag.chips.map((chip) => [chip.id, chip]));
        let left = drag.originLeft;
        for (const id of drag.next) {
          const chip = byId.get(id);
          if (!chip) continue;
          chip.node.style.translate = (left - chip.left) + 'px 0';
          left += chip.right - chip.left + drag.gap;
        }
        console.log('[HorizontalRowDnd:resolve] owner=' + ownerKey + ' source=' + drag.sourceId.slice(-16)
          + ' input=pointer at=' + at + ' x=' + drag.x.toFixed(1) + ' yIgnored=1 scrollLeft=' + container.scrollLeft.toFixed(1));
      }
      // Edge scrolling continues while the pointer is held still.
      drag.frame = requestAnimationFrame(paint);
    };

    const start = (drag: Gesture) => {
      const rect = container.getBoundingClientRect();
      drag.viewportLeft = rect.left;
      drag.viewportRight = rect.right;
      drag.clientWidth = container.clientWidth;
      drag.scrollWidth = container.scrollWidth;
      drag.chips = Array.from(container.querySelectorAll<HTMLElement>(itemSelector)).map((node) => {
        return {
          id: node.getAttribute(idAttribute) || '', node,
          // Both row containers establish the offset parent. Pressed scale
          // and a still-finishing translate must not change leased widths.
          left: node.offsetLeft,
          right: node.offsetLeft + node.offsetWidth,
          translate: node.style.translate, transition: node.style.transition,
        };
      });
      if (!sameHorizontalOrder(drag.chips.map((chip) => chip.id), drag.base)) {
        finish(true, 'structure-changed');
        return;
      }
      drag.originLeft = drag.chips[0]?.left || 0;
      drag.gap = drag.chips.length > 1 ? drag.chips[1].left - drag.chips[0].right : 0;
      drag.lastAt = drag.base.indexOf(drag.sourceId);
      drag.preview = createHorizontalRowDragPreview(drag.source);
      drag.preview.move(drag.x, drag.y);
      drag.source.style.opacity = '0.35';
      drag.source.style.willChange = 'translate';
      drag.chips.forEach(({ node }) => { node.style.transition = 'translate 120ms cubic-bezier(0.2, 0, 0, 1)'; });
      drag.releaseCursor = acquireInteractionCursor('grabbing');
      container.dataset.horizontalRowDragging = drag.sourceId;
      activeRef.current = true;
      suppressClick = true;
      container.setPointerCapture(drag.pointerId);
      historyForegroundPriority.beginInteraction(interactionOwner);
      drag.source.dispatchEvent(new Event(HORIZONTAL_ROW_DRAG_START));
      drag.lastFrameAt = performance.now();
      drag.frame = requestAnimationFrame(paint);
      console.log('[HorizontalRowDnd:start] owner=' + ownerKey + ' source=' + drag.sourceId.slice(-16)
        + ' input=pointer axis=x pickupMs=' + (performance.now() - drag.startedAt).toFixed(1));
    };

    const onPointerDown = (event: PointerEvent) => {
      if (gesture || event.button !== 0 || !event.isPrimary) return;
      const target = event.target as HTMLElement | null;
      const source = target?.closest<HTMLElement>(itemSelector);
      if (!source || !container.contains(source) || source.dataset.horizontalReorderDisabled === 'true') return;
      if (target?.closest('input,textarea,select,[contenteditable="true"],[data-no-drag]')) return;
      const sourceId = source.getAttribute(idAttribute) || '';
      const base = optionsRef.current.baseIds.slice();
      if (!base.includes(sourceId)) return;
      gesture = {
        source, sourceId, pointerId: event.pointerId,
        startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
        base, next: base, chips: [], originLeft: 0, viewportLeft: 0, viewportRight: 0,
        clientWidth: 0, scrollWidth: 0, gap: 0, opacity: source.style.opacity,
        willChange: source.style.willChange, releaseCursor: null,
        preview: null, frame: 0, lastAt: -1, startedAt: performance.now(),
        lastFrameAt: 0, maxFrameGap: 0, resolves: 0,
      };
      // Keep ordinary click/double-click targets until the movement threshold.
    };
    const onPointerMove = (event: PointerEvent) => {
      const drag = gesture;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!(event.buttons & 1)) { finish(true, 'buttons-zero', event.timeStamp); return; }
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!activeRef.current && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5) start(drag);
      if (activeRef.current) event.preventDefault();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (gesture?.pointerId !== event.pointerId) return;
      // Commit the painted order, not an unseen mouseup calculation.
      finish(false, 'pointerup', event.timeStamp);
    };
    const onCancel = (event: PointerEvent) => {
      if (gesture?.pointerId === event.pointerId) finish(true, event.type, event.timeStamp);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture) { event.preventDefault(); finish(true, 'escape'); }
    };
    const onBlur = () => finish(true, 'blur');
    const onResize = () => finish(true, 'resize');
    const onClick = (event: MouseEvent) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onNativeDrag = (event: DragEvent) => {
      if ((event.target as HTMLElement | null)?.closest(itemSelector)) event.preventDefault();
    };
    const onNewPress = () => { suppressClick = false; };
    container.addEventListener('pointerdown', onPointerDown, true);
    container.addEventListener('dragstart', onNativeDrag, true);
    container.addEventListener('lostpointercapture', onCancel);
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
    window.addEventListener('pointerdown', onNewPress, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    return () => {
      finish(true, 'unmount');
      container.removeEventListener('pointerdown', onPointerDown, true);
      container.removeEventListener('dragstart', onNativeDrag, true);
      container.removeEventListener('lostpointercapture', onCancel);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerdown', onNewPress, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
    };
  }, [containerRef, enabled, idAttribute, itemSelector, ownerKey]);

  return { activeRef };
}
