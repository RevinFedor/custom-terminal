'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const ast = ts.createSourceFile('main.js', fs.readFileSync(require.resolve('./main'), 'utf8'), ts.ScriptTarget.Latest, true);
const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'captureCodexFrame');
assert.ok(node);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(readScreen = async () => ({ success: true, clean: 'menu' })) {
  const events = new EventEmitter(), timers = new Set(), logs = [];
  const capture = vm.runInNewContext(node.getText(ast) + '\ncaptureCodexFrame', {
    console: { log: line => logs.push(line), warn: line => logs.push(line) },
    readCodexAuthoritativeScreen: readScreen, cleanCodexTuiFrame: value => value,
    CODEX_SYNC_MARKER: '<sync>',
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
  });
  const term = { onData(fn) { events.on('data', fn); return { dispose: () => events.off('data', fn) }; } };
  return { capture: options => capture(term, options), events, timers, logs };
}

test('cancel disposes a frame listener and its deadline without any terminal input', async () => {
  const h = fixture(), capture = h.capture({ predicate: () => false });
  assert.equal(h.events.listenerCount('data'), 1); assert.equal(h.timers.size, 1);
  capture.cancel(); capture.cancel();
  assert.equal((await capture).cancelled, true);
  assert.equal(h.events.listenerCount('data'), 0); assert.equal(h.timers.size, 0);
  h.events.emit('data', 'late frame'); assert.equal(h.logs.length, 0);
});

test('late current-screen read cannot complete or restart a cancelled capture', async () => {
  let release; const h = fixture(() => new Promise(resolve => { release = resolve; }));
  let predicates = 0;
  const capture = h.capture({ tabId: 'T', authoritativeScreen: true, predicate: () => { predicates++; return true; } });
  h.events.emit('data', 'frame'); capture.cancel();
  release({ success: true, clean: 'late menu' }); await tick();
  const result = await capture;
  assert.equal(result.cancelled, true); assert.equal(predicates, 0);
  assert.equal(h.events.listenerCount('data'), 0); assert.equal(h.timers.size, 0);
});

test('normal committed capture and timeout behavior are unchanged', async () => {
  const h = fixture(), capture = h.capture({ predicate: text => text === 'menu' });
  h.events.emit('data', 'menu');
  assert.equal((await capture).clean, 'menu'); assert.equal((await capture).timedOut, false);
  capture.cancel(); assert.equal((await capture).cancelled, undefined);
  const pending = h.capture({ predicate: () => false });
  for (const timer of [...h.timers]) timer();
  assert.equal((await pending).timedOut, true);
  assert.equal(h.events.listenerCount('data'), 0); assert.equal(h.timers.size, 0);
});
