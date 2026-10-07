import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getComposerControlsHost, subscribeComposerControlsHost } from '../../utils/composerControlsHost.mjs';
import {
  historyRecordTimeLabel, intersectRect, placeHistoryRecordTime, rectsIntersect,
} from '../../utils/historyRecordTimePresentation.mjs';
import recordTimes from '../../../shared/history-record-time.cjs';

type Rect = { left: number; top: number; right: number; bottom: number };
type View = {
  element: HTMLElement; key: string; label: string; scope: string; at: string;
  fontSize: number; fontFamily: string; maxWidth: number;
  position?: { left: number; top: number; placement: string };
};
const TARGET = '[data-history-time-key]';
const EXCLUDED = '.cb-row-copy,.cb-msg-actions,.cb-collapse-top,.cb-collapse-bottom,button[data-history-collapse],'
  + '[role="menu"],[role="dialog"],[data-history-record-time-overlay],input,textarea,[contenteditable="true"]';
const CHROME = '[data-history-composer-floating-status],[data-history-composer-prompt-band],'
  + '[data-history-side-surface-toggle],[data-history-scroll-to-bottom],[data-history-agent-dock],'
  + '[data-history-agent-popover],[data-prompt-queue-edge-controls],[data-ai-composer-chip-preview]';

function shown(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.closest('[inert],[aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
    && rect.right > rect.left && rect.bottom > rect.top;
}
function bounds(element: HTMLElement, scroller: HTMLElement, viewport: Rect): Rect {
  let clip = intersectRect(scroller.getBoundingClientRect(), viewport);
  for (let parent: HTMLElement | null = element.parentElement; parent && parent !== scroller; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) clip = { ...clip, top: Math.max(clip.top, rect.top), bottom: Math.min(clip.bottom, rect.bottom) };
    if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) clip = { ...clip, left: Math.max(clip.left, rect.left), right: Math.min(clip.right, rect.right) };
  }
  return clip;
}

// Only the currently hovered block is walked. No retained-list measurements.
function lastVisibleLine(element: HTMLElement, scroller: HTMLElement, clip: Rect): Rect | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let last: Rect | null = null;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const parent = text.parentElement;
    if (!text.textContent?.trim() || !parent || parent.closest(EXCLUDED + ',.hp-user-message-status')) continue;
    const band = parent.closest('.hp-history-user-prompt-band');
    if (band && band !== element) continue;
    if (!shown(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    const localClip = bounds(parent, scroller, clip);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0 || rect.top < localClip.top - 1 || rect.bottom > localClip.bottom + 1
        || rect.left < localClip.left - 1 || rect.right > localClip.right + 1) continue;
      if (!last || rect.bottom > last.bottom + 2) last = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      else if (Math.abs(rect.bottom - last.bottom) <= 2 && rect.right > last.right) last = { ...last, right: rect.right };
    }
  }
  if (last) {
    for (const glyph of element.querySelectorAll<SVGElement>('svg.cb-tool-chevron')) {
      const rect = glyph.getBoundingClientRect();
      if (rect.width && rect.bottom >= last.top && rect.top <= last.bottom && rect.right <= clip.right) {
        last = { ...last, right: Math.max(last.right, rect.right) };
      }
    }
  }
  if (!last) {
    // A chip/image-only prompt still dates its message, never the attachment file.
    for (const chip of element.querySelectorAll<HTMLElement>('.cb-composer-chip,.hp-history-image-chip')) {
      if (shown(chip)) {
        const rect = chip.getBoundingClientRect();
        if (rect.top >= clip.top && rect.bottom <= clip.bottom) last = rect;
      }
    }
  }
  return last;
}

/** One read-only, out-of-flow layer for one History owner. */
export function HistoryRecordTimeOverlay({ panelRef, scrollerRef, ownerKey, tabId = '', enabled = true }: {
  panelRef: React.RefObject<HTMLElement | null>;
  scrollerRef: React.RefObject<HTMLElement | null>;
  ownerKey: string; tabId?: string; enabled?: boolean;
}) {
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef(view); viewRef.current = view;
  const labelRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<{ measure: () => void } | null>(null);

  // Host ancestor refs attach after descendant layout effects. Installation
  // must wait for the completed host commit, especially on a cold History mount.
  useEffect(() => {
    setView(null);
    const panel = panelRef.current;
    if (!enabled || !panel) return;
    let meta = false, point: { x: number; y: number } | null = null, target: HTMLElement | null = null;
    let frame = 0, disposed = false;
    let chromeRects: Rect[] = [], safeTop = Infinity;
    const observedChrome = new Set<HTMLElement>();
    let observedMutationRoots: HTMLElement[] = [];
    const clear = () => { setView(null); };
    const validPanel = () => shown(panel) && panel.dataset.historyPresented !== '0'
      && panel.dataset.historyViewportReady !== '0';
    const chromeObserver = new ResizeObserver(() => { refreshChrome(); schedule(); });
    const chromeMutation = new MutationObserver(() => { refreshChrome(); schedule(); });
    const targetObserver = new ResizeObserver(() => schedule());
    const targetMutation = new MutationObserver(() => schedule());
    const panelObserver = new ResizeObserver(() => { refreshChrome(); schedule(); });
    const visibilityObserver = new MutationObserver(() => {
      if (!validPanel()) { meta = false; target = null; clear(); }
      else { refreshChrome(); schedule(); }
    });

    function refreshChrome() {
      // A cached envelope of this owner's bounded chrome. Never called by mousemove.
      const controls = panel.querySelector<HTMLElement>('[data-history-controls]')
        || (tabId ? getComposerControlsHost(tabId)?.closest('[data-history-controls]') : null);
      const nodes = new Set<HTMLElement>();
      const mutationRoots: HTMLElement[] = [];
      if (controls instanceof HTMLElement) {
        nodes.add(controls);
        mutationRoots.push(controls);
        controls.querySelectorAll<HTMLElement>(CHROME).forEach(node => nodes.add(node));
      }
      const dock = panel.querySelector<HTMLElement>('[data-history-agent-dock]');
      if (dock) mutationRoots.push(dock);
      if (tabId) for (const queue of document.querySelectorAll<HTMLElement>(`[data-prompt-queue-owner="${CSS.escape(tabId)}"]`)) {
        mutationRoots.push(queue);
        queue.querySelectorAll<HTMLElement>('.pq-collapsed-rail,[data-prompt-queue-edge-controls]').forEach(node => nodes.add(node));
        nodes.add(queue);
      }
      if (mutationRoots.length !== observedMutationRoots.length
        || mutationRoots.some((node, index) => node !== observedMutationRoots[index])) {
        chromeMutation.disconnect();
        observedMutationRoots = mutationRoots;
        for (const root of mutationRoots) chromeMutation.observe(root, { childList: true, subtree: true, attributes: true });
      }
      panel.querySelectorAll<HTMLElement>(CHROME).forEach(node => nodes.add(node));
      // Re-observing on every RO callback would schedule another initial
      // delivery forever, turning a passive annotation into a layout loop.
      for (const old of observedChrome) if (!nodes.has(old)) { chromeObserver.unobserve(old); observedChrome.delete(old); }
      for (const node of nodes) if (!observedChrome.has(node)) { chromeObserver.observe(node); observedChrome.add(node); }
      chromeRects = []; safeTop = panel.getBoundingClientRect().bottom;
      const pane = panel.getBoundingClientRect();
      for (const node of nodes) {
        if (!shown(node)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.right <= pane.left || rect.left >= pane.right) continue;
        chromeRects.push(rect);
        // Small edge buttons/rails are collision obstacles, not a full-width
        // ceiling hundreds of pixels above the input.
        if (node === controls || rect.width >= pane.width * 0.45) safeTop = Math.min(safeTop, rect.top);
      }
    }
    function resolveTarget() {
      if (!meta || !point || !validPanel()) return null;
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || !panel.contains(hit) || hit.closest(EXCLUDED)) return null;
      const found = hit.closest<HTMLElement>(TARGET);
      if (!found || !panel.contains(found)) return null;
      const scroller = scrollerRef.current;
      if (!scroller || !scroller.contains(found)) return null;
      const time = recordTimes.normalizeHistoryRecordTime({ version: 1, timestamp: found.dataset.historyTimeAt,
        kind: found.dataset.historyTimeSourceKind, scope: found.dataset.historyTimeScope });
      return time ? { found, time } : null;
    }
    function activate() {
      const resolved = resolveTarget();
      if (!resolved) { target = null; targetObserver.disconnect(); targetMutation.disconnect(); clear(); return; }
      const { found, time } = resolved;
      if (target !== found) {
        target = found; targetObserver.disconnect(); targetMutation.disconnect();
        targetObserver.observe(found);
        targetMutation.observe(found, { childList: true, characterData: true, subtree: true, attributes: true });
      }
      const font = getComputedStyle(found);
      const next = { element: found, key: found.dataset.historyTimeKey || '', label: historyRecordTimeLabel(time),
        scope: time.scope, at: time.timestamp, fontSize: parseFloat(font.fontSize) * 0.9,
        fontFamily: font.fontFamily, maxWidth: Math.max(0, Math.min(innerWidth, panel.getBoundingClientRect().right)
          - Math.max(0, panel.getBoundingClientRect().left) - 16) };
      const current = viewRef.current;
      if (current?.element === found && current.key === next.key && current.label === next.label && current.scope === next.scope
        && current.at === next.at && current.fontSize === next.fontSize && current.maxWidth === next.maxWidth) measure();
      else setView(next);
    }
    function measure() {
      const current = viewRef.current, scroller = scrollerRef.current, label = labelRef.current;
      if (!current || !label || !scroller || !meta || resolveTarget()?.found !== current.element) { clear(); return; }
      const pane = intersectRect(panel.getBoundingClientRect(), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
      const element = current.element;
      const kind = element.dataset.historyTimeKind;
      let surface = kind === 'tool' ? element.querySelector<HTMLElement>('.cb-tool-head-inner')
        : kind === 'user' ? element.querySelector<HTMLElement>('.cb-user-bubble') : element;
      if (kind === 'user' && !surface?.textContent?.trim()
        && !surface?.querySelector('.cb-composer-chip,.hp-history-image-chip,img')) {
        surface = element.querySelector<HTMLElement>('[data-history-user-prompt-band]') || surface;
      }
      const clip = bounds(surface || element, scroller, pane);
      const anchor = surface ? lastVisibleLine(surface, scroller, clip) : null;
      const controls = element.closest('.cb-row') || element;
      const obstacles = [...chromeRects];
      controls.querySelectorAll<HTMLElement>('button,.cb-row-copy,.cb-msg-actions,.cb-collapse-top,.cb-collapse-bottom')
        .forEach(node => { if (shown(node)) obstacles.push(node.getBoundingClientRect()); });
      const size = label.getBoundingClientRect();
      const position = placeHistoryRecordTime({ anchor, clip, pane, size, obstacles, safeTop });
      // A clipped/removed target cannot keep an old annotation alive.
      if (!position || !element.isConnected || !rectsIntersect(element.getBoundingClientRect(), scroller.getBoundingClientRect())) {
        clear(); return;
      }
      setView(previous => previous && previous.element === element
        ? previous.position?.left === position.left && previous.position?.top === position.top && previous.position?.placement === position.placement
          ? previous : { ...previous, position } : previous);
    }
    function schedule() {
      if (!meta || disposed || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; activate(); });
    }
    const move = (event: MouseEvent) => {
      point = { x: event.clientX, y: event.clientY };
      const changed = meta !== event.metaKey; meta = event.metaKey;
      if (!meta) { if (changed) clear(); return; }
      if (!(event.target instanceof Element) || !panel.contains(event.target) || event.target.closest(EXCLUDED)) {
        target = null; clear(); return;
      }
      const hit = event.target instanceof Element ? event.target.closest(TARGET) : null;
      if (hit !== target || changed) activate();
    };
    const down = (event: KeyboardEvent) => { if (event.key === 'Meta') { meta = true; refreshChrome(); activate(); } };
    const up = (event: KeyboardEvent) => { if (event.key === 'Meta') { meta = false; clear(); } };
    const blur = () => { meta = false; target = null; point = null; clear(); };
    const leave = () => { target = null; point = null; clear(); };
    const scroll = () => { clear(); schedule(); };
    const resize = () => { refreshChrome(); clear(); schedule(); };
    panelObserver.observe(panel); panelObserver.observe(scrollerRef.current || panel);
    visibilityObserver.observe(panel, { attributes: true, attributeFilter: ['inert', 'aria-hidden', 'style', 'data-history-presented', 'data-history-viewport-ready'] });
    refreshChrome();
    const unsubscribe = tabId ? subscribeComposerControlsHost(tabId, () => { refreshChrome(); schedule(); }) : () => {};
    window.addEventListener('mousemove', move, true);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('blur', blur); window.addEventListener('resize', resize);
    panel.addEventListener('mouseleave', leave); panel.addEventListener('scroll', scroll, true);
    controllerRef.current = { measure };
    return () => {
      disposed = true; if (frame) cancelAnimationFrame(frame);
      unsubscribe(); chromeObserver.disconnect(); chromeMutation.disconnect(); targetObserver.disconnect(); targetMutation.disconnect();
      panelObserver.disconnect(); visibilityObserver.disconnect(); controllerRef.current = null;
      window.removeEventListener('mousemove', move, true); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur); window.removeEventListener('resize', resize);
      panel.removeEventListener('mouseleave', leave); panel.removeEventListener('scroll', scroll, true);
    };
  }, [enabled, ownerKey, panelRef, scrollerRef, tabId]);

  useLayoutEffect(() => { if (view) controllerRef.current?.measure(); }, [view?.element, view?.key, view?.label, view?.scope, view?.fontSize, view?.maxWidth]);
  if (!view) return null;
  return createPortal(<div ref={labelRef} data-history-record-time-overlay data-owner={ownerKey}
    data-history-time-key={view.key} data-source-at={view.at} data-scope={view.scope}
    data-placement={view.position?.placement} aria-hidden="true"
    style={{ position: 'fixed', left: view.position?.left || 0, top: view.position?.top || 0,
      visibility: view.position ? 'visible' : 'hidden', zIndex: 25, pointerEvents: 'none', userSelect: 'none',
      display: 'flex', flexWrap: 'wrap', gap: '0 8px', maxWidth: view.maxWidth, boxSizing: 'border-box',
      color: '#8f8d88', fontSize: view.fontSize, fontFamily: view.fontFamily, fontWeight: 400, lineHeight: 1.35,
      padding: '0 4px',
      borderRadius: 4, background: view.position?.placement === 'fallback' ? '#1a1a1a' : 'transparent' }}>
    <span style={{ whiteSpace: 'nowrap' }}>{view.label}</span>
    {view.scope === 'container' && <span style={{ whiteSpace: 'nowrap' }}>общий exec</span>}
  </div>, document.body);
}

export default HistoryRecordTimeOverlay;
