import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { acquireInteractionCursor } from '../utils/interactionCursor';

type EndReason = 'up' | 'cancel' | 'blur' | 'lost-capture' | 'escape' | 'dispose';
type Options = {
  cursor: string;
  onMove: (event: PointerEvent) => void;
  onEnd?: (reason: EndReason, event?: PointerEvent) => void;
};

// A resize owns only its handle. Inherited body styles wake every retained
// History, even when the actual width update concerns a tiny popup.
export function startPointerGesture(event: ReactPointerEvent<HTMLElement>, options: Options) {
  if (event.button !== 0) return () => {};
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget;
  const pointerId = event.pointerId;
  const releaseCursor = acquireInteractionCursor(options.cursor, { target, pointerId });
  let finished = false;
  const finish = (reason: EndReason, endEvent?: PointerEvent) => {
    if (finished) return;
    finished = true;
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('blur', blur);
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('lostpointercapture', lost, true);
    releaseCursor();
    options.onEnd?.(reason, endEvent);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    e.preventDefault();
    options.onMove(e);
  };
  const up = (e: PointerEvent) => { if (e.pointerId === pointerId) finish('up', e); };
  const cancel = (e: PointerEvent) => { if (e.pointerId === pointerId) finish('cancel', e); };
  const lost = (e: PointerEvent) => {
    // Blink delivers loss to document when a popup removes its captured
    // handle without unmounting the component that owns this hook.
    if (e.pointerId === pointerId && (e.target === target || (!target.isConnected && e.target === document))) {
      finish('lost-capture', e);
    }
  };
  const blur = () => finish('blur');
  const keydown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    finish('escape');
  };
  window.addEventListener('pointermove', move, { capture: true, passive: false });
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('blur', blur);
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('lostpointercapture', lost, true);
  return () => finish('dispose');
}

export function usePointerGesture() {
  const cleanup = useRef<(() => void) | null>(null);
  const stop = useCallback(() => {
    const release = cleanup.current;
    cleanup.current = null;
    release?.();
  }, []);
  useEffect(() => stop, [stop]);
  const start = useCallback((event: ReactPointerEvent<HTMLElement>, options: Options) => {
    if (event.button !== 0) return;
    stop();
    cleanup.current = startPointerGesture(event, options);
  }, [stop]);
  return { start, stop };
}
