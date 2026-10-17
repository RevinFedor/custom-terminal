import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

// The service rail and the visible queue own their measured rectangles. A
// passive request list may only occupy the remaining space inside this pane.
export function useRequestDockLayout(root: RefObject<HTMLDivElement | null>, queueVisible: boolean, queueWidth: number, enabled = true) {
  const [layout, setLayout] = useState({ visible: false, right: 0, maxHeight: 200, panelRight: 0, panelTop: 30, panelWidth: 310 });
  useLayoutEffect(() => {
    if (!enabled) return;
    const rail = root.current?.parentElement;
    if (!rail) return;
    const owner = rail.closest('[data-prompt-queue-owner]');
    const pane = rail.closest('[data-split-pane-queue-host], [data-workspace-prompt-queue-host]');
    const queue = queueVisible ? owner?.querySelector('[data-prompt-queue-panel-mode]') : null;
    const edges = queueVisible ? owner?.querySelector('[data-prompt-queue-edge-controls]') : null;
    const measure = () => {
      const r = rail.getBoundingClientRect();
      const p = pane?.getBoundingClientRect() || { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight, width: window.innerWidth };
      const occupiedLeft = Math.min(r.left, queue?.getBoundingClientRect().left ?? r.left, edges?.getBoundingClientRect().left ?? r.left);
      const remaining = occupiedLeft - p.left - 16;
      const panelWidth = Math.max(160, Math.min(310, p.width - 16));
      const beside = remaining >= panelWidth;
      const panelLeft = beside ? occupiedLeft - panelWidth - 8 : Math.max(p.left + 8, Math.min(r.right - panelWidth, p.right - panelWidth - 8));
      const next = { visible: r.width > 0 && remaining >= 178, right: r.right - occupiedLeft + 8,
        maxHeight: Math.max(48, Math.min(200, p.bottom - r.top - 8)),
        panelRight: r.right - panelLeft - panelWidth, panelTop: beside ? 0 : r.height + 6, panelWidth };
      setLayout(old => Object.keys(next).every(key => old[key as keyof typeof old] === next[key as keyof typeof next]) ? old : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [rail, pane, queue, edges]) if (element) observer.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [root, queueVisible, queueWidth, enabled]);
  return layout;
}
