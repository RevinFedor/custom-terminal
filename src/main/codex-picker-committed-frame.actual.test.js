'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const { EventEmitter } = require('node:events');
const picker = require('./codex-model-picker');
const source = fs.readFileSync(process.env.CODEX_PICKER_MAIN_SOURCE || require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
const frame = ['Select Model and Effort',
  'Warning: OpenAI base URL is overridden to http://127.0.0.1:4001/codex/t/fixture.', '',
  '> 1. GPT-6.1-Sol (current)     Latest workhorse model for coding and everyday',
  '                              work.',
  '  2. GPT-6-Astra               Frontier intelligence.',
  '  3. GPT-6.1 Terra             GPT-6.1 Terra Codex model.', '', 'enter select · esc back'].join('\n');
const catalog = [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }];
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture() {
  const events = new EventEmitter(), timers = new Map(); let next = 0, visible = 'old composer', reads = 0;
  const mirror = { synchronizedFrameWaiters: new Set() }; let currentMirror = mirror;
  const context = vm.createContext({ console: { log() {}, warn() {} },
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id),
    CODEX_SYNC_MARKER: '\x1b[?2026l', cleanCodexTuiFrame: value => value,
    getHeadlessTerminalMirror: () => currentMirror,
    readCodexAuthoritativeScreen: async () => { reads++; return { success: true, clean: visible }; },
  });
  vm.runInContext(declaration('captureCodexFrame'), context);
  const term = { onData(fn) { events.on('data', fn); return { dispose: () => events.removeListener('data', fn) }; } };
  return { context, term, mirror, events, timers, reads: () => reads,
    setScreen(value) { visible = value; }, replace() { currentMirror = { synchronizedFrameWaiters: new Set() }; },
    commit() { for (const fn of [...mirror.synchronizedFrameWaiters]) fn(); } };
}

test('causal: real Main picker capture wakes at committed mirror after the final raw delta was read too early', async () => {
  const h = fixture(); let result;
  const capture = h.context.captureCodexFrame(h.term, { tabId: 'private-T', authoritativeScreen: true,
    predicate: clean => picker.inspectCodexModelPickerFrame(clean, 'gpt-6.1-terra', catalog).ready });
  capture.then(value => { result = value; });
  h.events.emit('data', 'controlled last PTY delta BEFORE mirror commit'); await tick();
  assert.equal(result, undefined);
  h.setScreen(frame); h.commit(); await tick();
  try { assert.ok(result, 'committed frame, not another raw byte or timeout, must finish the capture');
    assert.equal(result.timedOut, false); assert.equal(result.clean, frame);
    assert.equal(h.events.listenerCount('data'), 0); assert.equal(h.mirror.synchronizedFrameWaiters.size, 0);
    assert.equal(h.timers.size, 0);
  } finally { capture.cancel(); }
});

test('committed picker capture ignores replacement and cancellation removes exactly its observer', async () => {
  const h = fixture(); let result;
  const unrelated = () => {}; h.mirror.synchronizedFrameWaiters.add(unrelated);
  const capture = h.context.captureCodexFrame(h.term, { tabId: 'private-T', authoritativeScreen: true, predicate: () => true });
  capture.then(value => { result = value; });
  h.replace(); h.setScreen(frame); h.commit(); await tick();
  assert.equal(result, undefined); assert.equal(h.reads(), 0);
  capture.cancel(); await tick(); assert.equal(result.cancelled, true);
  assert.equal(h.events.listenerCount('data'), 0); assert.equal(h.mirror.synchronizedFrameWaiters.size, 1);
  assert.equal(h.mirror.synchronizedFrameWaiters.has(unrelated), true); assert.equal(h.timers.size, 0);
});
