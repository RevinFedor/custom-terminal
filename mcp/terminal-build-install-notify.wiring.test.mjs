import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./terminal-server.mjs', import.meta.url), 'utf8');

test('build install can suppress success callback while retaining exact source identity', () => {
  assert.match(source, /notifyOnSuccess:\s*\{/);
  assert.match(source, /notifyOnSuccess:\s*args\.notifyOnSuccess !== false/);
  assert.match(source, /tabId:\s*returnToTabId/);
  assert.match(source, /Success callback disabled/);
});
