// The first click after an overlay opens belongs to the OVERLAY.
//
// When a menu/popover is open, the next click's job is to close it. It must not
// also do whatever it would have done on that spot — the user aimed at "get rid
// of this", not at the surface underneath. Acting on both means one click does
// two things, and the second one is always the surprise.
//
// The bug this fixes: right-click a pane's tab chip (menu opens, focus correctly
// stays put), then click inside that pane — the pane took focus AND the menu
// closed. Pane focus listens on `pointerdown` in the CAPTURE phase, while every
// dismiss handler listens on `mousedown` in the bubble phase, so the focus move
// always wins the race and the dismissal looks like a deliberate click-through.
//
// Two parts, because a click is two events:
//   • at pointerdown we record whether an overlay was open — that is the only
//     moment the answer is still true, since the dismiss handler runs a moment
//     later and the overlay is gone by `click` time;
//   • handlers on `click` ask about that recorded answer instead of looking at
//     the DOM, which by then shows no overlay at all.

/**
 * Markers of surfaces that a click is expected to CLOSE.
 *
 * Deliberately a list of overlays that own the next click, not "anything
 * floating": a tooltip or an inline hint does not swallow a click, so adding one
 * here would silently make real clicks disappear.
 */
export const DISMISSIBLE_OVERLAY_SELECTORS = Object.freeze([
  '[data-tab-context-menu]',
  '[data-split-direction-menu]',
  '[data-run-after-picker-menu]',
  '[data-command-history-popover]',
  // Меню «что начать здесь» свободного места полосы окна. Без записи здесь оно
  // не участвовало в общем владении жестом, и клик, которым его закрывали,
  // попутно нажимал то, что лежало под ним.
  '[data-pane-new-tab-menu]',
  '[data-hidden-window-picker]',
]);

/** Is any click-to-dismiss overlay on screen right now? */
export function isDismissibleOverlayOpen(doc) {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  return DISMISSIBLE_OVERLAY_SELECTORS.some((selector) => !!doc.querySelector(selector));
}

/**
 * ESCAPE ПРИНАДЛЕЖИТ САМОМУ ВЕРХНЕМУ ОВЕРЛЕЮ.
 *
 * Свой capture-listener этого не гарантирует: побеждает тот, кто подписался
 * РАНЬШЕ, а не тот, кто ближе к человеку. Живой пример — пустое окно: его
 * обработчик Escape зарегистрирован при появлении окна, то есть заведомо
 * раньше меню, и `stopImmediatePropagation` закрывал страницу выбора, пока
 * человек всего лишь хотел убрать открытое поверх неё меню.
 *
 * Поэтому оконные обработчики Escape спрашивают ЭТО, а не свой флаг: пока на
 * экране есть меню, Escape принадлежит ему. Один Escape закрывает меню,
 * следующий — то, что под ним.
 */
export function escapeBelongsToOverlay(doc) {
  return isDismissibleOverlayOpen(doc);
}

// One gesture's worth of memory. Module-level on purpose: pointerdown and click
// are handled by different components, and threading a flag between them through
// props/store would put a transient input detail into app state.
let dismissalGesture = false;

/**
 * Call on pointerdown (capture). Records — and returns — whether this gesture is
 * a dismissal, i.e. whether an overlay was open when the press landed.
 */
export function notePointerDownForDismissal(doc) {
  dismissalGesture = isDismissibleOverlayOpen(doc);
  return dismissalGesture;
}

/**
 * True while the CURRENT gesture is the one that closed an overlay. Handlers on
 * click/mouseup consult this to stay out of the way.
 */
export function isDismissalGesture() {
  return dismissalGesture;
}

/** Test seam / explicit reset between gestures. */
export function resetDismissalGesture() {
  dismissalGesture = false;
}
