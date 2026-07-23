export const DEFAULT_FLOATING_TERMINAL_GEOMETRY = Object.freeze({
  x: 18,
  y: 8,
  width: 64,
  height: 52,
});

export const MAX_FLOATING_TERMINAL_HEIGHT_PERCENT = 80;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function normalizeFloatingTerminalGeometry(value) {
  const source = value && typeof value === 'object' ? value : DEFAULT_FLOATING_TERMINAL_GEOMETRY;
  const width = clamp(Number(source.width) || DEFAULT_FLOATING_TERMINAL_GEOMETRY.width, 30, 80);
  const height = clamp(
    Number(source.height) || DEFAULT_FLOATING_TERMINAL_GEOMETRY.height,
    20,
    MAX_FLOATING_TERMINAL_HEIGHT_PERCENT,
  );
  return {
    x: clamp(Number(source.x) || 0, 0, 100 - width),
    y: clamp(Number(source.y) || 0, 0, 100 - height),
    width,
    height,
  };
}

export function floatingGeometryToPixels(geometry, bounds) {
  const normalized = normalizeFloatingTerminalGeometry(geometry);
  return {
    x: bounds.width * normalized.x / 100,
    y: bounds.height * normalized.y / 100,
    width: bounds.width * normalized.width / 100,
    height: bounds.height * normalized.height / 100,
  };
}

export function floatingPixelsToGeometry(rect, bounds) {
  if (!bounds.width || !bounds.height) return { ...DEFAULT_FLOATING_TERMINAL_GEOMETRY };
  return normalizeFloatingTerminalGeometry({
    x: rect.x / bounds.width * 100,
    y: rect.y / bounds.height * 100,
    width: rect.width / bounds.width * 100,
    height: rect.height / bounds.height * 100,
  });
}

function pixelLimits(bounds) {
  const maxWidth = Math.max(1, bounds.width * 0.8);
  const maxHeight = Math.max(1, bounds.height * MAX_FLOATING_TERMINAL_HEIGHT_PERCENT / 100);
  return {
    minWidth: Math.min(maxWidth, Math.max(280, bounds.width * 0.3)),
    maxWidth,
    minHeight: Math.min(maxHeight, Math.max(140, bounds.height * 0.2)),
    maxHeight,
  };
}

export function dragFloatingTerminalRect(start, delta, bounds) {
  return {
    ...start,
    x: clamp(start.x + delta.x, 0, Math.max(0, bounds.width - start.width)),
    y: clamp(start.y + delta.y, 0, Math.max(0, bounds.height - start.height)),
  };
}

export function resizeFloatingTerminalRect(start, direction, delta, bounds) {
  const limits = pixelLimits(bounds);
  const left = start.x;
  const top = start.y;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  let nextLeft = left;
  let nextTop = top;
  let nextRight = right;
  let nextBottom = bottom;

  if (direction.includes('e')) {
    nextRight = clamp(right + delta.x, left + limits.minWidth, Math.min(bounds.width, left + limits.maxWidth));
  }
  if (direction.includes('w')) {
    nextLeft = clamp(left + delta.x, Math.max(0, right - limits.maxWidth), right - limits.minWidth);
  }
  if (direction.includes('s')) {
    nextBottom = clamp(bottom + delta.y, top + limits.minHeight, Math.min(bounds.height, top + limits.maxHeight));
  }
  if (direction.includes('n')) {
    nextTop = clamp(top + delta.y, Math.max(0, bottom - limits.maxHeight), bottom - limits.minHeight);
  }

  return {
    x: nextLeft,
    y: nextTop,
    width: nextRight - nextLeft,
    height: nextBottom - nextTop,
  };
}
