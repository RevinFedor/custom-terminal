import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRunAfterPreviewPlacement } from './runAfterPreviewPlacement.mjs';

const BASE = {
  editorWidth: 380,
  editorHeight: 64,
  margin: 8,
  gap: 8,
  maxWidth: 440,
  minSideWidth: 260,
  minPreviewWidth: 180,
  minPreviewHeight: 80,
};

test('Run after preview uses the free strip to the left without moving the editor', () => {
  const viewport = { width: 1600, height: 900 };
  const anchor = { top: 200, right: 320, maxHeight: 600 };
  const layout = resolveRunAfterPreviewPlacement({ viewport, anchor, ...BASE });

  assert.equal(layout.placement, 'left');
  assert.equal(layout.width, 380);
  assert.equal(layout.top, anchor.top);
  assert.equal(layout.maxHeight, anchor.maxHeight);

  const editorLeft = viewport.width - anchor.right - BASE.editorWidth;
  const previewRightEdge = viewport.width - layout.right;
  assert.equal(previewRightEdge, editorLeft - BASE.gap);
});

test('Run after preview falls below and keeps the editor left edge in a narrow viewport', () => {
  const viewport = { width: 941, height: 768 };
  const anchor = { top: 200, right: 345, maxHeight: 500 };
  const layout = resolveRunAfterPreviewPlacement({ viewport, anchor, ...BASE });

  assert.equal(layout.availableLeft, 200);
  assert.equal(layout.placement, 'below');
  assert.equal(layout.width, 380);
  assert.equal(layout.top, anchor.top + BASE.editorHeight + BASE.gap);
  assert.equal(layout.right, anchor.right);

  const editorLeft = viewport.width - anchor.right - BASE.editorWidth;
  const previewLeft = viewport.width - layout.right - layout.width;
  assert.equal(previewLeft, editorLeft);
  assert.ok(layout.top >= anchor.top + BASE.editorHeight + BASE.gap);
});

test('Run after side preview shrinks to the available strip instead of leaving the viewport', () => {
  const viewport = { width: 1200, height: 800 };
  const anchor = { top: 100, right: 530, maxHeight: 500 };
  const layout = resolveRunAfterPreviewPlacement({ viewport, anchor, ...BASE });

  assert.equal(layout.availableLeft, 274);
  assert.equal(layout.placement, 'left');
  assert.equal(layout.width, 274);
  const previewLeft = viewport.width - layout.right - layout.width;
  assert.equal(previewLeft, BASE.margin);
});
