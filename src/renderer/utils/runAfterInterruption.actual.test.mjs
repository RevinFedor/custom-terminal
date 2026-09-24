import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { isRecoverableAgentTurnInterruption } from './agentCompletionOutcome.mjs';

const source = fs.readFileSync(new URL('../hooks/usePromptQueueRunner.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('runner.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(n => ts.isFunctionDeclaration(n)
  && n.name?.text === 'applyAbnormalQueueOutcome').getText(ast);
const compiled = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const disarms = [], toasts = [];
  const store = { queues: new Map([['own', {}], ['pivot', {}]]),
    disarmQueuesForTrigger(...args) { disarms.push(args); return ['own']; } };
  const context = vm.createContext({
    queueShutdownPending: false, usePromptQueueStore: { getState: () => store },
    queueAppRuntimeInstanceId: 'main-fixture', queueAppRuntimeStartedAt: 100,
    tabExists: () => true, isRecoverableAgentTurnInterruption,
    explicitOutcomeTimestamp: data => data.outcomeTs,
    shortQueueTabId: id => id, getTabName: () => 'fixture',
    getPromptQueueAgent: () => 'codex', getPromptQueueSessionId: () => 'session',
    buildRunAfterIncidentReport: data => JSON.stringify(data),
    useUIStore: { getState: () => ({ showToast: (...args) => toasts.push(args) }) },
    console: { log() {} },
  });
  vm.runInContext(compiled, context);
  return { disarms, toasts, apply: (reason, source = 'codex-live') =>
    context.applyAbnormalQueueOutcome({ tabId: 'own', reason, outcomeTs: 200 }, source) };
}

test('manual Escape still disarms one-shot Run after but does not create a warning or incident on live/restore', () => {
  for (const reason of ['turn_aborted', 'rollout-turn_aborted', 'interrupt']) {
    for (const source of ['codex-live', 'claude-live', 'restore']) {
      const h = harness();
      assert.equal(h.apply(reason, source).length, 1);
      assert.equal(h.toasts.length, 0, reason + '/' + source);
      assert.equal(h.disarms.length, 1);
      const [trigger, at, options] = h.disarms[0];
      assert.equal(trigger, 'own'); assert.equal(at, 200);
      assert.equal(options.preserveLoop, true);
      assert.equal(options.preservePivoted, true);
      assert.equal(options.explicitStop, false);
    }
  }
});

test('provider error, missing final, watchdog and unknown reasons still create exact persistent warnings', () => {
  for (const reason of ['provider_error', 'error', 'codex-no-final-result', 'watchdog', 'unknown', 'interrupted-error']) {
    const h = harness(); h.apply(reason);
    assert.equal(h.toasts.length, 1, reason);
    assert.equal(h.disarms[0][2].preservePivoted, false);
    const toast = h.toasts[0];
    assert.equal(toast[1], 'warning'); assert.equal(toast[2], 0);
    assert.equal(JSON.parse(toast[4]).reason, reason);
    assert.equal(JSON.parse(toast[4]).sessionId, 'session');
  }
});
