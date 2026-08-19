import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const timeline = fs.readFileSync(
  fileURLToPath(new URL('../components/Workspace/Timeline.tsx', import.meta.url)),
  'utf8',
);
const popover = fs.readFileSync(
  fileURLToPath(new URL('../components/UI/CenteredUpwardPopover.tsx', import.meta.url)),
  'utf8',
);

test('ported operation labels recompute their fixed top on Timeline scroll', () => {
  const start = timeline.indexOf('const StatusLabelPortal');
  const end = timeline.indexOf('interface TimelineEntry', start);
  const block = timeline.slice(start, end);
  assert.match(block, /addEventListener\('scroll',\s*updatePosition,\s*true\)/);
  assert.match(block, /contentTop/);
});

test('a split popover chooses the nearest Timeline to its anchor, not document first', () => {
  assert.match(popover, /querySelectorAll\('\[data-timeline\]'\)/);
  assert.doesNotMatch(popover, /querySelector\('\[data-timeline\]'\)/);
});
