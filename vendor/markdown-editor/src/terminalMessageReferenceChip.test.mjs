import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as codec from './terminalMessageReference.mjs';
const require = createRequire(import.meta.url), ts = require('typescript');
// Execute the actual small TS helper, not a reimplementation. DOM/events are
// controlled here; real mouse/native clipboard remains separate acceptance.
const compiled = ts.transpileModule(fs.readFileSync(new URL('./terminalMessageReferenceChip.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
class Target {
  listeners = new Map();
  addEventListener(type, fn) { const set = this.listeners.get(type) || new Set(); set.add(fn); this.listeners.set(type, set); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, fields = {}) { const event = { type, metaKey: false, ctrlKey: false, button: 0, detail: 1, preventDefault() {}, stopPropagation() {}, ...fields }; for (const fn of this.listeners.get(type) || []) fn(event); }
}
function fixture() {
  const exports = {}; vm.runInNewContext(compiled, { exports, require: () => codec });
  const document = new Target(), window = new Target(); document.defaultView = window;
  const chip = () => {
    const node = new Target(), classes = new Set();
    Object.assign(node, { ownerDocument: document, dataset: {}, setAttribute() {}, classList: {
      toggle(name, value) { value ? classes.add(name) : classes.delete(name); }, remove(name) { classes.delete(name); },
    }, navigates: () => classes.has('cm-terminal-message--navigate') });
    return node;
  };
  return { ...exports, document, window, chip };
}
const snapshot = { referenceId: 'copy-id', source: { tabName: 'Source', iteration: 4 }, detailsText: 'full metadata' };
test('both modifier/hover orders, release, blur and many chips use one local document controller', () => {
  const f = fixture(), a = f.chip(), b = f.chip();
  const disposeA = f.attachTerminalMessageChip(a, snapshot, { openDetails() {}, navigate() {} });
  const disposeB = f.attachTerminalMessageChip(b, snapshot, { openDetails() {}, navigate() {} });
  assert.equal(f.document.listeners.get('keydown').size, 1);
  f.document.emit('keydown', { metaKey: true }); a.emit('mouseenter', { metaKey: true }); assert.equal(a.navigates(), true);
  a.emit('mouseleave'); b.emit('mouseenter'); assert.equal(b.navigates(), false);
  f.document.emit('keydown', { metaKey: true }); assert.equal(b.navigates(), true); assert.equal(a.navigates(), false);
  f.document.emit('keyup'); assert.equal(b.navigates(), false);
  f.document.emit('keydown', { metaKey: true }); f.window.emit('blur'); assert.equal(b.navigates(), false);
  disposeA(); disposeB(); assert.equal(f.document.listeners.get('keydown').size, 0);
});
test('plain viewer/Cmd exact navigation/key access remain distinct; drag and late errors do not Send', async () => {
  const f = fixture(), node = f.chip(), actions = []; let allow = true;
  const dispose = f.attachTerminalMessageChip(node, snapshot, { allowDetails: () => allow,
    openDetails: value => actions.push(['details', value]), navigate: value => { actions.push(['navigate', value]); throw Error('unavailable'); },
    error: reason => actions.push(['error', reason]) });
  node.emit('click'); allow = false; node.emit('click'); assert.equal(actions.length, 1);
  node.emit('keydown', { key: 'Enter' }); assert.equal(actions.length, 2);
  node.emit('click', { metaKey: true }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions.map(value => value[0]), ['details', 'details', 'navigate', 'error']);
  assert.equal(actions[2][1], snapshot); dispose();
});
