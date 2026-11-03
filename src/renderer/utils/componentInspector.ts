import {
  INSPECTOR_ATTRIBUTE,
  buildMeasurementConnectors,
  formatElementReference,
  formatFrameLabel,
  formatGapBadge,
  formatMeasurementReference,
  isInspectorModifier,
  measureGap,
  parseInspectorStamp,
  resolveLabelPlacement,
} from './componentInspectorModel.mjs';

// Component inspector: hold Option+Shift, hover an element, click to copy its
// `file:line:column` plus the DOM snippet. While still holding Option+Shift,
// `M` (or a right click) pins that element as A and the pixel distance to
// whatever is hovered next is drawn live; a click then copies the measurement.
//
// Why this is hand-written instead of the upstream `code-inspector` client:
// that client listens to `mousemove` with no rAF gate and, for every hovered
// node, calls `getBoundingClientRect()` across the whole composed path and 16
// `getComputedStyle()` (border/padding/margin × 4 sides) inside `renderCover`,
// plus 4 more while positioning its tooltip. Each of those reads flushes
// pending style and layout for the WHOLE document. This window holds ~161k DOM
// nodes across 415 tabs, so one pointer move cost seconds.
//
// The rules this file keeps, in order of importance:
//  1. no `getComputedStyle` anywhere on the pointer path;
//  2. at most ONE `getBoundingClientRect()` per newly hovered element, and only
//     when the stamped element under the pointer actually changed;
//  3. pointer moves are coalesced into one `requestAnimationFrame`;
//  4. the element is found through `composedPath()`/`closest()`, never by
//     walking or querying the tree;
//  5. the overlay is `position: fixed` + `transform` inside its own
//     `pointer-events: none` container, so nothing it draws can invalidate
//     application layout, and it holds no permanent compositor layers.
//
// Build-time stamping is kept (`scripts/lib/inspector-stamp.mjs`): the
// attribute is the only thing that carries a source location into a packaged
// renderer, which has no dev server and no loadable source maps.

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Stamp = NonNullable<ReturnType<typeof parseInspectorStamp>>;
type Pick = { element: HTMLElement; stamp: Stamp; rect: Rect };

const OVERLAY_ID = 'noted-component-inspector';
const LABEL_WIDTH = 380;
const LABEL_HEIGHT = 18;
const HOVER_COLOR = '#DA7756';
const ANCHOR_COLOR = '#4C9A5A';
const CONFIRM_COLOR = '#E8E3DD';
const FLASH_MS = 420;

function toRect(domRect: DOMRect): Rect {
  return {
    left: domRect.left, top: domRect.top,
    right: domRect.right, bottom: domRect.bottom,
    width: domRect.width, height: domRect.height,
  };
}

function cloneSnippet(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll?.(`[${INSPECTOR_ATTRIBUTE}]`).forEach(node => node.removeAttribute(INSPECTOR_ATTRIBUTE));
  clone.removeAttribute(INSPECTOR_ATTRIBUTE);
  return clone.outerHTML || '';
}

function writeClipboard(text: string): boolean {
  try {
    const electron = (window as any).require?.('electron');
    if (electron?.clipboard?.writeText) {
      electron.clipboard.writeText(text);
      return true;
    }
  } catch {
    // nodeIntegration may be unavailable in a future window type.
  }
  try {
    void navigator.clipboard?.writeText?.(text);
    return true;
  } catch {
    return false;
  }
}

function composedPathOf(event: Event): EventTarget[] {
  return typeof event.composedPath === 'function' ? event.composedPath() : [event.target as EventTarget];
}

export function installComponentInspector(): () => void {
  const host = window as typeof window & { __notedComponentInspectorInstalled?: boolean };
  if (host.__notedComponentInspectorInstalled) return () => {};
  host.__notedComponentInspectorInstalled = true;

  // --- overlay DOM (created once, reused for every gesture) ------------------
  // No `contain` on the root: `contain: paint/strict` would clip the fixed
  // children to this 0×0 box and make the frame invisible. No `will-change`
  // either — six permanent compositor layers is exactly the kind of cost this
  // inspector is supposed to avoid.
  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;'
    + 'z-index:2147483000;pointer-events:none;';

  const makeBox = (color: string) => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;box-sizing:border-box;display:none;'
      + `border:1px solid ${color};background:${color}1f;`;
    root.appendChild(box);
    return box;
  };
  const makeLabel = (maxWidth = LABEL_WIDTH, { opaque = false } = {}) => {
    const label = document.createElement('div');
    label.style.cssText = 'position:fixed;left:0;top:0;display:none;box-sizing:border-box;'
      + `height:${LABEL_HEIGHT}px;max-width:${maxWidth}px;padding:0 5px;`
      // The measurement readout is the one label that lands in the middle of the
      // UI, on top of whatever is being measured. A translucent background let
      // the content behind it show through and made the number hard to read, so
      // it gets solid black plus its own stacking above the connector lines.
      + (opaque
        ? 'background:#000;border:1px solid rgba(255,255,255,0.35);z-index:10;'
        : 'background:rgba(0,0,0,0.62);')
      + 'color:#fff;border-radius:3px;'
      + 'font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;'
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    root.appendChild(label);
    return label;
  };

  const hoverBox = makeBox(HOVER_COLOR);
  const anchorBox = makeBox(ANCHOR_COLOR);
  const hoverLabel = makeLabel();
  const anchorLabel = makeLabel();
  const gapLabel = makeLabel(260, { opaque: true });
  const hint = makeLabel(560);
  const connectors = [0, 1].map(() => {
    const line = document.createElement('div');
    line.style.cssText = `position:fixed;left:0;top:0;display:none;background:${HOVER_COLOR};`;
    root.appendChild(line);
    return line;
  });
  // Copy confirmation: a short flash over the element that was just copied.
  // Without it a click gives no feedback at all — the clipboard changes
  // silently and the frame keeps sitting where it was, so it is impossible to
  // tell a successful copy from a missed one.
  const flashBox = document.createElement('div');
  flashBox.style.cssText = 'position:fixed;left:0;top:0;box-sizing:border-box;display:none;'
    + `border:2px solid ${CONFIRM_COLOR};background:${CONFIRM_COLOR}3d;border-radius:2px;`
    + `transition:opacity ${FLASH_MS}ms ease-out;opacity:0;`;
  root.appendChild(flashBox);
  const flashLabel = makeLabel(260, { opaque: true });
  flashLabel.style.transition = `opacity ${FLASH_MS}ms ease-out`;

  document.body.appendChild(root);

  const place = (node: HTMLElement, left: number, top: number) => {
    node.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  };
  const showBox = (box: HTMLElement, rect: Rect) => {
    box.style.width = `${Math.max(rect.width, 1)}px`;
    box.style.height = `${Math.max(rect.height, 1)}px`;
    place(box, rect.left, rect.top);
    box.style.display = 'block';
  };
  const showLabel = (label: HTMLElement, text: string, rect: Rect) => {
    label.textContent = text;
    const spot = resolveLabelPlacement(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      { width: LABEL_WIDTH, height: LABEL_HEIGHT },
    );
    place(label, spot.left, spot.top);
    label.style.display = 'block';
  };
  const hide = (...nodes: HTMLElement[]) => { for (const node of nodes) node.style.display = 'none'; };

  // --- state -----------------------------------------------------------------
  let armed = false;               // physical Option+Shift held
  let hover: Pick | null = null;   // element currently framed
  let anchor: Pick | null = null;  // element A of a measurement
  let pendingPath: EventTarget[] | null = null;
  let frame = 0;
  let flashTimer = 0;               // copy-confirmation flash
  // Element whose frame stays off after a copy. A click is a move+down+up, so
  // the move's animation frame can land AFTER the click handler and would
  // immediately re-frame the element we just released — the copy would look
  // like nothing happened. The frame returns as soon as the pointer visits
  // anything else.
  let copiedElement: HTMLElement | null = null;

  const resolvePick = (element: HTMLElement | null): Pick | null => {
    if (!element) return null;
    const stamp = parseInspectorStamp(element.getAttribute(INSPECTOR_ATTRIBUTE));
    if (!stamp) return null;
    // The one rect read per newly hovered element. Everything the overlay
    // draws, including the measurement, is derived from these six numbers.
    return { element, stamp, rect: toRect(element.getBoundingClientRect()) };
  };

  const stampedFromPath = (path: EventTarget[]): HTMLElement | null => {
    for (const node of path) {
      if (!(node instanceof HTMLElement)) continue;
      if (node === root || node.parentNode === root) return null;
      if (node.hasAttribute(INSPECTOR_ATTRIBUTE)) return node;
      const stamped = node.closest?.(`[${INSPECTOR_ATTRIBUTE}]`) as HTMLElement | null;
      if (stamped) return stamped;
    }
    return null;
  };

  const paintHint = () => {
    hint.textContent = anchor
      ? 'A зафиксирован · наведи второй элемент, клик — скопировать расстояние · Esc — снять A'
      : 'Инспектор ⌥⇧ · клик — скопировать путь · M или правый клик — зафиксировать A для замера';
    place(hint, 8, Math.max(2, window.innerHeight - LABEL_HEIGHT - 8));
    hint.style.display = 'block';
  };

  const paintMeasurement = () => {
    hide(...connectors, gapLabel);
    if (!anchor) { hide(anchorBox, anchorLabel); return; }
    showBox(anchorBox, anchor.rect);
    showLabel(anchorLabel, `A · ${formatFrameLabel(anchor.stamp, anchor.rect)}`, anchor.rect);
    if (!hover || hover.element === anchor.element) return;
    const segments = buildMeasurementConnectors(anchor.rect, hover.rect);
    segments.forEach((segment, index) => {
      const line = connectors[index];
      if (!line) return;
      line.style.width = segment.axis === 'x' ? `${segment.length}px` : '1px';
      line.style.height = segment.axis === 'x' ? '1px' : `${segment.length}px`;
      place(line, segment.x, segment.y);
      line.style.display = 'block';
    });
    gapLabel.textContent = formatGapBadge(measureGap(anchor.rect, hover.rect));
    const nearX = segments[0] ? segments[0].x : hover.rect.left;
    const nearY = segments.find(segment => segment.axis === 'y')?.y ?? hover.rect.top;
    place(gapLabel, Math.min(nearX + 6, Math.max(0, window.innerWidth - 266)), Math.max(2, nearY - 22));
    gapLabel.style.display = 'block';
  };

  const paint = () => {
    if (!armed) return;
    if (hover) {
      showBox(hoverBox, hover.rect);
      showLabel(hoverLabel, formatFrameLabel(hover.stamp, hover.rect), hover.rect);
    } else {
      hide(hoverBox, hoverLabel);
    }
    paintMeasurement();
    paintHint();
  };

  const disarm = () => {
    if (!armed) return;
    armed = false;
    hover = null;
    anchor = null;
    pendingPath = null;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = 0; }
    copiedElement = null;
    hide(hoverBox, hoverLabel, anchorBox, anchorLabel, gapLabel, hint, flashBox, flashLabel, ...connectors);
  };

  const runFrame = () => {
    frame = 0;
    const path = pendingPath;
    pendingPath = null;
    if (!armed || !path) return;
    const element = stampedFromPath(path);
    // A just-copied element stays unframed until the pointer leaves it, so the
    // confirmation flash is not overwritten by a late frame from the click's
    // own pointer move.
    if (element && element === copiedElement) return;
    copiedElement = null;
    // Nothing the overlay shows depends on the pointer position inside one
    // element, so an unchanged target must skip the rect read as well — the
    // comparison happens BEFORE `resolvePick`, which is the call that reads
    // layout.
    if (element === (hover?.element ?? null)) return;
    hover = resolvePick(element);
    paint();
  };

  const schedule = (event: MouseEvent) => {
    pendingPath = composedPathOf(event);
    if (!frame) frame = requestAnimationFrame(runFrame);
  };

  const pickFromEvent = (event: MouseEvent): Pick | null => resolvePick(stampedFromPath(composedPathOf(event)));

  /**
   * Visible confirmation that the clipboard actually changed: the copied
   * element flashes once and the hover frame is dropped, so the gesture reads
   * as finished instead of leaving the same frame sitting under the pointer.
   * The flash uses its own box — reusing the hover frame would make an
   * immediate re-hover of the same element look like a stale highlight.
   */
  const flashCopied = (rect: Rect, text: string) => {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = 0; }
    showBox(flashBox, rect);
    flashLabel.textContent = text;
    const spot = resolveLabelPlacement(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      { width: 260, height: LABEL_HEIGHT },
    );
    place(flashLabel, spot.left, spot.top);
    flashLabel.style.display = 'block';
    flashBox.style.opacity = '1';
    flashLabel.style.opacity = '1';
    // Let the browser paint the opaque state before the transition starts.
    requestAnimationFrame(() => {
      flashBox.style.opacity = '0';
      flashLabel.style.opacity = '0';
    });
    flashTimer = window.setTimeout(() => {
      flashTimer = 0;
      hide(flashBox, flashLabel);
    }, FLASH_MS + 60);
    // Drop the live frame: the copy is done, and keeping the frame makes the
    // click look like it did nothing.
    hover = null;
    hide(hoverBox, hoverLabel);
  };

  const suppressFrameFor = (element: HTMLElement) => { copiedElement = element; };

  const copyElement = (pick: Pick) => {
    const ok = writeClipboard(formatElementReference(pick.stamp, cloneSnippet(pick.element)));
    console.warn('[Inspector] element ' + pick.stamp.location + ' copied=' + ok);
    flashCopied(pick.rect, ok ? `Скопировано · ${pick.stamp.name}` : 'Не удалось скопировать');
  };

  // --- listeners -------------------------------------------------------------
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'Escape') {
      if (!armed || !anchor) return;
      anchor = null;
      event.preventDefault();
      event.stopPropagation();
      paint();
      return;
    }
    if (!isInspectorModifier(event)) {
      if (armed) disarm();
      return;
    }
    // Physical `M`: pin the hovered element as A without needing a right click
    // (a trackpad right click under two held modifiers is awkward). `event.code`
    // is used because Option+Shift+M produces a typographic character — and for
    // the same reason the key is consumed ONLY while an element is actually
    // framed, so typing that character into a composer is never swallowed.
    if (event.code === 'KeyM' && armed && hover) {
      event.preventDefault();
      event.stopPropagation();
      anchor = hover.element === anchor?.element ? null : hover;
      paint();
      return;
    }
    if (armed) return;
    armed = true;
    paintHint();
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (!isInspectorModifier(event)) disarm();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!isInspectorModifier(event)) {
      if (armed) disarm();
      return;
    }
    // Entering the window with the modifier already held arms without a key
    // event, the same admission idiom the Cmd-hint hooks use.
    armed = true;
    schedule(event);
  };

  const onClick = (event: MouseEvent) => {
    if (!armed || !isInspectorModifier(event)) return;
    const pick = pickFromEvent(event);
    if (!pick) return;
    // Option+Shift+click lands on real buttons, chips and terminals; the
    // application must not receive the gesture.
    event.preventDefault();
    event.stopPropagation();
    hover = pick;
    if (!anchor) {
      // Copies the element and flashes it; `copyElement` clears the frame.
      copyElement(pick);
      suppressFrameFor(pick.element);
    } else if (anchor.element === pick.element) {
      anchor = null;
    } else {
      const gap = measureGap(anchor.rect, pick.rect);
      const ok = writeClipboard(formatMeasurementReference(anchor, pick));
      console.warn('[Inspector] measurement ' + anchor.stamp.location
        + ' → ' + pick.stamp.location + ' copied=' + ok);
      // A measurement ends the gesture too: release the anchor and confirm on
      // the second element, with the numbers that were copied.
      anchor = null;
      flashCopied(pick.rect, ok ? `Скопировано · ${formatGapBadge(gap)}` : 'Не удалось скопировать');
      suppressFrameFor(pick.element);
    }
    paint();
  };

  const onContextMenu = (event: MouseEvent) => {
    if (!armed || !isInspectorModifier(event)) return;
    const pick = pickFromEvent(event);
    if (!pick) return;
    event.preventDefault();
    event.stopPropagation();
    hover = pick;
    anchor = anchor?.element === pick.element ? null : pick;
    paint();
  };

  // Capture-phase press blocks the application's own pointer handling (drag
  // pickup, focus steal, text selection) before any component sees it.
  const swallowPress = (event: MouseEvent) => {
    if (!armed || !isInspectorModifier(event)) return;
    if (!stampedFromPath(composedPathOf(event))) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onViewportChange = () => {
    // Rects are viewport-relative, so scrolling invalidates them. Re-read only
    // the 0–2 framed elements, never the tree.
    if (!armed) return;
    if (hover) hover = { ...hover, rect: toRect(hover.element.getBoundingClientRect()) };
    if (anchor) anchor = { ...anchor, rect: toRect(anchor.element.getBoundingClientRect()) };
    paint();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', disarm);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerdown', swallowPress, true);
  window.addEventListener('mousedown', swallowPress, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', disarm);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerdown', swallowPress, true);
    window.removeEventListener('mousedown', swallowPress, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
    if (frame) cancelAnimationFrame(frame);
    if (flashTimer) clearTimeout(flashTimer);
    root.remove();
    host.__notedComponentInspectorInstalled = false;
  };
}
