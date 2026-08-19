import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(
  fileURLToPath(new URL('../components/Workspace/Terminal.tsx', import.meta.url)),
  'utf8',
);

test('PTY resize sends the exact dimensions already applied to xterm', () => {
  const start = source.indexOf('const safeFit = () =>');
  const end = source.indexOf('useEffect(() => {', start);
  assert.ok(start >= 0 && end > start);
  const safeFit = source.slice(start, end);
  assert.doesNotMatch(safeFit, /fit\.fit\(\);[\s\S]*fit\.proposeDimensions\(\)/);
  assert.match(safeFit, /cols:\s*colsAfter/);
  assert.match(safeFit, /rows:\s*rowsAfter/);
});
