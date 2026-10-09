export const TIMELINE_PREVIEW_RESPONSE_LINES_DEFAULT = 3;
export const TIMELINE_PREVIEW_RESPONSE_LINES_KEY = 'noted-terminal-timeline-preview-response-lines';
export function clampTimelinePreviewResponseLines(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.min(10, Math.round(number)))
    : TIMELINE_PREVIEW_RESPONSE_LINES_DEFAULT;
}
export function loadTimelinePreviewResponseLines(storage) {
  try { return clampTimelinePreviewResponseLines(storage?.getItem(TIMELINE_PREVIEW_RESPONSE_LINES_KEY)); }
  catch { return TIMELINE_PREVIEW_RESPONSE_LINES_DEFAULT; }
}
