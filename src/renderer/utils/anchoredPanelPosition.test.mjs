import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollMovesAnchor, retainPanelPosition } from './anchoredPanelPosition.mjs';

const doc = { defaultView: {} };
const anchor = { ownerDocument: doc, isConnected: true };
const history = { contains: () => false };
const toolbarParent = { contains: node => node === anchor };

test('scrolling History, the popup editor or a sibling does not move a toolbar anchor', () => {
  let reads = 0;
  for (let i = 0; i < 100; i++) if (scrollMovesAnchor(history, anchor)) reads++;
  assert.equal(reads, 0);
  assert.equal(scrollMovesAnchor(null, anchor), false);
  assert.equal(scrollMovesAnchor(anchor, anchor), false);
});
test('ancestor, document and window scrolling still reposition an anchored popup', () => {
  for (const target of [toolbarParent, doc, doc.defaultView]) assert.equal(scrollMovesAnchor(target, anchor), true);
  assert.equal(scrollMovesAnchor(toolbarParent, null), false);
  assert.equal(scrollMovesAnchor(toolbarParent, { ...anchor, isConnected: false }), false);
});
test('unchanged bounds retain React state identity; any real edge change updates it', () => {
  const current = { left: 10, top: 45, width: 760, height: 600 };
  for (let i = 0; i < 100; i++) assert.equal(retainPanelPosition(current, { ...current }), current);
  for (const key of Object.keys(current)) {
    const next = { ...current, [key]: current[key] + 1 };
    assert.equal(retainPanelPosition(current, next), next);
  }
});
