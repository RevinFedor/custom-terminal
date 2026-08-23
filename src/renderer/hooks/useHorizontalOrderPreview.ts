import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { sameHorizontalOrder } from '../utils/horizontalReorder.mjs';

type RectMap = Map<string, DOMRect>;

export function useHorizontalOrderPreview(
  baseIds: string[],
  containerRef: MutableRefObject<HTMLElement | null>,
  itemSelector: string,
  idAttribute: string,
  options: { duration?: number; easing?: string } = {},
) {
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  const previewRef = useRef<string[] | null>(null);
  const firstRectsRef = useRef<RectMap | null>(null);
  const animationsRef = useRef(new Map<string, Animation>());
  const duration = options.duration ?? 120;
  const easing = options.easing ?? 'cubic-bezier(0.2, 0, 0, 1)';

  const capture = useCallback(() => {
    const root = containerRef.current;
    const rects: RectMap = new Map();
    if (!root) return rects;
    root.querySelectorAll<HTMLElement>(itemSelector).forEach((element) => {
      const id = element.getAttribute(idAttribute) || '';
      if (!id) return;
      rects.set(id, element.getBoundingClientRect());
      const owned = animationsRef.current.get(id);
      if (owned) {
        owned.cancel();
        animationsRef.current.delete(id);
      }
    });
    return rects;
  }, [containerRef, idAttribute, itemSelector]);

  const updatePreview = useCallback((nextIds: string[] | null) => {
    const current = previewRef.current || baseIds;
    const next = nextIds && !sameHorizontalOrder(nextIds, baseIds) ? nextIds : null;
    const effectiveNext = next || baseIds;
    if (sameHorizontalOrder(current, effectiveNext)) return;
    firstRectsRef.current = capture();
    previewRef.current = next;
    setPreviewIds(next);
  }, [baseIds, capture]);

  const clearPreview = useCallback((animate = true) => {
    if (!previewRef.current) return;
    if (animate) firstRectsRef.current = capture();
    else firstRectsRef.current = null;
    previewRef.current = null;
    setPreviewIds(null);
  }, [capture]);

  const displayedIds = previewIds || baseIds;
  const displayedKey = displayedIds.join('\u0000');
  const baseKey = baseIds.join('\u0000');

  useLayoutEffect(() => {
    const first = firstRectsRef.current;
    firstRectsRef.current = null;
    const root = containerRef.current;
    if (!first || !root) return;
    root.querySelectorAll<HTMLElement>(itemSelector).forEach((element) => {
      const id = element.getAttribute(idAttribute) || '';
      const before = first.get(id);
      if (!id || !before) return;
      const after = element.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      const animation = element.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration, easing },
      );
      animationsRef.current.set(id, animation);
      animation.finished.finally(() => {
        if (animationsRef.current.get(id) === animation) animationsRef.current.delete(id);
      }).catch(() => {});
    });
  }, [containerRef, displayedKey, duration, easing, idAttribute, itemSelector]);

  // A durable commit caught up with the painted preview. Drop the temporary
  // owner without another layout change; the visible order is already exact.
  useEffect(() => {
    if (!previewRef.current || !sameHorizontalOrder(previewRef.current, baseIds)) return;
    previewRef.current = null;
    setPreviewIds(null);
  }, [baseKey, baseIds]);

  useEffect(() => () => {
    animationsRef.current.forEach((animation) => animation.cancel());
    animationsRef.current.clear();
  }, []);

  return {
    displayedIds,
    previewIds,
    updatePreview,
    clearPreview,
    previewRef,
  };
}
