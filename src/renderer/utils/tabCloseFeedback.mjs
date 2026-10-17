// Presentation only. Runtime cancellation, confirmation and archive ownership
// stay with closeTab. Several callers can share one live Tab object.
const pending = new WeakMap();

export function beginTabCloseFeedback({tab, isCurrent, publish}) {
  const notify = () => {
    if (!isCurrent()) return;
    try { publish(); }
    catch (error) {
      // A presentation subscriber must not replace the archive/stop outcome.
      console.warn('[CloseTab:Feedback] publication failed reason=' + (error?.code || error?.name || 'unknown'));
    }
  };
  let state = pending.get(tab);
  if (!state) {
    state = {count: 0, alreadyClosing: tab.aiClosing === true};
    pending.set(tab, state);
  }
  state.count++;
  if (!tab.aiClosing) {
    tab.aiClosing = true;
    notify();
  }
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    if (--state.count !== 0) return;
    pending.delete(tab);
    if (state.alreadyClosing || !tab.aiClosing) return;
    tab.aiClosing = false;
    // A late completion cannot clear a successor tab or publish an old Map.
    notify();
  };
}
