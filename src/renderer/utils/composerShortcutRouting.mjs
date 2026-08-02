const COMPOSER_ROOT_SELECTOR = '.gt-composer-editor';

export function isComposerKeyboardTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest(COMPOSER_ROOT_SELECTOR));
}

export function shouldOpenHistorySearchFromKeydown(event, surface) {
  if (!surface?.isOpen || event?.defaultPrevented || event?.isComposing) return false;
  if (event?.key?.toLowerCase() !== 'f') return false;
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;

  // Run after is portalled out of History's React subtree but still bubbles
  // through this window capture listener. Physical DOM ownership is the only
  // reliable boundary: every shared composer must receive Mod-F itself.
  if (isComposerKeyboardTarget(event.target)) return false;
  if (surface.terminalIsPrimary) return false;
  if (surface.mainSurface && surface.terminalOpen) return false;
  return true;
}
