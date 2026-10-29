'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectCodexModelPickerFrame, parseCodexAllModelPicker,
  classifyCodexManualEnterFrame, isCodexActivePickerFrame } = require('./codex-model-picker');
const { isCodexSettingsPickerVisible } = require('../shared/codex-native-picker-proof.cjs');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');

// Visible model rows and footer from the 27Oct06:57 Bangkok screenshot. The
// URL and surrounding transcript are deliberately omitted: neither is model
// authority. Identity comes from the same live catalog used by ControlBar.
const frame = [
  'Select Model and Effort',
  'Warning: OpenAI base URL is overridden to http://127.0.0.1:4001/codex/t/fixture.',
  'Selecting models may not be supported or work properly.',
  '',
  '› 1. GPT-6.1-Sol (current)     Latest workhorse model for coding and everyday work.',
  '  2. GPT-6-Astra               Frontier intelligence for demanding work.',
  '  3. GPT-6.1 Terra             GPT-6.1 Terra Codex model.',
  '  4. GPT-6-Sol                 Previous generation workhorse model.',
  '',
  'enter select · esc back',
].join('\n');
const catalog = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
];

test('actual screenshot model label resolves to the exact catalog id and physical row', () => {
  const picker = parseCodexAllModelPicker(frame, catalog);
  assert.equal(picker.selectedIndex, 0);
  assert.equal(picker.items.find(row => row.value === 'gpt-6.1-terra')?.index, 2);
  assert.equal(inspectCodexModelPickerFrame(frame, 'gpt-6.1-terra', catalog).ready, true);
});

test('new footer is recognized by the real manual-settings proof owner', () => {
  assert.equal(isCodexSettingsPickerVisible(frame), true);
  assert.equal(isCodexSettingsPickerVisible(frame.replaceAll('\n', '\r\n')), true);
  assert.equal(isCodexActivePickerFrame(frame), true);
  assert.equal(classifyCodexManualEnterFrame(frame).kind, 'all-model');
});

test('a clipped/headerless current display-name block remains a picker with the new footer', () => {
  const headerless = frame.slice(frame.indexOf('› 1.'));
  const picker = parseCodexAllModelPicker(headerless, catalog);
  assert.equal(picker.items.find(row => row.value === 'gpt-6.1-terra')?.index, 2);
  assert.equal(inspectCodexModelPickerFrame(headerless, 'gpt-6.1-terra', catalog).ready, true);
  assert.equal(isCodexActivePickerFrame(headerless), true);
});

test('duplicate catalog labels are not evidence to choose either model', () => {
  const duplicate = [...catalog, { id: 'gpt-6.1-foreign', label: 'GPT-6.1 Terra' }];
  assert.equal(inspectCodexModelPickerFrame(frame, 'gpt-6.1-terra', duplicate).ready, false);
  assert.equal(parseCodexAllModelPicker(frame, duplicate).items.some(row => row.value === 'gpt-6.1'), false);
});

test('an unrelated or merely similar display name cannot authorize the target', () => {
  assert.equal(inspectCodexModelPickerFrame(frame.replace('GPT-6.1 Terra             ', 'GPT-6.1 Terra Pro         '),
    'gpt-6.1-terra', catalog).ready, false);
  assert.equal(inspectCodexModelPickerFrame(frame, 'gpt-6.1-foreign', catalog).ready, false);
});

test('legacy slug rows still work without any catalog', () => {
  const legacy = ['Select Model and Effort', '› 1. gpt-6.1-sol (current) Workhorse',
    '  2. gpt-6.1-terra Model', 'Press enter to confirm or esc to go back'].join('\n');
  assert.equal(inspectCodexModelPickerFrame(legacy, 'gpt-6.1-terra').ready, true);
});

test('actual catalog owner exposes only a fresh live id/label snapshot, never fallback or a mutable cache', () => {
  const source = fs.readFileSync(require.resolve('./ipc/codex-data'), 'utf8');
  const ast = ts.createSourceFile('codex-data.js', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'getCachedCodexPickerCatalog');
  assert.ok(node, 'actual live catalog snapshot port');
  const state = { ts: 90, source: 'live', value: catalog };
  const context = vm.createContext({ modelCache: state, MODEL_CACHE_TTL_MS: 20, Date: { now: () => 100 } });
  vm.runInContext(node.getText(ast), context);
  const snapshot = context.getCachedCodexPickerCatalog();
  assert.equal(snapshot.find(row => row.id === 'gpt-6.1-terra').label, 'GPT-6.1 Terra');
  snapshot[0].label = 'changed copy'; assert.equal(state.value[0].label, 'GPT-6.1-Sol');
  state.source = 'bundled'; assert.equal(context.getCachedCodexPickerCatalog().length, 0);
  state.source = 'live'; state.ts = 80; assert.equal(context.getCachedCodexPickerCatalog().length, 0);
});
