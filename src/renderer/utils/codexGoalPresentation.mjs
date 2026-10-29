import {codexGoalPresentation} from '../../shared/timeline-entry-facts.mjs';
export {codexGoalPresentation};


/** Applies after canonical/live/handoff merge AND note/working-file projection.
 * Copies no records, mutates no cache and leaves exact later turnIndex intact. */
export function filterTimelineGoalPresentation(entries, toolType) {
  if (toolType !== 'codex' || !Array.isArray(entries)) return entries;
  const visible = entries.filter(entry => !codexGoalPresentation(entry, toolType));
  return visible.length === entries.length ? entries : visible;
}
