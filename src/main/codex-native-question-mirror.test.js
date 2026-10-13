'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { Terminal } = require('@xterm/headless');
const { inspectCodexNativeQuestions, createCodexNativeQuestionMirror } = require('./codex-native-question-mirror');
const { parseCodexVerifiedComposerFooter } = require('./codex-tui-readiness');
const { extractCodexQueuedMessageProofs } = require('./terminal-history-preview');
const { codexQueuedMessageMatchesAudit } = require('./codex-queued-message-proof');

// Text copied from official rust-v0.159.2 / rust-v0.162.0 snapshots.
// Committed metadata and cell styles are controlled fixtures, not CLI acceptance.
const wrappedOther = {
  ascii: '\n  Second\n\n    1. A suggested answer that is\n       long enough to wrap across\n       multiple rows\n  › 2. An alternative answer that\n       wraps across several option\n       rows\n\n  enter submit   ctrl+] skip\n  shift+→ main prompt',
  mac: '\n  Second\n\n    1. A suggested answer that is\n       long enough to wrap across\n       multiple rows\n  › 2. An alternative answer that\n       wraps across several option\n       rows\n\n  enter submit   ⌃] skip\n  ⇧→ main prompt',
};
const formats = {
  ascii: { skip: 'ctrl+]', back: 'shift+→', open: 'shift+←' },
  mac: { skip: '⌃]', back: '⇧→', open: '⇧←' },
};
const dim = { firstTextStyle: 'fg=1:8,bg=0:-1,dim', hasDim: true, allTextDim: true, hasNonDefaultFg: true };
function frame(text, { title = 'Second', seq = 10, cursorRow = 3, ...overrides } = {}) {
  const lines = text.split('\n').map((text, row) => ({ row, text, wrapped: false, ...dim }));
  for (const line of lines) {
    if (line.text.trim() === title) Object.assign(line, { hasNonDefaultBg: true,
      firstTextStyle: 'fg=1:5,bg=1:0,bold', hasDim: false, allTextDim: false });
    if (/^\s*\? \d+ questions?/.test(line.text)) line.allTextDim = false;
  }
  return { success: true, source: 'headless-main', authoritativeFrameCommitted: true,
    baseY: 0, cursorY: cursorRow, writeSeq: seq, flushedSeq: seq, lines, ...overrides };
}
function expanded(form, { progress = '', footerWrapped = false, free = false, title = 'Second' } = {}) {
  const h = formats[form];
  const footer = footerWrapped ? `  enter submit\n  ${h.skip} skip` : `  enter submit   ${h.skip} skip`;
  return [progress, '  ' + title, '', free ? '  Type your answer' : '  › 1. First\n    2. Other (write an answer)', '',
    footer, `  ${h.back} ${progress ? 'prev question' : 'main prompt'}`,
    progress ? `  ${h.open} next question` : ''].join('\n');
}
function collapsed(form, count = 2) {
  return `• Queued follow-up inputs\n\n  ? ${count} question${count === 1 ? '' : 's'} · 15s\n    ${formats[form].open} to answer\n\n› Ask Codex to do anything`;
}

for (const form of Object.keys(formats)) {
  test(`${form}: exact official wrapped Other snapshot is expanded with its full readable draft`, () => {
    const r = inspectCodexNativeQuestions(frame(wrappedOther[form]));
    assert.equal(r.kind, 'expanded');
    assert.equal(r.title, 'Second');
    assert.equal(r.count, 1);
    assert.equal(r.current, 0);
    assert.equal(r.optionIndex, 1);
    assert.equal(r.otherSelected, true);
    assert.equal(r.draft, 'An alternative answer that wraps across several option rows');
    assert.equal(r.draftUncertain, true);
  });
  for (const count of [1, 2]) test(`${form}: collapsed ${count}-question native summary`, () => {
    const r = inspectCodexNativeQuestions(frame(collapsed(form, count)));
    assert.equal(r.kind, 'collapsed');
    assert.equal(r.count, count);
    assert.equal(r.countdown, '15s');
  });
  for (const footerWrapped of [false, true]) {
    test(`${form}: single-question controls, separate footer rows=${footerWrapped}`, () => {
      const r = inspectCodexNativeQuestions(frame(expanded(form, { footerWrapped })));
      assert.equal(r.kind, 'expanded');
      assert.equal(r.count, 1);
      assert.equal(r.current, 0);
    });
    test(`${form}: multiple-question controls, separate footer rows=${footerWrapped}`, () => {
      const r = inspectCodexNativeQuestions(frame(expanded(form, { progress: '  2 of 3', footerWrapped })));
      assert.equal(r.kind, 'expanded');
      assert.equal(r.count, 3);
      assert.equal(r.current, 1);
    });
  }
  test(`${form}: free-answer editor retains its dim placeholder as empty`, () => {
    const r = inspectCodexNativeQuestions(frame(expanded(form, { free: true })));
    assert.equal(r.kind, 'expanded');
    assert.equal(r.draft, '');
    assert.equal(r.choices.length, 0);
  });
  test(`${form}: questions and option text containing modifier words are not rewritten`, () => {
    const title = 'Keep ctrl+] and shift+← literal';
    const text = expanded(form, { title }).replace('First', 'literal ⇧← and ctrl+]');
    const r = inspectCodexNativeQuestions(frame(text, { title }));
    assert.equal(r.kind, 'expanded');
    assert.equal(r.title, title);
    assert.equal(r.choices[0].label, 'literal ⇧← and ctrl+]');
  });
  for (const override of [{ success: false }, { authoritativeFrameCommitted: false }, { source: 'renderer' }]) {
    test(`${form}: invalid current-frame authority ${JSON.stringify(override)}`, () => {
      assert.equal(inspectCodexNativeQuestions(frame(wrappedOther[form], override)).kind, 'unknown');
    });
  }
  test(`${form}: quoted help followed by the real main composer is not a pending question`, () => {
    const text = wrappedOther[form] + '\n› actual main composer';
    assert.equal(inspectCodexNativeQuestions(frame(text)).kind, 'none');
  });
  test(`${form}: footer words without native title style cannot prove an expanded panel`, () => {
    const f = frame(wrappedOther[form]);
    f.lines.forEach(line => { line.hasNonDefaultBg = false; line.hasNonDefaultFg = false; });
    assert.equal(inspectCodexNativeQuestions(f).kind, 'unknown');
  });
  test(`${form}: dim prose summary lacks the native mixed-style header`, () => {
    const f = frame(collapsed(form));
    f.lines.forEach(line => { line.allTextDim = true; });
    assert.equal(inspectCodexNativeQuestions(f).kind, 'none');
  });
  test(`${form}: truncated controls are not actionable and cropped multi-question progress stays unknown`, () => {
    const text = `\n  2 of\n  Second\n  › x\n  ente…\n  ${formats[form].skip}…`;
    assert.ok(!['expanded', 'collapsed'].includes(inspectCodexNativeQuestions(frame(text)).kind));
    const cropped = expanded(form, { progress: '  2 of 3' }).replace('  2 of 3', '');
    assert.equal(inspectCodexNativeQuestions(frame(cropped)).kind, 'unknown');
  });
}

test('a different physical modifier is not accepted as the Ctrl/Shift question controls', () => {
  assert.equal(inspectCodexNativeQuestions(frame(wrappedOther.mac.replace('⌃] skip', '⌘] skip'))).kind, 'unknown');
  assert.equal(inspectCodexNativeQuestions(frame(collapsed('mac').replace('⇧← to answer', '⌥← to answer'))).kind, 'none');
});

function cellStyles(line) {
  const cells = [];
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x);
    if (c.getWidth() && c.getChars().trim()) cells.push(c);
  }
  const first = cells[0];
  return { hasDim: cells.some(c => !!c.isDim()),
    allTextDim: !!cells.length && cells.every(c => !!c.isDim()),
    hasNonDefaultBg: cells.some(c => c.getBgColorMode() !== 0),
    firstTextStyle: first ? `fg=${first.getFgColorMode()}:${first.getFgColor()},bg=${first.getBgColorMode()}:${first.getBgColor()}`
      + (first.isBold() ? ',bold' : '') + (first.isDim() ? ',dim' : '') : 'none' };
}
for (const form of Object.keys(formats)) test(`${form}: actual headless styled screen passes the actual parser`, async t => {
  const text = wrappedOther[form];
  const lines = text.split('\n');
  const terminal = new Terminal({ cols: 48, rows: 18, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const ansi = lines.map(line => line.trim() === 'Second'
    ? '\x1b[1;38;2;186;103;255;48;2;17;17;17m' + line + '\x1b[0m'
    : /submit|skip|main prompt/.test(line) ? '\x1b[2m' + line + '\x1b[0m' : line).join('\r\n');
  await new Promise(resolve => terminal.write(ansi, resolve));
  const buffer = terminal.buffer.active;
  const f = { success: true, source: 'headless-main', authoritativeFrameCommitted: true,
    baseY: buffer.baseY, cursorY: buffer.cursorY, writeSeq: 20, flushedSeq: 20,
    lines: lines.map((_text, row) => ({ row, text: buffer.getLine(row).translateToString(true),
      wrapped: buffer.getLine(row).isWrapped, ...cellStyles(buffer.getLine(row)) })) };
  const r = inspectCodexNativeQuestions(f);
  assert.equal(r.kind, 'expanded');
  assert.equal(r.title, 'Second');
  assert.equal(r.optionIndex, 1);
  assert.equal(r.draftUncertain, true);
});

for (const form of Object.keys(formats)) test(`${form}: actual headless mixed-style collapsed summary is recognized`, async t => {
  const lines = collapsed(form).split('\n');
  const terminal = new Terminal({ cols: 80, rows: 12, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const ansi = lines.map(line => line.includes('? 2 questions')
    ? '  \x1b[2m? \x1b[0m2\x1b[2m questions · 15s\x1b[0m'
    : line.includes('to answer') ? '\x1b[2m' + line + '\x1b[0m' : line).join('\r\n');
  await new Promise(resolve => terminal.write(ansi, resolve));
  const b = terminal.buffer.active;
  const f = { success: true, source: 'headless-main', authoritativeFrameCommitted: true,
    baseY: b.baseY, cursorY: b.cursorY, writeSeq: 20, flushedSeq: 20,
    lines: lines.map((_text, row) => ({ row, text: b.getLine(row).translateToString(true),
      wrapped: b.getLine(row).isWrapped, ...cellStyles(b.getLine(row)) })) };
  assert.equal(inspectCodexNativeQuestions(f).kind, 'collapsed');
});

function mirrorHarness(form) {
  let f = frame(expanded(form));
  let owner = { key: 'terminal:run:mirror:SID', sessionId: 'SID', lifecycleGeneration: 'L1' };
  let abortReason = null;
  const callbacks = new Set(), writes = [], published = [];
  const h = { get frame() { return f; }, set frame(value) { f = value; },
    get owner() { return owner; }, set owner(value) { owner = value; },
    get abortReason() { return abortReason; }, set abortReason(value) { abortReason = value; },
    writes, published, callbacks, onWrite: null,
    emit(next) { f = next; for (const callback of [...callbacks]) callback(); } };
  h.mirror = createCodexNativeQuestionMirror({ readFrame: () => f, readOwner: () => owner,
    subscribeFrames: (_tab, callback) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    withWriter: (_tab, work) => work({ abortReason: () => abortReason,
      write(bytes) { writes.push(bytes); h.onWrite?.(bytes); } }),
    publish: (_tab, state) => published.push(state), log() {} });
  return h;
}
for (const form of Object.keys(formats)) {
  test(`${form}: stale/uncommitted frames cannot settle the modeled close operation`, async () => {
    const h = mirrorHarness(form), q = h.mirror.get('T');
    assert.ok(q?.expanded);
    let settled = false;
    h.onWrite = () => {
      h.emit(frame(collapsed(form, 1))); // same seq10: not a new frame
      h.emit(frame(collapsed(form, 1), { seq: 11, authoritativeFrameCommitted: false }));
      setImmediate(() => { assert.equal(settled, false); h.emit(frame(collapsed(form, 1), { seq: 12 })); });
    };
    const r = await h.mirror.control('T', { action: 'close', targetId: q.targetId, requestId: 'R' }).then(value => { settled = true; return value; });
    assert.equal(r.success, true);
    assert.deepEqual(h.writes, ['\x1b[1;2C']);
    assert.equal(h.callbacks.size, 0);
  });
  test(`${form}: a foreign current owner cannot act on the previous target`, async () => {
    const h = mirrorHarness(form), q = h.mirror.get('T');
    assert.ok(q?.expanded);
    h.owner = { key: 'another-terminal', sessionId: 'different', lifecycleGeneration: 'L2' };
    const r = await h.mirror.control('T', { action: 'close', targetId: q.targetId, requestId: 'R' });
    assert.equal(r.success, false);
    assert.equal(r.error, 'question_state_changed');
    assert.deepEqual(h.writes, []);
  });
  test(`${form}: generation change after a modeled key never confirms the action`, async () => {
    const h = mirrorHarness(form), q = h.mirror.get('T');
    assert.ok(q?.expanded);
    h.onWrite = () => { h.owner = { key: 'replacement', sessionId: 'SID2', lifecycleGeneration: 'L2' };
      h.emit(frame(collapsed(form, 1), { seq: 11 })); };
    const r = await h.mirror.control('T', { action: 'close', targetId: q.targetId, requestId: 'R' });
    assert.equal(r.success, false);
    assert.equal(r.error, 'question_owner_changed');
    assert.equal(h.writes.length, 1);
    assert.equal(h.callbacks.size, 0);
  });
}

const mainSource = fs.readFileSync(require.resolve('./main.js'), 'utf8');
const sendStart = mainSource.indexOf('async function prepareCodexMainComposerForSend(');
const sendEnd = mainSource.indexOf('\n}\n', sendStart) + 3;
assert.ok(sendStart >= 0 && sendEnd > sendStart);
const mirrorStart = mainSource.indexOf('const codexNativeQuestionMirror = createCodexNativeQuestionMirror(');
const ownerStart = mainSource.indexOf('  readOwner(tabId) {', mirrorStart);
const ownerEnd = mainSource.indexOf('  subscribeFrames(', ownerStart);
assert.ok(mirrorStart >= 0 && ownerStart > mirrorStart && ownerEnd > ownerStart);
for (const unavailable of ['no-proof', 'no-terminal', 'no-mirror', 'not-ready', 'foreign-terminal', 'old-lifecycle']) {
  test('actual Main question availability refuses ' + unavailable, () => {
    const terminal = {}, mirror = { generation: 'M1' };
    const proof = { terminalToken: terminal, lifecycleGeneration: 'L1', sessionId: 'SID' };
    if (unavailable === 'foreign-terminal') proof.terminalToken = {};
    if (unavailable === 'old-lifecycle') proof.lifecycleGeneration = 'L0';
    const readOwner = vm.runInNewContext('({' + mainSource.slice(ownerStart, ownerEnd) + '}).readOwner', {
      terminals: new Map(unavailable === 'no-terminal' ? [] : [['T', terminal]]),
      getCodexWriterProofSnapshot: () => unavailable === 'no-proof' ? null : proof,
      getHeadlessTerminalMirror: () => unavailable === 'no-mirror' ? null : mirror,
      getTerminalLifecycleGeneration: () => 'L1',
      codexTuiReadyTabs: new Set(unavailable === 'not-ready' ? [] : ['T']),
    });
    assert.equal(readOwner('T'), null);
  });
}
test('actual Main question availability keeps the exact current terminal/lifecycle/mirror writer key', () => {
  const terminal = {}, mirror = { generation: 'M1' };
  const readOwner = vm.runInNewContext('({' + mainSource.slice(ownerStart, ownerEnd) + '}).readOwner', {
    terminals: new Map([['T', terminal]]),
    getCodexWriterProofSnapshot: () => ({ terminalToken: terminal, lifecycleGeneration: 'L1', sessionId: 'SID' }),
    getHeadlessTerminalMirror: () => mirror, getTerminalLifecycleGeneration: () => 'L1', codexTuiReadyTabs: new Set(['T']),
  });
  assert.equal(readOwner('T').key, 'L1:M1:SID');
});
for (const form of Object.keys(formats)) test(`${form}: unchanged actual Send preparation recognizes and closes the modeled expanded panel`, async () => {
  const h = mirrorHarness(form);
  const terminal = {};
  h.onWrite = () => h.emit(frame(collapsed(form, 1), { seq: 11 }));
  const prepare = vm.runInNewContext(mainSource.slice(sendStart, sendEnd) + '\nprepareCodexMainComposerForSend', {
    terminals: new Map([['T', terminal]]), getTerminalLifecycleGeneration: () => 'L1', crypto,
    agentSendCancellations: { isCancelled: () => false }, agentSendRequestTargetFailure: () => null,
    codexNativeQuestionMirror: h.mirror,
  });
  const r = await prepare('T', { handoffId: 'H', sendAttemptId: 'A' });
  assert.equal(r.success, true);
  assert.equal(r.inputWritten, true);
  assert.deepEqual(h.writes, ['\x1b[1;2C']);
  assert.ok(h.writes.every(bytes => !bytes.includes('\r')), 'this fixture never writes Send/Enter');
});

test('native model/effort/Fast footer and ordinary queued-message proof remain positive controls', () => {
  assert.deepEqual(parseCodexVerifiedComposerFooter('gpt-5.4 xhigh fast · Full Access'),
    { model: 'gpt-5.4', effort: 'xhigh', fast: true, proof: 'verified-composer-footer' });
  const f = frame('Messages to be submitted after next tool call\n↳ Please continue.\n› Ask Codex to do anything');
  const proofs = extractCodexQueuedMessageProofs(f.lines);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0].text, 'Please continue.');
  assert.deepEqual(codexQueuedMessageMatchesAudit({ expectedText: 'Please continue.' }, proofs[0].text, proofs[0]),
    { reason: 'codex_tui_queue_exact' });
});
