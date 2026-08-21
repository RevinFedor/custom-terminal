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
  const dependencyRead = source.indexOf('}, [stripWrap, rowH]);');
  assert.ok(declaration >= 0, 'rowH declaration is present');
  assert.ok(dependencyRead >= 0, 'layout effect depends on rowH');
  assert.ok(
    declaration < dependencyRead,
    'a const below its dependency array throws before the first History frame',
  );
});
