import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import * as settings from './codexEffectiveSettings.mjs';

const require = createRequire(import.meta.url);
const { _api } = require('../../main/ipc/codex-data');
const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name?.text === 'reconcileCodexEffectiveSettings') declaration = node;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(declaration);
const compiled = ts.transpileModule('const ' + declaration.getText(ast) + ';\nglobalThis.reconcile = reconcileCodexEffectiveSettings;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const time = offset => new Date(1788867270000 + offset).toISOString();
const rows = (effort, at) => [
  { role: 'slash', content: '/model gpt-5.6-sol', timestamp: time(at) },
  { role: 'slash', content: '/effort ' + effort, timestamp: time(at) },
];
function harness(extra = {}) {
  const tab = { codexSessionId: 'S', codexModel: 'gpt-5.6-sol', codexEffort: 'max',
    codexSettingsProofSessionId: 'S', codexSettingsProofAt: Date.parse(time(6000)), ...extra };
  const writes = [];
  const state = {
    getCodexSessionId: () => tab.codexSessionId,
    openProjects: new Map([['P', { tabs: new Map([['T', tab]]) }]]),
    updateCodexState: (_tab, patch) => { writes.push(['persistent', patch]); Object.assign(tab, patch); },
    updateCodexLiveState: (_tab, patch) => { writes.push(['live', patch]); Object.assign(tab, patch); },
  };
  const context = vm.createContext({ ...settings, useWorkspaceStore: { getState: () => state } });
  vm.runInContext(compiled, context);
  return { tab, writes, reconcile: (entries, sid = 'S') => context.reconcile('T', sid, entries) };
}

test('tab-4196: cached Ultra history cannot replace a newer confirmed Max after tab return', () => {
  const h = harness();
  h.reconcile(rows('ultra', 1000));
  h.reconcile(rows('ultra', 1000));
  assert.equal(h.writes.length, 0);
  assert.equal(settings.resolveCodexEffectiveSettings(h.tab).effort, 'max');
});

test('a newer Ultra proof is live-only and bars older non-Ultra history', () => {
  const h = harness();
  h.reconcile(rows('ultra', 7000));
  assert.equal(h.tab.codexEffort, 'max', 'Ultra is not a persistent default');
  assert.equal(settings.resolveCodexEffectiveSettings(h.tab).effort, 'ultra');
  assert.equal(h.tab.codexLiveSettingsProofAt, Date.parse(time(7000)));
  h.reconcile(rows('high', 6500));
  assert.equal(settings.resolveCodexEffectiveSettings(h.tab).effort, 'ultra');
  h.reconcile(rows('max', 8000));
  assert.equal(settings.resolveCodexEffectiveSettings(h.tab).effort, 'max');
});

test('history for a replaced writer cannot project settings', () => {
  const h = harness();
  h.reconcile(rows('ultra', 9000), 'old-S');
  assert.equal(h.writes.length, 0);
});

test('a late Ultra fallback read cannot resurrect it after a newer Max selection', () => {
  const live = { codexLiveModel: 'gpt-5.6-sol', codexLiveEffort: 'ultra', codexLiveSettingsSessionId: 'S', codexLiveSettingsProofAt: 50 };
  assert.equal(settings.canApplyCodexConversationFallback({ codexSessionId: 'S', ...live }, live), true);
  assert.equal(settings.canApplyCodexConversationFallback({ codexSessionId: 'S', codexEffort: 'max' }, live), false);
  assert.equal(settings.canApplyCodexConversationFallback({ codexSessionId: 'S', ...live, codexLiveSettingsProofAt: 60 }, live), false);
});

test('canonical History includes native thread_settings_applied after an older Ultra turn', () => {
  const history = _api.buildCodexFullHistory([
    { __line: 1, type: 'turn_context', timestamp: time(1000), payload: { model: 'gpt-5.6-sol', effort: 'ultra' } },
    { __line: 2, type: 'event_msg', timestamp: time(6000), payload: {
      type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-sol', reasoning_effort: 'max' },
    } },
  ], 'S');
  const proof = settings.deriveCodexEffectiveSettingsFromHistory(history);
  assert.equal(proof.effort, 'max');
  assert.equal(proof.proofAt, Date.parse(time(6000)));
  assert.equal(history.filter(row => row.content === '/effort max').length, 1);
});
