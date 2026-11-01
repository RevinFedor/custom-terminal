'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('history context uses provider history APIs and never the normal turn submit path', () => {
  const main = read('src/main/main.js');
  const codex = read('src/main/ipc/codex-data.js');
  assert.match(main, /agent:record-history-context/);
  assert.match(main, /historyOnly: true[\s\S]{0,120}modelTurnStarted: false/);
  const injectBody = codex.match(/injectHistoryContext = async function[\s\S]*?ipcMain\.handle\('codex:get-account-profiles'/)?.[0] || '';
  assert.ok(injectBody);
  assert.doesNotMatch(injectBody, /thread\/(?:start|resume|inject_items)|CodexAppServerClient/);
  assert.match(injectBody, /type: 'thread_settings_applied'/);
  assert.match(injectBody, /type: 'response_item'/);
  assert.match(injectBody, /type: 'user_message'/);
  assert.match(injectBody, /handle\.appendFile\(serialized, 'utf8'\)/);
  const claude = read('src/main/ipc/claude-data.js');
  assert.match(claude, /CLAUDE_HISTORY_CONTEXT_ACK_TEXT/);
  assert.match(claude, /if \(isClaudeHistoryContextAck\(entry\)\) continue/);
});

function loadDeclarations(context, file, names) {
  const source = read(file), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = names.map(name => {
    const matches = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name));
    assert.equal(matches.length, 1, file + ':' + name); return matches[0].getText(tree);
  });
  vm.runInContext(ts.transpileModule(declarations.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context, { filename: file });
}

async function recordComposition(recordResult) {
  const { runAgentSendFlow } = await import(pathToFileURL(path.join(root, 'src/renderer/utils/agentSendFlow.mjs')).href);
  const calls = [], forbidden = () => assert.fail('record-only flow must not prove a submit composer or send a provider turn');
  // Execute scenario -> adapter -> record preparation -> common flow. Only
  // provider runtime/presence, session adoption and readiness are substituted;
  // no renderer store, IPC, DB, CLI or provider is started by this wiring test.
  const runtime = { toolType: 'codex', label: 'Codex',
    getPresence: async () => { calls.push(['presence']); return { status: 'inactive' }; },
    recordHistoryContext: async (...args) => { calls.push(['record', ...args]); return recordResult; },
    stopProcess: forbidden, sendPrompt: forbidden,
  };
  const context = vm.createContext({ exports: {}, console: { log() {}, warn() {} },
    runAgentSendFlow,
    getAgentSendProviderContract: (toolType, suppliedRuntime) => {
      assert.equal(toolType, 'codex'); assert.equal(suppliedRuntime, runtime);
      return { toolType, resolveHistorySession: (_presence, sessionId) => ({ sessionId, authority: 'history-hint' }),
        adoptHistorySession: async (...args) => { calls.push(['adopt', ...args]); return true; } };
    },
    prepareAgentRuntimeForSend: async input => {
      calls.push(['ready', input]); return { status: 'active', submitCapability: 'direct' };
    },
    proveAgentComposerForSend: forbidden, normalizeAgentSendOutcome: forbidden,
    cancelCoordinatedAgentSendFollowers: forbidden, getCoordinatedAgentSendCancellation: () => null,
  });
  // This dependency is pure and has no runtime imports.
  vm.runInContext(ts.transpileModule(read('src/renderer/utils/agentSendSettingsContract.ts'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  loadDeclarations(context, 'src/renderer/utils/agentRecordContextPreparation.ts',
    ['restartSettingsError', 'resolveStoppedRecordContextRestartSettings', 'buildRestartSettingsFailure', 'prepareAgentRecordContext']);
  loadDeclarations(context, 'src/renderer/utils/agentSendAdapter.ts', ['createAgentSendAdapter']);
  loadDeclarations(context, 'src/renderer/utils/agentScenarios.ts', ['normalizeStatus', 'runAgentPromptScenario']);
  return { calls, run: () => context.runAgentPromptScenario({
    tabId: 'T', toolType: 'codex', runtime, sessionId: 'old-session', cwd: '/fixture',
    prompt: 'fixture context', handoffId: 'fixture-handoff', source: 'history-panel',
    recordWithoutReply: true, statusAtSend: 'inactive', settingsIntent: { kind: 'none' },
    historyRestartSettings: { kind: 'codex-launch-settings', model: 'fixture-model', effort: 'low' },
    onHistoryRecorded: result => calls.push(['recorded', result]),
  }) };
}

test('actual record-only scenario composes adapter preparation and returns before any provider operation', async () => {
  const recorded = { success: true, accepted: true, sessionId: 'recorded-session',
    historyOnly: true, historyRecorded: true, modelTurnStarted: false };
  const h = await recordComposition(recorded), result = await h.run();
  assert.deepEqual(h.calls.map(c => c[0]), ['presence', 'record', 'adopt', 'recorded', 'ready']);
  const [, tabId, prompt, options] = h.calls.find(c => c[0] === 'record');
  assert.equal(tabId, 'T'); assert.equal(prompt, 'fixture context');
  assert.equal(options.sessionId, 'old-session'); assert.equal(options.handoffId, 'fixture-handoff');
  assert.equal(options.sessionAuthority, 'history-hint'); assert.equal(options.cwd, '/fixture');
  assert.equal(options.model, 'fixture-model'); assert.equal(options.effort, 'low');
  assert.equal(h.calls.find(c => c[0] === 'ready')[1].sessionId, 'recorded-session');
  assert.equal(result.historyRecorded, true); assert.equal(result.modelTurnStarted, false);
  assert.equal(result.recordWithoutReply, true); assert.equal(result.reopened, true);
  assert.equal(result.restartSessionId, 'recorded-session');
  assert.deepEqual(result.sendFlowTrace.map(e => e.phase), ['created', 'preparing-context', 'ensuring-ready', 'returned']);
});

test('actual adapter record failure cannot fall through to readiness or normal submit', async () => {
  const h = await recordComposition({ success: false, accepted: false, error: 'fixture-record-rejected' });
  await assert.rejects(h.run(), /fixture-record-rejected/);
  assert.deepEqual(h.calls.map(c => c[0]), ['presence', 'record']);
});

test('fresh Codex history binding is accepted by both renderer and main CAS gates', () => {
  const store = read('src/renderer/store/useWorkspaceStore.ts');
  const main = read('src/main/main.js');
  assert.match(store, /'editRange', 'deleteRange', 'historyContext'/);
  assert.match(main, /'editRange', 'deleteRange', 'historyContext'/);
});

test('recording waits for startup receipt reconciliation and checks Stop cancellation before mutation', () => {
  const main = read('src/main/main.js');
  const handler = main.match(/ipcMain\.handle\('agent:record-history-context'[\s\S]*?\n\}\);\n\n\/\/ Programmatic paste/)?.[0] || '';
  assert.match(handler, /await agentSendReceiptStartupReady/);
  assert.match(handler, /agentSendCancellations\.isCancelled\(tabId, handoffId, attemptId\)/);
  assert.match(handler, /markAttemptState[\s\S]*ENTER_ARMED/);
});
