import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { settingProofNeedsAttention } from './confirmedAgentSettings.mjs';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../components/Workspace/ClaudeControlBar.tsx', import.meta.url), 'utf8');
const compile = code => ts.transpileModule(code, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
} }).outputText;

function view(state = {}) {
  const context = {
    React, module: { exports: {} }, settingProofNeedsAttention,
    isAnthropicPTY: true, isCodex: false, isCommandRunning: false,
    claudeSessionId: 'saved-session', confirmedClaudeModel: 'old-model', confirmedClaudeEffort: undefined,
    pendingClaudeModel: null, pendingClaudeEffort: null,
    providerState: {}, resolveAnthropicModelId: value => value,
    modelSpinning: false, effortSpinning: false, modelBlocked: false, effortBlocked: false,
    codexModelMenuDisabled: false, codexModelDisabled: false, codexEffortDisabled: false,
    settingsWriteBusy: false, codexTurnBusy: false, pinnedPopup: null, busyCancelHover: false,
    thinkActive: true, triggerStyle: {}, triggerProps: () => ({}),
    modelActiveId: 'fable', modelLabel: 'fable', effortActive: 'medium', effortTriggerLabel: 'med',
    ...state,
  };
  vm.createContext(context);
  const pendingStart = source.indexOf('  const codexSettingsIntentPending =');
  const start = pendingStart >= 0 ? pendingStart : source.indexOf('  const claudeModelProofNeedsAttention =');
  const end = source.indexOf('  // Trigger caption.', start);
  vm.runInContext(compile(source.slice(start, end)), context);
  const renderButton = kind => {
    const marker = source.indexOf(`data-agent-setting-trigger="${kind}"`);
    const begin = source.lastIndexOf('<button', marker);
    const finish = source.indexOf('</button>', marker) + '</button>'.length;
    assert.ok(marker >= 0 && begin >= 0 && finish > marker);
    vm.runInContext(compile('module.exports = () => (' + source.slice(begin, finish) + ');'), context);
    return renderToStaticMarkup(React.createElement(context.module.exports));
  };
  return { model: renderButton('model'), effort: renderButton('effort') };
}

test('stopped Claude: actual pair-save handler immediately shows both pending choices without an exclamation mark', async () => {
  const calls = [];
  let providerState = {};
  const start = source.indexOf('  const applyClaudeModelAndEffort = async');
  const end = source.indexOf('  const setEffortOnDeepSeek =', start);
  const context = {
    console: { log() {}, error() {} },
    claudeSettingActionsRef: { current: { seq: 1 } },
    isSDKTab: false, isAnthropicPTY: true, isCommandRunning: false, tabId: 'test-tab',
    setLocalBusy() {}, focusTerminal() {}, claudeSettingActionIsCurrent: () => true,
    setProviderState: value => { providerState = value; },
    showToast: message => assert.fail(message),
    ipcRenderer: { invoke: async (channel, payload) => { calls.push({ channel, payload }); return payload; } },
  };
  vm.createContext(context);
  vm.runInContext(compile(source.slice(start, end) + '\nglobalThis.applyPair = applyClaudeModelAndEffort;'), context);
  assert.equal(await context.applyPair('fable', 'medium', 'pair'), true);
  assert.deepEqual(calls.map(call => call.channel), ['provider:set-options'], 'no CLI command while stopped');
  const html = view({ providerState, pendingClaudeModel: providerState.startupModel,
    pendingClaudeEffort: providerState.startupEffort });
  for (const kind of ['model', 'effort']) {
    assert.match(html[kind], /background-color:rgba\(245,158,11,0\.07\)/);
    assert.doesNotMatch(html[kind], />!<\/span>/);
    assert.match(html[kind], /следующ/);
  }
  assert.match(html.model, />fable<\/span>/);
  assert.match(html.effort, />med<\/span>/);
});

test('pending next-launch settings stay pending without SID and when equal to historical values', () => {
  for (const claudeSessionId of [null, 'saved-session']) {
    const html = view({ claudeSessionId, confirmedClaudeModel: 'fable', confirmedClaudeEffort: 'medium',
      pendingClaudeModel: 'fable', pendingClaudeEffort: 'medium' });
    assert.match(html.model, /background-color:rgba\(245,158,11,0\.07\)/);
    assert.match(html.effort, /background-color:rgba\(245,158,11,0\.07\)/);
  }
});

test('consumed intent plus confirmed live pair removes the pending color from both buttons', () => {
  const html = view({ isCommandRunning: true, confirmedClaudeModel: 'fable', confirmedClaudeEffort: 'medium' });
  assert.doesNotMatch(html.model, /background-color:rgba\(245,158,11,0\.07\)/);
  assert.doesNotMatch(html.effort, /background-color:rgba\(245,158,11,0\.07\)/);
});

test('stopped Codex pending pair and a proof warning use color, not added punctuation', () => {
  const html = view({ isCodex: true, isAnthropicPTY: false, providerState: {
    codexSettingsIntentRevision: 2, codexSettingsIntentAppliedRevision: 1,
  } });
  for (const button of Object.values(html)) {
    assert.match(button, /background-color:rgba\(245,158,11,0\.07\)/);
    assert.doesNotMatch(button, />!<\/span>/);
  }
});
