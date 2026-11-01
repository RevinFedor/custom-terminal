'use strict';
// Only the read-only setup waiter is evaluated, never the launch script.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'dev-mini-orchestrator.mjs'), 'utf8');
const body = source.slice(source.indexOf('function waitForWorkspace('), source.indexOf('\nlet client;'));
function waiter(call) {
  const listeners = new Set(), timers = new Set();
  const context = { setTimeout(fn) { const t = { fn }; timers.add(t); return t; }, clearTimeout(t) { timers.delete(t); } };
  vm.runInNewContext(body + '\nthis.wait = waitForWorkspace;', context);
  const client = { call, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  return { done: context.wait(client, 'own'), emit(method) { for (const fn of [...listeners]) fn({ method, sessionId: 'own' }); }, listeners, timers };
}
test('initial context destruction is followed by the actual load, not a failed restore or a create retry', async () => {
  let calls = 0;
  const f = waiter(async method => { assert.equal(method, 'Runtime.evaluate'); if (++calls === 1) throw Error('Execution context was destroyed'); return { result: { value: true } }; });
  await new Promise(resolve => setImmediate(resolve));
  f.emit('Page.loadEventFired'); await f.done;
  assert.equal(calls, 2); assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
});
test('a missing initial store waits for a load event and does not poll', async () => {
  let calls = 0;
  const f = waiter(async () => ({ result: { value: ++calls > 1 } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); f.emit('Page.loadEventFired'); await f.done;
  assert.equal(calls, 2); assert.equal(f.timers.size, 0);
});
test('a real setup failure is terminal and releases its observer', async () => {
  const f = waiter(async () => { throw Error('own transport unavailable'); });
  await assert.rejects(f.done, /own transport unavailable/);
  assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
});
test('human DEV uses regular Dock and explicit low without sending a model prompt', () => {
  assert.match(source, /NOTED_E2E_WINDOWED: '0'/);
  const seed = fs.readFileSync(path.join(__dirname, 'seed-mini-orchestrator-dev.cjs'), 'utf8');
  assert.match(seed, /setAppState\('defaultCodexEffort', 'low'\)/);
  assert.doesNotMatch(source, /api\(['"]\/api\/[^'"]*(?:send|prompt)/);
  assert.match(source, /FIRST-START\.json/);
  assert.match(source, /codex:run-command/);
  assert.doesNotMatch(source, /terminal:(?:paste|input)|agent:send|mini:set-enabled/);
});
test('Main is selected before admission without reading RAM or resetting an existing profile', () => {
  const admission = source.slice(0, source.indexOf('// The explicit basic prototype'));
  assert.match(admission, /path\.join\(replayDir, 'main'\)/);
  assert.match(admission, /path\.join\(mainReplayDir, 'REPLAY\.json'\)/);
  assert.doesNotMatch(admission, /mkdtemp|spawn\(|writeFile|web-token|GEMINI_API_KEY/);
  assert.match(admission, /process\.exit\(2\)/);
});
test('prepared-result launch only opens the archive; it never starts another model', () => {
  const branch = source.slice(source.indexOf('if (replayProfile?.presentationOnly)'), source.indexOf("preparationStage = 'выбор Luna из каталога'"));
  assert.match(branch, /fixture\.cases\.length < 1 \|\| fixture\.cases\.length > 4/);
  assert.match(branch, /mini-orchestrator:open/);
  assert.doesNotMatch(branch, /codex:run-command|\/api\/agent-tabs|FIRST-START|modelSelection/);
  const guard = branch.slice(branch.indexOf('    if (!fixture'), branch.indexOf('    // Presentation-only'));
  const validate = require('node:vm').runInNewContext('(fixture,replayProfile)=>{' + guard + '; return true;}');
  const cases = Array.from({ length: 3 }, (_, i) => ({ tabId: 'own-' + i, sessionId: 'sid-' + i }));
  const profile = { tabId: 'own-0', cases };
  assert.equal(validate({ presentationOnly: true, guide: 'own-0', cases }, profile), true);
  assert.equal(validate({ presentationOnly: true, guide: 'own-0', cases: cases.slice(0, 2) }, { ...profile, cases: cases.slice(0, 2) }), true);
  assert.equal(validate({ presentationOnly: true, guide: 'own-0', cases: cases.slice(0, 1) }, { ...profile, cases: cases.slice(0, 1) }), true, 'a ready Main is not blocked by an optional missing RAM case');
  for (const count of [0, 5]) {
    const rows = Array.from({ length: count }, (_, i) => ({ tabId: 't' + i, sessionId: 's' + i }));
    assert.throws(() => validate({ presentationOnly: true, guide: 'own-0', cases: rows }, { ...profile, cases: rows }), /unavailable/);
  }
  assert.throws(() => validate({ presentationOnly: true, guide: 'own-0', cases: cases.map((item, i) => i === 1 ? { ...item, sessionId: 'foreign' } : item) }, profile), /unavailable/);
  assert.throws(() => validate({ presentationOnly: true, guide: 'foreign', cases }, profile), /unavailable/);
});
