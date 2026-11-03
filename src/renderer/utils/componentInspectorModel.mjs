// Pure model of the component inspector: stamp parsing, clipboard payloads and
// the pixel geometry of the measurement mode. No DOM access, no listeners —
// `componentInspector.ts` owns those. Keeping this half pure is what makes the
// inspector testable without Electron, and it keeps the hot path honest: every
// function here takes plain numbers that the caller already read with ONE
// `getBoundingClientRect()`. Nothing in the inspector may call
// `getComputedStyle()` per pointer move; that is exactly what made the upstream
// `code-inspector` client cost seconds on a 161k-node window.

export const INSPECTOR_ATTRIBUTE = 'data-insp-path';
export const OUTER_HTML_LIMIT = 1200;

/**
 * Build-time stamp format is `path:line:column:tag` (tag = JSX element name).
 * Paths may themselves contain `:`, so fields are taken from the end.
 */
export function parseInspectorStamp(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length < 4) return null;
  const name = parts[parts.length - 1];
  const column = Number(parts[parts.length - 2]);
  const line = Number(parts[parts.length - 3]);
  const path = parts.slice(0, parts.length - 3).join(':');
  if (!path || !name || !Number.isFinite(line) || !Number.isFinite(column)) return null;
  return { path, line, column, name, location: `${path}:${line}:${column}` };
}

/** Physical Alt+Shift, with no other modifier — the inspector's only trigger. */
export function isInspectorModifier(event) {
  if (!event) return false;
  return !!event.altKey && !!event.shiftKey && !event.metaKey && !event.ctrlKey;
}

export function px(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function rectOf(rect) {
  return {
    left: rect.left, top: rect.top,
    right: rect.right, bottom: rect.bottom,
    width: rect.width ?? (rect.right - rect.left),
    height: rect.height ?? (rect.bottom - rect.top),
  };
}

/**
 * Distance between the two boxes' borders, horizontally and vertically.
 * `gap` is the empty space between the facing edges; when the projections
 * overlap on that axis the gap is 0 and `overlap` carries the shared length.
 */
export function measureGap(anchorRect, targetRect) {
  const a = rectOf(anchorRect);
  const b = rectOf(targetRect);
  const gapX = b.left >= a.right ? b.left - a.right : (a.left >= b.right ? a.left - b.right : 0);
  const gapY = b.top >= a.bottom ? b.top - a.bottom : (a.top >= b.bottom ? a.top - b.bottom : 0);
  const overlapX = gapX > 0 ? 0 : Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const overlapY = gapY > 0 ? 0 : Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return {
    gapX: px(gapX), gapY: px(gapY),
    overlapX: px(overlapX), overlapY: px(overlapY),
    deltaLeft: px(b.left - a.left), deltaRight: px(b.right - a.right),
    deltaTop: px(b.top - a.top), deltaBottom: px(b.bottom - a.bottom),
    centerX: px((b.left + b.right) / 2 - (a.left + a.right) / 2),
    centerY: px((b.top + b.bottom) / 2 - (a.top + a.bottom) / 2),
  };
}

/**
 * Viewport-space segments to draw for a measurement: one per axis that has a
 * real gap. Each segment is a straight line placed inside the facing corridor,
 * so the number sits where the distance actually is.
 */
export function buildMeasurementConnectors(anchorRect, targetRect) {
  const a = rectOf(anchorRect);
  const b = rectOf(targetRect);
  const gap = measureGap(a, b);
  const connectors = [];
  if (gap.gapX > 0) {
    const toRight = b.left >= a.right;
    const x = toRight ? a.right : b.right;
    const y = gap.overlapY > 0
      ? (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2
      : ((a.top + a.bottom) / 2 + (b.top + b.bottom) / 2) / 2;
    connectors.push({ axis: 'x', x: px(x), y: px(y), length: gap.gapX, label: `${gap.gapX}px` });
  }
  if (gap.gapY > 0) {
    const toBottom = b.top >= a.bottom;
    const y = toBottom ? a.bottom : b.bottom;
    const x = gap.overlapX > 0
      ? (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2
      : ((a.left + a.right) / 2 + (b.left + b.right) / 2) / 2;
    connectors.push({ axis: 'y', x: px(x), y: px(y), length: gap.gapY, label: `${gap.gapY}px` });
  }
  return connectors;
}

/** One-line summary painted next to the hovered element while measuring. */
export function formatGapBadge(gap) {
  const parts = [`X ${gap.gapX}px`, `Y ${gap.gapY}px`];
  if (gap.gapX === 0 && gap.overlapX > 0) parts[0] = `X 0 (нахлёст ${gap.overlapX})`;
  if (gap.gapY === 0 && gap.overlapY > 0) parts[1] = `Y 0 (нахлёст ${gap.overlapY})`;
  return parts.join(' · ');
}

/** Short label under the frame: where the element comes from and how big it is. */
export function formatFrameLabel(stamp, rect) {
  const size = `${px(rect.width)}×${px(rect.height)}`;
  return `${stamp.location} · ${stamp.name} · ${size}`;
}

function clampNumber(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Label placement from the element rect alone — reading the label's own size
 * would force a synchronous layout on every pointer move, which is the cost
 * this inspector exists to avoid. `labelHeight`/`labelWidth` are the fixed
 * box the caller styles the label with.
 */
export function resolveLabelPlacement(rect, viewport, label = {}) {
  const labelWidth = label.width ?? 360;
  const labelHeight = label.height ?? 18;
  const margin = label.margin ?? 4;
  const above = rect.top - labelHeight - margin;
  const below = rect.bottom + margin;
  const fitsAbove = above >= 0;
  const top = fitsAbove
    ? above
    : clampNumber(below, 0, Math.max(0, viewport.height - labelHeight));
  const left = clampNumber(rect.left, 0, Math.max(0, viewport.width - labelWidth));
  return { left: px(left), top: px(top), placement: fitsAbove ? 'above' : 'below' };
}

function truncateOuterHtml(html, limit = OUTER_HTML_LIMIT) {
  if (typeof html !== 'string' || !html) return '';
  return html.length > limit ? `${html.slice(0, limit)}\n  ...(truncated)` : html;
}

/**
 * Clipboard payload for a single element. Format is the one the project
 * already used before this rewrite: the JSX/DOM snippet, a blank line, then
 * `in <tag> at path:line:column`. It pastes into Claude/Cursor as a
 * self-contained reference.
 */
export function formatElementReference(stamp, outerHtml) {
  const html = truncateOuterHtml(outerHtml);
  return html
    ? `${html}\n\nin <${stamp.name}> at ${stamp.location}`
    : `<${stamp.name}> at ${stamp.location}`;
}

/** Clipboard payload for a measurement between two stamped elements. */
export function formatMeasurementReference(anchor, target) {
  const gap = measureGap(anchor.rect, target.rect);
  const line = (mark, item) => `${mark} <${item.stamp.name}> at ${item.stamp.location}`
    + `  ${px(item.rect.width)}×${px(item.rect.height)}`
    + ` @ (${px(item.rect.left)}, ${px(item.rect.top)})`;
  const overlap = [];
  if (gap.gapX === 0 && gap.overlapX > 0) overlap.push(`overlap x ${gap.overlapX}px`);
  if (gap.gapY === 0 && gap.overlapY > 0) overlap.push(`overlap y ${gap.overlapY}px`);
  return [
    line('A', anchor),
    line('B', target),
    `gap x ${gap.gapX}px · gap y ${gap.gapY}px${overlap.length ? ` (${overlap.join(' · ')})` : ''}`,
    `edges: left ${signed(gap.deltaLeft)} · right ${signed(gap.deltaRight)}`
      + ` · top ${signed(gap.deltaTop)} · bottom ${signed(gap.deltaBottom)}`,
    `centers: x ${signed(gap.centerX)} · y ${signed(gap.centerY)}`,
  ].join('\n');
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}
