import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const base = process.env.NOTED_GOAL_CHOICE_PREIMAGE;
const { projectCodexGoalLifecycle } = await import(base
  ? pathToFileURL(path.join(base, 'PRE-codexGoalDesktopAdapter.mjs')) : './codexGoalDesktopAdapter.mjs');
const source = fs.readFileSync(base ? path.join(base, 'PRE-AgentLifecycleActions.tsx')
  : new URL('../components/Workspace/AgentLifecycleActions.tsx', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs' }).code,
  { module, exports: module.exports, require: createRequire(import.meta.url) });
const Actions = module.exports.default;
const owned = { tabId: 'T', operationId: 'op', currentOperation: true, runtimeLive: true,
  owner: { sessionId: 'S' }, status: 'available', pending: false, availableActions: ['resume', 'leave-paused'] };
const callbacks = { onChoose() {}, onRefresh() {}, onDismiss() {} };
const render = lifecycle => renderToStaticMarkup(React.createElement(Actions, { lifecycle }));

test('both actual manual choices stay reachable inside the exact Goal startup gate', () => {
  const base = { tabId: 'T', engine: 'codex', kind: 'starting', goalOperationId: 'op', goalStartupPending: true };
  const result = projectCodexGoalLifecycle(base, owned, callbacks);
  assert.ok(result.goalActions, 'a startupPending flag cannot hide the exact Main-authorized Goal actions');
  assert.equal((render(result).match(/data-codex-goal-action=/g) || []).length, 2);
  assert.doesNotMatch(render(result), /disabled=/);
});

test('even the same Goal cannot override auth/usage/trust or another startup operation', () => {
  const base = { tabId: 'T', engine: 'codex', kind: 'starting', goalOperationId: 'op',
    goalStartupPending: true, goalControlsBlocked: true };
  assert.equal(projectCodexGoalLifecycle(base, owned, callbacks), base);
  const foreign = { ...base, goalControlsBlocked: false, goalOperationId: 'another-op' };
  assert.equal(projectCodexGoalLifecycle(foreign, owned, callbacks), foreign);
});

for (const action of ['resume', 'leave-paused']) test('automatic/manual pending shows progress on the chosen actual button: ' + action, () => {
  const result = projectCodexGoalLifecycle(null, { ...owned, action, policy: action, status: 'pending',
    pending: true, availableActions: [] }, callbacks);
  assert.equal(result.goalActions.pendingAction, action);
  const html = render(result);
  assert.match(html, /aria-busy="true"/); assert.match(html, /data-codex-goal-progress/);
  assert.match(html, /noted-infinite-animation/);
  assert.doesNotMatch(html, /data-codex-goal-read/);
});

test('unobserved automatic choice is a visible error, not dead buttons / refresh / confirmation vocabulary', () => {
  const goal = { ...owned, phase: 'confirming', status: 'unknown', pending: false,
    action: 'resume', reason: 'provider-result-unobserved', availableActions: [] };
  const result = projectCodexGoalLifecycle(null, goal, callbacks);
  assert.equal(result.kind, 'error');
  assert.match(result.description, /Не удалось.*Resume Goal/);
  assert.doesNotMatch(result.description, /подтвержд|статус/);
  assert.equal(result.goalActions.onRefresh, undefined);
  const html = render(result);
  assert.doesNotMatch(html, /data-codex-goal-read|data-codex-goal-action|aria-busy="true"/);
  assert.match(html, /data-agent-lifecycle-dismiss/);
  assert.equal(goal.status, 'unknown', 'presentation never changes the delivery/choice receipt');
});

test('a fresh Main-proven menu offers both recovery choices in the error; unknown receipt alone never does', () => {
  const result = projectCodexGoalLifecycle(null, { ...owned, status: 'unknown', action: 'leave-paused',
    recoveryAvailable: true }, callbacks);
  const html = render(result);
  assert.equal(result.kind, 'error');
  assert.equal((html.match(/data-codex-goal-action=/g) || []).length, 2);
  assert.doesNotMatch(html, /data-codex-goal-read|disabled=/);
});

function settingsFixture(stored, local = null) {
  const source = fs.readFileSync(base ? path.join(base, 'PRE-useUIStore.ts')
    : new URL('../store/useUIStore.ts', import.meta.url), 'utf8');
  const a = source.indexOf('const LS_KEY_CODEX_RESUME_GOAL ='), b = source.indexOf('const normalizePersistentCodexEffort', a);
  let release;
  const saved = [], updates = [], values = new Map(local === null ? [] : [['noted-terminal-codex-resume-paused-goal', local]]);
  const ctx = { module: { exports: {} }, APP_STATE_KEY_CODEX_RESUME_GOAL: 'codexResumePausedGoal',
    useUIStore: { setState: patch => updates.push(patch) },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    window: { require: () => ({ ipcRenderer: { invoke: (channel, payload) => {
      if (channel === 'app:getState') return new Promise(resolve => { release = () => resolve(stored); });
      saved.push({ channel, payload }); return Promise.resolve();
    } } }) } };
  const code = source.slice(a, b) + '\nmodule.exports={initialCodexResumePausedGoal,saveCodexResumePausedGoal}';
  vm.runInNewContext(transformSync(code, { loader: 'ts', format: 'cjs' }).code, ctx);
  return { api: ctx.module.exports, release: () => release(), saved, updates, values };
}
test('actual settings cache/persistence round-trip manual null and preserve both saved boolean choices', async () => {
  for (const configured of [null, true, false]) {
    const h = settingsFixture(configured, configured === null ? null : String(configured));
    assert.equal(h.api.initialCodexResumePausedGoal, configured);
    h.release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.updates.at(-1).codexResumePausedGoal, configured);
    h.api.saveCodexResumePausedGoal(null);
    assert.equal(h.saved.at(-1).payload.value, null);
    assert.equal(h.saved.at(-1).payload.key, 'codexResumePausedGoal');
  }
});
test('late settings hydration cannot replace a newer manual choice with automatic Resume', async () => {
  const h = settingsFixture(true, 'true'); h.api.saveCodexResumePausedGoal(null);
  h.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.updates.length, 0); assert.equal(h.values.get('noted-terminal-codex-resume-paused-goal'), 'null');
});
