const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'ipc', 'codex-data.js'), 'utf8');

test('concurrent model catalog consumers join one child-process request', () => {
  const start = source.indexOf('function listCodexModels()');
  const end = source.indexOf('\nasync function loadSessionRecords', start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /let modelCacheInflight = null;/);
  assert.match(body, /if \(modelCacheInflight\)[\s\S]*return modelCacheInflight;/);
  assert.match(body, /modelCacheInflight = new Promise/);
  assert.match(body, /modelCacheInflight = null;[\s\S]*resolve\(value\)/);
  assert.equal((body.match(/execFile\('codex'/g) || []).length, 2,
    'only live + bundled fallback commands may exist inside the shared request');
});
