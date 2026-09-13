import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { acquireInteractionCursor } from '../utils/interactionCursor';

type Drag = { phase: string; sessionId: string; sourceId: string | number; pointerId: number };

// The outline already captures its source row. Use the same row, including
// the projected source after project navigation; never capture the whole pane.
export function useOutlineDragCursor(drag: Drag | null, scroller: RefObject<HTMLElement | null>) {
  const owner = useRef<{ target: HTMLElement; sessionId: string; release: () => void } | null>(null);
  const releasedSession = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = drag ? `${typeof drag.sourceId}:${String(drag.sourceId)}` : '';
    const target = drag?.phase === 'dragging' && releasedSession.current !== drag.sessionId
      ? scroller.current?.querySelector<HTMLElement>(`[data-outline-dnd-key="${CSS.escape(key)}"]`) ?? null
      : null;
    if (owner.current?.target === target && owner.current?.sessionId === drag?.sessionId) return;
    owner.current?.release();
    owner.current = null;
    if (!target || !drag) return;
    const started = performance.now();
    const releaseCursor = acquireInteractionCursor('grabbing', { target, pointerId: drag.pointerId });
    console.log(`[TabDnd:cursor] phase=acquire owner=source-row session=${drag.sessionId} setupMs=${(performance.now() - started).toFixed(1)}`);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const cleanupStarted = performance.now();
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onEnd, true);
      window.removeEventListener('blur', onBlur);
      releaseCursor();
      console.log(`[TabDnd:cursor] phase=release session=${drag.sessionId} cleanupMs=${(performance.now() - cleanupStarted).toFixed(1)}`);
    };
    const onEnd = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      releasedSession.current = drag.sessionId;
      release();
    };
    const onBlur = () => { releasedSession.current = drag.sessionId; release(); };
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('pointercancel', onEnd, true);
    window.addEventListener('blur', onBlur);
    owner.current = { target, sessionId: drag.sessionId, release };
  });
  useLayoutEffect(() => () => {
    owner.current?.release();
    owner.current = null;
  }, []);
}
