'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const runtime = require('./claude-startup-main-runtime');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
function declaration(name) {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, 'actual main declaration ' + name);
  return node.getText(ast);
}

function harness(confirmed, { models = [], defaultModel = 'none' } = {}) {
  const ctx = vm.createContext({
    console: { log() {}, warn() {} },
    projectManager: { db: {
      getAppState: key => key === 'defaultClaudeModel' ? defaultModel
        : key === 'defaultClaudeEffort' ? 'none'
          : key === 'claudeCodeSettings' ? { models } : null,
      db: { prepare: () => ({ get: () => ({ claude_session_id: 'S', cwd: '/fixture' }) }) },
      getParentSession: () => null,
    } },
    terminalProjects: new Map([['T', '/fixture']]),
    bridgeKnownSessions: new Map([['T', 'S']]),
    claudeLaunchGenerationByTab: new Map([['T', {
      generation: 'G', launchMode: 'resume', sessionIdHint: 'S',
    }]]),
    claudeDataApi: { getConfirmedSettings: async () => ({ success: true, sessionId: 'S', ...confirmed }) },
    readClaudeStartupIntent: () => null,
    rememberClaudeStartupIntentUse() {},
    selectClaudeStartupSettingsSession: runtime.selectClaudeStartupSettingsSession,
    resolveClaudeSettingsAcrossForkChain: runtime.resolveClaudeSettingsAcrossForkChain,
    resolveClaudeStartupModelValue: runtime.resolveClaudeStartupModelValue,
    applyClaudeStartupIntent: runtime.applyClaudeStartupIntent,
  });
  vm.runInContext(declaration('resolveClaudeStartupSettingsInMain'), ctx);
  return ctx.resolveClaudeStartupSettingsInMain({ tabId: 'T', generation: 'G', sessionIdHint: 'S' });
}

test('actual main restore preserves explicitly observed 1M context beside a concrete model ID', async () => {
  const result = await harness({
    model: 'claude-sonnet-4-5',
    observedModel: { label: 'claude-sonnet-4-5[1m]', modelId: 'claude-sonnet-4-5', contextTokens: 1000000 },
    modelRequestedValue: 'claude-sonnet-4-5[1m]', modelRequestSatisfied: true,
    modelProofAt: 123, modelProofSessionId: 'S', effort: null,
  });
  assert.equal(result.model, 'claude-sonnet-4-5[1m]');
  assert.equal(result.source, 'session-history');
});

test('actual main restore never invents 1M context when the same ID had no context observation', async () => {
  const result = await harness({
    model: 'claude-sonnet-4-5',
    observedModel: { label: 'claude-sonnet-4-5', modelId: 'claude-sonnet-4-5', contextTokens: null },
    modelRequestedValue: 'claude-sonnet-4-5[1m]', modelRequestSatisfied: null,
    modelProofAt: 123, modelProofSessionId: 'S', effort: null,
  });
  assert.equal(result.model, 'claude-sonnet-4-5');
});

test('actual tab171 restart maps lossy Fable label and exact wrapper to its only configured 1M row', async () => {
  const result = await harness({
    model: 'Fable 5',
    observedModel: { label: 'Fable 5', modelId: null, contextTokens: null },
    modelRequestedValue: 'claude-fable-5[1m]', modelRequestSatisfied: null,
    modelProofAt: 1790013151246, modelProofSessionId: 'S', effort: null,
  }, { models: [{ key: 'fable', id: 'claude-fable-5[1m]', label: 'fable' }] });
  assert.equal(result.model, 'claude-fable-5[1m]');
  assert.equal(result.source, 'session-history');
});

test('actual main falls back to the global default instead of resurrecting a removed history variant', async () => {
  const result = await harness({
    model: 'Fable 5',
    observedModel: { label: 'Fable 5', modelId: null, contextTokens: null },
    modelRequestedValue: 'claude-fable-5', modelRequestSatisfied: true,
    modelProofAt: 123, modelProofSessionId: 'S', effort: null,
  }, {
    models: [{ key: 'opus', id: 'claude-opus-5[1m]', label: 'opus' }],
    defaultModel: 'claude-opus-5[1m]',
  });
  assert.equal(result.model, 'claude-opus-5[1m]');
  assert.equal(result.source, 'app-defaults');
});
