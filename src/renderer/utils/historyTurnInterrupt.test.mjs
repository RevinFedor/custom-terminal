import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createRequire } from 'node:module';
import { canInterruptHistoryTurn, requestHistoryTurnInterrupt } from './historyTurnInterrupt.mjs';

const require = createRequire(import.meta.url);
const { createCodexTurnInterrupt } = require('../../main/codex-turn-interrupt');
const { createClaudeTurnInterrupt } = require('../../main/claude-turn-interrupt');
const source = readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const runAction = useCallback(');
const body = source.slice(start + '  const runAction = useCallback('.length,
  source.indexOf('    const recordWithoutReply =', start));
const interruptActionSource = transformSync('const action = ' + body + '\nthrow new Error("entered send lane");\n};', { loader: 'ts' }).code + '\naction';

for (const [provider, createInterrupt] of [['codex', createCodexTurnInterrupt], ['claude', createClaudeTurnInterrupt]]) {
  for (const queuedCount of [0, 1, 3]) for (const confirming of [true, false]) {
    test(`${provider}: Escape with ${queuedCount} queued messages, confirming=${confirming}, never waits for History or stops a successor`, async () => {
      const snapshot = { terminal: {}, busy: true, inputReady: true, stopping: false,
        turnId: 'turn-A', runSeq: 1, lifecycleGeneration: 'pty-A', launchGeneration: 'launch', processId: 42 };
      const writes = [], pending = [], errors = [];
      const receipts = Array.from({ length: queuedCount }, (_, id) => ({ id, status: confirming ? 'audit-pending' : 'queued' }));
      let releaseHistory;
      const history = new Promise(resolve => { releaseHistory = resolve; });
      const interrupt = createInterrupt({ getSnapshot: () => snapshot,
        withWriteLock: async (_term, work) => work(),
        writeEscape: () => {
          writes.push('Escape');
          // Provider starts queued work BEFORE the renderer sees the IPC result.
          if (queuedCount) snapshot.turnId = 'turn-B';
          else snapshot.busy = false;
        },
      });
      const slot = { current: null };
      const run = vm.runInNewContext(interruptActionSource, {
        requestHistoryTurnInterrupt, interruptRequestRef: slot,
        presenceOwnerKey: 'T:codex', presenceOwnerKeyRef: { current: 'T:codex' },
        setInterruptRequestPending: value => pending.push(value), historyDiag() {},
        tabId: 'T', statusRef: { current: 'busy' }, midstreamPromptRecoveryRef: { current: { handoffId: 'B' } },
        getCoordinatedAgentAction: () => ({ kind: 'send', confirming }),
        runtime: { interruptTurn: interrupt }, reportError: error => errors.push(error),
        refreshPresence: () => history,
        actionInFlightRef: { current: true }, // actual branch must precede this shared Send lock
      });
      const result = await run('interrupt');
      assert.equal(result.success, true);
      assert.deepEqual(pending, [true, false]);
      assert.deepEqual(writes, ['Escape']);
      assert.equal(snapshot.busy, queuedCount > 0);
      assert.deepEqual(receipts.map(item => item.status), Array(queuedCount).fill(confirming ? 'audit-pending' : 'queued'),
        'a successor is not delivery proof for any individual message');
      assert.equal(errors.length, 0);
      releaseHistory();
    });
  }
}

test('Escape request queued after paste cannot interrupt a different turn that already started', async () => {
  const snapshot = { terminal: {}, busy: true, inputReady: true, turnId: 'A', runSeq: 1, lifecycleGeneration: 'G' };
  let writeBoundary, writes = 0;
  const interrupt = createCodexTurnInterrupt({ getSnapshot: () => snapshot,
    withWriteLock: (_term, work) => new Promise(resolve => { writeBoundary = () => resolve(work()); }),
    writeEscape: () => writes++,
  });
  const work = interrupt('T');
  snapshot.turnId = 'B';
  writeBoundary();
  assert.equal((await work).skipped, 'target-turn-changed');
  assert.equal(writes, 0);
});

test('rapid duplicate request shares only its own IPC, not the Send or delivery wait', async () => {
  const slot = { current: null }, pending = [];
  let finish, calls = 0;
  const args = { slot, ownerKey: 'T', currentOwner: () => 'T',
    request: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    onPending: value => pending.push(value), onResult() {}, onError() {}, refresh() {},
  };
  const first = requestHistoryTurnInterrupt(args), duplicate = requestHistoryTurnInterrupt(args);
  assert.equal(first, duplicate);
  await Promise.resolve(); finish({ success: true }); await first;
  assert.equal(calls, 1); assert.deepEqual(pending, [true, false]);
});

test('a late IPC result cannot clear another tab request or its current busy state', async () => {
  let currentOwner = 'A', finish;
  const slot = { current: null }, pending = [];
  const work = requestHistoryTurnInterrupt({ slot, ownerKey: 'A', currentOwner: () => currentOwner,
    request: () => new Promise(resolve => { finish = resolve; }),
    onPending: value => pending.push(value), onResult: () => assert.fail('stale result'), onError: () => assert.fail('stale error'),
    refresh: () => assert.fail('stale refresh'),
  });
  await Promise.resolve(); currentOwner = 'B'; const replacement = { ownerKey: 'B' }; slot.current = replacement;
  finish({ success: true }); await work;
  assert.equal(slot.current, replacement); assert.deepEqual(pending, [true]);
});

test('availability permits Escape during Send confirmation but preserves stop, modal and Rewind guards', () => {
  assert.equal(canInterruptHistoryTurn({ status: 'busy', busyAction: 'send' }), true);
  for (const change of [{ stopping: true }, { answeringQuestion: true }, { pendingQuestion: true }, { rewindLocked: true },
    { interruptPending: true }, { recordWithoutReply: true }, { busyAction: 'stop' }, { status: 'active' }, { status: 'starting' }]) {
    assert.equal(canInterruptHistoryTurn({ status: 'busy', busyAction: 'send', ...change }), false);
  }
  assert.doesNotMatch(source, /interruptAwaitRef|interruptAwaiting|Waiting for.*stop record and restored prompt/);
  assert.match(source, /const isCancellingTurn = interruptRequestPending/);
  assert.match(source, /midstreamPromptRecoveryRef\.current === pending/);
  assert.match(source, /interruptRecoveryInFlightRef\.current\.has\(pending\.handoffId\)/);
});
