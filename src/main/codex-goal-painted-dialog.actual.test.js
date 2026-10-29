'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { Terminal } = require('@xterm/headless');
const { createCodexRuntimePolicyController } = require('./codex-runtime-policies');
const goalPrompt = require('./codex-resume-goal-prompt');
const { parseCodexVerifiedComposerFooter } = require('./codex-tui-readiness');
const replay = require('./fixtures/codex-goal-painted-dialog-replay.json');

const source = fs.readFileSync(__dirname + '/main.js', 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const producer = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'codexPolicyFrame');
assert.ok(producer, 'execute the actual Main frame producer, not a second projector');
const tick = () => new Promise(resolve => setImmediate(resolve));
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));

function snapshot(terminal, seq) {
  const buffer = terminal.buffer.active;
  return { rows: terminal.rows, cols: terminal.cols, viewportY: buffer.viewportY, baseY: buffer.baseY,
    authoritativeFrameCommitted: true, liveSynchronizedOutputOpen: false, synchronizedOutputOpen: false,
    writeSeq: seq, lines: Array.from({ length: terminal.rows }, (_, offset) => ({
      row: buffer.viewportY + offset,
      text: buffer.getLine(buffer.viewportY + offset)?.translateToString(true) || '',
    })) };
}

async function harness(preference = false) {
  const terminal = new Terminal({ cols: replay.baseline.cols, rows: replay.baseline.rows,
    scrollback: 1000, allowProposedApi: true });
  const mirror = { terminal, complete: true, failed: false, pendingResizeWriteSeq: null,
    redrawTrace: { synchronizedOutputOpen: false } };
  const context = vm.createContext({ ...goalPrompt, getHeadlessTerminalMirror: () => mirror });
  vm.runInContext(producer.getText(ast), context);
  const owner = { terminal: {}, live: true, lifecycleGeneration: 'actual-replay-owner', runSeq: 1, inputRevision: 0 };
  let frame, now = 1000, eventIndex = 0, timerId = 0;
  const writes = [], publications = [], timers = new Map();
  const controller = createCodexRuntimePolicyController({ capture: () => ({ ...owner }),
    readFrame: async () => frame, readPolicy: () => ({ resumeGoal: preference, actionDeadlineAt: 61000 }),
    withWriteLock: async (_terminal, fn) => fn({ active: true }),
    sendKey: async (_tab, key, options) => { assert.equal(options.guard(), true); writes.push(key); return { written: true }; },
    isComposer: f => !!parseCodexVerifiedComposerFooter(f.text), stopAll: () => assert.fail('not process Stop'),
    publish: (_tab, value) => publications.push(value), now: () => now,
    setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
  });
  function capture(seq) {
    mirror.writeSeq = mirror.flushedSeq = seq;
    const snap = snapshot(terminal, seq);
    mirror.lastCommittedVisibleSnapshot = snap;
    frame = context.codexPolicyFrame('T', mirror, snap);
    return frame;
  }
  await write(terminal, replay.baseline.screen);
  async function advance(seq) {
    while (eventIndex < replay.events.length) {
      const event = replay.events[eventIndex++];
      if (event.kind === 'resize') terminal.resize(event.cols, event.rows);
      else {
        await write(terminal, event.data);
        if (event.seq === seq) return capture(seq);
      }
    }
    assert.fail('missing saved output sequence ' + seq);
  }
  return { terminal, mirror, owner, writes, publications, controller, timers, advance, capture,
    setTime(value) { now = value; }, get frame() { return frame; }, dispose() { controller.clear('T'); terminal.dispose(); } };
}

test('saved native Goal repaint uses ONE actual Main policy operation and one arrow/Enter, not a textual underlay reset', async () => {
  const h = await harness();
  try {
    const before = await h.advance(33);
    assert.equal(before.valid, true);
    h.controller.observe('T', before); await tick();
    assert.deepEqual(h.writes, ['\x1b[B']);
    const operationId = h.controller.readGoalAction('T').operationId;
    const after = await h.advance(38);
    assert.equal(after.valid, true);
    assert.deepEqual(Array.from(after.snapshot.lines, x => x.text.trimEnd()),
      replay.savedFrame38.lines.map(x => x.text.trimEnd()), 'all saved Main rows, not only the menu');
    assert.equal(after.snapshot.cols, replay.savedFrame38.cols);
    assert.equal(after.snapshot.rows, replay.savedFrame38.rows);
    h.controller.observe('T', after); await tick();
    assert.deepEqual(h.writes, ['\x1b[B', '\r'], JSON.stringify(h.controller.readGoalAction('T')));
    assert.equal(h.controller.readGoalAction('T').operationId, operationId);
    assert.equal(h.publications.some(x => x.reason === 'goal-dialog-changed'), false);
    assert.equal(h.controller.readGoalAction('T').choiceConfirmed, false, 'Enter is not composer/writer proof');
    await write(h.terminal, '\x1b[0m\x1b[2J\x1b[H> Ask Codex to do anything\r\ngpt-6-luna low · Context 1% used');
    h.controller.observe('T', h.capture(39)); await tick();
    assert.equal(h.controller.readGoalAction('T').choiceConfirmed, true, 'controlled next composer, not a native E2E claim');
    h.controller.observe('T', after); await tick();
    assert.deepEqual(h.writes, ['\x1b[B', '\r'], 'late original menu cannot repeat input');
  } finally { h.dispose(); }
});

test('actual Goal text changing inside the painted menu still revokes the original choice', async () => {
  const h = await harness();
  try {
    h.controller.observe('T', await h.advance(33)); await tick();
    await h.advance(38);
    await write(h.terminal, '\x1b[48;2;53;53;53m\x1b[23;12HCHANGED GOAL');
    h.controller.observe('T', h.capture(39)); await tick();
    assert.deepEqual(h.writes, ['\x1b[B']);
    assert.equal(h.controller.readGoalAction('T').reason, 'goal-dialog-changed');
    assert.equal(h.controller.readGoalAction('T').actionAttempted, false);
  } finally { h.dispose(); }
});

test('painted selection does not renew the original cold deadline or bypass manual input ownership', async () => {
  for (const cause of ['deadline', 'input']) {
    const h = await harness();
    try {
      h.controller.observe('T', await h.advance(33)); await tick();
      if (cause === 'input') h.owner.inputRevision++;
      else {
        h.setTime(61000);
        const timer = [...h.timers.values()].find(x => x.ms === 60000);
        assert.ok(timer); await timer.fn();
      }
      h.controller.observe('T', await h.advance(38)); await tick();
      assert.deepEqual(h.writes, ['\x1b[B']);
      assert.equal(h.controller.readGoalAction('T').choiceConfirmed, false);
    } finally { h.dispose(); }
  }
});

test('the painted projection has independently matching native option-row bounds, and preserves the whole Goal body', async () => {
  const h = await harness();
  try {
    const first = await h.advance(33), last = await h.advance(38);
    for (const frame of [first, last]) {
      const p = frame.goalDialogProjection;
      assert.ok(p, frame.goalDialogProjectionReason);
      assert.equal(p.bounds.left, 3); assert.equal(p.bounds.right, 75);
      assert.equal(p.snapshotToken, frame.snapshot); assert.equal(p.mirrorToken, h.mirror);
      assert.equal(p.seq, frame.seq);
      assert.match(p.text, /Do not create any other Goal\. Then/);
      assert.match(p.text, /histories, other sessions, browser or network\./);
      assert.doesNotMatch(p.text, /› A|ac…|Then\s+ew/);
    }
    const body = text => text.slice(text.indexOf('Goal:'), text.indexOf('1. Resume'))
      .replace(/[›❯»>]/g, '').replace(/\s+/g, ' ').trim();
    assert.equal(body(first.goalDialogProjection.text), body(last.goalDialogProjection.text));
  } finally { h.dispose(); }
});

test('manual Goal GET/action keeps the same admitted painted key without rereading or auto-choosing', async () => {
  const h = await harness(null);
  try {
    h.controller.observe('T', await h.advance(38)); await tick();
    const view = h.controller.readGoalAction('T');
    assert.equal(view.reason, 'user-choice-required'); assert.equal(view.status, 'available');
    assert.deepEqual(view.availableActions, ['resume', 'leave-paused']);
    assert.deepEqual(h.writes, []);
    const result = h.controller.applyGoalAction('T', { operationId: view.operationId,
      requestId: 'own-explicit-painted-choice', action: 'leave-paused' });
    assert.equal(result.accepted, true); await tick();
    assert.deepEqual(h.writes, ['\r']);
    h.controller.applyGoalAction('T', { operationId: view.operationId,
      requestId: 'own-explicit-painted-choice', action: 'leave-paused' });
    await tick(); assert.deepEqual(h.writes, ['\r']);
  } finally { h.dispose(); }
});

for (const field of ['seq', 'mirrorToken', 'snapshotToken']) {
  test('a copied painted projection from another ' + field + ' cannot authorize Enter', async () => {
    const h = await harness();
    try {
      h.controller.observe('T', await h.advance(33)); await tick();
      const frame = await h.advance(38);
      frame.goalDialogProjection[field] = field === 'seq' ? 33 : {};
      h.controller.observe('T', frame); await tick();
      assert.deepEqual(h.writes, ['\x1b[B']);
      assert.equal(h.controller.readGoalAction('T').reason, 'goal-dialog-changed');
    } finally { h.dispose(); }
  });
}

test('a change at the final INSIDE panel cell remains Goal content, not removable trailing noise', async () => {
  const h = await harness();
  try {
    h.controller.observe('T', await h.advance(33)); await tick();
    await h.advance(38);
    await write(h.terminal, '\x1b[48;2;53;53;53m\x1b[25;75HX');
    const changed = h.capture(39);
    assert.ok(changed.goalDialogProjection, changed.goalDialogProjectionReason);
    assert.match(changed.goalDialogProjection.text, /Then +X/);
    h.controller.observe('T', changed); await tick();
    assert.deepEqual(h.writes, ['\x1b[B']);
    assert.equal(h.controller.readGoalAction('T').reason, 'goal-dialog-changed');
  } finally { h.dispose(); }
});

test('mismatched control paint bounds and missing paint proof use the unchanged conservative snapshot identity', async () => {
  for (const mode of ['unequal-bounds', 'unstyled']) {
    const h = await harness();
    try {
      h.controller.observe('T', await h.advance(33)); await tick();
      const frame = await h.advance(38);
      if (mode === 'unequal-bounds') await write(h.terminal, '\x1b[0m\x1b[30;75H ');
      else {
        await write(h.terminal, '\x1b[0m\x1b[2J\x1b[H'
          + frame.snapshot.lines.map(x => x.text).join('\r\n'));
      }
      const unknown = h.capture(39);
      assert.equal(unknown.goalDialogProjection, null);
      h.controller.observe('T', unknown); await tick();
      assert.deepEqual(h.writes, ['\x1b[B']);
      assert.equal(h.controller.readGoalAction('T').choiceConfirmed, false);
    } finally { h.dispose(); }
  }
});

test('stale text/dimensions or an uncommitted Main frame never supplies a new painted proof', async () => {
  const h = await harness();
  try {
    const old = await h.advance(33); await h.advance(38);
    const stale = goalPrompt.projectCodexResumeGoalPaintedDialog(h.terminal, old.snapshot, old.text);
    assert.equal(stale.projected, false); assert.equal(stale.reason, 'snapshot-text-changed');
    const dimensions = goalPrompt.projectCodexResumeGoalPaintedDialog(h.terminal,
      { ...h.frame.snapshot, cols: h.frame.snapshot.cols + 1 }, h.frame.text);
    assert.equal(dimensions.projected, false);
    h.mirror.redrawTrace.synchronizedOutputOpen = true;
    const uncommitted = h.capture(39);
    assert.equal(uncommitted.valid, false); assert.equal(uncommitted.goalDialogProjection, null);
    h.controller.observe('T', uncommitted); await tick(); assert.deepEqual(h.writes, []);
  } finally { h.dispose(); }
});

test('projection uses terminal CELL columns and preserves wide/combining Goal content at the right edge', async () => {
  const h = await harness();
  try {
    await h.advance(38);
    await write(h.terminal, '\x1b[48;2;53;53;53m\x1b[25;72H界e\u0301');
    const frame = h.capture(39);
    assert.ok(frame.goalDialogProjection, frame.goalDialogProjectionReason);
    assert.match(frame.goalDialogProjection.text, /界e\u0301/);
    assert.doesNotMatch(frame.goalDialogProjection.text, /Then\s+ew/);
  } finally { h.dispose(); }
});
