export const PANE_BODY_FOCUS_DRAG_THRESHOLD_PX = 4;
export const PANE_BODY_FOCUS_TEXT_DELAY_MS = 240;

export function paneBodyFocusGestureMoved(startX, startY, clientX, clientY) {
  return Math.hypot(clientX - startX, clientY - startY) >= PANE_BODY_FOCUS_DRAG_THRESHOLD_PX;
}

export function paneBodySelectionBlocksFocus(selection) {
  if (!selection || selection.isCollapsed) return false;
  return String(selection.toString?.() || '').length > 0;
}

export function paneBodyFocusDelayMs(selectionSensitive) {
  return selectionSensitive ? PANE_BODY_FOCUS_TEXT_DELAY_MS : 0;
}
