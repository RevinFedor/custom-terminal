import React, { startTransition, useLayoutEffect, useRef, useState } from 'react';
import { subscribePaneTimelinePresentation } from '../../utils/paneTimelinePresentation.mjs';
import Timeline from './Timeline';

type PersistentPaneTimelineProps = Omit<
  React.ComponentProps<typeof Timeline>,
  'isVisible'
> & {
  initialPresented: boolean;
};

/**
 * Reactive presentation boundary for Timeline only.
 *
 * The parent keeps pane presentation in a ref so a workflow switch cannot
 * reconcile History/Virtuoso. Timeline still needs to observe show/hide in
 * order to flush one deferred transcript refresh. Keeping that state here
 * updates only the Timeline subtree and never remounts either sibling.
 */
function PersistentPaneTimeline({
  initialPresented,
  tabId,
  ...timelineProps
}: PersistentPaneTimelineProps) {
  const [presented, setPresented] = useState(initialPresented);
  const presentedRef = useRef(presented);
  presentedRef.current = presented;

  useLayoutEffect(() => {
    const subscription = subscribePaneTimelinePresentation({
      target: window,
      tabId,
      initialPresented: presentedRef.current,
      onPresented: (nextPresented: boolean) => {
        presentedRef.current = nextPresented;
        // Pane opacity is already committed imperatively. Timeline visibility
        // may reconcile afterwards without extending the click's first paint;
        // this is scheduler priority, not a timer or fixed wait.
        startTransition(() => setPresented(nextPresented));
      },
    });
    return subscription.dispose;
  }, [tabId]);

  return (
    <Timeline
      {...timelineProps}
      tabId={tabId}
      isVisible={presented}
    />
  );
}

export default React.memo(PersistentPaneTimeline);
