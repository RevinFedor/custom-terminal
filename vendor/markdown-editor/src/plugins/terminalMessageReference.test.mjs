import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EditorState } from '@codemirror/state';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import { history, undo, redo } from '@codemirror/commands';
import * as codec from '../terminalMessageReference.mjs';
const require = createRequire(import.meta.url), ts = require('typescript');
const exports = {};
const scanned = [];
const compiled = ts.transpileModule(fs.readFileSync(new URL('./terminalMessageReference.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(compiled, { exports, require: name => name.endsWith('terminalMessageReference.mjs')
  ? { ...codec, collectTerminalMessageBlocks: text => { scanned.push(text.length); return codec.collectTerminalMessageBlocks(text); } }
  : name.endsWith('terminalMessageReferenceChip') ? {} : name === '@codemirror/state' ? cmState : name === '@codemirror/view' ? cmView : require(name) });
const field = () => exports.terminalMessageReferences(() => ({ clipboard: { writeText() {} } }));
const source = { tabId: 'opaque-tab', messageId: 'message', sessionId: 'physical', provider: 'codex' };
test('actual GT field keeps paste/Unicode/full body through Undo/Redo and ordinary edits do not scan following megabytes', () => {
  const snapshot = codec.makeTerminalMessageSnapshot('日本語🙂\nDetails\n</noted-message-reference>', source, 'copy-id');
  const block = codec.buildTerminalMessageBlock(snapshot), extension = field();
  let state = EditorState.create({ doc: 'before after', extensions: [history(), extension] });
  const view = { get state() { return state; }, dispatch: tr => { state = tr.state || state.update(tr).state; } };
  state = state.update({ changes: { from: 7, insert: block }, selection: { anchor: 7 + block.length }, userEvent: 'input.paste' }).state;
  assert.equal(state.field(extension).blocks.length, 1);
  assert.equal(state.field(extension).blocks[0].snapshot.detailsText, snapshot.detailsText);
  assert.equal(undo(view), true); assert.equal(state.field(extension).blocks.length, 0); assert.equal(state.doc.toString(), 'before after');
  assert.equal(redo(view), true); assert.equal(state.field(extension).blocks.length, 1);
  state = state.update({ changes: { from: 0, insert: 'new ' } }).state;
  assert.equal(state.field(extension).blocks[0].from, 11);
  const from = state.field(extension).blocks[0].from;
  state = state.update({ changes: { from, to: from + 1, insert: '?' } }).state;
  assert.equal(state.field(extension).blocks.length, 0);
  assert.ok(state.doc.toString().includes(snapshot.detailsText));
  state = EditorState.create({ doc: 'head\n' + 'x'.repeat(1024 * 1024), extensions: [extension] });
  scanned.length = 0;
  state = state.update({ changes: { from: 0, insert: 'z' } }).state;
  assert.ok(scanned.length > 0 && scanned.every(size => size <= 24001));
});
test('ordinary initial document and inserted malformed framing keep all text, nested literal blocks are not secondary chips', () => {
  const inner = codec.buildTerminalMessageBlock(codec.makeTerminalMessageSnapshot('inner', source, 'inner-id'));
  const outer = codec.buildTerminalMessageBlock(codec.makeTerminalMessageSnapshot(inner + '\ntail', source, 'outer-id'));
  const extension = field(); let state = EditorState.create({ doc: 'head\n' + outer + '\nlast', extensions: [extension] });
  assert.equal(state.field(extension).blocks.length, 1);
  state = state.update({ changes: { from: state.doc.length, insert: '\n' + outer.slice(0, -1) } }).state;
  assert.equal(state.field(extension).blocks.length, 1);
  assert.ok(state.doc.toString().endsWith(outer.slice(0, -1)));
});
