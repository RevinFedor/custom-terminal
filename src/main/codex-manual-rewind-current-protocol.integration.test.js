'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rewind = require('./codex-manual-rewind');
const { hashCodexRewindTargetText } = require('./codex-rewind-target-proof');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
function actual(name) {
  const start = main.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert(start >= 0, name);
  return main.slice(start, main.indexOf('\n}\n', start) + 3);
}

// Production 23.09 23:09 UTC / tab4196: CodexOverlayStyle captured this exact
// normalized footer at 61 columns. The title completes the existing main
// geometry proof; no prompt text is used to choose the target.
function snapshot(footer = 'q close esc/← to edit prev → to edit next enter to edi') {
  return {
    success: true, rows: 60, cols: 61, writeSeq: 10, flushedSeq: 10,
    mirrorGeneration: 'mirror',
    lines: [
      { row: 1757, text: '/ T R A N S C R I P T / / / / / / /' },
      { row: 1814, text: '↑/↓ to scroll pgup/pgdn to page home/end to jump' },
      { row: 1815, text: footer, occupiedEndX: 61 },
    ],
  };
}

function harness(frame = snapshot()) {
  let revision = 1;
  let journal = null;
  let available = true;
  const writes = [];
  const cancellations = [];
  const sourceMessages = ['first prompt', 'second prompt'].map((text, i) => ({
    uuid: 'user-' + i, physicalSessionId: 'source', sourceLine: i + 10,
    text, textHash: hashCodexRewindTargetText(text), branchable: true,
  }));
  const state = { actionGeneration: 'rewind-action', sourceSessionId: 'source',
    ownedInputRevision: 1, ownedControlCount: 1, navigationOlderSteps: 0, sourceMessages };
  const observer = { sourceMode: 'writer-handoff', manualRewind: state };
  const term = { write(bytes) {
    assert(journal, 'durable target journal must precede destructive Enter');
    writes.push(bytes);
  } };
  const context = {
    ...rewind, console: { log() {}, warn() {} },
    codexWatchers: { get: () => available ? observer : null },
    codexTurnWatchers: { get: () => ({ busy: false }) },
    terminalCommandState: { get: () => ({ isRunning: true, runSeq: 1 }) },
    terminalProjects: { get: () => '/fixture' },
    getHeadlessVisibleBufferSnapshot: () => frame,
    getTerminalInputRevision: () => revision,
    hasCodexPromptOrTurnInFlight: () => false,
    cancelCodexWriterHandoffBeforeAction: (_tab, reason) => { cancellations.push(reason); available = false; },
    withPtyWriteLock: async (_term, run) => run(),
    flushHeadlessTerminalMirror: async () => ({ success: true }),
    transcriptService: { captureCodexRewindSourceSnapshot: async () => ({ snapshotComplete: true }) },
    markCodexWriterHandoffActionBoundary: (_tab, _at, target) => { journal = target; return true; },
    buildManualCodexRewindCommitExpectation: () => ({ actionGeneration: state.actionGeneration }),
    createManualCodexRewindRestoredComposerWait: () => ({ cancel() {} }),
    clearCodexPromptInFlight() {}, markActivePtySubmit() {},
    reconcileManualCodexRewindAfterEnter: async () => {},
    broadcastManualCodexRewindBlocked() {},
  };
  const methods = vm.runInNewContext([
    actual('trackManualCodexRewindNavigationInput'),
    actual('handleManualCodexRewindConfirmationEnter'),
    '({trackManualCodexRewindNavigationInput, handleManualCodexRewindConfirmationEnter})',
  ].join('\n'), context);
  return {
    state, sourceMessages, writes, cancellations, frame,
    get journal() { return journal; },
    dropObserver() { available = false; },
    async input(bytes) {
      const before = revision++;
      methods.trackManualCodexRewindNavigationInput('T', bytes, { inputRevisionBefore: before });
      if (bytes === '\r') return methods.handleManualCodexRewindConfirmationEnter('T', term, bytes);
    },
  };
}

test('actual manual Rewind retains current q-close navigation and journals before one Enter', async () => {
  const h = harness();
  await h.input('\x1b[D');
  assert.deepEqual(h.cancellations, []);
  assert.equal(h.state.navigationOlderSteps, 1);
  await h.input('\x1b[C');
  assert.equal(h.state.navigationOlderSteps, 0);
  const result = await h.input('\r');
  assert.equal(result.submitted, true);
  assert.equal(h.journal.targetUuid, 'user-1');
  assert.equal(h.journal.targetSourceLine, 11);
  assert.deepEqual(h.writes, ['\r']);
});

test('partial native chrome cannot become ordinary Enter after its observer is lost', async () => {
  const h = harness(snapshot('q close esc/← to edit prev → to edit next'));
  h.dropObserver();
  const result = await h.input('\r');
  assert.equal(result.handled, true);
  assert.equal(result.submitted, false);
  assert.equal(result.error, 'rewind-frame-incomplete');
  assert.deepEqual(h.writes, []);
});

test('current footer does not bypass target branchability or turn selection', async () => {
  const h = harness();
  h.sourceMessages[1].branchable = false;
  const result = await h.input('\r');
  assert.equal(result.error, 'selected-prompt-not-branchable');
  assert.deepEqual(h.writes, []);
  assert.equal(h.journal, null);
});

test('ordinary composer still has zero-wait passthrough and no Rewind journal', async () => {
  const h = harness({ success: true, lines: [{ row: 1, text: '› ordinary prompt' }] });
  h.dropObserver();
  const result = await h.input('\r');
  assert.equal(result.handled, false);
  assert.equal(h.journal, null);
});

test('both exact close labels and clipped prefixes retain geometry and negative controls', () => {
  for (const close of ['q to quit', 'q close']) {
    for (const end of ['enter to edit message', 'enter to edi', 'enter']) {
      const frame = snapshot(close + ' esc/← to edit prev → to edit next ' + end);
      assert.equal(rewind.classifyManualCodexEnterFrame(frame).kind, 'native-rewind-confirm');
      const noTitle = structuredClone(frame);
      noTitle.lines.shift();
      assert.equal(rewind.classifyManualCodexEnterFrame(noTitle).proven, false);
      const separatedFooters = structuredClone(frame);
      separatedFooters.lines[2].row += 2;
      assert.equal(rewind.classifyManualCodexEnterFrame(separatedFooters).proven, false);
      if (end !== 'enter to edit message') {
        const noPhysicalClip = structuredClone(frame);
        noPhysicalClip.lines[2].occupiedEndX = 20;
        assert.equal(rewind.classifyManualCodexEnterFrame(noPhysicalClip).proven, false);
      }
    }
  }
  const foreign = snapshot('q close esc/← to edit previous → to edit next enter to edi');
  assert.equal(rewind.classifyManualCodexEnterFrame(foreign).proven, false);
});
