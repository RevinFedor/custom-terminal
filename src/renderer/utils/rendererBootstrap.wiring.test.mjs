import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const renderer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(renderer, 'main.tsx'), 'utf8');

test('renderer entry owns one window-scoped bootstrap lease across Vite re-evaluation', () => {
  assert.match(main, /__notedTerminalRendererBootstrapStarted\?: boolean/);
  assert.match(main, /if \(!rendererBootstrapWindow\.__notedTerminalRendererBootstrapStarted\) \{/);
  assert.match(main, /rendererBootstrapWindow\.__notedTerminalRendererBootstrapStarted = true/);
  assert.match(main, /rendererBootstrapWindow\.__notedTerminalRendererBootstrapStarted = false/);
  assert.equal((main.match(/ReactDOM\.createRoot\(/g) || []).length, 1);
});
