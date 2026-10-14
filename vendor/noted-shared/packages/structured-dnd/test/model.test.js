import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVisualHierarchyDepthMap,
  consumeAxisThresholdSteps,
  consumeHorizontalThresholdFrame,
  flatStructuredEntities,
  moveStructuredEntity,
  normalizeSelectedVisualRootIds,
  orderVisualHierarchyItems,
  resolveVisualBlockMove,
  resolveGroupedListTarget,
  resolveAxisFrameOwner,
  resolveFrozenCommitProjection,
  resolveIdleAxisFeedbackState,
  resolveIdleHorizontalSessionState,
  resolveStructuredHierarchyStep,
  resolveStructuredVerticalMove,
  resolveVisualHierarchyStep,
  shouldHandoffBlockedHorizontalToVertical,
  shouldClearHorizontalBoundary,
  shouldRestartHorizontalBoundary,
  shouldShowAxisBoundaryStop,
  startPointerDragSession,
  visualHierarchyAncestorIds,
  visualHierarchySubtreeItems,
} from '../src/index.js';

function createPointerTestEnvironment() {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const listeners = new Map();
  let frameQueue = [];

  globalThis.window = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  globalThis.document = {
    body: {
      style: {
        cursor: '',
        userSelect: '',
      },
    },
  };
  globalThis.requestAnimationFrame = (callback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  };

  const event = (overrides = {}) => ({
    button: 0,
    clientX: 10,
    clientY: 10,
    metaKey: false,
    key: '',
    target: { closest: () => null },
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
    ...overrides,
  });

  return {
    dispatch(type, overrides) {
      listeners.get(type)?.(event(overrides));
    },
    async flushFrame() {
      const callbacks = frameQueue;
      frameQueue = [];
      callbacks.forEach((callback) => callback(Date.now()));
      await Promise.resolve();
    },
    restore() {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    },
  };
}

test('accepted boundary crossing stays valid inside a bounded hold zone', () => {
  assert.equal(shouldShowAxisBoundaryStop({ previewChanged: true, canContinue: false }), false);
  assert.equal(shouldShowAxisBoundaryStop({
    previewChanged: false,
    canContinue: false,
    acceptedAt: 100,
    currentPosition: 139,
    holdDistance: 40,
  }), false);
  assert.equal(shouldShowAxisBoundaryStop({
    previewChanged: false,
    canContinue: false,
    acceptedAt: 100,
    currentPosition: 140,
    holdDistance: 40,
  }), true);
  assert.equal(shouldShowAxisBoundaryStop({ previewChanged: false, canContinue: false }), true);
  assert.equal(shouldShowAxisBoundaryStop({ previewChanged: false, canContinue: true }), false);
});

test('idle frame preserves a visible vertical stop but clears horizontal deadzone feedback', () => {
  assert.deepEqual(resolveIdleAxisFeedbackState({
    feedbackAxis: 'vertical',
    releaseBlocked: true,
  }), {
    feedbackAxis: 'vertical',
    releaseBlocked: true,
  });
  assert.deepEqual(resolveIdleAxisFeedbackState({
    feedbackAxis: 'horizontal',
    releaseBlocked: true,
  }), {
    feedbackAxis: null,
    releaseBlocked: false,
  });
  assert.deepEqual(resolveIdleAxisFeedbackState({
    feedbackAxis: 'horizontal',
    releaseBlocked: false,
    retainHorizontal: true,
  }), {
    feedbackAxis: 'horizontal',
    releaseBlocked: false,
  });
  assert.deepEqual(resolveIdleAxisFeedbackState({
    feedbackAxis: 'horizontal',
    releaseBlocked: true,
    retainHorizontal: true,
    clearHorizontalBlock: true,
  }), {
    feedbackAxis: 'horizontal',
    releaseBlocked: false,
  });
});

test('horizontal idle retreat closes the old boundary and follows the residual direction', () => {
  assert.deepEqual(resolveIdleHorizontalSessionState({
    boundaryActive: true,
    boundaryStartX: 28,
    boundaryStartY: 0,
    feedbackDirection: 'right',
    deltaX: -3,
    clearHorizontalBlock: true,
  }), {
    boundaryActive: false,
    boundaryStartX: null,
    boundaryStartY: null,
    feedbackDirection: 'left',
  });

  assert.deepEqual(resolveIdleHorizontalSessionState({
    boundaryActive: true,
    boundaryStartX: -28,
    boundaryStartY: 4,
    feedbackDirection: 'left',
    deltaX: 0,
    clearHorizontalBlock: false,
  }), {
    boundaryActive: true,
    boundaryStartX: -28,
    boundaryStartY: 4,
    feedbackDirection: 'left',
  });
});

test('horizontal boundary closes in the deadzone after an interpolated retreat already cleared the stop', () => {
  assert.equal(shouldClearHorizontalBoundary({
    feedbackAxis: 'horizontal',
    boundaryActive: true,
    deltaX: 0,
    horizontalDeadzone: 6,
  }), true);
  assert.equal(shouldClearHorizontalBoundary({
    feedbackAxis: 'horizontal',
    boundaryActive: true,
    deltaX: 7,
    horizontalDeadzone: 6,
  }), false);
  assert.equal(shouldClearHorizontalBoundary({
    feedbackAxis: 'vertical',
    boundaryActive: true,
    deltaX: 0,
    horizontalDeadzone: 6,
  }), false);
});

test('coalesced reverse starts a new horizontal boundary session', () => {
  assert.equal(shouldRestartHorizontalBoundary({
    boundaryActive: true,
    boundaryDirection: 'right',
    frameDirection: 'left',
  }), true);
  assert.equal(shouldRestartHorizontalBoundary({
    boundaryActive: true,
    boundaryDirection: 'left',
    frameDirection: 'left',
  }), false);
  assert.equal(shouldRestartHorizontalBoundary({
    boundaryActive: false,
    boundaryDirection: 'right',
    frameDirection: 'left',
  }), false);
});

test('forbidden preview cannot commit during navigation but retains its last accepted resume projection', () => {
  assert.deepEqual(resolveFrozenCommitProjection({
    hasCommitProjection: true,
    commitKey: 'hierarchy:right:attach',
    releaseBlocked: true,
  }), {
    canCommit: false,
    frozenCommitKey: null,
    frozenHasCommitProjection: false,
    resumeCommitKey: 'hierarchy:right:attach',
    resumeHasCommitProjection: true,
  });
  assert.deepEqual(resolveFrozenCommitProjection({
    hasCommitProjection: true,
    commitKey: 'vertical:after:last',
    releaseBlocked: false,
  }), {
    canCommit: true,
    frozenCommitKey: 'vertical:after:last',
    frozenHasCommitProjection: true,
    resumeCommitKey: 'vertical:after:last',
    resumeHasCommitProjection: true,
  });
  assert.deepEqual(resolveFrozenCommitProjection({
    hasCommitProjection: false,
    commitKey: null,
    releaseBlocked: true,
  }), {
    canCommit: false,
    frozenCommitKey: null,
    frozenHasCommitProjection: false,
    resumeCommitKey: null,
    resumeHasCommitProjection: false,
  });
});

test('blocked horizontal frame gates release and rebases the orthogonal axis', () => {
  const frame = consumeHorizontalThresholdFrame({
    clientX: 100,
    clientY: 40,
    horizontalBaseX: 0,
    verticalBaseY: 0,
    threshold: 28,
    state: 0,
    resolveStep: (state) => state < 1
      ? { ok: true, next: state + 1, reason: 'accepted' }
      : { ok: false, reason: 'depth-limit' },
  });

  assert.equal(frame.acceptedSteps, 1);
  assert.equal(frame.blockedAtThreshold, true);
  assert.equal(frame.releaseBlocked, true);
  assert.equal(frame.nextHorizontalBaseX, 72);
  assert.equal(frame.nextVerticalBaseY, 40);
  assert.equal(frame.residualDeltaX, 28);

  assert.equal(resolveAxisFrameOwner({
    deltaX: 99 - frame.nextHorizontalBaseX,
    deltaY: 40 - frame.nextVerticalBaseY,
    horizontalDeadzone: 6,
    verticalThreshold: 4,
  }), 'horizontal');
});

test('accepted horizontal frame keeps release valid below the next threshold', () => {
  const frame = consumeHorizontalThresholdFrame({
    clientX: 35,
    clientY: 2,
    horizontalBaseX: 0,
    verticalBaseY: 0,
    threshold: 28,
    state: 0,
    resolveStep: (state) => ({ ok: true, next: state + 1 }),
  });

  assert.equal(frame.acceptedSteps, 1);
  assert.equal(frame.blockedAtThreshold, false);
  assert.equal(frame.releaseBlocked, false);
  assert.equal(frame.nextHorizontalBaseX, 28);
  assert.equal(frame.nextVerticalBaseY, 2);
  assert.equal(frame.residualDeltaX, 7);
});

test('pure vertical interpolation does not ratchet the orthogonal anchor behind residual X', () => {
  const frame = consumeHorizontalThresholdFrame({
    clientX: 380,
    clientY: 643,
    previousClientX: 380,
    previousClientY: 636,
    horizontalBaseX: 370,
    verticalBaseY: 636,
    threshold: 28,
    state: 1,
    resolveStep: () => ({ ok: false, reason: 'depth-limit' }),
  });

  assert.equal(frame.acceptedSteps, 0);
  assert.equal(frame.blockedAtThreshold, false);
  assert.equal(frame.nextHorizontalBaseX, 370);
  assert.equal(frame.nextVerticalBaseY, 636);
  assert.equal(resolveAxisFrameOwner({
    deltaX: 380 - frame.nextHorizontalBaseX,
    deltaY: 650 - frame.nextVerticalBaseY,
    horizontalDeadzone: 6,
    verticalThreshold: 4,
  }), 'vertical');
});

test('blocked horizontal feedback cannot starve accumulated vertical movement', () => {
  let horizontalBaseX = 0;
  let verticalBaseY = 0;
  let previousClientX = 0;
  let previousClientY = 0;
  let horizontalBoundaryActive = false;

  for (let clientY = 0; clientY <= 5; clientY += 1) {
    const frame = consumeHorizontalThresholdFrame({
      clientX: 28,
      clientY,
      previousClientX,
      previousClientY,
      horizontalBaseX,
      verticalBaseY,
      horizontalBoundaryActive,
      threshold: 28,
      state: 1,
      resolveStep: () => ({ ok: false, reason: 'depth-limit' }),
    });
    horizontalBaseX = frame.nextHorizontalBaseX;
    verticalBaseY = frame.nextVerticalBaseY;
    horizontalBoundaryActive ||= frame.blockedAtThreshold;
    previousClientX = 28;
    previousClientY = clientY;
  }

  assert.equal(verticalBaseY, 0);
  assert.equal(shouldHandoffBlockedHorizontalToVertical({
    horizontalBlocked: true,
    deltaX: 0,
    deltaY: 5 - verticalBaseY,
    verticalThreshold: 4,
  }), true);
});

test('blocked horizontal jitter cannot ratchet the vertical anchor', () => {
  let horizontalBaseX = 0;
  let verticalBaseY = 0;
  let previousClientX = 28;
  let previousClientY = 0;

  for (let clientY = 1; clientY <= 8; clientY += 1) {
    const clientX = clientY % 2 === 1 ? 30 : 28;
    const frame = consumeHorizontalThresholdFrame({
      clientX,
      clientY,
      previousClientX,
      previousClientY,
      horizontalBaseX,
      verticalBaseY,
      horizontalBoundaryActive: true,
      threshold: 28,
      state: 1,
      resolveStep: () => ({ ok: false, reason: 'depth-limit' }),
    });
    horizontalBaseX = frame.nextHorizontalBaseX;
    verticalBaseY = frame.nextVerticalBaseY;
    previousClientX = clientX;
    previousClientY = clientY;
  }

  assert.equal(verticalBaseY, 0);
  assert.equal(shouldHandoffBlockedHorizontalToVertical({
    horizontalBlocked: true,
    deltaX: 0,
    deltaY: 8 - verticalBaseY,
    verticalThreshold: 4,
  }), true);
});

test('null previous pointer coordinates fall back to axis bases', () => {
  const frame = consumeHorizontalThresholdFrame({
    clientX: 120,
    clientY: 800,
    previousClientX: null,
    previousClientY: null,
    horizontalBaseX: 90,
    verticalBaseY: 790,
    threshold: 28,
    state: 0,
    resolveStep: () => ({ ok: false, reason: 'depth-limit' }),
  });

  assert.equal(frame.nextVerticalBaseY, 800);
});

test('release waits for geometry refresh and previews the latest coalesced pointer before commit', async () => {
  const environment = createPointerTestEnvironment();
  const previews = [];
  const commits = [];
  const cancels = [];
  let geometryVersion = 0;

  try {
    startPointerDragSession({
      button: 0,
      clientX: 10,
      clientY: 10,
      metaKey: false,
      target: { closest: () => null },
      preventDefault() {},
      stopPropagation() {},
    }, {
      item: { id: 'dragged' },
      getBase: () => ({ order: ['dragged', 'target'] }),
      captureGeometry: () => ({ version: ++geometryVersion }),
      autoScroll: () => true,
      onPreview: ({ session, clientX, clientY }) => {
        previews.push({ clientX, clientY, geometry: session.geometry.version });
        session.pendingNext = { order: ['target', 'dragged'] };
        session.commitKey = 'after:target';
        session.hasCommitProjection = true;
        return { key: 'after:target', changed: false };
      },
      canCommitAt: ({ session, clientX, clientY }) => (
        !session.refreshing
        && session.geometry.version === 2
        && session.processedClientX === clientX
        && session.processedClientY === clientY
      ),
      onCommit: (session) => commits.push(session.commitKey),
      onCancel: () => cancels.push('cancel'),
    });

    environment.dispatch('pointermove', { clientX: 20, clientY: 20 });
    environment.dispatch('pointermove', { clientX: 25, clientY: 30 });
    environment.dispatch('pointerup', { clientX: 25, clientY: 30 });

    assert.deepEqual(commits, []);
    assert.deepEqual(cancels, []);

    await environment.flushFrame();
    await environment.flushFrame();

    assert.deepEqual(previews.at(-1), { clientX: 25, clientY: 30, geometry: 2 });
    assert.deepEqual(commits, ['after:target']);
    assert.deepEqual(cancels, []);
  } finally {
    environment.restore();
  }
});

test('pointer movement after a queued pointerup cannot change the released projection', async () => {
  const environment = createPointerTestEnvironment();
  const previews = [];
  const commits = [];
  const cancels = [];

  try {
    startPointerDragSession({
      button: 0,
      clientX: 10,
      clientY: 10,
      metaKey: false,
      target: { closest: () => null },
      preventDefault() {},
      stopPropagation() {},
    }, {
      item: { id: 'dragged' },
      getBase: () => ({ order: ['dragged', 'target'] }),
      captureGeometry: () => ({ ready: true }),
      autoScroll: () => true,
      onPreview: ({ session, clientX, clientY }) => {
        previews.push([clientX, clientY]);
        session.pendingNext = { order: ['target', 'dragged'] };
        session.commitKey = 'after:target';
        session.hasCommitProjection = true;
        return { key: 'after:target', changed: false };
      },
      canCommitAt: ({ session, clientX, clientY }) => (
        session.processedClientX === clientX && session.processedClientY === clientY
      ),
      onCommit: () => commits.push('commit'),
      onCancel: () => cancels.push('cancel'),
    });

    environment.dispatch('pointermove', { clientX: 20, clientY: 20 });
    environment.dispatch('pointerup', { clientX: 20, clientY: 20 });
    environment.dispatch('pointermove', { clientX: 60, clientY: 70 });
    await environment.flushFrame();
    await environment.flushFrame();

    assert.deepEqual(previews.at(-1), [20, 20]);
    assert.deepEqual(commits, ['commit']);
    assert.deepEqual(cancels, []);
  } finally {
    environment.restore();
  }
});

test('release cannot commit stale preview while geometry refresh is pending', async () => {
  const environment = createPointerTestEnvironment();
  const commits = [];
  let geometryVersion = 0;

  try {
    startPointerDragSession({
      button: 0,
      clientX: 10,
      clientY: 10,
      metaKey: false,
      target: { closest: () => null },
      preventDefault() {},
      stopPropagation() {},
    }, {
      item: { id: 'dragged' },
      getBase: () => ({ order: ['dragged', 'target'] }),
      captureGeometry: () => ({ version: ++geometryVersion }),
      autoScroll: () => true,
      onPreview: ({ session }) => {
        session.pendingNext = { order: ['target', 'dragged'] };
        session.commitKey = 'after:target';
        session.hasCommitProjection = true;
        return { key: 'after:target', changed: false };
      },
      canCommitAt: () => true,
      onCommit: (session) => commits.push(session.geometry.version),
      onCancel() {},
    });

    environment.dispatch('pointermove', { clientX: 20, clientY: 20 });
    environment.dispatch('pointerup', { clientX: 20, clientY: 20 });

    assert.deepEqual(commits, []);
    await environment.flushFrame();
    await environment.flushFrame();
    assert.deepEqual(commits, [2]);
  } finally {
    environment.restore();
  }
});

test('release at an unpainted pointerup coordinate cancels instead of committing an unseen slot', async () => {
  const environment = createPointerTestEnvironment();
  const commits = [];
  const cancels = [];

  try {
    startPointerDragSession({
      button: 0,
      clientX: 10,
      clientY: 10,
      metaKey: false,
      target: { closest: () => null },
      preventDefault() {},
      stopPropagation() {},
    }, {
      item: { id: 'dragged' },
      getBase: () => ({ order: ['dragged', 'target'] }),
      captureGeometry: () => ({ ready: true }),
      autoScroll: () => true,
      onPreview: ({ session }) => {
        session.pendingNext = { order: ['target', 'dragged'] };
        session.commitKey = 'after:target';
        session.hasCommitProjection = true;
        return { key: 'after:target', changed: false };
      },
      canCommitAt: ({ session, clientX, clientY }) => (
        session.processedClientX === clientX && session.processedClientY === clientY
      ),
      onCommit: () => commits.push('commit'),
      onCancel: () => cancels.push('cancel'),
    });

    environment.dispatch('pointermove', { clientX: 20, clientY: 20 });
    environment.dispatch('pointerup', { clientX: 25, clientY: 30 });
    await environment.flushFrame();
    await environment.flushFrame();

    assert.deepEqual(commits, []);
    assert.deepEqual(cancels, ['cancel']);
  } finally {
    environment.restore();
  }
});

test('Escape invalidates a queued release before geometry refresh completes', async () => {
  const environment = createPointerTestEnvironment();
  const commits = [];
  const cancels = [];

  try {
    startPointerDragSession({
      button: 0,
      clientX: 10,
      clientY: 10,
      metaKey: false,
      target: { closest: () => null },
      preventDefault() {},
      stopPropagation() {},
    }, {
      item: { id: 'dragged' },
      getBase: () => ({ order: ['dragged', 'target'] }),
      captureGeometry: () => ({ ready: true }),
      autoScroll: () => true,
      onPreview: ({ session }) => {
        session.pendingNext = { order: ['target', 'dragged'] };
        session.commitKey = 'after:target';
        session.hasCommitProjection = true;
        return { key: 'after:target', changed: false };
      },
      canCommitAt: () => true,
      onCommit: () => commits.push('commit'),
      onCancel: () => cancels.push('cancel'),
    });

    environment.dispatch('pointermove', { clientX: 20, clientY: 20 });
    environment.dispatch('pointerup', { clientX: 20, clientY: 20 });
    environment.dispatch('keydown', { key: 'Escape' });

    assert.deepEqual(commits, []);
    assert.deepEqual(cancels, ['cancel']);
    await environment.flushFrame();
    await environment.flushFrame();
    assert.deepEqual(commits, []);
    assert.deepEqual(cancels, ['cancel']);
  } finally {
    environment.restore();
  }
});

test('coalesced axis movement consumes every accepted threshold and preserves the remainder', () => {
  const result = consumeAxisThresholdSteps({
    delta: 101,
    threshold: 28,
    state: 0,
    resolveStep: (state) => state < 3
      ? { ok: true, next: state + 1, reason: `step-${state + 1}` }
      : { ok: false, reason: 'limit' },
  });

  assert.equal(result.requestedSteps, 3);
  assert.equal(result.acceptedSteps, 3);
  assert.equal(result.state, 3);
  assert.equal(result.consumedDelta, 84);
  assert.equal(result.remainder, 17);
  assert.equal(result.blockedAtStep, null);
});

test('coalesced axis movement stops at the first forbidden threshold without discarding displacement', () => {
  const result = consumeAxisThresholdSteps({
    delta: -140,
    threshold: 28,
    state: 3,
    resolveStep: (state) => state > 1
      ? { ok: true, next: state - 1 }
      : { ok: false, reason: 'root-limit' },
  });

  assert.equal(result.requestedSteps, 5);
  assert.equal(result.acceptedSteps, 2);
  assert.equal(result.state, 1);
  assert.equal(result.consumedDelta, -56);
  assert.equal(result.remainder, -84);
  assert.equal(result.blockedAtStep, 2);
  assert.equal(result.blockedResult.reason, 'root-limit');
});

const model = () => ({
  containers: [{ id: 'g1', position: 0 }, { id: 'g2', position: 2 }],
  items: [
    { id: 'a', containerId: 'g1', position: 0 },
    { id: 'b', containerId: null, position: 1 },
    { id: 'c', containerId: 'g1', position: 1 },
  ],
});

test('container moves as one flat entity while its children stay attached', () => {
  const next = moveStructuredEntity(model(), { type: 'container', id: 'g1' }, { kind: 'flat', index: 3 });
  assert.deepEqual(flatStructuredEntities(next).map((item) => `${item.type}:${item.id}`), ['item:b', 'container:g2', 'container:g1']);
  assert.deepEqual(next.items.filter((item) => item.containerId === 'g1').sort((a, b) => a.position - b.position).map((item) => item.id), ['a', 'c']);
});

test('item can enter, reorder inside, and leave a container', () => {
  const inside = moveStructuredEntity(model(), { type: 'item', id: 'b' }, { kind: 'container', containerId: 'g1', index: 1 });
  assert.deepEqual(inside.items.filter((item) => item.containerId === 'g1').sort((a, b) => a.position - b.position).map((item) => item.id), ['a', 'b', 'c']);
  const root = moveStructuredEntity(inside, { type: 'item', id: 'b' }, { kind: 'flat', index: 1 });
  assert.equal(root.items.find((item) => item.id === 'b').containerId, null);
});

test('visual subtree moves atomically and cross-container move detaches only its root', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }, { id: 'g2', position: 1 }],
    items: [
      { id: 'a', containerId: 'g1', parentId: null, position: 0 },
      { id: 'b', containerId: 'g1', parentId: 'a', position: 1 },
      { id: 'c', containerId: 'g1', parentId: 'b', position: 2 },
      { id: 'd', containerId: 'g2', parentId: null, position: 0 },
    ],
  };
  const movedRoot = moveStructuredEntity(source, { type: 'item', id: 'a' }, { kind: 'container', containerId: 'g2', index: 1 });
  assert.deepEqual(movedRoot.items.filter((item) => ['a', 'b', 'c'].includes(item.id)).map((item) => item.containerId), ['g2', 'g2', 'g2']);
  assert.equal(movedRoot.items.find((item) => item.id === 'b').parentId, 'a');
  assert.equal(movedRoot.items.find((item) => item.id === 'c').parentId, 'b');

  const movedChild = moveStructuredEntity(source, { type: 'item', id: 'b' }, { kind: 'container', containerId: 'g2', index: 1 });
  assert.equal(movedChild.items.find((item) => item.id === 'b').parentId, null);
  assert.equal(movedChild.items.find((item) => item.id === 'c').parentId, 'b');
  assert.equal(movedChild.items.find((item) => item.id === 'c').containerId, 'g2');

  const reorderedChild = moveStructuredEntity(source, { type: 'item', id: 'b' }, { kind: 'container', containerId: 'g1', index: 2 });
  assert.equal(reorderedChild.items.find((item) => item.id === 'b').parentId, 'a');
  assert.equal(reorderedChild.items.find((item) => item.id === 'c').parentId, 'b');
});

test('moving a grouped visual root to flat detaches its entire subtree', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'a', containerId: 'g1', parentId: null, position: 0 },
      { id: 'b', containerId: 'g1', parentId: 'a', position: 1 },
      { id: 'c', containerId: 'g1', parentId: 'b', position: 2 },
      { id: 'outside', containerId: null, parentId: null, position: 1 },
    ],
  };

  const moved = moveStructuredEntity(source, { type: 'item', id: 'a' }, { kind: 'flat', index: 1 });
  assert.deepEqual(
    moved.items.filter((item) => ['a', 'b', 'c'].includes(item.id)).map((item) => ({
      id: item.id,
      containerId: item.containerId,
      parentId: item.parentId,
    })),
    [
      { id: 'a', containerId: null, parentId: null },
      { id: 'b', containerId: null, parentId: 'a' },
      { id: 'c', containerId: null, parentId: 'b' },
    ],
  );
  assert.equal(moved.items.some((item) => item.containerId === 'g1' && ['b', 'c'].includes(item.id)), false);
});

test('moving a grouped child to flat detaches its subtree but not its former parent', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'a', containerId: 'g1', parentId: null, position: 0 },
      { id: 'b', containerId: 'g1', parentId: 'a', position: 1 },
      { id: 'c', containerId: 'g1', parentId: 'b', position: 2 },
      { id: 'd', containerId: 'g1', parentId: 'a', position: 3 },
    ],
  };

  const moved = moveStructuredEntity(source, { type: 'item', id: 'b' }, { kind: 'flat', index: 1 });
  assert.deepEqual(
    moved.items.map((item) => ({ id: item.id, containerId: item.containerId, parentId: item.parentId })),
    [
      { id: 'a', containerId: 'g1', parentId: null },
      { id: 'b', containerId: null, parentId: null },
      { id: 'c', containerId: null, parentId: 'b' },
      { id: 'd', containerId: 'g1', parentId: 'a' },
    ],
  );
});

test('flat ordering exposes only visual roots and detaching a child keeps its descendants', () => {
  const source = {
    containers: [],
    items: [
      { id: 'a', containerId: null, parentId: null, position: 0 },
      { id: 'b', containerId: null, parentId: 'a', position: 1 },
      { id: 'c', containerId: null, parentId: 'b', position: 2 },
      { id: 'd', containerId: null, parentId: null, position: 3 },
    ],
  };
  assert.deepEqual(flatStructuredEntities(source).map((item) => item.id), ['a', 'd']);
  const detached = moveStructuredEntity(source, { type: 'item', id: 'b' }, { kind: 'flat', index: 1 });
  assert.equal(detached.items.find((item) => item.id === 'b').parentId, null);
  assert.equal(detached.items.find((item) => item.id === 'c').parentId, 'b');
  assert.deepEqual(flatStructuredEntities(detached).map((item) => item.id), ['a', 'b', 'd']);
});

test('grouped resolver treats a group header and body as one atomic vertical block', () => {
  const rect = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right, midY: (top + bottom) / 2 });
  const geometry = {
    list: rect(0, 300),
    flat: [{ type: 'container', id: 'g1', index: 0, rect: rect(20, 120), header: rect(20, 50) }],
    groups: [{ containerId: 'g1', header: rect(20, 50), body: rect(50, 120), rows: [{ id: 'a', rect: rect(60, 90, 30, 200) }], empty: null, rowLeft: 30, rowRight: 200 }],
  };
  const upper = resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 25 });
  const lowerHeader = resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 45 });
  const body = resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 80 });
  assert.deepEqual([upper.kind, upper.targetType, upper.targetId, upper.placement], ['block', 'container', 'g1', 'before']);
  assert.deepEqual([lowerHeader.kind, lowerHeader.targetType, lowerHeader.targetId, lowerHeader.placement], ['block', 'container', 'g1', 'before']);
  assert.deepEqual([body.kind, body.targetType, body.targetId, body.placement], ['block', 'container', 'g1', 'after']);
});

test('grouped resolver keeps an empty container body atomic without a placeholder element', () => {
  const rect = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right, midY: (top + bottom) / 2 });
  const geometry = {
    list: rect(0, 300),
    flat: [{ type: 'container', id: 'g1', index: 0, rect: rect(20, 58), header: rect(20, 50) }],
    groups: [{ containerId: 'g1', header: rect(20, 50), body: rect(50, 58), rows: [], empty: null, rowLeft: null, rowRight: null }],
  };
  assert.deepEqual(
    resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 54 }),
    { key: 'block:container:g1:after', kind: 'block', targetType: 'container', targetId: 'g1', placement: 'after', reason: 'atomic-flat-block' },
  );
});

test('structured vertical move crosses a whole group without entering it', () => {
  const rect = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right, midY: (top + bottom) / 2 });
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'member', containerId: 'g1', parentId: null, position: 0 },
      { id: 'source', containerId: null, parentId: null, position: 1 },
    ],
  };
  const geometry = {
    list: rect(0, 300),
    flat: [
      { type: 'container', id: 'g1', index: 0, rect: rect(20, 120), header: rect(20, 50) },
      { type: 'item', id: 'source', index: 1, rect: rect(130, 165), header: rect(130, 165) },
    ],
    groups: [{ containerId: 'g1', body: rect(50, 120), rows: [{ id: 'member', rect: rect(60, 95) }] }],
  };
  const moved = resolveStructuredVerticalMove({
    model: source,
    geometry,
    drag: { type: 'item', id: 'source' },
    clientX: 100,
    clientY: 40,
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.targetEntity.type, 'container');
  assert.deepEqual(moved.targetIds, ['container:g1', 'member']);
  assert.equal(moved.model.items.find((item) => item.id === 'source').containerId, null);
  assert.deepEqual(flatStructuredEntities(moved.model).map((item) => `${item.type}:${item.id}`), ['item:source', 'container:g1']);
});

test('structured vertical move crosses sibling subtrees and preserves hierarchy/container', () => {
  const rect = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right, midY: (top + bottom) / 2 });
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'root', containerId: 'g1', parentId: null, position: 0 },
      { id: 'source', containerId: 'g1', parentId: 'root', position: 1 },
      { id: 'source-child', containerId: 'g1', parentId: 'source', position: 2 },
      { id: 'target', containerId: 'g1', parentId: 'root', position: 3 },
      { id: 'target-child', containerId: 'g1', parentId: 'target', position: 4 },
    ],
  };
  const rows = source.items.map((item, index) => ({ id: item.id, rect: rect(20 + index * 36, 52 + index * 36, 24, 200) }));
  const geometry = {
    list: rect(0, 300),
    flat: [{ type: 'container', id: 'g1', index: 0, rect: rect(10, 230), header: rect(10, 20) }],
    groups: [{ containerId: 'g1', body: rect(20, 230), rows }],
  };
  const moved = resolveStructuredVerticalMove({
    model: source,
    geometry,
    drag: { type: 'item', id: 'source' },
    clientX: 100,
    clientY: 205,
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.targetIds, ['target', 'target-child']);
  assert.deepEqual(moved.orderedIds, ['root', 'target', 'target-child', 'source', 'source-child']);
  assert.equal(moved.model.items.find((item) => item.id === 'source').parentId, 'root');
  assert.equal(moved.model.items.find((item) => item.id === 'source-child').parentId, 'source');
  assert.equal(moved.model.items.find((item) => item.id === 'source').containerId, 'g1');
});

test('horizontal right enters only the immediately preceding group and keeps the subtree', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'member', containerId: 'g1', parentId: null, position: 0 },
      { id: 'source', containerId: null, parentId: null, position: 1 },
      { id: 'child', containerId: null, parentId: 'source', position: 2 },
      { id: 'tail', containerId: null, parentId: null, position: 3 },
    ],
  };
  const moved = resolveStructuredHierarchyStep({ model: source, sourceId: 'source', direction: 'right' });
  assert.equal(moved.ok, true);
  assert.equal(moved.reason, 'enter-previous-container');
  assert.equal(moved.model.items.find((item) => item.id === 'source').containerId, 'g1');
  assert.equal(moved.model.items.find((item) => item.id === 'child').containerId, 'g1');
  assert.equal(moved.model.items.find((item) => item.id === 'child').parentId, 'source');
  assert.equal(moved.model.items.find((item) => item.id === 'tail').position, 1);
});

test('fallback group entry reindexes roots without flattening nested sibling positions', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'member', containerId: 'g1', parentId: null, position: 0 },
      { id: 'member-child', containerId: 'g1', parentId: 'member', position: 17 },
      { id: 'source', containerId: null, parentId: null, position: 1 },
      { id: 'source-child', containerId: null, parentId: 'source', position: 9 },
      { id: 'tail', containerId: null, parentId: null, position: 2 },
    ],
  };

  const moved = resolveStructuredHierarchyStep({ model: source, sourceId: 'source', direction: 'right' });
  assert.equal(moved.ok, true);
  assert.deepEqual(
    moved.model.items
      .filter((item) => item.containerId === 'g1' && item.parentId == null)
      .sort((a, b) => a.position - b.position)
      .map((item) => [item.id, item.position]),
    [['member', 0], ['source', 1]],
  );
  assert.equal(moved.model.items.find((item) => item.id === 'member-child').position, 17);
  assert.equal(moved.model.items.find((item) => item.id === 'source-child').position, 9);
  assert.equal(moved.model.items.find((item) => item.id === 'tail').position, 1);
});

test('fallback group entry rejects a preceding container that is not open', () => {
  const source = {
    containers: [{ id: 'closed', position: 0 }],
    items: [{ id: 'source', containerId: null, parentId: null, position: 1 }],
  };

  const blocked = resolveStructuredHierarchyStep({
    model: source,
    sourceId: 'source',
    direction: 'right',
    openContainerIds: [],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'target-container-not-open');
  assert.equal(blocked.model.items.find((item) => item.id === 'source').containerId, null);

  const opened = resolveStructuredHierarchyStep({
    model: source,
    sourceId: 'source',
    direction: 'right',
    openContainerIds: ['closed'],
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.containerId, 'closed');
});

test('fallback group entry expires after the pointer leaves both the group block and source row', () => {
  const rect = (top, bottom) => ({ top, bottom, left: 0, right: 240, midY: (top + bottom) / 2 });
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [{ id: 'source', containerId: null, parentId: null, position: 1 }],
  };
  const geometry = {
    flat: [
      { type: 'container', id: 'g1', rect: rect(20, 80), header: rect(20, 42) },
      { type: 'item', id: 'source', rect: rect(86, 118), header: rect(86, 118) },
    ],
    groups: [{ containerId: 'g1', body: rect(42, 80), rows: [] }],
  };

  const active = resolveStructuredHierarchyStep({
    model: source,
    sourceId: 'source',
    direction: 'right',
    geometry,
    clientY: 100,
    openContainerIds: ['g1'],
  });
  assert.equal(active.ok, true);
  assert.equal(active.containerId, 'g1');

  const stale = resolveStructuredHierarchyStep({
    model: source,
    sourceId: 'source',
    direction: 'right',
    geometry,
    clientY: 170,
    openContainerIds: ['g1'],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'previous-container-left-by-y');
});

test('horizontal right uses the Y-selected open group instead of the previous flat group', () => {
  const rect = (top, bottom, left = 0, right = 240) => ({
    top,
    bottom,
    left,
    right,
    midY: (top + bottom) / 2,
  });
  const source = {
    containers: [
      { id: 'previous', position: 0 },
      { id: 'target', position: 2 },
    ],
    items: [
      { id: 'target-first', containerId: 'target', parentId: null, position: 0 },
      { id: 'source', containerId: null, parentId: null, position: 1 },
    ],
  };
  const geometry = {
    groups: [
      { containerId: 'previous', body: rect(30, 38), rows: [] },
      {
        containerId: 'target',
        body: rect(80, 130),
        rows: [{ id: 'target-first', rect: rect(86, 122) }],
      },
    ],
  };

  const moved = resolveStructuredHierarchyStep({
    model: source,
    sourceId: 'source',
    direction: 'right',
    targetContainerId: 'target',
    geometry,
    clientY: 82,
  });

  assert.equal(moved.ok, true);
  assert.equal(moved.reason, 'enter-target-container');
  assert.equal(moved.containerId, 'target');
  assert.equal(moved.insertionIndex, 0);
  assert.equal(moved.model.containers.find((container) => container.id === 'target').position, 1);
  assert.deepEqual(
    moved.model.items
      .filter((item) => item.containerId === 'target')
      .sort((a, b) => a.position - b.position)
      .map((item) => item.id),
    ['source', 'target-first'],
  );
});

test('Y-selected group entry places the source after a whole visual subtree', () => {
  const rect = (top, bottom) => ({ top, bottom, left: 0, right: 240, midY: (top + bottom) / 2 });
  const source = {
    containers: [{ id: 'target', position: 0 }],
    items: [
      { id: 'root', containerId: 'target', parentId: null, position: 0 },
      { id: 'child', containerId: 'target', parentId: 'root', position: 1 },
      { id: 'tail', containerId: 'target', parentId: null, position: 2 },
      { id: 'source', containerId: null, parentId: null, position: 1 },
    ],
  };
  const geometry = {
    groups: [{
      containerId: 'target',
      body: rect(40, 180),
      rows: [
        { id: 'root', rect: rect(50, 80) },
        { id: 'child', rect: rect(80, 110) },
        { id: 'tail', rect: rect(120, 150) },
      ],
    }],
  };

  const moved = resolveStructuredHierarchyStep({
    model: source,
    sourceId: 'source',
    direction: 'right',
    targetContainerId: 'target',
    geometry,
    clientY: 108,
  });

  assert.equal(moved.insertionIndex, 2);
  assert.deepEqual(
    orderVisualHierarchyItems(
      moved.model.items.filter((item) => item.containerId === 'target'),
    ).map((item) => item.id),
    ['root', 'child', 'source', 'tail'],
  );
  assert.deepEqual(
    moved.model.items
      .filter((item) => item.containerId === 'target' && item.parentId == null)
      .sort((a, b) => a.position - b.position)
      .map((item) => [item.id, item.position]),
    [['root', 0], ['source', 1], ['tail', 2]],
  );
  assert.equal(moved.model.items.find((item) => item.id === 'child').parentId, 'root');
  assert.equal(moved.model.items.find((item) => item.id === 'child').position, 1);
});

test('Y-selected closed group is not an implicit hierarchy target', () => {
  const source = {
    containers: [{ id: 'closed', position: 0 }],
    items: [{ id: 'source', containerId: null, parentId: null, position: 1 }],
  };
  const moved = resolveStructuredHierarchyStep({
    model: source,
    sourceId: 'source',
    direction: 'right',
    targetContainerId: 'closed',
    geometry: { groups: [] },
    clientY: 40,
  });
  assert.equal(moved.ok, false);
  assert.equal(moved.reason, 'target-container-not-open');
});

test('Y-selected group entry expires when the pointer leaves the remembered block', () => {
  const rect = (top, bottom) => ({ top, bottom, left: 0, right: 240, midY: (top + bottom) / 2 });
  const source = {
    containers: [{ id: 'target', position: 0 }],
    items: [
      { id: 'member', containerId: 'target', parentId: null, position: 0 },
      { id: 'source', containerId: null, parentId: null, position: 1 },
    ],
  };
  const geometry = {
    flat: [{ type: 'container', id: 'target', rect: rect(40, 120), header: rect(40, 64) }],
    groups: [{ containerId: 'target', body: rect(64, 120), rows: [{ id: 'member', rect: rect(70, 102) }] }],
  };

  const moved = resolveStructuredHierarchyStep({
    model: source,
    sourceId: 'source',
    direction: 'right',
    targetContainerId: 'target',
    geometry,
    clientY: 180,
  });
  assert.equal(moved.ok, false);
  assert.equal(moved.reason, 'target-container-left-by-y');
  assert.equal(moved.model.items.find((item) => item.id === 'source').containerId, null);
});

test('detaching the first grouped root compacts the remaining persisted positions', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'source', containerId: 'g1', parentId: null, position: 0 },
      { id: 'remaining', containerId: 'g1', parentId: null, position: 1 },
      { id: 'outside', containerId: null, parentId: null, position: 1 },
    ],
  };
  const moved = resolveStructuredHierarchyStep({
    model: source,
    sourceId: 'source',
    direction: 'left',
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.reason, 'detach-from-container');
  assert.equal(moved.model.items.find((item) => item.id === 'source').containerId, null);
  assert.equal(moved.model.items.find((item) => item.id === 'remaining').position, 0);
  assert.equal(moved.model.containers.find((container) => container.id === 'g1').position, 0);
  assert.equal(moved.model.items.find((item) => item.id === 'source').position, 1);
  assert.equal(moved.model.items.find((item) => item.id === 'outside').position, 2);
});

test('global indent removes the source from the shared group and root position plane', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'parent', containerId: null, parentId: null, position: 1 },
      { id: 'source', containerId: null, parentId: null, position: 2 },
      { id: 'tail', containerId: null, parentId: null, position: 3 },
    ],
  };

  const moved = resolveStructuredHierarchyStep({ model: source, sourceId: 'source', direction: 'right' });
  assert.equal(moved.ok, true);
  assert.equal(moved.parentId, 'parent');
  assert.deepEqual(flatStructuredEntities(moved.model), [
    { type: 'container', id: 'g1', position: 0 },
    { type: 'item', id: 'parent', position: 1 },
    { type: 'item', id: 'tail', position: 2 },
  ]);
  assert.equal(moved.model.items.find((item) => item.id === 'source').position, 0);
});

test('global outdent inserts after the former root block in the shared flat plane', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'parent', containerId: null, parentId: null, position: 1 },
      { id: 'source', containerId: null, parentId: 'parent', position: 0 },
      { id: 'tail', containerId: null, parentId: null, position: 2 },
    ],
  };

  const moved = resolveStructuredHierarchyStep({ model: source, sourceId: 'source', direction: 'left' });
  assert.equal(moved.ok, true);
  assert.equal(moved.parentId, null);
  assert.deepEqual(flatStructuredEntities(moved.model), [
    { type: 'container', id: 'g1', position: 0 },
    { type: 'item', id: 'parent', position: 1 },
    { type: 'item', id: 'source', position: 2 },
    { type: 'item', id: 'tail', position: 3 },
  ]);
});

test('visual hierarchy attaches to previous peer and outdents one level per step', () => {
  const items = [
    { id: 'a', containerId: null, parentId: null },
    { id: 'b', containerId: null, parentId: null },
    { id: 'c', containerId: null, parentId: null },
  ];
  const attached = resolveVisualHierarchyStep({ items, sourceId: 'b', direction: 'right' });
  assert.equal(attached.ok, true);
  assert.equal(attached.parentId, 'a');
  const sibling = resolveVisualHierarchyStep({ items: attached.items, sourceId: 'c', direction: 'right' });
  assert.equal(sibling.parentId, 'a');
  const nested = resolveVisualHierarchyStep({ items: sibling.items, sourceId: 'c', direction: 'right' });
  assert.equal(nested.parentId, 'b');
  assert.deepEqual(orderVisualHierarchyItems(nested.items).map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual([...buildVisualHierarchyDepthMap(nested.items).entries()], [['a', 0], ['b', 1], ['c', 2]]);
  assert.deepEqual(visualHierarchyAncestorIds(nested.items, 'c'), ['b', 'a']);
  const outdent = resolveVisualHierarchyStep({ items: nested.items, sourceId: 'c', direction: 'left' });
  assert.equal(outdent.parentId, 'a');
  const detached = resolveVisualHierarchyStep({ items: outdent.items, sourceId: 'c', direction: 'left' });
  assert.equal(detached.parentId, null);
});

test('visual attach compacts both sibling namespaces and vertical reorder uses the new parent', () => {
  const items = [
    { id: 'root-a', containerId: 'g1', parentId: null, position: 0 },
    { id: 'root-b', containerId: 'g1', parentId: null, position: 1 },
    { id: 'existing-child', containerId: 'g1', parentId: 'root-b', position: 0 },
    { id: 'source', containerId: 'g1', parentId: null, position: 2 },
  ];

  const attached = resolveVisualHierarchyStep({ items, sourceId: 'source', direction: 'right' });
  assert.equal(attached.ok, true);
  assert.equal(attached.parentId, 'root-b');
  assert.deepEqual(
    attached.items
      .filter((item) => item.parentId == null)
      .sort((a, b) => a.position - b.position)
      .map((item) => [item.id, item.position]),
    [['root-a', 0], ['root-b', 1]],
  );
  assert.deepEqual(
    attached.items
      .filter((item) => item.parentId === 'root-b')
      .sort((a, b) => a.position - b.position)
      .map((item) => [item.id, item.position]),
    [['existing-child', 0], ['source', 1]],
  );

  const reordered = resolveVisualBlockMove({
    items: attached.items,
    sourceId: 'source',
    targetId: 'existing-child',
    placement: 'before',
  });
  assert.equal(reordered.ok, true);
  assert.deepEqual(
    reordered.items
      .filter((item) => item.parentId === 'root-b')
      .sort((a, b) => a.position - b.position)
      .map((item) => [item.id, item.position]),
    [['source', 0], ['existing-child', 1]],
  );
});

test('visual outdent compacts the old children and inserts after the former parent', () => {
  const items = [
    { id: 'root', containerId: 'g1', parentId: null, position: 0 },
    { id: 'branch', containerId: 'g1', parentId: 'root', position: 0 },
    { id: 'next', containerId: 'g1', parentId: 'root', position: 1 },
    { id: 'source', containerId: 'g1', parentId: 'branch', position: 0 },
    { id: 'old-tail', containerId: 'g1', parentId: 'branch', position: 1 },
  ];

  const moved = resolveVisualHierarchyStep({ items, sourceId: 'source', direction: 'left' });
  assert.equal(moved.ok, true);
  assert.equal(moved.parentId, 'root');
  assert.deepEqual(
    moved.items
      .filter((item) => item.parentId === 'root')
      .sort((a, b) => a.position - b.position)
      .map((item) => [item.id, item.position]),
    [['branch', 0], ['source', 1], ['next', 2]],
  );
  assert.deepEqual(
    moved.items
      .filter((item) => item.parentId === 'branch')
      .map((item) => [item.id, item.position]),
    [['old-tail', 0]],
  );
});

test('visual hierarchy does not indent under a remote peer from another parent branch', () => {
  const items = [
    { id: 'previous-root', containerId: null, parentId: null, position: 0 },
    { id: 'previous-child', containerId: null, parentId: 'previous-root', position: 1 },
    { id: 'previous-grandchild', containerId: null, parentId: 'previous-child', position: 2 },
    { id: 'current-root', containerId: null, parentId: null, position: 3 },
    { id: 'source', containerId: null, parentId: 'current-root', position: 4 },
  ];

  const result = resolveVisualHierarchyStep({ items, sourceId: 'source', direction: 'right' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-previous-peer');
  assert.equal(result.items.find((item) => item.id === 'source').parentId, 'current-root');
});

test('left steps outdent through parent, then container, then disable at flat root', () => {
  const items = [
    { id: 'a', containerId: 'g1', parentId: null, position: 0 },
    { id: 'b', containerId: 'g1', parentId: 'a', position: 1 },
    { id: 'c', containerId: 'g1', parentId: 'b', position: 2 },
    { id: 'd', containerId: 'g1', parentId: 'c', position: 3 },
  ];

  const parentLevel = resolveVisualHierarchyStep({ items, sourceId: 'b', direction: 'left' });
  assert.equal(parentLevel.reason, 'detach-to-root');
  assert.equal(parentLevel.items.find((item) => item.id === 'b').parentId, null);
  assert.equal(parentLevel.items.find((item) => item.id === 'c').parentId, 'b');
  assert.equal(parentLevel.items.find((item) => item.id === 'b').containerId, 'g1');

  const groupLevel = resolveVisualHierarchyStep({ items: parentLevel.items, sourceId: 'b', direction: 'left' });
  assert.equal(groupLevel.reason, 'detach-from-container');
  assert.deepEqual(groupLevel.parentAssignments, { b: null, c: 'b', d: 'c' });
  assert.deepEqual(groupLevel.containerAssignments, { b: null, c: null, d: null });
  assert.deepEqual(
    groupLevel.items.filter((item) => ['b', 'c', 'd'].includes(item.id)).map((item) => ({
      id: item.id,
      containerId: item.containerId,
      parentId: item.parentId,
    })),
    [
      { id: 'b', containerId: null, parentId: null },
      { id: 'c', containerId: null, parentId: 'b' },
      { id: 'd', containerId: null, parentId: 'c' },
    ],
  );

  const disabled = resolveVisualHierarchyStep({ items: groupLevel.items, sourceId: 'b', direction: 'left' });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.reason, 'already-root');
});

test('visual hierarchy follows persisted positions after a vertical reorder', () => {
  const items = [
    { id: 'a', containerId: 'g1', parentId: null, position: 0 },
    { id: 'b', containerId: 'g1', parentId: 'a', position: 2 },
    { id: 'c', containerId: 'g1', parentId: 'a', position: 1 },
  ];
  assert.deepEqual(orderVisualHierarchyItems(items).map((item) => item.id), ['a', 'c', 'b']);
  const nested = resolveVisualHierarchyStep({ items, sourceId: 'b', direction: 'right' });
  assert.equal(nested.ok, true);
  assert.equal(nested.parentId, 'c');
});

test('visual hierarchy rejects cross-container attach and disabled boundaries', () => {
  const items = [
    { id: 'a', containerId: 'g1', parentId: null },
    { id: 'b', containerId: 'g2', parentId: null },
    { id: 'flat-root', containerId: null, parentId: null },
  ];
  assert.equal(resolveVisualHierarchyStep({ items, sourceId: 'b', direction: 'right' }).reason, 'no-previous-peer');
  assert.equal(resolveVisualHierarchyStep({ items, sourceId: 'flat-root', direction: 'left' }).reason, 'already-root');
  const deep = [
    { id: 'a', containerId: null, parentId: null },
    { id: 'b', containerId: null, parentId: 'a' },
    { id: 'c', containerId: null, parentId: 'b' },
  ];
  assert.equal(resolveVisualHierarchyStep({ items: deep, sourceId: 'c', direction: 'right', maxDepth: 2 }).reason, 'max-depth');
});

test('visual hierarchy rejects indent when any descendant would exceed max depth', () => {
  const items = [
    { id: 'previous', containerId: null, parentId: null, position: 0 },
    { id: 'source', containerId: null, parentId: null, position: 1 },
    { id: 'd1', containerId: null, parentId: 'source', position: 2 },
    { id: 'd2', containerId: null, parentId: 'd1', position: 3 },
    { id: 'd3', containerId: null, parentId: 'd2', position: 4 },
    { id: 'd4', containerId: null, parentId: 'd3', position: 5 },
  ];

  const result = resolveVisualHierarchyStep({ items, sourceId: 'source', direction: 'right', maxDepth: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max-depth');
  assert.equal(result.sourceDepth, 0);
  assert.equal(result.sourceSubtreeMaxDepth, 4);
});

test('visual subtree helper returns all transitive descendants in visual order', () => {
  const items = [
    { id: 'outside', parentId: null, position: 0 },
    { id: 'root', parentId: null, position: 1 },
    { id: 'later-child', parentId: 'root', position: 3 },
    { id: 'first-child', parentId: 'root', position: 2 },
    { id: 'grandchild', parentId: 'first-child', position: 4 },
  ];

  assert.deepEqual(
    visualHierarchySubtreeItems(items, 'root').map((item) => item.id),
    ['root', 'first-child', 'grandchild', 'later-child'],
  );
});

test('selected visual roots ignore click order and transitively selected descendants', () => {
  const items = [
    { id: 'a', parentId: null, position: 0 },
    { id: 'b', parentId: 'a', position: 1 },
    { id: 'c', parentId: 'b', position: 2 },
    { id: 'd', parentId: null, position: 3 },
  ];

  assert.deepEqual(normalizeSelectedVisualRootIds(items, ['d', 'a']), ['a', 'd']);
  assert.deepEqual(normalizeSelectedVisualRootIds(items, ['a', 'd']), ['a', 'd']);
  assert.deepEqual(normalizeSelectedVisualRootIds(items, ['c', 'a']), ['a']);
  assert.deepEqual(normalizeSelectedVisualRootIds(items, ['a', 'c']), ['a']);
});

test('visual block move crosses a foreign subtree atomically even when target is a child', () => {
  const items = [
    { id: 'source', containerId: null, parentId: null, position: 0 },
    { id: 'target', containerId: null, parentId: null, position: 1 },
    { id: 'target-a', containerId: null, parentId: 'target', position: 2 },
    { id: 'target-b', containerId: null, parentId: 'target', position: 3 },
    { id: 'after', containerId: null, parentId: null, position: 4 },
  ];

  const moved = resolveVisualBlockMove({
    items,
    sourceId: 'source',
    targetId: 'target-a',
    placement: 'after',
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.targetRootId, 'target');
  assert.deepEqual(moved.targetIds, ['target', 'target-a', 'target-b']);
  assert.deepEqual(moved.orderedIds, ['target', 'target-a', 'target-b', 'source', 'after']);
});

test('visual block move never accepts a source descendant as an external target', () => {
  const items = [
    { id: 'source', containerId: null, parentId: null, position: 0 },
    { id: 'child', containerId: null, parentId: 'source', position: 1 },
    { id: 'grandchild', containerId: null, parentId: 'child', position: 2 },
    { id: 'after', containerId: null, parentId: null, position: 3 },
  ];
  const result = resolveVisualBlockMove({ items, sourceId: 'source', targetId: 'grandchild', placement: 'after' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'target-inside-source');
});

test('visual block move reorders sibling subtrees without changing their parent', () => {
  const items = [
    { id: 'root', containerId: 'g1', parentId: null, position: 0 },
    { id: 'a', containerId: 'g1', parentId: 'root', position: 1 },
    { id: 'a-child', containerId: 'g1', parentId: 'a', position: 2 },
    { id: 'b', containerId: 'g1', parentId: 'root', position: 3 },
  ];
  const moved = resolveVisualBlockMove({ items, sourceId: 'b', targetId: 'a-child', placement: 'before' });
  assert.equal(moved.ok, true);
  assert.equal(moved.targetRootId, 'a');
  assert.deepEqual(moved.orderedIds, ['root', 'b', 'a', 'a-child']);
  assert.equal(moved.items.find((item) => item.id === 'b').parentId, 'root');
  assert.equal(moved.items.find((item) => item.id === 'b').containerId, 'g1');
});

test('visual block move reindexes only the affected sibling namespace', () => {
  const items = [
    { id: 'outside', containerId: null, parentId: null, position: 41 },
    { id: 'root', containerId: 'g1', parentId: null, position: 0 },
    { id: 'a', containerId: 'g1', parentId: 'root', position: 0 },
    { id: 'a-child', containerId: 'g1', parentId: 'a', position: 17 },
    { id: 'b', containerId: 'g1', parentId: 'root', position: 1 },
  ];

  const moved = resolveVisualBlockMove({ items, sourceId: 'b', targetId: 'a', placement: 'before' });
  assert.equal(moved.ok, true);
  assert.equal(moved.items.find((item) => item.id === 'outside').position, 41);
  assert.equal(moved.items.find((item) => item.id === 'root').position, 0);
  assert.equal(moved.items.find((item) => item.id === 'a-child').position, 17);
  assert.equal(moved.items.find((item) => item.id === 'b').position, 0);
  assert.equal(moved.items.find((item) => item.id === 'a').position, 1);
  assert.deepEqual(moved.orderedIds, ['root', 'b', 'a', 'a-child', 'outside']);
});

test('visual block move rejects a child crossing a different parent context', () => {
  const items = [
    { id: 'root-a', containerId: 'g1', parentId: null, position: 0 },
    { id: 'child-a', containerId: 'g1', parentId: 'root-a', position: 1 },
    { id: 'root-b', containerId: 'g1', parentId: null, position: 2 },
    { id: 'child-b', containerId: 'g1', parentId: 'root-b', position: 3 },
  ];
  const result = resolveVisualBlockMove({ items, sourceId: 'child-a', targetId: 'child-b', placement: 'after' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'different-parent-context');
});

test('visual block move normalizes multi-selection by visible order', () => {
  const items = [
    { id: 'a', containerId: null, parentId: null, position: 0 },
    { id: 'a-child', containerId: null, parentId: 'a', position: 1 },
    { id: 'b', containerId: null, parentId: null, position: 2 },
    { id: 'target', containerId: 'g1', parentId: null, position: 3 },
  ];
  const moved = resolveVisualBlockMove({
    items,
    sourceId: 'b',
    selectedIds: ['b', 'a-child', 'a'],
    targetId: 'target',
    placement: 'after',
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.sourceRootIds, ['a', 'b']);
  assert.deepEqual(moved.orderedIds, ['target', 'a', 'a-child', 'b']);
  assert.deepEqual(moved.containerAssignments, { a: 'g1', 'a-child': 'g1', b: 'g1' });
});

test('visual hierarchy helpers terminate on cyclic and broken parent links', () => {
  const items = [
    { id: 'a', parentId: 'b', position: 0 },
    { id: 'b', parentId: 'a', position: 1 },
    { id: 'broken-root', parentId: 'missing', position: 2 },
    { id: 'broken-child', parentId: 'broken-root', position: 3 },
  ];

  assert.deepEqual(visualHierarchySubtreeItems(items, 'a').map((item) => item.id), ['a', 'b']);
  assert.deepEqual(visualHierarchySubtreeItems(items, 'broken-root').map((item) => item.id), ['broken-root', 'broken-child']);
  assert.deepEqual(normalizeSelectedVisualRootIds(items, ['b', 'a', 'broken-child', 'broken-root']), ['broken-root', 'a']);
});
