import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(
  fileURLToPath(new URL('./SplitPaneChrome.tsx', import.meta.url)),
  'utf8',
);

test('split header height exists before any hook dependency reads it', () => {
  const declaration = source.indexOf('const rowH = resolveSplitAttachRowHeight');
  const dependencyRead = source.indexOf('}, [paneIndex, stripWrap, rowH]);');
  assert.ok(declaration >= 0, 'rowH declaration is present');
  assert.ok(dependencyRead >= 0, 'layout effect depends on rowH');
  assert.ok(
    declaration < dependencyRead,
    'a const below its dependency array throws before the first History frame',
  );
});

test('workflow retarget does not synchronously measure or republish pane height', () => {
  const start = source.indexOf('// Шапка СООБЩАЕТ окну свою настоящую высоту.');
  const end = source.indexOf('// Clamp the strip menu into the window', start);
  const heightOwner = source.slice(start, end);
  const measurementEffectEnd = heightOwner.indexOf('}, [paneIndex, stripWrap, rowH]);');
  const measurementEffect = heightOwner.slice(0, measurementEffectEnd);

  assert.doesNotMatch(measurementEffect, /getBoundingClientRect\(/,
    'wrapped height must arrive through ResizeObserver, not force layout in commit');
  assert.match(measurementEffect, /borderBox\?\.blockSize \|\| entry\?\.contentRect\.height/);
  assert.doesNotMatch(measurementEffect, /\[paneIndex, stripWrap, rowH, tabId\]/,
    'changing the shown tab must not tear down the pane-scoped root variable');
  assert.match(heightOwner, /publishedHeaderHeightRef\.current \|\| rowH/,
    'the new shown tab receives the already measured pane height');
});
