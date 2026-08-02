const PROJECT_ARROW_OWNING_SURFACES = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '.xterm',
  '.gt-composer-editor',
].join(',');

export function shouldNavigateProjectsWithArrow(event, activeArea, editingProjectId) {
  if (activeArea !== 'projects' || editingProjectId) return false;
  if (event?.code !== 'ArrowLeft' && event?.code !== 'ArrowRight') return false;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return false;
  }
  const target = event.target;
  if (target && typeof target.closest === 'function'
      && target.closest(PROJECT_ARROW_OWNING_SURFACES)) return false;
  return true;
}
