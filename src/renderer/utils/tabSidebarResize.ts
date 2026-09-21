import type { PointerEvent as ReactPointerEvent } from 'react';
import { startPointerGesture } from '../hooks/usePointerGesture';
import { freezePaneContentsForResize } from './splitResizeFreeze.mjs';

type Options = {
  getWidth: () => number;
  commitWidth: (width: number) => void;
  subscribeCancel: (cancel: () => void) => () => void;
  onFinish: () => void;
};

// One physical resize: lightweight boxes follow the pointer, retained content
// keeps its containing block, and the display profile changes once at release.
export function startTabSidebarResize(event: ReactPointerEvent<HTMLElement>, options: Options) {
  if (event.button !== 0) return () => {};
  const sidebar = event.currentTarget.closest<HTMLElement>('[data-tab-sidebar]');
  const stack = sidebar?.closest<HTMLElement>('[data-persistent-tab-sidebar-stack]') || sidebar;
  const scope = stack?.parentElement;
  if (!sidebar || !stack || !scope) return () => {};
  const widthNodes = Array.from(new Set([
    sidebar, stack,
    ...scope.ownerDocument.querySelectorAll<HTMLElement>('[data-workspace-navigation-project-tools]'),
  ]));
  const startWidth = sidebar.getBoundingClientRect().width;
  const startX = event.clientX;
  const frozen = freezePaneContentsForResize(scope, { includeRetained: true, reason: 'tab-sidebar' });
  const clamp = (x: number) => Math.max(140, Math.min(400, startWidth + x - startX));
  const paint = (width: number) => widthNodes.forEach(node => { node.style.width = width + 'px'; });
  let nextWidth = startWidth;
  let finished = false;
  let unsubscribe = () => {};
  let stop = () => {};
  const cancel = () => stop();
  const finish = (commit: boolean, clientX?: number) => {
    if (finished) return;
    finished = true;
    unsubscribe();
    window.removeEventListener('resize', cancel);
    if (commit && clientX !== undefined) nextWidth = clamp(clientX);
    const changed = commit && nextWidth !== options.getWidth();
    try {
      // The real display-profile setter uses flushSync. Keep content frozen
      // until React has committed the same width as the DOM preview.
      if (changed) options.commitWidth(nextWidth);
    } finally {
      paint(options.getWidth());
      frozen.release(changed);
      options.onFinish();
    }
  };
  stop = startPointerGesture(event, {
    cursor: 'col-resize',
    onMove: move => {
      if (!(move.buttons & 1)) { cancel(); return; }
      nextWidth = clamp(move.clientX);
      paint(nextWidth);
    },
    onEnd: (reason, endEvent) => finish(reason === 'up', endEvent?.clientX),
  });
  unsubscribe = options.subscribeCancel(cancel);
  window.addEventListener('resize', cancel);
  return stop;
}
