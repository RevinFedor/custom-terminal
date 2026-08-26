import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const chip = fs.readFileSync(path.join(here, 'PaneTabChip.tsx'), 'utf8');

test('pane-tab selection background commits immediately while release scale stays animated', () => {
  const style = chip.slice(chip.indexOf("transform: pointerHeld"), chip.indexOf('// The full chip follows'));
  assert.match(style, /transform: pointerHeld && !dragging \? 'scale\(0\.985\)' : undefined/);
  assert.match(style, /transition: pointerHeld\s*\? 'none'\s*:\s*'transform 70ms ease-out'/);
  assert.doesNotMatch(style, /background(?:-color)?\s+[\d.]+m?s/);
  assert.doesNotMatch(style, /color\s+[\d.]+m?s/);
});

test('pointer press still acknowledges before the heavy pane commit', () => {
  assert.match(chip, /if \(!renaming\) setPressed\(true\)/);
  assert.match(chip, /if \(!renaming\) setPointerHeld\(true\)/);
  assert.match(chip, /active: visuallyActive \|\| pressed/);
  assert.match(chip, /if \(!shown\) return;[\s\S]*setPressed\(false\)/);
});
