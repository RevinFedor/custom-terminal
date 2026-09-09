'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const start = source.indexOf('  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/rewind-recovery$/);');
const end = source.indexOf('  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/rewind-state$/);', start);
assert.ok(start >= 0 && end > start, 'actual recovery route must exist');
const route = source.slice(start, end);

function harness({ method = 'GET', query = {}, body = {}, result = {}, available = true } = {}) {
  const calls = [];
  const reader = request => { calls.push(['read', request]); return result; };
  const recover = async request => { calls.push(['recover', request]); return result; };
  const context = vm.createContext({
    req: { method }, res: {}, parsed: { pathname: '/api/terminal-tabs/tab-A/rewind-recovery', query },
    decId: decodeURIComponent,
    cleanOptionalString: (value, fallback) => typeof value === 'string' ? value.trim() : fallback,
    readBody: async () => body,
    readCodexRewindPostEnterResult: available ? reader : null,
    recoverCodexRewindPostEnter: available ? recover : null,
    sendJson: (_response, status, json) => ({ status, json }),
    sendTerminalBridgeError: (_response, error) => ({ status: 500, error: error.message }),
  });
  return { calls, run: () => vm.runInContext('(async () => { let m;\n' + route + '\n})()', context) };
}
const identity = { operationId: 'old-rewind', generation: 'old-generation' };

test('GET reads the exact saved operation without starting recovery', async () => {
  const h = harness({ query: identity, result: { success: true, historyDraftText: 'actual capture' } });
  const value = await h.run();
  assert.equal(value.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['read', {
    tabId: 'tab-A', operationId: 'old-rewind', actionGeneration: 'old-generation',
  }]]);
});
test('POST continues only the explicitly named operation, not a new Rewind', async () => {
  const h = harness({ method: 'POST', body: identity, result: { success: true } });
  assert.equal((await h.run()).status, 200);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'recover');
  assert.equal(h.calls[0][1].operationId, 'old-rewind');
});
test('unfinished post-Enter returns 202, not a confirmed success or duplicate request', async () => {
  const h = harness({ method: 'POST', body: identity,
    result: { success: false, pending: true, rollbackMayHaveApplied: true } });
  const value = await h.run();
  assert.equal(value.status, 202);
  assert.equal(value.json.success, false);
  assert.equal(h.calls.length, 1);
});
test('missing identity cannot start or read another operation', async () => {
  for (const method of ['GET', 'POST']) {
    const h = harness({ method, query: { generation: 'G' }, body: { operationId: 'A' } });
    assert.equal((await h.run()).status, 400);
    assert.equal(h.calls.length, 0);
  }
});
test('unavailable recovery capability is explicit and performs no action', async () => {
  const h = harness({ method: 'POST', body: identity, available: false });
  assert.equal((await h.run()).status, 503);
  assert.equal(h.calls.length, 0);
});
test('a definite scope refusal is 409 without a client retry', async () => {
  const h = harness({ method: 'POST', body: identity,
    result: { success: false, error: 'codex_rewind_recovery_owner_changed' } });
  assert.equal((await h.run()).status, 409);
  assert.equal(h.calls.length, 1);
});
