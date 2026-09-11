/**
 * `busy` is an edge belonging to a turn or local command; automation needs
 * that exact edge. `activityBusy` is main's current aggregate for display.
 * A completed /compact may coexist with a newer, still-running answer.
 * Older main builds and other providers keep the existing boolean contract.
 */
export function resolveAgentBusyPresentation(event) {
  return typeof event?.activityBusy === 'boolean'
    ? event.activityBusy
    : event?.busy === true;
}
