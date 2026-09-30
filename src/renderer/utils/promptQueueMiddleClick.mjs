/**
 * Consume the row's middle-button gesture before nested inputs/buttons see it.
 * Call without `remove` on mousedown (no focus, autoscroll or paste), then with
 * `remove` on auxclick. React portals bubble through their logical parent, but
 * a separate picker/menu is not part of this physical row's delete target.
 */
export function consumePromptQueueMiddleClick(event, remove) {
  if (event.button !== 1 || !event.currentTarget.contains(event.target)) return false;
  event.preventDefault();
  event.stopPropagation();
  remove?.();
  return true;
}
