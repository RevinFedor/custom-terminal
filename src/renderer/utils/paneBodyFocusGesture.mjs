export const PANE_BODY_FOCUS_DRAG_THRESHOLD_PX = 4;

export function paneBodyFocusGestureMoved(startX, startY, clientX, clientY) {
  return Math.hypot(clientX - startX, clientY - startY) >= PANE_BODY_FOCUS_DRAG_THRESHOLD_PX;
}

export function paneBodySelectionBlocksFocus(selection) {
  if (!selection || selection.isCollapsed) return false;
  return String(selection.toString?.() || '').length > 0;
}

/**
 * Decide from the completed gesture, never from the kind of DOM row beneath
 * it. A transcript row may receive either a plain click or a real selection;
 * treating the whole row as selection-only made empty History focus correctly
 * while every populated History silently rejected the same click.
 */
export function paneBodyPrimaryFocusBlockReason(moved, selection) {
  if (moved) return 'pointer-drag';
  if (paneBodySelectionBlocksFocus(selection)) return 'text-selection';
  return null;
}
