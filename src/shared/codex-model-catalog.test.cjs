'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const shared = require('./codex-model-catalog.cjs');
const { projectConfiguredAgentModels } = require('../main/agent-provider-model-contract.js');

// Exercise the actual TypeScript entry imported by Desktop callers, not a
// hand-written stand-in for its exports. Compilation stays entirely in memory.
const desktopPath = path.resolve(__dirname, '../renderer/constants/codexSettings.ts');
const desktopBundle = buildSync({ entryPoints: [desktopPath], bundle: true, platform: 'node', format: 'cjs', write: false });
const desktopModule = new Module(desktopPath, module);
desktopModule._compile(desktopBundle.outputFiles[0].text, desktopPath);
const desktop = desktopModule.exports;

const astra = {
  id: 'gpt-6-astra', label: 'GPT-6-Astra', defaultEffort: 'high',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};
const live = [
  { id: 'gpt-5.6-sol', label: 'Live Sol', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-luna', label: 'Live Luna', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  astra,
];
const configured = [
  { id: 'gpt-5.6-luna', label: 'My Luna', efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'gpt-5.6-sol', label: 'My Sol', efforts: ['low', 'ultra'], defaultEffort: 'low' },
  { id: 'gpt-5.5', label: 'Hidden legacy', efforts: ['xhigh'], visible: false },
];
const api = (models = configured, removedModelIds = [], liveModels = live) => projectConfiguredAgentModels({
  liveModels,
  configuredSettings: { models, removedModelIds },
});
const desktopPublic = (models = configured, removedModelIds = [], liveModels = live) => desktop.mergeCodexModelOptions(liveModels, models, removedModelIds)
  .filter((row) => row.visible !== false)
  .map((row) => ({
    id: row.id, label: row.label, efforts: row.efforts,
    defaultEffort: desktop.resolveCodexEffortForModel(row, row.defaultEffort) || '',
  }));

test('Desktop and public catalog append a newly discovered model after configured rows', () => {
  const expected = [
    { id: 'gpt-5.6-luna', label: 'My Luna', efforts: ['high', 'max'], defaultEffort: 'max' },
    { id: 'gpt-5.6-sol', label: 'My Sol', efforts: ['low', 'ultra'], defaultEffort: 'low' },
    astra,
  ];
  assert.deepEqual(api(), expected);
  assert.deepEqual(desktopPublic(), expected);
  assert.equal(shared.DEFAULT_CODEX_MODEL_OPTIONS.some((row) => row.id === astra.id), false, 'Astra is discovered, never added as a bundled workaround');
});

test('hidden and deleted live models never reappear in public projection', () => {
  const hidden = [...configured, { ...astra, visible: false }];
  assert.deepEqual(api(hidden), desktopPublic(hidden));
  assert.equal(api(hidden).some((row) => row.id === astra.id), false);
  assert.deepEqual(api(configured, [astra.id]), desktopPublic(configured, [astra.id]));
  assert.equal(api(configured, [astra.id]).some((row) => row.id === astra.id), false);
  assert.equal(desktop.mergeCodexModelOptions(live, hidden).find((row) => row.id === astra.id).visible, false, 'Settings retains the unchecked row for later re-enabling');
});

test('live capabilities bound selected effort; a new effort does not select itself', () => {
  const rows = [...configured, { ...astra, efforts: ['high', 'max'], defaultEffort: 'max' }];
  assert.deepEqual(api(rows), desktopPublic(rows));
  const publicAstra = api(rows).find((row) => row.id === astra.id);
  assert.deepEqual(publicAstra.efforts, ['high', 'max']);
  assert.equal(publicAstra.defaultEffort, 'max');
  const merged = desktop.mergeCodexModelOptions(live, rows).find((row) => row.id === astra.id);
  assert.deepEqual(merged.supportedEfforts, astra.efforts, 'checkbox selection does not shrink capability metadata');
});

test('manually configured unknown models and their labels survive a live-only catalog', () => {
  const manual = { id: 'private-router-model', label: 'Local route', efforts: ['custom-effort'], defaultEffort: 'custom-effort' };
  const rows = [manual, ...configured];
  assert.deepEqual(api(rows), desktopPublic(rows));
  assert.deepEqual(api(rows)[0], manual);
});

test('deleted fallback model IDs suppress bundled defaults on every surface', () => {
  const removed = ['gpt-5.5', 'gpt-5.6-sol', astra.id];
  const result = api([], removed);
  assert.deepEqual(result, desktopPublic([], removed));
  assert.deepEqual(result.map((row) => row.id), ['gpt-5.6-luna']);
});

test('empty, absent, hidden-all and catalog-offline configurations have matching semantics', () => {
  for (const models of [undefined, [], configured, configured.map((row) => ({ ...row, visible: false }))]) {
    for (const liveModels of [undefined, [], live]) {
      const projected = projectConfiguredAgentModels({ liveModels, configuredSettings: { models } });
      const desktopRows = desktop.mergeCodexModelOptions(liveModels, models)
        .filter((row) => row.visible !== false)
        .map((row) => ({ id: row.id, label: row.label, efforts: row.efforts, defaultEffort: desktop.resolveCodexEffortForModel(row, row.defaultEffort) || '' }));
      assert.deepEqual(projected, desktopRows);
    }
  }
  const hideAll = [...configured.map((row) => ({ ...row, visible: false })), { ...astra, visible: false }];
  assert.deepEqual(api(hideAll), []);
});

test('outdated effort choices resolve to confirmed live support without changing the input', () => {
  const rows = [...configured, { ...astra, efforts: ['old-removed-effort'], defaultEffort: 'old-removed-effort' }];
  const snapshot = JSON.stringify({ rows, live });
  assert.deepEqual(api(rows), desktopPublic(rows));
  const result = api(rows).find((row) => row.id === astra.id);
  assert.deepEqual(result.efforts, astra.efforts);
  assert.equal(result.defaultEffort, astra.defaultEffort);
  assert.equal(JSON.stringify({ rows, live }), snapshot);
});

test('browser wrapper and main require share the exact pure functions', async () => {
  const browser = await import('./codex-model-catalog.mjs');
  assert.equal(browser.mergeCodexModelOptions, shared.mergeCodexModelOptions);
  assert.equal(browser.normalizeCodexModelOptions, shared.normalizeCodexModelOptions);
});
