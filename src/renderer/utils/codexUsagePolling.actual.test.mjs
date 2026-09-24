import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const componentFile = path.resolve(import.meta.dirname, '../components/Workspace/ClaudeUsageButton.tsx');
const source = fs.readFileSync(componentFile, 'utf8');
const ast = ts.createSourceFile(componentFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function extractEffect(needle, name) {
  let callback = null;
  const walk = (node) => {
    if (ts.isCallExpression(node)
      && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes(needle)) {
      callback = node.arguments[0].getText(ast);
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  assert.ok(callback, 'the production Codex ' + name + ' effect exists');
  return ts.transpileModule('globalThis.' + name + ' = ' + callback + ';', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

test('Codex checks 30 seconds after the last request even across manual reads and tab switches', async () => {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const calls = [];
  const lastRefreshStartedAtRef = { current: 0 };
  const makeRefresh = (account) => (force, request) => {
    calls.push({ account, force, reason: request.reason, at: now });
    lastRefreshStartedAtRef.current = now;
    return Promise.resolve();
  };
  const document = {
    visibilityState: 'visible',
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
  };
  const context = {
    Date: { now: () => now },
    lastRefreshStartedAtRef,
    document,
    setTimeout: (callback, delay) => {
      assert.ok(delay >= 0);
      const id = ++nextTimerId;
      timers.set(id, { callback, dueAt: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(extractEffect("reason: 'interval'", 'pollEffect'), context);
  const mount = (account, interval) => {
    context.refresh = makeRefresh(account);
    context.codexUsagePollInterval = interval;
    return context.pollEffect();
  };
  const advance = async (target) => {
    for (let passes = 0; passes < 20; passes += 1) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!due) { now = target; return; }
      now = due[1].dueAt;
      timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    assert.fail('poll scheduled repeatedly without advancing time');
  };

  let cleanup = mount('A', 30_000);
  assert.equal(timers.size, 1);
  await advance(30_000);
  assert.deepEqual(calls, [{ account: 'A', force: false, reason: 'interval', at: 30_000 }]);
  await advance(45_000);
  cleanup();
  cleanup = mount('B', 30_000); // active tab changed
  await advance(60_000);
  assert.equal(calls[1].account, 'B');
  assert.equal(calls[1].at, 60_000, 'tab switch did not postpone the deadline');

  await advance(70_000);
  lastRefreshStartedAtRef.current = now; // manual refresh started
  await advance(90_000);
  assert.equal(calls.length, 2, 'scheduled timer did not duplicate the manual read');
  await advance(100_000);
  assert.equal(calls[2].at, 100_000, 'next read is 30 seconds after manual refresh');

  document.visibilityState = 'hidden';
  listeners.get('visibilitychange')();
  assert.equal(timers.size, 0, 'hidden app has no usage poll');
  document.visibilityState = 'visible';
  await advance(151_000);
  listeners.get('visibilitychange')();
  await advance(151_000);
  assert.equal(calls[3].at, 151_000, 'visibility resume checks overdue usage');

  cleanup();
  cleanup = mount('B', 180_000); // no exact account, discovery only
  await advance(181_000);
  assert.equal(calls.length, 4, 'no all-profile sweep after 30 seconds');
  await advance(331_000);
  assert.equal(calls[4].at, 331_000, 'discovery keeps its old three-minute deadline');
  cleanup();
  cleanup = mount('B', 30_000);
  await advance(361_000);
  assert.equal(calls[5].at, 361_000, 'exact-account cadence resumes');

  cleanup();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});

test('tab switches cannot trigger an all-profile sweep every 30 seconds without an exact account', () => {
  let now = 30_000;
  const lastRefreshStartedAtRef = { current: 0 };
  const document = { visibilityState: 'visible' };
  const calls = [];
  const context = {
    Date: { now: () => now },
    codexUsagePollInterval: 180_000,
    lastRefreshStartedAtRef,
    document,
    refresh: () => { calls.push(now); lastRefreshStartedAtRef.current = now; },
    console: { log: () => {} },
  };
  vm.runInNewContext(extractEffect('[CodexUsage] context-refresh throttled', 'contextEffect'), context);
  context.contextEffect();
  assert.deepEqual(calls, []);
  now = 180_000;
  context.contextEffect();
  assert.deepEqual(calls, [180_000]);
  context.codexUsagePollInterval = 30_000;
  now = 210_000;
  context.contextEffect();
  assert.deepEqual(calls, [180_000, 210_000]);
  document.visibilityState = 'hidden';
  now = 240_000;
  context.contextEffect();
  assert.equal(calls.length, 2);
});
