import { PANE_LAYER_PRESENTATION_EVENT } from './paneLayerPresentation.mjs';

/**
 * Subscribe one retained Timeline to the presentation of its physical pane.
 *
 * SplitPaneSurface deliberately keeps presentation in a ref so workflow
 * switches do not reconcile the heavy History/Virtuoso sibling. A Timeline,
 * however, needs one reactive boolean to release a deferred transcript
 * refresh when that already-warm pane becomes visible. This tiny subscription
 * is the bridge: duplicate events are coalesced and no parent state is needed.
 */
export function subscribePaneTimelinePresentation({
  target,
  tabId,
  initialPresented = false,
  onPresented,
}) {
  let presented = initialPresented === true;
  let disposed = false;

  const onPresentation = (event) => {
    const detail = event?.detail;
    if (disposed || detail?.tabId !== tabId || typeof detail.presented !== 'boolean') return;
    const nextPresented = detail.presented === true;
    if (nextPresented === presented) return;
    presented = nextPresented;
    onPresented(nextPresented);
  };

  target.addEventListener(PANE_LAYER_PRESENTATION_EVENT, onPresentation);
  return {
    current: () => presented,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      target.removeEventListener(PANE_LAYER_PRESENTATION_EVENT, onPresentation);
    },
  };
}
