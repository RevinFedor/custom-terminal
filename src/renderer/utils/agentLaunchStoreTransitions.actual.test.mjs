import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { resolvePtyAgentOwner } from './ptyAgentOwner.mjs';
import { withAgentLaunchAdmission } from './agentLaunchAdmission.mjs';
import { planCodexLaunchSettingsPersistence } from './codexEffectiveSettings.mjs';
import { planCarriedCodexSettingsProofApplication } from './codexSessionAdoption.mjs';

// Selected actual Store/adapter/source-check functions. IPC, materialization
// ACK timing and accepted-writer proof are controlled, not provider evidence.
const workspace = fs.readFileSync(new URL('../store/useWorkspaceStore.ts', import.meta.url), 'utf8');
const restore = fs.readFileSync(new URL('./continueInterruptedSession.ts', import.meta.url), 'utf8');
const runtimes = fs.readFileSync(new URL('./historyAgentRuntimes.ts', import.meta.url), 'utf8');
function select(source, predicate) {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  let found;
  function walk(node) { if (predicate(node, ast)) found = node; ts.forEachChild(node, walk); }
  walk(ast); assert.ok(found, 'actual source declaration found'); return found.getText(ast);
}
const setSession = select(workspace, n => ts.isPropertyAssignment(n) && n.name.getText() === 'setCodexSessionId');
const interrupted = select(workspace, n => ts.isVariableDeclaration(n) && n.name.getText() === 'isTabInterrupted');
const sourceCheck = select(restore, n => ts.isBinaryExpression(n) && n.left.getText() === 'checkSource'
  && ts.isArrowFunction(n.right) && n.right.getText().includes('openProjects'));
const startFresh = select(runtimes, n => ts.isFunctionDeclaration(n) && n.name?.text === 'startFreshCodexSession');
const js = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS } }).outputText;
function fixture(sessionId = 'S') {
  const tab = { codexSessionId: sessionId, commandType: 'codex', wasInterrupted: true, cwd: '/fixture' };
  const subscribers = new Set(), history = [];
  const store = { openProjects: new Map([['P', { projectId: 'P', projectPath: '/fixture', tabs: new Map([['T', tab]]) }]]),
    setTabCommandType() {}, markAiLaunchAutoTitle() {}, clearAiLaunchSnapshot() {} };
  const env = { exports: {}, console: { log() {}, warn() {} }, AbortController, resolvePtyAgentOwner, withAgentLaunchAdmission,
    get: () => store, set: () => { for (const fn of subscribers) fn(); },
    projectCodexSettingsProofOwner: () => null, maybeArmPendingAutoTabTitle() {}, clearPendingAutoTabTitle() {},
    planCarriedCodexSettingsProofApplication,
    saveTabsThenNotifyProjectLayoutChanged: () => history.push(tab.codexSessionId),
    useWorkspaceStore: { getState: () => store }, projectId: 'P', tabId: 'T', engine: 'codex', cwd: '/fixture',
    controller: new AbortController(), sourceSessionId: sessionId, sessionReconciliation: null,
    shortTab: x => x, getCodexLaunchOptions: () => ({}), planCodexLaunchSettingsPersistence,
    ipcRenderer: { invoke() {} },
  };
  vm.createContext(env);
  vm.runInContext(js('const actions = { ' + setSession + ' };\nglobalThis.actualSetSession = actions.setCodexSessionId;\nconst ' + interrupted + ';'), env);
  store.setCodexSessionId = env.actualSetSession;
  return { env, tab, store, subscribers, history };
}

for (const sameSid of [false, true]) test('actual Store late carried source A preserves child B selection; sameSID=' + sameSid, async () => {
  const f = fixture(sameSid ? 'C' : null);
  Object.assign(f.tab, { codexModel: 'B', codexEffort: 'high', codexSettingsProofAt: 200,
    providerState: { codexSettingsIntentRevision: 2, codexSettingsIntentModel: 'B', codexSettingsIntentEffort: 'high' } });
  assert.equal(await f.store.setCodexSessionId('T', 'C', 'detected', { codexSettingsProof: { model: 'A', effort: 'max', proofAt: 100 } }), true);
  assert.equal(f.tab.codexSessionId, 'C'); assert.equal(f.tab.codexModel, 'B'); assert.equal(f.tab.codexEffort, 'high');
  assert.equal(f.tab.codexSettingsProofAt, 200);
  // A real newer proof for B is accepted independently of the selected label.
  await f.store.setCodexSessionId('T', 'C', 'detected', { codexSettingsProof: { model: 'B', effort: 'high', proofAt: 300 } });
  assert.equal(f.tab.codexSettingsProofAt, 300); assert.equal(f.tab.codexSettingsProofSessionId, 'C');
});

test('queued child choice is not converted into applied source settings on SAME SID', async () => {
  const f = fixture('C');
  Object.assign(f.tab, { codexModel: 'A', codexEffort: 'max', providerState: {
    codexSettingsIntentRevision: 2, codexSettingsIntentModel: 'B', codexSettingsIntentEffort: 'high' } });
  await f.store.setCodexSessionId('T', 'C', 'detected', { codexSettingsProof: { model: 'A', effort: 'max', proofAt: 100 } });
  assert.equal(f.tab.providerState.codexSettingsIntentModel, 'B');
  assert.equal(f.tab.codexSettingsProofAt, undefined, 'late source A cannot settle desired B or erase its pending state');
  assert.equal(f.tab.providerState.codexSettingsIntentAppliedRevision, undefined);
});

test('actual Store rereads child choice after awaited binding CAS, not captured before await', async () => {
  const f = fixture('S');
  Object.assign(f.tab, { codexModel: 'A', codexEffort: 'max' });
  let release, enter;
  const atCommit = new Promise(resolve => { enter = resolve; });
  f.env.prepareHistoryRewriteSnapshot = async () => null;
  f.env.commitCodexSessionId = () => new Promise(resolve => { release = resolve; enter(); });
  f.env.saveTabs = async () => ({ success: true }); f.env.notifyProjectLayoutChanged = () => {};
  const action = f.store.setCodexSessionId('T', 'C', 'editRange', { codexSettingsProof: { model: 'A', effort: 'max', proofAt: 100 } });
  await atCommit;
  Object.assign(f.tab, { codexModel: 'B', codexEffort: 'high', providerState: {
    codexSettingsIntentRevision: 1, codexSettingsIntentModel: 'B', codexSettingsIntentEffort: 'high' } });
  release(); assert.equal(await action, true);
  assert.equal(f.tab.codexModel, 'B'); assert.equal(f.tab.codexEffort, 'high');
  assert.equal(f.tab.codexSettingsProofAt, undefined, 'desired B is not fabricated application proof');
});

test('a closed/replaced child during awaited binding is not resurrected by settings hydration', async () => {
  const f = fixture('S'); let release, enter;
  const atCommit = new Promise(resolve => { enter = resolve; });
  f.env.prepareHistoryRewriteSnapshot = async () => null;
  f.env.commitCodexSessionId = () => new Promise(resolve => { release = resolve; enter(); });
  const action = f.store.setCodexSessionId('T', 'C', 'editRange', { codexSettingsProof: { model: 'A', effort: 'max', proofAt: 100 } });
  await atCommit; f.store.openProjects.get('P').tabs.delete('T'); release();
  assert.equal(await action, false); assert.equal(f.tab.codexSessionId, 'S');
});

test('R3 gate: actual Store own writer adoption may retire interruption but must still join the exact admitted launch', async () => {
  const f = fixture(); let joins = 0;
  f.env.launchAdmission = { reconcileSession: async sid => { assert.equal(sid, 'C'); joins++; return true; } };
  vm.runInContext(js('let checkSource; ' + sourceCheck + '; globalThis.actualCheck = checkSource;'), f.env);
  f.subscribers.add(() => { try { f.env.actualCheck(); } catch {} });
  assert.equal(await f.store.setCodexSessionId('T', 'C', 'detected'), true);
  assert.equal(f.tab.wasInterrupted, false, 'actual Store clears the presentation flag on new writer adoption');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(joins, 1, 'presentation flag is not cancellation of an already admitted exact launch');
  assert.equal(f.env.controller.signal.aborted, false);
});

test('R3 gate: late materialization ACK cannot overwrite a newer actual Store session before Main denies launch', async () => {
  const f = fixture(null); let launches = 0;
  const scope = {
    ready: async () => ({ launchFence: { terminalInstanceId: 'TERM', stopRevision: 0, order: 1 } }),
    materialize: async () => {
      // Main materialized M, then another owner C won while the M ACK waited.
      await f.store.setCodexSessionId('T', 'C', 'detected');
      return { success: true, sessionId: 'M', materializedSessionId: 'M', metadataOnly: true };
    },
    run: async () => { launches++; return { success: false, accepted: false, launchWritten: false,
      code: 'agent_launch_intent_source_changed', error: 'agent_launch_intent_source_changed' }; },
    snapshot: () => ({}),
  };
  vm.runInContext(js(startFresh.replace(/^export /, '') + '\nglobalThis.actualStart = startFreshCodexSession;'), f.env);
  const result = await f.env.actualStart({ tabId: 'T', cwd: '/fixture', launchAdmission: scope });
  assert.equal(result.success, false);
  assert.equal(f.tab.codexSessionId, 'C', 'Main final refusal must not follow an earlier renderer rollback C -> M');
  assert.equal(launches, 0, 'changed source must be refused before launch invocation');
});

test('a cleared interruption label never joins a foreign or unproven writer', async () => {
  const f = fixture(); let joins = 0;
  f.env.launchAdmission = { reconcileSession: async () => { joins++; return false; } };
  vm.runInContext(js('let checkSource; ' + sourceCheck + '; globalThis.actualCheck = checkSource;'), f.env);
  f.subscribers.add(() => { try { f.env.actualCheck(); } catch {} });
  await f.store.setCodexSessionId('T', 'FOREIGN', 'detected');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(joins, 1); assert.equal(f.env.controller.signal.aborted, true);
});

for (const original of [null, 'M']) test('Start preserves new and already-bound metadata-only UUID: ' + original, async () => {
  const f = fixture(original); let materializations = 0, launches = 0;
  const scope = { ready: async () => ({ launchFence: { terminalInstanceId: 'TERM', stopRevision: 0, order: 1 } }),
    materialize: async () => { materializations++; return { success: true, sessionId: 'M', materializedSessionId: 'M', metadataOnly: true }; },
    run: async (_channel, payload) => { launches++; assert.equal(payload.sessionId, 'M');
      return { success: true, accepted: true, launchId: 'L' }; }, snapshot: () => ({}) };
  vm.runInContext(js(startFresh.replace(/^export /, '') + '\nglobalThis.actualStart = startFreshCodexSession;'), f.env);
  const result = await f.env.actualStart({ tabId: 'T', cwd: '/fixture', launchAdmission: scope });
  assert.equal(result.success, true); assert.equal(f.tab.codexSessionId, 'M');
  assert.equal(materializations, 1); assert.equal(launches, 1);
});

for (const change of ['provider', 'cwd', 'project']) test('materialization ACK cannot retarget a changed source: ' + change, async () => {
  const f = fixture(null); let launches = 0;
  const scope = { ready: async () => ({ launchFence: { terminalInstanceId: 'TERM', stopRevision: 0, order: 1 } }),
    materialize: async () => {
      if (change === 'provider') f.tab.commandType = 'claude';
      if (change === 'cwd') f.tab.cwd = '/other';
      if (change === 'project') { const owner = f.store.openProjects.get('P');
        f.store.openProjects.delete('P'); f.store.openProjects.set('Q', owner); }
      return { success: true, sessionId: 'M', materializedSessionId: 'M', metadataOnly: true };
    }, run: async () => { launches++; return { success: true }; }, snapshot: () => ({}) };
  vm.runInContext(js(startFresh.replace(/^export /, '') + '\nglobalThis.actualStart = startFreshCodexSession;'), f.env);
  const result = await f.env.actualStart({ tabId: 'T', cwd: '/fixture', launchAdmission: scope });
  assert.equal(result.success, false); assert.equal(f.tab.codexSessionId, null); assert.equal(launches, 0);
});
