'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { fixture, tick } = require('./fixtures/model-preparation.cjs');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);

function installGuard(h, current) {
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createCodexModelEffortIntentWriteGuard');
  assert.ok(fn, 'actual Main revision guard');
  h.ctx.getCodexModelEffortIntentRecord = () => current.value;
  vm.runInContext(fn.getText(ast), h.ctx);
  return intent => h.ctx.createCodexModelEffortIntentWriteGuard('T', intent);
}

test('actual Main skips superseded A before any native input; B then applies and the original prompt enters once', async t => {
  const h = fixture(t), A = { model: 'gpt-5.6-luna', effort: 'medium', revision: 18, actionSequence: 18 },
    B = { ...h.requested, revision: 19, actionSequence: 19 }, current = { value: A };
  const guard = installGuard(h, current);
  let release;
  h.ctx.resolveActiveCodexConfigForTab = () => new Promise(resolve => { release = resolve; });
  const old = h.ctx.executeCodexSelectModelEffortRequest(null, { tabId: 'T', ...A, ...h.opts,
    expectedWriterSessionId: 'S', preparation: h.prep, settingsWriteGuard: guard(A) });
  await tick(40); current.value = B;
  release({ status: 'found', configPath: '/controlled/config.toml' });
  const refused = await old;
  assert.equal(h.writes.length, 0, 'old queued intent may not write /model after the replacement');
  assert.equal(refused.error, 'codex_settings_intent_superseded');
  assert.equal(h.serviceEnters, 0); assert.equal(h.promptCalls, 0);
  h.ctx.resolveActiveCodexConfigForTab = async () => ({ status: 'found', configPath: '/controlled/config.toml' });
  const selected = await h.ctx.executeCodexSelectModelEffortRequest(null, { tabId: 'T', ...B, ...h.opts,
    expectedWriterSessionId: 'S', preparation: h.prep, settingsWriteGuard: guard(B) });
  const completion = selected.continuePreparation(); await tick(60); h.frame('/model');
  assert.equal((await completion).success, true);
  assert.equal(h.serviceEnters, 1);
  assert.equal(h.writes.filter(bytes => bytes.includes('/model')).length, 1);
  const sent = await h.start();
  assert.equal(sent.success, true, JSON.stringify(sent));
  assert.equal(h.promptCalls, 1);
  assert.equal(h.serviceEnters, 1, 'same-pair original Send must not open a second picker');
});

test('actual intent guard joins only the exact pair/revision/action sequence until the first control write', t => {
  const h = fixture(t), expected = { ...h.requested, revision: 18, actionSequence: 4 }, current = { value: expected };
  const factory = installGuard(h, current);
  for (const patch of [{ revision: 19 }, { actionSequence: 5 }, { model: 'foreign' }, { effort: 'low' }]) {
    const guard = factory(expected); current.value = { ...expected, ...patch };
    assert.equal(guard('admission').allowed, false);
  }
  for (const phase of ['slash-command-paste', 'draft-exact-copy']) {
    current.value = expected; const guard = factory(expected);
    assert.equal(guard(phase).allowed, true);
    current.value = { ...expected, revision: 19 };
    assert.equal(guard('picker-confirm-model').allowed, true,
      'already-owned native operation must settle safely; it cannot be abandoned/replayed on a newer desired pair');
  }
});

test('Main intent scheduler composes the guard with the actual existing picker request', () => {
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'scheduleCodexModelEffortIntentReconcile');
  assert.match(fn.getText(ast), /settingsWriteGuard:\s*createCodexModelEffortIntentWriteGuard\(tabId, intent\)/);
});

test('a replacement while queued behind another settings owner performs no old picker write', async t => {
  const h = fixture(t), A = { ...h.requested, revision: 18, actionSequence: 18 }, current = { value: A };
  const factory = installGuard(h, current); let release;
  const held = h.queue.run(() => new Promise(resolve => { release = resolve; })); await tick(30);
  const pending = h.ctx.executeCodexSelectModelEffortRequest(null, { tabId: 'T', ...A, ...h.opts,
    preparation: h.prep, expectedWriterSessionId: 'S', settingsWriteGuard: factory(A) });
  await tick(40); current.value = { ...A, revision: 19, actionSequence: 19 };
  release(); await held;
  assert.equal((await pending).error, 'codex_settings_intent_superseded');
  assert.equal(h.writes.length, 0);
});

test('already owned slash finishes once, but actual applied-intent CAS cannot acknowledge the newer choice', async t => {
  const h = fixture(t), A = { ...h.requested, revision: 18, actionSequence: 18 },
    B = { ...A, model: 'gpt-5.6-luna', effort: 'medium', revision: 19, actionSequence: 19 }, current = { value: A };
  const factory = installGuard(h, current);
  const first = await h.ctx.executeCodexSelectModelEffortRequest(null, { tabId: 'T', ...A, ...h.opts,
    preparation: h.prep, expectedWriterSessionId: 'S', settingsWriteGuard: factory(A) });
  assert.equal(h.writes.filter(bytes => bytes.includes('/model')).length, 1);
  current.value = B;
  const pending = first.continuePreparation(); await tick(30); h.frame('/model');
  assert.equal((await pending).success, true);
  assert.equal(h.serviceEnters, 1);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'markCodexModelEffortIntentApplied');
  vm.runInContext(fn.getText(ast), h.ctx);
  const ack = h.ctx.markCodexModelEffortIntentApplied('T', A, 'S');
  assert.equal(ack.applied, false); assert.equal(ack.reason, 'newer-intent-present');
  assert.equal(current.value, B);
  assert.equal(h.promptCalls, 0);
});

test('an intent already owning slash input still loses all write authority on Stop', async t => {
  const h = fixture(t), A = { ...h.requested, revision: 18, actionSequence: 18 }, current = { value: A };
  const factory = installGuard(h, current);
  const first = await h.ctx.executeCodexSelectModelEffortRequest(null, { tabId: 'T', ...A, ...h.opts,
    preparation: h.prep, expectedWriterSessionId: 'S', settingsWriteGuard: factory(A) });
  const pending = first.continuePreparation(); await tick(30); h.change('stop'); h.frame('/model');
  await tick(80); h.clock.advance(1800); await tick(80);
  assert.equal((await pending).success, false);
  assert.equal(h.serviceEnters, 0); assert.equal(h.promptCalls, 0);
});
