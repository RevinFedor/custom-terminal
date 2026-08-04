'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { parseClaudeComposerCurrentFrame } = require('./claude-composer-proof');
const {
  buildMissingPromptEmptyFrameAnsi,
  buildResidualEmptyFrameAnsi,
  createE2eBoundaryTestGate,
} = require('./e2e-boundary-test-gate');

function harness() {
  let now = 100;
  let arm = 0;
  let operation = 0;
  const events = [];
  const gate = createE2eBoundaryTestGate({
    enabled: true,
    now: () => ++now,
    makeArmId: () => 'arm-' + (++arm),
    makeOperationId: () => 'operation-' + (++operation),
    onEvent: (kind, detail) => events.push({ kind, detail }),
  });
  return { gate, events };
}

test('disabled gate cannot affect product boundaries', async () => {
  const gate = createE2eBoundaryTestGate({ enabled: false });
  assert.deepEqual(gate.arm({ kind: 'before-enter', identity: { tabId: 'a' } }), {
    success: false,
    error: 'test_hook_disabled',
  });
  assert.deepEqual(await gate.waitIfArmed({ kind: 'before-enter', identity: { tabId: 'a' } }), {
    claimed: false,
    reason: 'test_hook_disabled',
  });
});

test('an exact identity holds and releases only with its operation receipt', async () => {
  const { gate } = harness();
  const armed = gate.arm({
    kind: 'post-enter-audit',
    identity: { tabId: 'tab-a', handoffId: 'handoff-a', provider: 'claude' },
  }).arm;
  assert.deepEqual(await gate.waitIfArmed({
    kind: 'post-enter-audit',
    identity: { tabId: 'tab-b', handoffId: 'handoff-a', provider: 'claude' },
  }), { claimed: false, reason: 'not-armed' });

  const waiting = gate.waitIfArmed({
    kind: 'post-enter-audit',
    identity: { tabId: 'tab-a', handoffId: 'handoff-a', provider: 'claude' },
  });
  const held = gate.snapshot()[0];
  assert.equal(held.state, 'held');
  assert.equal(gate.release({
    armId: armed.armId,
    operationId: 'wrong',
  }).success, false);
  assert.equal(gate.release({
    armId: armed.armId,
    operationId: held.operationId,
    identity: { tabId: 'tab-b' },
  }).success, false);
  assert.equal(gate.release({
    armId: armed.armId,
    operationId: held.operationId,
    identity: { tabId: 'tab-a', handoffId: 'handoff-a' },
  }).success, true);
  assert.equal((await waiting).state, 'released');
});

test('reverse release cannot cross two same-kind operations', async () => {
  const { gate } = harness();
  gate.arm({ kind: 'proof', identity: { tabId: 'a', generation: 'g1' } });
  gate.arm({ kind: 'proof', identity: { tabId: 'b', generation: 'g2' } });
  const waitA = gate.waitIfArmed({ kind: 'proof', identity: { tabId: 'a', generation: 'g1' } });
  const waitB = gate.waitIfArmed({ kind: 'proof', identity: { tabId: 'b', generation: 'g2' } });
  const [a, b] = gate.snapshot();
  assert.equal(gate.release({ armId: b.armId, operationId: b.operationId }).success, true);
  assert.equal((await waitB).arm.armId, b.armId);
  assert.equal(gate.snapshot()[0].state, 'held');
  assert.equal(gate.release({ armId: a.armId, operationId: a.operationId }).success, true);
  assert.equal((await waitA).arm.armId, a.armId);
});

test('non-hold actions claim once and require an exact completion receipt', () => {
  const { gate } = harness();
  const armed = gate.arm({
    kind: 'resume-work',
    action: 'inject',
    identity: { tabId: 'a', generation: 'g1' },
    payload: { marker: 'RW-1' },
  }).arm;
  const claimed = gate.claim({ kind: 'resume-work', identity: { tabId: 'a', generation: 'g1' } });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.payload.marker, 'RW-1');
  assert.deepEqual(gate.claim({ kind: 'resume-work', identity: { tabId: 'a', generation: 'g1' } }), {
    claimed: false,
    reason: 'not-armed',
  });
  assert.equal(gate.complete({ armId: armed.armId, operationId: 'wrong' }).success, false);
  assert.equal(gate.complete({
    armId: armed.armId,
    operationId: claimed.arm.operationId,
    result: { submitted: true },
  }).success, true);
  assert.equal(gate.snapshot()[0].state, 'completed');
});

test('clear and identity replacement release all held promises without leaks', async () => {
  const { gate } = harness();
  gate.arm({ kind: 'a', identity: { tabId: 'tab-a', generation: 'g1' } });
  gate.arm({ kind: 'b', identity: { tabId: 'tab-b', generation: 'g1' } });
  const waitA = gate.waitIfArmed({ kind: 'a', identity: { tabId: 'tab-a', generation: 'g1' } });
  assert.equal(gate.cancelMatching({ tabId: 'tab-a' }, 'terminal-replaced').cancelled, 1);
  assert.equal((await waitA).state, 'cancelled');
  assert.equal(gate.snapshot()[1].state, 'armed');
  assert.equal(gate.clear('rollback').cancelled, 1);
  assert.equal(gate.snapshot()[1].state, 'cancelled');
});

test('residual-frame ANSI leaves the cursor at an empty composer while cells remain to its right', async () => {
  const terminal = new Terminal({ cols: 80, rows: 12, allowProposedApi: true });
  const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
  await write('\x1b[2J\x1b[H❯ ');
  const cursorBefore = terminal.buffer.active.cursorX;
  await write(buildResidualEmptyFrameAnsi('E2E_RESIDUAL'));
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = buffer.viewportY; row < buffer.viewportY + terminal.rows; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    let occupiedEndX = 0;
    let promptCellX = null;
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      const chars = String(cell?.getChars?.() || '');
      if (chars.includes('❯')) promptCellX = x;
      if (chars.trim()) occupiedEndX = x + 1;
    }
    lines.push({
      row,
      text: line.translateToString(true),
      wrapped: !!line.isWrapped,
      occupiedEndX,
      promptCellX,
    });
  }
  const proof = parseClaudeComposerCurrentFrame({
    source: 'headless-main',
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines,
  });
  assert.equal(buffer.cursorX, cursorBefore);
  assert.equal(proof.proofOutcome, 'unknown');
  assert.equal(proof.proofReason, 'composer-content-after-cursor');
  assert.equal(proof.exactCaptureRecommended, true);
});

test('missing-prompt ANSI keeps the empty composer cursor while removing only the mirrored prompt row', async () => {
  const terminal = new Terminal({ cols: 80, rows: 12, allowProposedApi: true });
  const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
  await write('\x1b[2J\x1b[H❯ ');
  const cursorBefore = terminal.buffer.active.cursorX;
  await write(buildMissingPromptEmptyFrameAnsi(cursorBefore));
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = buffer.viewportY; row < buffer.viewportY + terminal.rows; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    let occupiedEndX = 0;
    let promptCellX = null;
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      const chars = String(cell?.getChars?.() || '');
      if (chars.includes('❯')) promptCellX = x;
      if (chars.trim()) occupiedEndX = x + 1;
    }
    lines.push({
      row,
      text: line.translateToString(true),
      wrapped: !!line.isWrapped,
      occupiedEndX,
      promptCellX,
    });
  }
  const proof = parseClaudeComposerCurrentFrame({
    source: 'headless-main',
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines,
  });
  assert.equal(buffer.cursorX, cursorBefore);
  assert.equal(proof.proofOutcome, 'unknown');
  assert.equal(proof.proofReason, 'active-prompt-not-found');
  assert.equal(proof.exactCaptureRecommended, undefined);
});
