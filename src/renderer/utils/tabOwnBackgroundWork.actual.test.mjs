// Run After / Loop must wait for the tab's OWN async Agent.
//
// Scar (15.10 class): a parent turn ends while its own subagent is still
// running. Auto-stop was repaired then; the prompt queue was not, so a queued
// card could be sent into a tab that was still working.
//
// These cases execute the REAL projection module. The runner wiring itself is
// asserted structurally at the end (the runner imports React and cannot be
// loaded under plain node).

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

import {
  applyTabBackgroundWorkRecord,
  initializeTabOwnBackgroundWork,
  resetTabOwnBackgroundWorkForTest,
  subscribeTabOwnBackgroundWork,
  tabOwnBackgroundWorkBlocks,
  tabOwnBackgroundWorkCount,
} from './tabOwnBackgroundWork.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerSource = fs.readFileSync(
  path.join(here, '..', 'hooks', 'usePromptQueueRunner.ts'),
  'utf8',
);

test.beforeEach(() => resetTabOwnBackgroundWorkForTest());

test('a live own agent blocks the next step; its end releases exactly once', () => {
  const seen = [];
  subscribeTabOwnBackgroundWork((event) => seen.push(event));

  applyTabBackgroundWorkRecord({ tabId: 'tab-a', count: 1, revision: 1 });
  assert.equal(tabOwnBackgroundWorkBlocks('tab-a'), true, 'live agent must block');
  assert.equal(tabOwnBackgroundWorkCount('tab-a'), 1);

  // A second concurrent agent is not a new transition for the subscriber.
  assert.equal(applyTabBackgroundWorkRecord({ tabId: 'tab-a', count: 2, revision: 2 }), false);
  assert.equal(tabOwnBackgroundWorkBlocks('tab-a'), true);

  assert.equal(applyTabBackgroundWorkRecord({ tabId: 'tab-a', count: 0, revision: 3 }), true);
  assert.equal(tabOwnBackgroundWorkBlocks('tab-a'), false, 'last agent gone → step allowed');
});

test('a stale record cannot resurrect or clear newer background work', () => {
  applyTabBackgroundWorkRecord({ tabId: 'tab-a', count: 0, revision: 8 });
  assert.equal(applyTabBackgroundWorkRecord({ tabId: 'tab-a', count: 1, revision: 7 }), false);
  assert.equal(tabOwnBackgroundWorkBlocks('tab-a'), false, 'older snapshot must not revive work');

  applyTabBackgroundWorkRecord({ tabId: 'tab-b', count: 1, revision: 4 });
  assert.equal(applyTabBackgroundWorkRecord({ tabId: 'tab-b', count: 0, revision: 2 }), false);
  assert.equal(tabOwnBackgroundWorkBlocks('tab-b'), true, 'older snapshot must not clear live work');
});

test('one tab background work never blocks another tab', () => {
  applyTabBackgroundWorkRecord({ tabId: 'tab-a', count: 1, revision: 1 });
  assert.equal(tabOwnBackgroundWorkBlocks('tab-b'), false);
  assert.equal(tabOwnBackgroundWorkBlocks(''), false);
});

test('restore adopts main counts for tabs that already have live agents', async () => {
  const requested = [];
  const channel = {
    on() {},
    invoke(name, args) {
      requested.push({ name, args });
      return Promise.resolve({
        records: [
          { tabId: 'tab-a', count: 2, revision: 11 },
          { tabId: 'tab-b', count: 0, revision: 11 },
        ],
      });
    },
  };
  global.window = { require: () => ({ ipcRenderer: channel }) };
  try {
    await initializeTabOwnBackgroundWork(['tab-a', 'tab-b', 'tab-a', '']);
    assert.deepEqual(requested[0].args.tabIds, ['tab-a', 'tab-b'], 'deduped, blanks dropped');
    assert.equal(tabOwnBackgroundWorkBlocks('tab-a'), true, 'reload mid-agent still blocks');
    assert.equal(tabOwnBackgroundWorkBlocks('tab-b'), false);
  } finally {
    delete global.window;
  }
});

test('a failed restore does not silently mark every tab idle', async () => {
  const channel = { on() {}, invoke: () => Promise.reject(new Error('unavailable')) };
  global.window = { require: () => ({ ipcRenderer: channel }) };
  try {
    applyTabBackgroundWorkRecord({ tabId: 'tab-a', count: 1, revision: 1 });
    await initializeTabOwnBackgroundWork(['tab-a']);
    assert.equal(tabOwnBackgroundWorkBlocks('tab-a'), true, 'known live work survives a failed read');
  } finally {
    delete global.window;
  }
});

test('background Bash/Monitor stays out of this gate', () => {
  // Main counts agents only; `taskCount` is deliberately excluded so a detached
  // `npm run dev` cannot hold a tab busy forever. Guard that boundary here too.
  applyTabBackgroundWorkRecord({ tabId: 'tab-a', count: 0, taskCount: 3, revision: 1 });
  assert.equal(tabOwnBackgroundWorkBlocks('tab-a'), false);
});

// Execute the REAL `isTabWorkflowBlocked` from the runner with the real
// projection module wired in — only store/runtime/IPC are controlled ports.
function gateFixture() {
  const declaration = (source, name) => {
    const tree = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
    const node = tree.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name);
    return node.getText(tree).replace(/^export /, '');
  };
  const code = ts.transpileModule(declaration(runnerSource, 'isTabWorkflowBlocked'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({
    console,
    tabOwnBackgroundWorkBlocks,
    hasPriorWorkflowInput: () => false,
    queueShutdownPending: false,
    queueManualStopping: new Set(),
    autoCompactCoordinator: null,
    capacityWorkflowBlocked: () => false,
    prevBusyRef: new Map(),
    isOrchestrationCompletionBlocked: () => false,
    isLoopOrchestrationBlocked: () => false,
    loopDependenciesBlock: () => false,
    messageLoopWaitsBlock: () => false,
    loopNaturalCausesByOwner: new Map(),
    loopPromptMode: () => 'all-work',
    promptTabTriggerReady: () => true,
    hasPendingAgentGoalWork: () => false,
    usePromptQueueStore: { getState: () => ({ getQueue: () => ({}) }) },
    useWorkspaceStore: { getState: () => ({ openProjects: new Map() }) },
  });
  vm.runInContext(code, context);
  return context;
}

test('actual runner gate refuses the next step while an own agent runs', () => {
  const gate = gateFixture();
  assert.equal(gate.isTabWorkflowBlocked('tab-a'), false, 'idle tab is not blocked');

  applyTabBackgroundWorkRecord({ tabId: 'tab-a', count: 1, revision: 1 });
  assert.equal(gate.isTabWorkflowBlocked('tab-a'), true,
    'parent final + live own agent must NOT release the queue');
  assert.equal(gate.isTabWorkflowBlocked('tab-b'), false, 'a neighbour tab stays free');

  applyTabBackgroundWorkRecord({ tabId: 'tab-a', count: 0, revision: 2 });
  assert.equal(gate.isTabWorkflowBlocked('tab-a'), false, 'agent finished → step allowed');
});

test('runner consults the gate, defers the outcome and replays it on release', () => {
  assert.match(
    runnerSource,
    /import \{ initializeTabOwnBackgroundWork, subscribeTabOwnBackgroundWork, tabOwnBackgroundWorkBlocks \} from '\.\.\/utils\/tabOwnBackgroundWork\.mjs';/,
  );
  // The step gate and both continuation predicates.
  assert.equal(
    (runnerSource.match(/tabOwnBackgroundWorkBlocks\(/g) || []).length,
    4,
    'gate must cover isTabWorkflowBlocked, both pending-continuation checks and the defer',
  );
  // The outcome is preserved, not dropped.
  assert.match(runnerSource, /has own background work → DEFER workflow outcome/);
  assert.match(
    runnerSource,
    /processSuccessfulWorkflowOutcome\(deferred\.data, deferred\.source \+ '-own-background-done', deferred\.outcomeTs\)/,
    'replay must reuse the ORIGINAL outcome timestamp, not the release time',
  );
  assert.match(runnerSource, /unsubscribeOwnBackgroundWork\(\);/, 'subscription must be cleaned up');
});
