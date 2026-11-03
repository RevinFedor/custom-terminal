'use strict';
// Decision 01.11 (Fedor): a manual model/effort choice belongs to the TAB and
// survives restarts until the user changes it; the StatusBar default applies to
// newly created tabs only.
//
// Incident: tab c41a18522055 was set to Opus/high at 02:34 and again at 03:29,
// and came back as Opus/MAX at 03:46. Two separate holes:
//   1. the stored next-launch pair was DELETED the first time it was applied;
//   2. a change made while Claude was RUNNING went to the PTY only and was
//      never stored, because `/effort` is process-local.
// Both then fell through to the global default (`defaultClaudeEffort=max`).
//
// Real functions from main.js, driven over a real provider-state store.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declaration = (name) => {
  const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, 'function ' + name + ' found in main.js');
  return node.getText(ast);
};

const TAB = 'tab-d0c9f42d-2fcf-4abe-993d-c41a18522055';

function harness({ state = { type: 'anthropic' }, generation = 'claude-launch-3' } = {}) {
  const store = new Map([[TAB, { ...state }]]);
  const persisted = [];
  const broadcasts = [];
  const logs = [];
  const ctx = vm.createContext({
    console: { log: (l) => logs.push(l), warn: (l) => logs.push(l) },
    String, Number, Object,
    getProviderState: (tabId) => store.get(tabId) || {},
    setProviderState: (tabId, value) => store.set(tabId, value),
    broadcastProviderState: (tabId, value) => broadcasts.push({ tabId, value }),
    projectManager: { db: { updateTabProviderState: (tabId, value) => persisted.push({ tabId, value }) } },
    claudeLaunchGenerationByTab: new Map(generation ? [[TAB, { generation }]] : []),
    claudeStartupIntentUseByTab: new Map(),
    normalizeClaudeStartupIntent: (providerState) => {
      if (!providerState || providerState.type !== 'anthropic') return null;
      const model = String(providerState.startupModel || '').trim();
      const effort = String(providerState.startupEffort || '').trim();
      const intent = {
        ...(model && model !== 'none' ? { model } : {}),
        ...(effort && effort !== 'none' ? { effort } : {}),
      };
      return intent.model || intent.effort ? intent : null;
    },
  });
  vm.runInContext([
    declaration('rememberClaudeStartupIntentUse'),
    declaration('consumeClaudeStartupIntent'),
    declaration('retainClaudeManualSettingChoice'),
    declaration('updateProviderOptionsForTab'),
  ].join('\n'), ctx);
  return { ctx, store, persisted, broadcasts, logs, read: () => store.get(TAB) };
}

test('an applied next-launch pair is retained, not deleted, so later launches reuse it', () => {
  const h = harness({ state: { type: 'anthropic', startupModel: 'claude-opus-5[1m]', startupEffort: 'high' } });
  const intent = { model: 'claude-opus-5[1m]', effort: 'high' };
  h.ctx.rememberClaudeStartupIntentUse(TAB, 'claude-launch-3', intent);
  assert.equal(h.ctx.consumeClaudeStartupIntent(TAB, 'claude-launch-3'), true);
  const after = h.read();
  // Pre-fix these two were deleted; the next launch then fell back to history
  // and, through it, to the global default.
  assert.equal(after.startupModel, 'claude-opus-5[1m]');
  assert.equal(after.startupEffort, 'high');
  assert.equal(after.startupIntentAppliedGeneration, 'claude-launch-3');
  assert.equal(h.persisted.at(-1).value.startupEffort, 'high', 'retained in SQLite, survives restart');
  assert.ok(h.logs.some((l) => l.includes('intent-applied') && l.includes('retained=tab-preference')));

  // A second launch applies the same retained pair and is idempotent.
  h.ctx.rememberClaudeStartupIntentUse(TAB, 'claude-launch-4', intent);
  assert.equal(h.ctx.consumeClaudeStartupIntent(TAB, 'claude-launch-4'), true);
  assert.equal(h.read().startupEffort, 'high');
  assert.equal(h.read().startupIntentAppliedGeneration, 'claude-launch-4');
  h.ctx.rememberClaudeStartupIntentUse(TAB, 'claude-launch-4', intent);
  assert.equal(h.ctx.consumeClaudeStartupIntent(TAB, 'claude-launch-4'), false, 'same generation applies once');
});

test('changing model/effort on a RUNNING Claude stores the tab preference too', () => {
  const h = harness();
  h.ctx.retainClaudeManualSettingChoice(TAB, { model: 'claude-opus-5[1m]', effort: 'high' }, 'controlbar:pair');
  const after = h.read();
  assert.equal(after.startupModel, 'claude-opus-5[1m]');
  assert.equal(after.startupEffort, 'high');
  // Already applied by this very launch: the control must not claim "saved for
  // the next launch, not yet applied".
  assert.equal(after.startupIntentAppliedGeneration, 'claude-launch-3');
  assert.equal(h.persisted.length, 1);
  assert.equal(h.broadcasts.length, 1);
  assert.ok(h.logs.some((l) => l.includes('manual-choice-retained')));

  // One-setting change keeps the other half of the pair.
  h.ctx.retainClaudeManualSettingChoice(TAB, { effort: 'xhigh' }, 'controlbar:effort');
  assert.equal(h.read().startupModel, 'claude-opus-5[1m]');
  assert.equal(h.read().startupEffort, 'xhigh');
  // An unchanged repeat writes nothing.
  const writes = h.persisted.length;
  h.ctx.retainClaudeManualSettingChoice(TAB, { effort: 'xhigh' }, 'controlbar:effort');
  assert.equal(h.persisted.length, writes);
});

test('retention never touches another provider or an empty result', () => {
  const codex = harness({ state: { type: 'codex' } });
  codex.ctx.retainClaudeManualSettingChoice(TAB, { model: 'gpt-5.5', effort: 'high' }, 'controlbar:pair');
  assert.deepEqual(codex.read(), { type: 'codex' });
  const h = harness();
  h.ctx.retainClaudeManualSettingChoice(TAB, {}, 'controlbar:pair');
  h.ctx.retainClaudeManualSettingChoice('', { effort: 'high' }, 'controlbar:pair');
  assert.equal(h.persisted.length, 0);
});

test('a NEW choice clears the applied mark so the control shows it as pending', () => {
  const h = harness({ state: { type: 'anthropic', startupModel: 'claude-opus-5[1m]',
    startupEffort: 'high', startupIntentAppliedGeneration: 'claude-launch-3' } });
  h.ctx.updateProviderOptionsForTab(TAB, { tabId: TAB, startupEffort: 'xhigh' });
  assert.equal(h.read().startupEffort, 'xhigh');
  assert.equal(h.read().startupIntentAppliedGeneration, undefined);
  // Re-selecting the SAME value keeps the applied mark.
  h.ctx.retainClaudeManualSettingChoice(TAB, { effort: 'xhigh' }, 'controlbar:effort');
  assert.equal(h.read().startupIntentAppliedGeneration, 'claude-launch-3');
  h.ctx.updateProviderOptionsForTab(TAB, { tabId: TAB, startupEffort: 'xhigh' });
  assert.equal(h.read().startupIntentAppliedGeneration, 'claude-launch-3');
});

test('wired: both live apply handlers retain the choice, and the startup path keeps it', () => {
  // Both handlers still retain — but the SENT id, not Claude's printed label.
  // `applied.appliedSettings` / `applied.value` carry what Claude echoed
  // (`Opus 5`), and retaining that re-injected `/model Opus 5` on the next
  // launch, which Claude rejects (03.11, tab 5b20bf267cca). See
  // retained-setting-uses-sent-id.actual.test.js.
  assert.ok(main.includes('...(request.model ? { model: request.model } : {}),'),
    'the pair handler retains the requested model');
  assert.ok(main.includes('...(request.effort ? { effort: request.effort } : {}),'),
    'the pair handler retains the requested effort');
  assert.ok(main.includes('{ [request.kind]: applied.requestedValue ?? request.value }'),
    'the single handler retains the requested value');
  assert.ok(!main.includes('retainClaudeManualSettingChoice(request.tabId, applied.appliedSettings, request.source);'),
    'the printed labels must not be retained any more');
  assert.ok(!/delete current\.startupModel;\s*\n\s*delete current\.startupEffort;/.test(main),
    'the applied pair is no longer deleted');
});
