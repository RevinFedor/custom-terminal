import assert from 'node:assert/strict';
import test from 'node:test';

import { PANE_LAYER_PRESENTATION_EVENT } from './paneLayerPresentation.mjs';
import { subscribePaneTimelinePresentation } from './paneTimelinePresentation.mjs';
import { planTimelineTranscriptRefresh } from './timelineTranscriptRefresh.mjs';

class PresentationTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(detail) {
    for (const listener of this.listeners.get(PANE_LAYER_PRESENTATION_EVENT) || []) {
      listener({ detail });
    }
  }

  listenerCount() {
    return this.listeners.get(PANE_LAYER_PRESENTATION_EVENT)?.size || 0;
  }
}

test('ready dormant Timeline reacts to ref-only presentation and flushes once without remount', () => {
  const target = new PresentationTarget();
  const physicalTree = {
    history: { kind: 'History' },
    virtuoso: { kind: 'Virtuoso' },
    scroller: { kind: 'scroller' },
    timeline: { kind: 'Timeline' },
  };
  const identityBefore = { ...physicalTree };
  const visibleStates = [];
  let pending = planTimelineTranscriptRefresh({
    invalidation: true,
    isTurnBusy: false,
    documentVisible: true,
    surfaceVisible: false,
  }).pending;
  let refreshFlushes = 0;

  // The host is already mounted and heavy-ready. No parent state transition is
  // involved below: the only input is the pane presentation event that also
  // updates SplitPaneSurface's synchronous ref.
  const subscription = subscribePaneTimelinePresentation({
    target,
    tabId: 'tab-ready',
    initialPresented: false,
    onPresented: (presented) => {
      visibleStates.push(presented);
      const plan = planTimelineTranscriptRefresh({
        pending,
        isTurnBusy: false,
        documentVisible: true,
        surfaceVisible: presented,
      });
      pending = plan.pending;
      if (plan.refresh) refreshFlushes += 1;
    },
  });

  assert.equal(target.listenerCount(), 1);
  target.dispatch({ tabId: 'another-tab', presented: true });
  target.dispatch({ tabId: 'tab-ready', presented: true });
  target.dispatch({ tabId: 'tab-ready', presented: true });

  assert.equal(subscription.current(), true);
  assert.deepEqual(visibleStates, [true]);
  assert.equal(refreshFlushes, 1, 'duplicate presented=true cannot flush twice');
  assert.equal(pending, false);

  target.dispatch({ tabId: 'tab-ready', presented: false });
  assert.equal(subscription.current(), false);
  assert.deepEqual(visibleStates, [true, false]);
  assert.equal(target.listenerCount(), 1, 'hide keeps the retained Timeline subscribed');
  assert.equal(refreshFlushes, 1);

  assert.strictEqual(physicalTree.history, identityBefore.history);
  assert.strictEqual(physicalTree.virtuoso, identityBefore.virtuoso);
  assert.strictEqual(physicalTree.scroller, identityBefore.scroller);
  assert.strictEqual(physicalTree.timeline, identityBefore.timeline);

  subscription.dispose();
  assert.equal(target.listenerCount(), 0);
  target.dispatch({ tabId: 'tab-ready', presented: true });
  assert.deepEqual(visibleStates, [true, false], 'unmounted host ignores stale events');
});
