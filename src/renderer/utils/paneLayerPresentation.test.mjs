import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diffPaneLayerPresentations,
  paneLayerPresentationKey,
  paneLayerStructuralKey,
} from './paneLayerPresentation.mjs';

const structural = {
  projectId: 'p',
  tabId: 'a',
  tabType: 'terminal',
  cwd: '/tmp/a',
  inPane: true,
  layoutPaneIndex: 0,
  geometryKey: '0|50%|0|100%|single',
  terminalPresented: true,
};

test('workflow presentation does not change persistent tab structure identity', () => {
  const visible = paneLayerStructuralKey({
    ...structural,
    presented: true,
    focused: true,
    visiblePaneIndex: 0,
  });
  const dormant = paneLayerStructuralKey({
    ...structural,
    presented: false,
    focused: false,
    visiblePaneIndex: -1,
  });
  assert.equal(visible, dormant);
  assert.equal(
    paneLayerStructuralKey({ ...structural, terminalPresented: true }),
    paneLayerStructuralKey({ ...structural, terminalPresented: false }),
    'single-center floating terminal visibility cannot rebuild a pane-owned terminal',
  );
});

test('retained single-center terminal visibility is presentation, not structure', () => {
  const centre = {
    ...structural,
    inPane: false,
    geometryKey: 'single-centre',
    retainedTerminalPresentation: true,
  };
  assert.equal(
    paneLayerStructuralKey({ ...centre, terminalPresented: true }),
    paneLayerStructuralKey({ ...centre, terminalPresented: false }),
  );
  assert.equal(
    paneLayerStructuralKey({ ...centre, active: true, projectActive: true }),
    paneLayerStructuralKey({ ...centre, active: false, projectActive: false }),
  );
});

test('geometry and surface kind remain structural boundaries', () => {
  assert.notEqual(
    paneLayerStructuralKey(structural),
    paneLayerStructuralKey({ ...structural, geometryKey: '0|33%|0|100%|single' }),
  );
  assert.notEqual(
    paneLayerStructuralKey(structural),
    paneLayerStructuralKey({ ...structural, tabType: 'claude-sdk' }),
  );
});

test('presentation key changes only for user-visible ownership facts', () => {
  const hidden = paneLayerPresentationKey({ inPane: true, presented: false, focused: false });
  const shown = paneLayerPresentationKey({ inPane: true, presented: true, focused: true });
  assert.notEqual(hidden, shown);
  assert.notEqual(
    paneLayerPresentationKey({ inPane: true, presented: true, geometryKey: 'wide' }),
    paneLayerPresentationKey({ inPane: true, presented: true, geometryKey: 'narrow' }),
  );
});

test('4↔2 workflow switch reports only outgoing and incoming pane tabs', () => {
  const previous = new Map();
  const next = new Map();
  for (const id of ['a', 'b', 'c', 'd']) {
    previous.set(id, paneLayerPresentationKey({ inPane: true, presented: true, focused: id === 'a' }));
    next.set(id, { inPane: true, presented: false, focused: false });
  }
  for (const id of ['e', 'f']) {
    previous.set(id, paneLayerPresentationKey({ inPane: true, presented: false, focused: false }));
    next.set(id, { inPane: true, presented: true, focused: id === 'e' });
  }
  // A hundred other persistent tabs do not become part of the presentation
  // transition merely because the parent store emitted.
  for (let index = 0; index < 100; index += 1) {
    const id = `idle-${index}`;
    previous.set(id, paneLayerPresentationKey({ inPane: false, presented: false, focused: false }));
    next.set(id, { inPane: false, presented: false, focused: false });
  }
  assert.deepEqual(diffPaneLayerPresentations(previous, next).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});
