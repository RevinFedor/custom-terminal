'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cjs = require('./fork-operation.cjs');

test('browser and main fork-operation contracts agree without a local CJS browser import', async () => {
  const esm = await import('./fork-operation.mjs');
  const source = fs.readFileSync(path.join(__dirname, 'fork-operation.mjs'), 'utf8');
  assert.doesNotMatch(source, /(?:import|from)\s+[^;\n]*['"][^'"]+\.cjs['"]/);
  for (const value of [undefined, null, '', 'fork', 'rewind', 'edit', 'delete', 'provider', 'future']) {
    assert.equal(esm.normalizeForkOperation(value), cjs.normalizeForkOperation(value));
  }
  for (const mode of [undefined, '', 'full', 'latest_compact', 'history_rewind', 'history_edit', 'history_delete', 'direct-virtual', 'future']) {
    assert.equal(esm.historyRewriteOperation(mode), cjs.historyRewriteOperation(mode));
    for (const origin of [undefined, 'app', 'terminal-mcp', 'orchestration', 'legacy-fork-marker', 'transcript']) {
      for (const operation of [undefined, '', 'fork', 'rewind', 'edit', 'delete', 'provider', 'future']) {
        const camel = { forkMode: mode, operationKind: operation, origin };
        const snake = { fork_mode: mode, operation_kind: operation, origin };
        assert.equal(esm.resolveForkOperation(camel), cjs.resolveForkOperation(camel));
        assert.equal(esm.resolveForkOperation(snake), cjs.resolveForkOperation(snake));
        for (const hidden of [undefined, false, true, 0, 1]) {
          assert.equal(esm.isVisibleAppFork({ ...camel, hidden }), cjs.isVisibleAppFork({ ...camel, hidden }));
        }
      }
    }
  }
});

test('an empty technical fork snapshot never becomes a visible History FORK row', () => {
  for (const operationKind of ['rewind', 'edit', 'delete', 'provider']) {
    assert.equal(cjs.isVisibleAppFork({ operationKind, entry_uuids: [] }), false);
  }
  assert.equal(cjs.isVisibleAppFork({ operationKind: 'fork', entry_uuids: [] }), true);
  assert.equal(cjs.isVisibleAppFork({ operationKind: 'fork', hidden: 1 }), false);
  const history = fs.readFileSync(path.join(__dirname, '../main/ipc/claude-data.js'), 'utf8');
  const begin = history.indexOf('// Fork-at-beginning detection');
  const end = history.indexOf('// Build structured entries', begin);
  assert.ok(begin >= 0 && end > begin);
  assert.match(history.slice(begin, end), /isVisibleAppFork\(directMarker\)/);
});
