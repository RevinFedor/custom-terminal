import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../components/Dashboard/StorageBrowser.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('StorageBrowser.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name, scope) {
  let found;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, name);
  vm.runInNewContext(ts.transpileModule('globalThis.result = ' + found.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, scope);
  return scope.result;
}

test('actual hours handler writes only settings and keeps existing group preferences', async () => {
  const writes = [];
  const scope = {
    inventory: { settings: { enabled: true, provider: 'all', gracePeriodHours: 24, retentionDays: { fork: null, regular: 7 } } },
    retentionSettingsBusyRef: { current: false }, graceHoursDraft: '48',
    saveRetentionSettings: async (settings) => writes.push(settings),
    setGraceHoursDraft() {}, showToast() {},
  };
  await callback('updateGraceHours', scope)();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].gracePeriodHours, 48);
  assert.equal(writes[0].retentionDays.fork, null);
  assert.equal(writes[0].retentionDays.regular, 7);
  assert.equal(scope.inventory.settings.gracePeriodHours, 24);
});

test('actual handler rejects empty, zero, fractional and invalid hours without a write', async () => {
  for (const draft of ['', '0', '-1', '1.5', 'bad', '87601']) {
    let writes = 0, notices = 0, restored;
    const scope = {
      inventory: { settings: { gracePeriodHours: 24 } }, retentionSettingsBusyRef: { current: false },
      graceHoursDraft: draft, saveRetentionSettings: async () => writes++,
      setGraceHoursDraft: (value) => { restored = value; }, showToast: () => notices++,
    };
    await callback('updateGraceHours', scope)();
    assert.equal(writes, 0, draft);
    assert.equal(notices, 1, draft);
    assert.equal(restored, '24', draft);
  }
});

test('actual settings save is single-flight, has no Delete/Resume IPC, and reports failure', async () => {
  let finish;
  const channels = [], notices = [];
  const scope = {
    inventory: { settings: { gracePeriodHours: 24 } }, retentionSettingsBusyRef: { current: false },
    setRetentionSaving() {}, setInventory() {}, setGraceHoursDraft() {},
    showToast: (...args) => notices.push(args), loadInventory: async () => {},
    ipcRenderer: { invoke: (name) => { channels.push(name); return new Promise((resolve) => { finish = resolve; }); } },
  };
  const save = callback('saveRetentionSettings', scope);
  const first = save({ gracePeriodHours: 48 });
  await save({ gracePeriodHours: 72 });
  assert.deepEqual(channels, ['storage:set-settings']);
  finish({ success: false, error: 'write-failed' });
  await first;
  assert.equal(scope.retentionSettingsBusyRef.current, false);
  assert.equal(notices.length, 1);
});

test('actual JSX exposes an explicit hours field adjacent to the automatic toggle, no timer added', () => {
  assert.match(source, /data-storage-grace-hours/);
  assert.match(source, /Auto-delete delay/);
  assert.match(source, /type="number" min=\{1\} max=\{87600\} step=\{1\}/);
  assert.match(source, /onBlur=\{\(\) => void updateGraceHours\(\)\}/);
  assert.match(source, /data-storage-auto-delete/);
  assert.doesNotMatch(source, /setInterval/);
  const result = ts.transpileModule(source, {
    fileName: 'StorageBrowser.tsx', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.equal(result.diagnostics.length, 0);
});
