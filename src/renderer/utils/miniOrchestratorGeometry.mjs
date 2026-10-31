// Presentation geometry only. The same pointer owner as Run After/Git owns
// gestures; no PTY, application admission or layout polling lives here.
const MARGIN = 8;
const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
export function fitMiniPanel(rect, viewport) {
  const width = clamp(rect.width, 0, Math.max(0, viewport.width - MARGIN * 2));
  const height = clamp(rect.height, 0, Math.max(0, viewport.height - MARGIN * 2));
  return { left: clamp(rect.left, MARGIN, viewport.width - width - MARGIN),
    top: clamp(rect.top, MARGIN, viewport.height - height - MARGIN), width, height };
}
export function resizeMiniPanel(rect, edge, dx, dy, viewport) {
  const right = rect.left + rect.width;
  const width = edge === 'left' || edge === 'left-bottom'
    ? clamp(rect.width - dx, Math.min(280, rect.width, Math.max(0, right - MARGIN)), Math.max(0, right - MARGIN)) : rect.width;
  const height = edge === 'bottom' || edge === 'left-bottom'
    ? clamp(rect.height + dy, Math.min(160, rect.height, Math.max(0, viewport.height - rect.top - MARGIN)), Math.max(0, viewport.height - rect.top - MARGIN)) : rect.height;
  return { left: right - width, top: rect.top, width, height };
}
export function moveMiniPanel(rect, dx, dy, viewport) {
  return fitMiniPanel({ ...rect, left: rect.left + dx, top: rect.top + dy }, viewport);
}
