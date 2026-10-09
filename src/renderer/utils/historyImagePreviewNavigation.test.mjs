import test from 'node:test';
import assert from 'node:assert/strict';
import * as navigation from './historyImageRuns.mjs';

const parts = [
  { kind: 'image', id: 7, ref: { path: '/same.png' } },
  { kind: 'text', text: 'image order belongs to this message' },
  { kind: 'prompt', chip: { id: 'other-chip' } },
  { kind: 'image', id: 2, ref: { path: '/same.png' } },
  { kind: 'paste', text: 'not an image' },
  { kind: 'image', id: 9, error: 'missing' },
];

test('image preview follows source occurrences, not numeric ids, paths or other chip types', () => {
  assert.equal(navigation.historyImagePreviewPart(parts, 'image:3:2'), parts[3]);
  assert.equal(navigation.historyImagePreviewStep(parts, 'image:0:7', 1), 'image:3:2');
  assert.equal(navigation.historyImagePreviewStep(parts, 'image:3:2', 1), 'image:5:9');
  assert.equal(navigation.historyImagePreviewStep(parts, 'image:5:9', -1), 'image:3:2');
  assert.equal(navigation.historyImagePreviewStep(parts, 'image:3:2', -1), 'image:0:7');
});

test('edges, one image and unknown occurrence never wrap or select a substitute', () => {
  assert.equal(navigation.historyImagePreviewStep(parts, 'image:0:7', -1), 'image:0:7');
  assert.equal(navigation.historyImagePreviewStep(parts, 'image:5:9', 1), 'image:5:9');
  assert.equal(navigation.historyImagePreviewStep([parts[0]], 'image:0:7', 1), 'image:0:7');
  assert.equal(navigation.historyImagePreviewStep(parts, 'image:3:99', 1), 'image:3:99');
  assert.equal(navigation.historyImagePreviewPart(parts, 'image:3:99'), null);
  assert.equal(navigation.historyImagePreviewStep(parts, 'paste:4', 1), 'paste:4');
});

test('reading adjacent images never mutates the message or its refs', () => {
  const before = JSON.stringify(parts);
  let key = 'image:3:2';
  for (let i = 0; i < 30; i++) key = navigation.historyImagePreviewStep(parts, key, 1);
  assert.equal(key, 'image:5:9');
  for (let i = 0; i < 30; i++) key = navigation.historyImagePreviewStep(parts, key, -1);
  assert.equal(key, 'image:0:7');
  assert.equal(JSON.stringify(parts), before);
});

function keyboardFixture() {
  let listener;
  const calls = [];
  const panel = { presented: '1', inert: false,
    getAttribute() { return this.presented; }, hasAttribute() { return this.inert; } };
  const anchor = { isConnected: true, closest() { return panel; } };
  const target = {
    addEventListener(type, fn, capture) {
      assert.equal(type, 'keydown'); assert.equal(capture, true); listener = fn;
    },
    removeEventListener(type, fn, capture) {
      assert.equal(type, 'keydown'); assert.equal(capture, true); assert.equal(fn, listener); listener = null;
    },
  };
  const event = (key, extra = {}) => ({ key, ...extra,
    preventDefault() { calls.push('prevent'); },
    stopImmediatePropagation() { calls.push('stop'); },
  });
  return { panel, anchor, target, calls, event, key: (...args) => listener?.(event(...args)) };
}

test('only open presented image preview captures plain arrows, including a boundary no-op', () => {
  const f = keyboardFixture();
  const unbind = navigation.bindHistoryImagePreviewKeys({
    target: f.target, anchor: f.anchor, navigate: (direction) => f.calls.push(direction),
  });
  f.key('ArrowRight'); f.key('ArrowLeft');
  assert.deepEqual(f.calls, ['prevent', 'stop', 1, 'prevent', 'stop', -1]);
  unbind(); f.key('ArrowRight');
  assert.equal(f.calls.length, 6);
});

test('modified arrows, composition, handled events and Escape retain their existing owners', () => {
  const f = keyboardFixture();
  const unbind = navigation.bindHistoryImagePreviewKeys({
    target: f.target, anchor: f.anchor, navigate: (direction) => f.calls.push(direction),
  });
  for (const field of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
    f.key('ArrowRight', { [field]: true });
  }
  f.key('Escape'); f.key('ArrowUp'); f.key('x');
  assert.deepEqual(f.calls, []); unbind();
});

test('retained hidden, closed/inert and detached History cannot steal arrows', () => {
  const f = keyboardFixture();
  const unbind = navigation.bindHistoryImagePreviewKeys({
    target: f.target, anchor: f.anchor, navigate: (direction) => f.calls.push(direction),
  });
  f.panel.presented = '0'; f.key('ArrowRight');
  f.panel.presented = '1'; f.panel.inert = true; f.key('ArrowRight');
  f.panel.inert = false; f.anchor.isConnected = false; f.key('ArrowRight');
  assert.deepEqual(f.calls, []); unbind();
});
