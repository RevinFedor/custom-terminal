'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const parser = require('./claude-trust-folder-state');
const { waitForCommittedSemanticFrame } = require('./committed-semantic-frame-wait');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ownerSource = main.slice(main.indexOf('async function handleClaudeTrustFolderPrompt('),
  main.indexOf('function clearClaudeConfirmDialogCooldown('));
const header = [
  'Accessing workspace:', '/Users/example/Desktop/voice-record', '',
  'Quick safety check: Is this a project you created or one',
  'you trust? (Like your own code, a well-known open source',
  "Claude Code'll be able to read, edit, and execute files", 'here.',
  'Security guide', '',
];
function harness(options = {}) {
  const tabId = 'trust-test-tab';
  const mirror = { synchronizedFrameWaiters: new Set(), failed: false };
  let inputRevision = 0;
  let lifecycle = 'lifecycle';
  let sequence = 10;
  let context;
  const writes = [], ready = [], timers = new Set();
  const rows = selected => options.legacy
    ? [selected === 'yes' ? '❯ 1. Yes, I trust this folder' : '  1. Yes, I trust this folder',
      selected === 'no' ? '❯ 2. No, exit' : '  2. No, exit']
    : [selected === 'no' ? '❯ No, exit' : '  No, exit',
      selected === 'yes' ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder'];
  const frame = selected => ({ success: true, authoritativeFrameCommitted: true,
    liveSynchronizedOutputOpen: false, writeSeq: ++sequence, flushedSeq: sequence,
    lines: (selected === 'composer' ? ['❯'] : header.concat(rows(selected)))
      .map(text => ({ text })),
  });
  let current = frame(options.selected || 'no');
  const publish = selected => {
    current = frame(selected);
    context.observeClaudeTrustFolderPromptCommittedFrame(tabId, mirror, current, sequence);
    for (const listener of [...mirror.synchronizedFrameWaiters]) listener();
  };
  const term = { write(data) {
    writes.push(data);
    if (data === '\r') { publish('composer'); return; }
    assert.ok(data === '\x1b[A' || data === '\x1b[B', 'no paste or unrelated control');
    if (options.change === 'input') inputRevision += 1;
    if (options.change === 'run') context.terminalCommandState.set(tabId, { runSeq: 2 });
    if (options.change === 'launch') context.claudeLaunchGenerationByTab.set(tabId, { generation: 'other' });
    if (options.change === 'lifecycle') lifecycle = 'other';
    if (options.change === 'terminal') context.terminals.set(tabId, {});
    if (options.noNewFrame) {
      queueMicrotask(() => { for (const timer of [...timers]) timer(); });
      return;
    }
    publish('yes');
    if (options.flipAfterYes) publish('no');
    if (options.openAfterYes) current = { ...current, authoritativeFrameCommitted: false, liveSynchronizedOutputOpen: true };
  } };
  context = vm.createContext({
    ...parser,
    console: { log() {}, warn() {} }, Date, Promise,
    terminals: new Map([[tabId, term]]),
    claudeLaunchGenerationByTab: new Map(options.unowned ? [] : [[tabId, { generation: 'launch' }]]),
    terminalCommandState: new Map([[tabId, { runSeq: 1 }]]),
    claudeTrustFolderPromptFired: new Map(), claudeTrustFolderPromptInflight: new Map(),
    claudeTrustFolderPromptHintTabs: new Set(), claudeTrustFolderPromptHintBuffers: new Map(),
    claudePromptReady: new Set(), claudePromptStability: { markActivity() {} },
    claudeCtrlCDangerZone: new Set(),
    looksLikeClaudeAutoModeDefaultPromptText: () => false,
    looksLikeClaudeRewindMenuText: () => false,
    classifyClaudeSettingsDialogText: () => null,
    parseClaudeComposerCurrentFrame: snapshot => snapshot.lines.length === 1 ? { proofOutcome: 'absent' } : null,
    publishClaudePromptReady: () => ready.push('ready'),
    getHeadlessTerminalMirror: () => mirror,
    getTerminalLifecycleGeneration: () => lifecycle,
    getTerminalInputRevision: () => inputRevision,
    bumpTerminalInputRevision: () => ++inputRevision,
    waitForHeadlessSynchronizedOutputClose: async () => ({ ready: true }),
    getHeadlessVisibleBufferSnapshot: () => current,
    recordComposerForensicPtyInput() {},
    withPtyWriteLock: async (_term, callback) => callback(),
    waitForCommittedSemanticFrame: args => waitForCommittedSemanticFrame({ ...args,
      setTimer(callback) { timers.add(callback); return callback; },
      clearTimer(callback) { timers.delete(callback); },
    }),
  });
  vm.runInContext(ownerSource, context);
  return { context, writes, ready, mirror, publish,
    async run() {
      context.observeClaudeTrustFolderPromptCommittedFrame(tabId, mirror, current, sequence);
      return await context.claudeTrustFolderPromptInflight.get(tabId);
    },
  };
}

for (const legacy of [false, true]) {
  test(`${legacy ? 'old numbered' : 'incident unnumbered/reversed'} No → selected Yes → one Enter → composer`, async () => {
    const h = harness({ legacy });
    const result = await h.run();
    assert.equal(result.reason, 'trust_folder_confirmed');
    assert.equal(result.dismissed, true);
    assert.deepEqual(h.writes, [legacy ? '\x1b[A' : '\x1b[B', '\r']);
    assert.deepEqual(h.ready, ['ready']);
    assert.equal(h.mirror.synchronizedFrameWaiters.size, 0);
    h.publish('no'); // stale Ink redraw cannot restart an already written operation
    assert.equal(h.writes.length, 2);
  });
}

test('already selected Yes gets one Enter and no arrow', async () => {
  const h = harness({ selected: 'yes' });
  assert.equal((await h.run()).dismissed, true);
  assert.deepEqual(h.writes, ['\r']);
});

for (const change of ['input', 'run', 'launch', 'lifecycle', 'terminal']) {
  test(`${change} changes during selection: no confirming Enter and no false ready`, async () => {
    const h = harness({ change });
    const result = await h.run();
    assert.equal(result.submitted, false);
    assert.deepEqual(h.writes, ['\x1b[B']);
    assert.deepEqual(h.ready, []);
    assert.equal(h.mirror.synchronizedFrameWaiters.size, 0);
  });
}

for (const options of [{ noNewFrame: true }, { flipAfterYes: true }, { openAfterYes: true }]) {
  test(`selection requires the current committed Yes, not an earlier frame: ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    const result = await h.run();
    assert.equal(result.submitted, false);
    assert.deepEqual(h.writes, ['\x1b[B']);
    assert.deepEqual(h.ready, []);
  });
}

test('unknown selection and an unmanaged terminal never auto-select trust', async () => {
  for (const options of [{ selected: 'unknown' }, { unowned: true }]) {
    const h = harness(options);
    assert.equal(await h.run(), undefined);
    assert.deepEqual(h.writes, []);
  }
});
