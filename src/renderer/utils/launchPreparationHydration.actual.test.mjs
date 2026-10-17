import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { applyAgentLaunchPreparationSnapshot, invalidateSessionStartingProbeSequence,
  isSessionStartingProbeCurrent } from './sessionStartingState.mjs';
const require = createRequire(import.meta.url);
const { createAgentLaunchPreparationRegistry } = require('../../main/agent-launch-preparation');
const { classifyCodexLaunchPreparationResult } = require('../../main/codex-runtime-contract');
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const hook = ts.createSourceFile('hook.ts', read('../components/Workspace/useAgentLifecycle.ts'), ts.ScriptTarget.Latest, true);
const main = ts.createSourceFile('main.js', read('../../main/main.js'), ts.ScriptTarget.Latest, true);
function find(root, predicate) { let result; function visit(n) { if (!result && predicate(n)) result = n; if (!result) ts.forEachChild(n, visit); } visit(root); assert.ok(result); return result; }
const callback = name => find(hook, n => ts.isVariableDeclaration(n) && n.name.getText(hook) === name).getText(hook);
const hydration = find(hook, n => ts.isCallExpression(n) && n.expression.getText(hook) === 'useEffect'
  && n.arguments[0]?.getText(hook).includes("ipcRenderer.invoke('agent:get-launch-preparation-state'"));
const runTS = (text, ctx) => vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
const declaration = name => find(main, n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(main);

async function hydrate(kind) {
  const target = { tabId: 'test-tab', engine: 'codex' };
  const snap = patch => ({ tabId: target.tabId, toolType: 'codex', token: 19, preparing: true, ...patch });
  let resolve, cleanup;
  const pending = new Promise(done => { resolve = done; });
  const ctx = vm.createContext({ target, targetRef: { current: target }, enabled: true,
    probeSeqRef: { current: 0 }, launchPreparationEventSeqRef: { current: 0 },
    dismissedKeysRef: { current: new Set() }, dismissKey: info => info.tabId,
    state: null, useCallback: fn => fn, useEffect: fn => { cleanup = fn(); },
    invalidateSessionStartingProbeSequence, isSessionStartingProbeCurrent, applyAgentLaunchPreparationSnapshot,
    ipcRenderer: { invoke: (channel, tabId) => { assert.equal(channel, 'agent:get-launch-preparation-state'); assert.equal(tabId, target.tabId); return pending; } },
  });
  ctx.setSessionStarting = fn => { ctx.state = fn(ctx.state); };
  runTS('const ' + callback('invalidateProbe') + '; const ' + callback('applyLaunchPreparationState')
    + '; globalThis.apply = applyLaunchPreparationState; globalThis.invalidate = invalidateProbe;', ctx);
  runTS(hydration.getText(hook), ctx);
  if (kind === 'late-null') { ctx.apply(snap()); resolve({ state: null }); }
  else if (kind === 'late-failure') { ctx.invalidate(target.tabId); ctx.state = null; resolve({ state: snap({ preparing: false, error: 'old' }) }); }
  else {
    if (kind === 'presence-only') ctx.probeSeqRef.current++;
    if (kind === 'foreign') ctx.invalidate('foreign');
    if (kind === 'unmount') cleanup();
    if (kind === 'engine-change') ctx.targetRef.current = { ...target, engine: 'claude' };
    resolve({ state: snap({ preparing: false, error: 'real failure' }) });
  }
  await pending; await Promise.resolve(); await Promise.resolve();
  return ctx.state;
}
test('actual hydration: late null cannot erase a newer preparation event', async () => assert.equal((await hydrate('late-null'))?.launchPreparationToken, 19));
test('actual hydration: late failure cannot resurrect after readiness event', async () => assert.equal(await hydrate('late-failure'), null));
for (const kind of ['ordinary', 'presence-only', 'foreign']) test('actual hydration preserves authoritative failure: ' + kind,
  async () => assert.equal((await hydrate(kind))?.startupError, 'real failure'));
for (const kind of ['unmount', 'engine-change']) test('actual hydration ignores replaced target: ' + kind,
  async () => assert.equal(await hydrate(kind), null));

test('actual Main launch wrapper waits for its outer intent result before final error publication', async () => {
  const events = [], sender = { id: 31 }, term = {}, tabId = 'test-tab';
  const registry = createAgentLaunchPreparationRegistry({ onChange: state => events.push(state) });
  const identity = { intentId: 'launch:actual-wrapper:1', tabId, toolType: 'codex', senderId: sender.id,
    requestedSessionId: 'S', launchFence: { terminalInstanceId: 'T', stopRevision: 0 }, source: { terminalCwd: '/fixture' } };
  const intent = registry.beginIntent(identity).state;
  const payload = { tabId, command: 'codex-c', sessionId: 'S', launchIntent: registry.intentIdentity(intent),
    launchFence: identity.launchFence, launchAttempt: 1 };
  const refusal = { success: false, accepted: false, launchWritten: false, error: 'process_lookup_failed', reason: 'process_lookup_unknown' };
  const ctx = vm.createContext({ agentLaunchPreparations: registry, classifyCodexLaunchPreparationResult,
    terminals: new Map([[tabId, term]]), console: { log() {} },
    agentLaunchIntentPayloadKey: () => 'same-payload', assertAgentSendLaunchCurrent() {},
    agentLaunchIntentTrace: () => ({}), runCodexCommandFromPayloadInner: async () => refusal,
    agentLaunchIntentRefusal() { throw Error('unexpected fixture admission refusal'); } });
  vm.runInContext(declaration('runAgentLaunchIntentAttempt') + '\n' + declaration('runCodexCommandAfterLifecycleAdmission'), ctx);
  const result = await ctx.runAgentLaunchIntentAttempt(sender, payload, () => ctx.runCodexCommandAfterLifecycleAdmission(sender, payload));
  assert.equal(result.launchWritten, false);
  assert.equal(events.some(state => !state.preparing && !state.accepted && !state.cleared), false);
  assert.equal(registry.get(tabId).phase, 'retry-wait');
  registry.finishIntent({ ...identity, token: intent.token });
  assert.equal(registry.get(tabId).preparing, false, 'no next attempt retains the real final failure');
});
