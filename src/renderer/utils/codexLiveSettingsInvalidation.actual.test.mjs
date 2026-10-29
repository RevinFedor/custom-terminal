import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { projectCodexProvisionalSettingsOverlay } from './codexEffectiveSettings.mjs';
import liveSettingsModule from '../../main/codex-live-settings.js';

const source = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleCodexLiveSettings') handler = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handler, 'actual renderer event handler');
const compiled = ts.transpileModule('globalThis.handler = ' + handler.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture() {
  const tab = { codexLiveModel: 'gpt-7.2-artemis', codexLiveEffort: 'high',
    codexLiveSettingsSessionId: 'S1', codexLiveSettingsProofAt: 100 };
  const changes = [], state = { openProjects: new Map([['P', { tabs: new Map([['T', tab]]) }]]),
    updateCodexLiveState: (id, patch) => { changes.push({ id, patch }); Object.assign(tab, patch); } };
  const context = vm.createContext({ projectCodexProvisionalSettingsOverlay, useWorkspaceStore: { getState: () => state } });
  vm.runInContext(compiled, context);
  const invalidation = { ownerId: 'S1', model: 'gpt-7.2-artemis', effort: 'high', proofAt: 100, frameSeq: 2 };
  return { tab, changes, invalidation, emit: data => context.handler(null, { tabId: 'T', ...data }),
    deliver: (value = invalidation) => context.handler(null, { tabId: 'T', invalidation: value }) };
}

test('actual renderer clears only the exact previously published live settings on invalidation', () => {
  const h = fixture(); h.deliver();
  assert.equal(h.changes.length, 1);
  assert.equal(h.tab.codexLiveModel, undefined); assert.equal(h.tab.codexLiveSettingsSessionId, undefined);
});

test('late invalidation cannot clear a newer, foreign or different proven model', () => {
  for (const change of [{ codexLiveSettingsSessionId: 'S2' }, { codexLiveSettingsProofAt: 101 },
    { codexLiveModel: 'gpt-6-astra' }]) {
    const h = fixture(); Object.assign(h.tab, change); h.deliver(); assert.equal(h.changes.length, 0);
  }
});

test('actual Main observer invalidates the exact renderer pair after a newer unresolved composer', () => {
  const h = fixture(), owner = { live: true, terminal: {}, lifecycleGeneration: 'G1', runSeq: 1,
    ownerId: 'S1', sessionId: 'S1' };
  const observer = liveSettingsModule.createCodexLiveSettingsObserver({ capture: () => ({ ...owner }),
    publish: (_tabId, liveSettings) => h.emit({ liveSettings }), invalidate: (_tabId, invalidation) => h.emit({ invalidation }) });
  observer.observe('T', { valid: true, seq: 1, text: '› Ask Codex to do anything\ngpt-6.1-sol max · /fixture' });
  assert.equal(h.tab.codexLiveModel, 'gpt-6.1-sol');
  observer.observe('T', { valid: true, seq: 2, text: '› Ask Codex to do anything\nGPT-7.2 Artemis high · /fixture' });
  assert.equal(observer.read('T'), null); assert.equal(h.tab.codexLiveModel, undefined);
  assert.equal(h.changes.length, 2);
});
