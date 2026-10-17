const COMPOSER_ROOT_SELECTOR = '.gt-composer-editor';

export function isComposerKeyboardTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest(COMPOSER_ROOT_SELECTOR));
}

export function shouldOpenHistorySearchFromKeydown(event, surface) {
  if (!surface?.isOpen || event?.defaultPrevented || event?.isComposing) return false;
  if (event?.code ? event.code !== 'KeyF' : event?.key?.toLowerCase() !== 'f') return false;
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;

  // Find follows the presented History even while its composer owns focus.
  // The input-only find panel is an explicit window-menu action.
  if (surface.terminalIsPrimary) return false;
  if (surface.mainSurface && surface.terminalOpen) return false;
  return true;
}
