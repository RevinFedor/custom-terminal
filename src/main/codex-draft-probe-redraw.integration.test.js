'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexDraftRequestHarness, drainMicrotasks } = require('./fixtures/codex-draft-request-observation.cjs');

test('4196 frame-order control: stale transcript row waits for current composer without becoming empty proof', async () => {
  let complete = false;
  const h = createCodexDraftRequestHarness({ getDraft: () => ({ success: true,
    hasDraft: complete ? false : null, preview: '', source: 'headless-main',
    frameBlocker: complete ? null : 'synchronized-output-open',
    frameIdentity: { generation: 'G1', writeSeq: complete ? 5133 : 5132 } }) });
  let finished = false;
  const pending = h.read('4196-ordered-control', { waitFor: false, waitOnUnknownOnly: true })
    .then(result => { finished = true; return result; });
  await drainMicrotasks();
  h.replyRenderer({ hasDraft: true, preview: 'Working context changed',
    source: 'cursor:5051:multiline-draft-row-5054', frameIdentity: { generation: 'G1', writeSeq: 5031 } });
  await drainMicrotasks();
  assert.equal(finished, false, 'stale positive cannot finish current unknown observation');
  complete = true;
  h.notifyFrame();
  const result = await pending;
  assert.equal(result.hasDraft, false);
  assert.equal(result.rendererPositiveIgnored, 'renderer-frame-behind');
  assert.equal(h.reports.length, 0, 'explained same-generation catch-up is not a heavy incident');
});

async function drainUntil(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await drainMicrotasks(20);
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), message || 'expected observation checkpoint was not reached');
}

function proofFor({ phase, writeSeq, generation = 'G1' }) {
  if (phase === 'partial') {
    return {
      success: true,
      hasDraft: null,
      source: 'headless-main:frame-not-authoritative',
      frameBlocker: 'synchronized-output-open',
      frameState: {
        generation, writeSeq, flushedSeq: writeSeq,
        synchronizedOutputOpen: true, pendingResizeWriteSeq: null,
      },
    };
  }
  return {
    success: true,
    hasDraft: phase === 'draft',
    source: `headless-main:cursor:${phase === 'draft' ? '10:draft' : '10:dim-hint'}`,
    preview: phase === 'draft' ? 'new manual draft' : '',
    frameIdentity: { generation, writeSeq },
  };
}

function fixture({ initiallyPartial = false, rendererAvailable = true } = {}) {
  let phase = initiallyPartial ? 'partial' : 'empty';
  let writeSeq = initiallyPartial ? 30 : 31;
  let currentGeneration = 'G1';
  const mirror = { generation: 'G1', generationOrdinal: 1, complete: true,
    synchronizedFrameWaiters: new Set() };
  const frameReads = [];
  const h = createCodexDraftRequestHarness({
    mirror,
    rendererAvailable,
    getDraft: (_reason, currentMirror) => {
      frameReads.push({ generation: currentMirror.generation, phase, writeSeq });
      return proofFor({ phase, writeSeq, generation: currentMirror.generation });
    },
  });
  return {
    ...h,
    get rendererRequest() { return h.rendererRequest; },
    frameReads,
    read() {
      return h.read('codex-pre-submit-before-paste', {
        waitFor: false,
        waitTimeoutMs: 1000,
        waitOnUnknownOnly: true,
        mergeRendererPositive: true,
      });
    },
    replyDuringRedraw() {
      assert.ok(h.rendererRequest, 'one renderer hint is requested for this observation');
      phase = 'partial';
      writeSeq = 67;
      h.replyRenderer({ frameIdentity: { generation: currentGeneration, writeSeq: 31 } });
    },
    complete(nextPhase = 'empty', nextWriteSeq = 68) {
      phase = nextPhase;
      writeSeq = nextWriteSeq;
      h.notifyFrame(mirror);
    },
    replace() {
      const replacement = { generation: 'G2', generationOrdinal: 2, complete: true,
        synchronizedFrameWaiters: new Set() };
      currentGeneration = 'G2';
      h.setCurrentMirror(replacement);
      h.notifyFrame(mirror);
    },
  };
}

test('actual request: empty31 → renderer await → open67 waits for closed68 within one observation budget', async () => {
  const h = fixture();
  let calls = 0;
  const pending = (() => { calls++; return h.read(); })();
  await drainMicrotasks();
  assert.ok(h.rendererRequest, 'the initial empty proof asks the renderer for one conservative hint');
  h.clock.advance(88);
  h.replyDuringRedraw();
  await drainUntil(() => h.frameReads.some(frame => frame.writeSeq === 67),
    'request rereads the current partial frame after renderer response');

  assert.equal(calls, 1);
  assert.equal(h.clock.now(), 1088);
  assert.equal(h.clock.setCalls.length, 2, 'one observation deadline and one renderer hint deadline');
  assert.equal(h.clock.timers.size, 1, 'the renderer timer is removed; the original observation deadline remains');
  assert.equal(h.clock.setCalls[0].delayMs, 1000, 'no new proof-wait budget was minted');

  h.complete();
  await drainMicrotasks();
  const result = await pending;
  assert.equal(result.hasDraft, false);
  assert.equal(result.frameIdentity.writeSeq, 68, 'the old empty31 proof is not reused');
  assert.equal(result.observation.status, 'settled');
  assert.equal(h.reports.length, 0);
  assert.equal(calls, 1, 'the committed frame resolves the same request; it does not send again');
  assert.deepEqual(h.frameReads.map(frame => frame.writeSeq), [31, 67, 68],
    'initial proof, changed partial frame, and current committed frame are read in order');
});

test('actual request protects a genuine draft arriving during the redraw', async () => {
  const h = fixture();
  const pending = h.read();
  await drainMicrotasks();
  h.replyDuringRedraw();
  await drainUntil(() => h.frameReads.some(frame => frame.writeSeq === 67));
  h.complete('draft');
  await drainMicrotasks();

  const result = await pending;
  assert.equal(result.hasDraft, true);
  assert.equal(result.preview, 'new manual draft');
  assert.equal(result.frameIdentity.writeSeq, 68);
});

test('actual request refuses owner change during the redraw wait, despite the earlier empty proof', async () => {
  const h = fixture();
  const pending = h.read();
  await drainMicrotasks();
  h.replyDuringRedraw();
  await drainUntil(() => h.frameReads.some(frame => frame.writeSeq === 67));
  h.replace();
  await drainMicrotasks();

  const result = await pending;
  assert.equal(result.hasDraft, null);
  assert.equal(result.success, false);
  assert.equal(result.observation.status, 'superseded');
  assert.equal(result.source, 'headless-main:codex:observation-superseded');
  assert.equal(h.reports.length, 0, 'a revoked owner cannot publish a frame incident from its stale proof');
});

test('actual request revokes the wait when input ownership changes but the mirror itself stays the same', async () => {
  const h = fixture();
  const pending = h.read();
  await drainMicrotasks();
  h.replyDuringRedraw();
  await drainMicrotasks();
  h.setOwner({ inputRevision: 2 });
  h.notifyFrame(h.mirror);
  await drainMicrotasks();

  const result = await pending;
  assert.equal(result.hasDraft, null);
  assert.equal(result.success, false);
  assert.equal(result.observation.status, 'superseded');
  assert.equal(h.reports.length, 0);
});

test('actual request expires on the original deadline and keeps the new frame unknown', async () => {
  const h = fixture();
  const pending = h.read();
  await drainMicrotasks();
  h.clock.advance(88);
  h.replyDuringRedraw();
  await drainUntil(() => h.frameReads.some(frame => frame.writeSeq === 67));
  assert.equal(h.clock.timers.size, 1, 'no second wait timer exists');

  h.clock.advance(912);
  await drainMicrotasks();
  const result = await pending;
  assert.equal(result.hasDraft, null);
  assert.equal(result.frameBlocker, 'synchronized-output-open');
  assert.equal(result.frameState.writeSeq, 67);
  assert.equal(result.timedOut, true);
  assert.equal(result.observation.budgetMs, 1000);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].payload.context.mainProof.frameState.writeSeq, 67);
});

test('actual request spends the renderer wait inside the original deadline, not as a fresh proof budget', async () => {
  const h = fixture({ initiallyPartial: true });
  const pending = h.read();
  await drainMicrotasks();
  assert.ok(h.rendererRequest, 'the one renderer hint starts from the initial unknown frame');

  h.clock.advance(650);
  h.replyDuringRedraw();
  await drainUntil(() => h.frameReads.some(frame => frame.writeSeq === 67));
  assert.equal(h.clock.now(), 1650);
  assert.equal(h.clock.timers.size, 1, 'only the original 1000ms observation timer remains');
  assert.equal(h.clock.setCalls[0].delayMs, 1000);

  h.clock.advance(349);
  await drainMicrotasks();
  assert.equal(h.clock.timers.size, 1, 'deadline has not been renewed after renderer await');
  h.clock.advance(1);
  await drainMicrotasks();
  const result = await pending;
  assert.equal(result.hasDraft, null);
  assert.equal(result.timedOut, true);
  assert.equal(result.observation.elapsedMs, 1000);
  assert.equal(h.clock.timers.size, 0);
});

test('actual request with no foreground renderer still settles from a current main frame event', async () => {
  const h = fixture({ initiallyPartial: true, rendererAvailable: false });
  const pending = h.read();
  await drainUntil(() => h.frameReads.length > 0);
  assert.equal(h.rendererRequest, null, 'background proof does not request a foreground renderer');

  h.complete('empty', 68);
  await drainMicrotasks();
  const result = await pending;
  assert.equal(result.hasDraft, false);
  assert.equal(result.frameIdentity.writeSeq, 68);
  assert.equal(result.observation.status, 'settled');
});
