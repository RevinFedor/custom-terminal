'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexRuntimePolicyController, inspectCodexPolicyDialog } = require('./codex-runtime-policies');
const { parseCodexVerifiedComposerFooter } = require('./codex-tui-readiness');

const menu = 'Resume paused goal?\nGoal: finish the current task\n> 1. Resume goal   Mark it active and continue when idle\n  2. Leave paused  Keep it paused; use /goal resume later\nPress enter to confirm or esc to go back';
const selectedMenu = index => index === 1 ? menu : menu.replace('> 1.', '  1.').replace('  2.', '> 2.');
const composer = '> Ask Codex to do anything\ngpt-6-astra max · Context 42% used';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const owner = { terminal: {}, lifecycleGeneration: 'G', runSeq: 1, inputRevision: 1,
    turnId: 'A', sessionId: 'S', live: true };
  let frame = { valid: true, seq: 1, text: selectedMenu(options.selected || 1) };
  let gate = Promise.resolve();
  let tail = Promise.resolve();
  let writeOwner = null;
  let timerId = 0;
  const timers = new Map(), writes = [], events = [], logs = [];
  const counters = { reads: 0, locks: 0, stops: 0 };
  const preferences = { resumeGoal: false };
  const controller = createCodexRuntimePolicyController({
    capture: () => ({ ...owner }),
    readFrame: async () => { counters.reads++; return options.readFrame?.(frame) || frame; },
    readPolicy: () => preferences,
    isComposer: value => !!parseCodexVerifiedComposerFooter(value.text),
    withWriteLock: (term, work) => {
      counters.locks++;
      assert.equal(term, owner.terminal);
      const result = tail.then(async () => {
        await gate;
        const locked = { active: true };
        writeOwner = locked;
        try { return await work(locked); }
        finally { locked.active = false; writeOwner = null; }
      });
      tail = result.catch(() => {});
      return result;
    },
    sendKey: async (_tabId, key, { owner: locked, expectedFrame, guard }) => {
      options.beforeWrite?.({ owner, key, frame, paint, replaceFrame });
      if (!guard() || writeOwner !== locked || !locked.active || !frame.valid
        || frame.seq !== expectedFrame.seq || frame.text !== expectedFrame.text) {
        return { written: false, reason: 'policy-write-owner-or-frame-changed' };
      }
      writes.push(key);
      if (key !== '\r' && !options.noSelectionFrame) {
        const selected = inspectCodexPolicyDialog(frame.text).selectedIndex;
        const next = selected + (key === '\x1b[B' ? 1 : -1);
        paint(frame.text.replace('> ', '  ').replace(new RegExp('  ' + next + '\\.'), '> ' + next + '.'));
      }
      if (key === '\r' && options.synchronousComposer) paint(composer);
      if (key === '\r' && options.enterWait) await options.enterWait;
      if (key === '\r' && options.enterThrows) throw new Error('write acknowledgement lost');
      if (key === '\r' && options.enterUnknown) return {};
      options.afterWrite?.({ owner, key, frame, paint, replaceFrame });
      return { written: true };
    },
    stopAll: async () => { counters.stops++; throw new Error('Goal must never stop processes'); },
    publish: (_tabId, value) => events.push(value),
    log: message => logs.push(message),
    setTimer: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimer: id => timers.delete(id),
    confirmationMs: 30, actionMs: 100,
    maxGoalActionRequests: options.maxGoalActionRequests ?? 1024,
  });
  function replaceFrame(next) { frame = { ...frame, ...next }; }
  function paint(text = frame.text, extra = {}) {
    frame = { ...frame, text, seq: frame.seq + 1, ...extra };
    controller.observe('T', frame);
  }
  function hold() {
    let release;
    gate = new Promise(resolve => { release = resolve; });
    return release;
  }
  async function expire(ms) {
    const timer = [...timers.values()].find(value => value.ms === ms);
    assert.ok(timer, 'expected a bounded action/confirmation deadline');
    await timer.callback();
    await tick();
  }
  async function manual() {
    const release = hold();
    paint();
    await expire(100);
    release();
    await tick();
    const state = controller.readGoalAction('T');
    assert.equal(state.status, 'available');
    assert.deepEqual(writes, []);
    return state;
  }
  function apply(action = 'resume', requestId = 'request-1', operationId = controller.readGoalAction('T').operationId) {
    return controller.applyGoalAction('T', { action, requestId, operationId });
  }
  return { controller, owner, options, counters, writes, events, logs, preferences, timers,
    paint, replaceFrame, hold, expire, manual, apply, get frame() { return frame; } };
}

test('GET does not observe a visible menu, read a frame, acquire a lock or start a stopped runtime', () => {
  const h = fixture();
  assert.equal(h.controller.readGoalAction('T').reason, 'no-goal-dialog');
  h.owner.live = false;
  assert.equal(h.controller.readGoalAction('T').reason, 'runtime-not-live');
  assert.equal(h.controller.readGoalAction('T', { requestId: 'lost' }).reason, 'goal-request-not-found');
  assert.deepEqual(h.counters, { reads: 0, locks: 0, stops: 0 });
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.writes, []);
  assert.equal(h.timers.size, 0);
});

for (const action of ['resume', 'leave-paused']) {
  for (const selected of [1, 2]) test('explicit ' + action + ' from highlight ' + selected + ' uses one native choice', async () => {
    const h = fixture({ selected });
    const state = await h.manual();
    const request = { operationId: state.operationId, requestId: 'exact-request', action };
    const accepted = h.controller.applyGoalAction('T', request);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.status, 'pending');
    assert.equal(h.controller.applyGoalAction('T', request).replayed, true);
    await tick();
    const target = action === 'resume' ? 1 : 2;
    const expected = selected === target ? ['\r'] : [selected < target ? '\x1b[B' : '\x1b[A', '\r'];
    assert.deepEqual(h.writes, expected);
    const pending = h.controller.readGoalAction('T', { requestId: request.requestId });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.actionWritten, true);
    assert.equal(pending.composerReady, false);
    assert.equal(pending.choiceConfirmed, false);
    assert.equal(h.apply(action, 'different-request').reason, 'goal-action-pending');
    h.paint(composer);
    const confirmed = h.controller.readGoalAction('T', { requestId: request.requestId });
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.choiceConfirmed, true);
    assert.equal(confirmed.composerReady, true);
    assert.ok(confirmed.resultFrameSeq > state.frameSeq);
    assert.equal(h.controller.applyGoalAction('T', request).status, 'confirmed');
    assert.equal(h.apply(action, 'after-completion').reason, 'goal-choice-already-confirmed');
    await tick();
    assert.deepEqual(h.writes, expected);
    assert.deepEqual(h.preferences, { resumeGoal: false }, 'explicit choice never changes saved preferences');
    assert.equal(h.counters.stops, 0, 'Leave paused is not process Stop or goal deletion');
    assert.ok(h.logs.some(line => line.includes('request=exact-request')));
    assert.ok(h.logs.every(line => !line.includes('finish the current task')), 'no Goal text in diagnostics');
  });
}

test('requestId is bound to exact tab, operation and action, including rejected requests', async () => {
  const h = fixture();
  const state = await h.manual();
  h.apply('resume', 'bound');
  for (const change of [{ action: 'leave-paused' }, { operationId: 'other-operation' }, { tabId: 'other-tab' }]) {
    const result = h.controller.applyGoalAction(change.tabId || 'T', {
      requestId: 'bound', action: 'resume', operationId: state.operationId, ...change,
    });
    assert.equal(result.reason, 'goal-request-conflict');
    assert.equal(result.accepted, false);
  }
  await tick();
  assert.deepEqual(h.writes, ['\r']);
  assert.equal(h.apply('resume', 'stale', 'other-operation').reason, 'stale-goal-operation');
  assert.equal(h.apply('resume', 'stale').reason, 'goal-request-conflict');
  assert.equal(h.controller.readGoalAction('other-tab', { requestId: 'bound' }).reason, 'goal-request-not-found');
});

test('an unknown automatic Enter cannot be replayed through the explicit API', async () => {
  const h = fixture({ selected: 2 });
  h.paint(); await tick(); await h.expire(30);
  const state = h.controller.readGoalAction('T');
  assert.equal(state.status, 'unknown');
  assert.equal(state.actionWritten, true);
  assert.equal(h.apply('resume').reason, 'goal-action-outcome-unknown');
  assert.equal(h.apply('leave-paused', 'other-request').reason, 'goal-action-outcome-unknown');
  h.paint(); await tick();
  assert.deepEqual(h.writes, ['\r']);
  h.paint(composer);
  assert.equal(h.controller.readGoalAction('T').status, 'confirmed', 'late exact composer settles, no second Enter');
});

test('explicit Enter is pending, then unknown, and only later committed composer confirms it', async () => {
  const h = fixture(); await h.manual();
  h.apply(); await tick(); await h.expire(30);
  const before = { ...h.counters };
  const state = h.controller.readGoalAction('T', { requestId: 'request-1' });
  assert.equal(state.status, 'unknown');
  assert.equal(state.choiceConfirmed, false);
  assert.equal(h.apply().status, 'unknown');
  assert.equal(h.apply('resume', 'new-request').reason, 'goal-action-outcome-unknown');
  assert.deepEqual(h.counters, before, 'GET and retries do not perform screen catch-up actions');
  h.paint(composer);
  assert.equal(h.controller.readGoalAction('T', { requestId: 'request-1' }).status, 'confirmed');
  assert.deepEqual(h.writes, ['\r']);
});

for (const previous of ['automatic', 'explicit']) {
  for (const action of ['resume', 'leave-paused']) test('fresh same-dialog frame permits ' + action
    + ' after settled unknown ' + previous + ' Enter, preserving the original receipt', async () => {
    const h = fixture({ selected: 2 });
    if (previous === 'explicit') { await h.manual(); h.apply('leave-paused', 'original-request'); }
    else h.paint();
    await tick(); await h.expire(30);
    const old = h.controller.readGoalAction('T');
    assert.equal(old.status, 'unknown');
    assert.equal(old.recoveryAvailable, false, 'the retained pre-Enter frame cannot authorize retry');
    const before = { ...h.counters };
    h.controller.readGoalAction('T');
    assert.deepEqual(h.counters, before, 'GET itself does not obtain new frame evidence');
    h.paint(selectedMenu(2));
    const recoverable = h.controller.readGoalAction('T');
    assert.equal(recoverable.status, 'unknown');
    assert.equal(recoverable.recoveryAvailable, true);
    assert.ok(recoverable.recoveryFrameSeq > old.frameSeq);
    assert.deepEqual(recoverable.availableActions, ['resume', 'leave-paused']);
    if (previous === 'explicit') {
      const duplicate = h.apply('leave-paused', 'original-request');
      assert.equal(duplicate.replayed, true);
      assert.equal(duplicate.status, 'unknown');
      assert.deepEqual(h.writes, ['\r'], 'same requestId is never a recovery action');
    }
    const accepted = h.apply(action, 'recovery-request');
    assert.equal(accepted.accepted, true);
    await tick();
    assert.deepEqual(h.writes, action === 'resume' ? ['\r', '\x1b[A', '\r'] : ['\r', '\r']);
    h.paint(composer);
    const result = h.controller.readGoalAction('T', { requestId: 'recovery-request' });
    assert.equal(result.status, 'confirmed');
    assert.equal(result.choiceConfirmed, true);
    if (previous === 'explicit') {
      const prior = h.controller.readGoalAction('T', { requestId: 'original-request' });
      assert.equal(prior.status, 'unknown');
      assert.equal(prior.choiceConfirmed, false);
      assert.equal(prior.recoveryAvailable, false);
      assert.equal(prior.supersededByRequestId, 'recovery-request');
      assert.equal(h.apply('leave-paused', 'original-request').status, 'unknown');
    }
    assert.equal(h.counters.stops, 0);
  });
}

test('fresh Goal while an old key acknowledgement is still pending does not enable recovery', async () => {
  const h = fixture(); await h.manual();
  let release;
  h.options.enterWait = new Promise(resolve => { release = resolve; });
  h.apply(); await tick();
  h.paint();
  assert.equal(h.controller.readGoalAction('T').status, 'pending');
  await h.expire(100);
  const stillRunning = h.controller.readGoalAction('T');
  assert.equal(stillRunning.status, 'unknown');
  assert.equal(stillRunning.recoveryAvailable, false, 'deadline is not proof the writer finished');
  assert.equal(h.apply('leave-paused', 'too-soon').reason, 'goal-action-outcome-unknown');
  release(); await tick();
  assert.equal(h.controller.readGoalAction('T').recoveryAvailable, true);
  h.apply('leave-paused', 'settled-recovery'); await tick();
  assert.deepEqual(h.writes, ['\r', '\x1b[B', '\r']);
});

test('the existing confirmation read can prove a newer still-visible Goal without side effects from GET', async () => {
  const h = fixture({ selected: 2 });
  h.paint(); await tick();
  h.replaceFrame({ seq: h.frame.seq + 1 });
  await h.expire(30);
  const reads = h.counters.reads;
  const state = h.controller.readGoalAction('T');
  assert.equal(state.status, 'unknown');
  assert.equal(state.recoveryAvailable, true);
  assert.equal(h.counters.reads, reads);
  h.apply('resume', 'recovery'); await tick();
  assert.deepEqual(h.writes, ['\r', '\x1b[A', '\r']);
});

test('recovery rechecks the current frame under the lock, not just its API admission snapshot', async () => {
  for (const change of ['stale-frame', 'composer', 'Stop', 'input']) {
    const h = fixture(); await h.manual();
    h.apply(); await tick(); await h.expire(30);
    const actionFrame = h.frame;
    h.paint();
    assert.equal(h.controller.readGoalAction('T').recoveryAvailable, true);
    const release = h.hold();
    h.apply('leave-paused', 'recovery');
    if (change === 'stale-frame') h.replaceFrame(actionFrame);
    if (change === 'composer') h.replaceFrame({ seq: h.frame.seq + 1, text: composer });
    if (change === 'Stop') h.owner.live = false;
    if (change === 'input') h.owner.inputRevision++;
    release(); await tick();
    assert.deepEqual(h.writes, ['\r']);
    assert.equal(h.controller.readGoalAction('T', { requestId: 'request-1' }).status, 'unknown');
    assert.equal(h.controller.readGoalAction('T', { requestId: 'recovery' }).choiceConfirmed, false);
  }
});

for (const flag of ['enterUnknown', 'enterThrows']) test('ambiguous key result is honest and cannot write twice: ' + flag, async () => {
  const h = fixture({ [flag]: true }); await h.manual();
  h.apply(); await tick();
  const state = h.controller.readGoalAction('T', { requestId: 'request-1' });
  assert.equal(state.status, 'unknown');
  assert.equal(state.actionAttempted, true);
  assert.equal(state.actionWritten, false);
  assert.equal(h.apply().status, 'unknown');
  h.paint(composer);
  const after = h.controller.readGoalAction('T', { requestId: 'request-1' });
  assert.equal(after.composerReady, true);
  assert.equal(after.choiceConfirmed, false, 'composer alone does not invent a proven key write');
  assert.equal(after.status, 'unknown');
  assert.deepEqual(h.writes, ['\r']);
});

test('a synchronous committed composer during the key write settles the same request', async () => {
  const h = fixture({ synchronousComposer: true }); await h.manual();
  h.apply(); await tick();
  const result = h.controller.readGoalAction('T', { requestId: 'request-1' });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.choiceConfirmed, true);
  assert.equal(h.controller.read('T'), null);
  assert.deepEqual(h.writes, ['\r']);
});

test('composer already present before the action is not proof of the requested Goal choice', async () => {
  const h = fixture(); await h.manual();
  h.replaceFrame({ seq: h.frame.seq + 1, text: composer });
  h.apply(); await tick();
  const result = h.controller.readGoalAction('T', { requestId: 'request-1' });
  assert.equal(result.composerReady, true);
  assert.equal(result.actionWritten, false);
  assert.equal(result.choiceConfirmed, false);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(h.writes, []);
});

const mutations = {
  terminal: owner => { owner.terminal = {}; },
  generation: owner => { owner.lifecycleGeneration = 'G2'; },
  run: owner => { owner.runSeq++; },
  input: owner => { owner.inputRevision++; },
  Stop: owner => { owner.live = false; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test('stale ' + name + ' before API admission never writes', async () => {
    const h = fixture(); const state = await h.manual();
    mutate(h.owner);
    const before = { ...h.counters };
    const result = h.apply('resume', 'stale-owner', state.operationId);
    assert.equal(result.accepted, false);
    assert.deepEqual(h.counters, before);
    assert.deepEqual(h.writes, []);
  });
  test('stale ' + name + ' while waiting for the shared PTY lock never writes', async () => {
    const h = fixture(); await h.manual();
    const release = h.hold();
    h.apply(); mutate(h.owner); release(); await tick();
    assert.deepEqual(h.writes, []);
    assert.equal(h.controller.readGoalAction('T', { requestId: 'request-1' }).choiceConfirmed, false);
  });
  test('stale ' + name + ' at the final key boundary never writes', async () => {
    const h = fixture(); await h.manual();
    h.options.beforeWrite = ({ owner }) => mutate(owner);
    h.apply(); await tick();
    assert.deepEqual(h.writes, []);
  });
}

test('Stop after Enter preserves unknown receipt; reading it never starts the runtime', async () => {
  const h = fixture(); await h.manual();
  h.apply(); await tick();
  h.owner.live = false;
  h.controller.clear('T');
  const before = { ...h.counters };
  assert.equal(h.controller.readGoalAction('T').reason, 'runtime-not-live');
  assert.equal(h.controller.readGoalAction('T', { requestId: 'request-1' }).status, 'unknown');
  assert.equal(h.apply('resume', 'request-1', h.events[0].operationId).status, 'unknown');
  h.paint(composer);
  assert.deepEqual(h.counters, before);
  assert.deepEqual(h.writes, ['\r']);
});

test('a new operational turn alone is not a Goal selection receipt', async () => {
  const h = fixture(); await h.manual();
  h.apply(); await tick();
  assert.equal(h.controller.observeOperationalTurn('T', 'B'), true);
  assert.equal(h.controller.read('T'), null, 'ordinary live queue capability remains');
  const result = h.controller.readGoalAction('T', { requestId: 'request-1' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.choiceConfirmed, false);
  h.paint(); await tick(); assert.deepEqual(h.writes, ['\r']);
});

test('a composer caused by another input cannot confirm the old Goal action', async () => {
  const h = fixture(); await h.manual();
  h.apply(); await tick();
  h.owner.inputRevision++;
  h.paint(composer);
  const result = h.controller.readGoalAction('T', { requestId: 'request-1' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.composerReady, false);
  assert.equal(result.choiceConfirmed, false);
});

for (const kind of ['older', 'same-sequence-changed', 'different-goal', 'uncommitted']) {
  test('rejects stale or unproved frame: ' + kind, async () => {
    const h = fixture(); await h.manual();
    if (kind === 'older') h.replaceFrame({ seq: h.frame.seq - 1 });
    if (kind === 'same-sequence-changed') h.replaceFrame({ text: selectedMenu(2) });
    if (kind === 'different-goal') h.replaceFrame({ seq: h.frame.seq + 1, text: menu.replace('current task', 'another task') });
    if (kind === 'uncommitted') h.replaceFrame({ valid: false });
    h.apply(); await tick();
    assert.deepEqual(h.writes, []);
    assert.equal(h.controller.readGoalAction('T', { requestId: 'request-1' }).choiceConfirmed, false);
    if (kind === 'uncommitted') {
      await h.expire(100);
      assert.equal(h.controller.read('T').phase, 'manual');
      assert.deepEqual(h.writes, []);
    }
  });
}

test('frame changes at the final guard do not authorize Enter on the replacement composer', async () => {
  const h = fixture(); await h.manual();
  h.options.beforeWrite = ({ replaceFrame, frame }) => replaceFrame({ seq: frame.seq + 1, text: composer });
  h.apply(); await tick();
  assert.deepEqual(h.writes, []);
  assert.equal(h.controller.readGoalAction('T', { requestId: 'request-1' }).actionAttempted, false);
});

test('a guard-refused Enter never resurrects a composer already observed at the write boundary', async () => {
  const h = fixture(); await h.manual();
  h.options.beforeWrite = ({ paint }) => paint(composer);
  h.apply(); await tick();
  assert.deepEqual(h.writes, []);
  assert.equal(h.controller.read('T'), null);
  const result = h.controller.readGoalAction('T', { requestId: 'request-1' });
  assert.equal(result.composerReady, true);
  assert.equal(result.actionAttempted, false);
  assert.equal(result.choiceConfirmed, false);
  assert.equal(result.status, 'unavailable');
  assert.equal(h.timers.size, 0);
});

test('a navigation write without a newer frame does not permit another arrow or Enter', async () => {
  const h = fixture({ selected: 2, noSelectionFrame: true }); await h.manual();
  h.apply(); await tick();
  const state = h.controller.readGoalAction('T', { requestId: 'request-1' });
  assert.equal(state.reason, 'option-selection-not-confirmed');
  assert.equal(state.keyWritten, true);
  assert.equal(state.actionWritten, false);
  assert.deepEqual(state.availableActions, []);
  h.apply(); h.apply('resume', 'another-request'); await tick();
  assert.deepEqual(h.writes, ['\x1b[A']);
});

test('Stop or a different Goal after navigation cannot receive Enter', async () => {
  for (const change of ['Stop', 'goal']) {
    const h = fixture({ selected: 2 }); await h.manual();
    h.options.afterWrite = ({ owner, key, paint }) => {
      if (key === '\r') return;
      if (change === 'Stop') owner.live = false;
      else paint(menu.replace('current task', 'replacement task'));
    };
    h.apply(); await tick();
    assert.deepEqual(h.writes, ['\x1b[A']);
    assert.equal(h.controller.readGoalAction('T', { requestId: 'request-1' }).choiceConfirmed, false);
  }
});

test('new input or a changed Goal gets a new manual operation, never an automatic extra Enter', async () => {
  for (const change of ['input', 'goal']) {
    const h = fixture(); const old = await h.manual();
    if (change === 'input') h.owner.inputRevision++;
    h.paint(change === 'goal' ? menu.replace('current task', 'another task') : selectedMenu(2));
    await tick();
    const current = h.controller.readGoalAction('T');
    assert.notEqual(current.operationId, old.operationId);
    assert.equal(current.status, 'available');
    assert.deepEqual(h.writes, []);
    assert.equal(h.apply('resume', 'old-snapshot', old.operationId).reason, 'stale-goal-operation');
    h.apply('leave-paused', 'current-snapshot', current.operationId); await tick();
    assert.equal(h.writes.filter(key => key === '\r').length, 1);
  }
});

test('no dialog, missing footer and ambiguous highlight cannot be turned into a native action', async () => {
  const absent = fixture();
  assert.equal(absent.apply('resume', 'none', 'not-an-operation').reason, 'no-goal-dialog');
  for (const text of [composer, menu.replace('Press enter to confirm or esc to go back', ''),
    menu.replace('  2.', '> 2.')]) {
    const h = fixture(); h.paint(text); await tick();
    const state = h.controller.readGoalAction('T');
    assert.deepEqual(state.availableActions, []);
    const result = h.apply('resume', 'unproved', state.operationId || 'missing');
    assert.equal(result.accepted, false);
    assert.deepEqual(h.writes, []);
  }
});

test('explicit choice invalidates the older unwritten automatic work still waiting in the same lock', async () => {
  const h = fixture({ selected: 2 });
  const release = h.hold();
  h.paint(); await h.expire(100);
  h.apply('resume');
  release(); await tick();
  assert.deepEqual(h.writes, ['\x1b[A', '\r'], 'only the explicit Resume, not old automatic Leave paused');
});

test('operation identity does not collide across controller restart or clear', async () => {
  const first = fixture(); const old = await first.manual();
  const second = fixture(); const next = await second.manual();
  assert.notEqual(old.operationId, next.operationId);
  assert.equal(second.apply('resume', 'old-request', old.operationId).reason, 'stale-goal-operation');
  second.controller.clear('T');
  const recreated = await second.manual();
  assert.notEqual(next.operationId, recreated.operationId);
  assert.deepEqual(second.writes, []);
});

test('bounded request receipts never evict a used requestId to make it executable again', async () => {
  const h = fixture({ maxGoalActionRequests: 1 }); await h.manual();
  h.apply('resume', 'retained'); await tick();
  assert.equal(h.apply('leave-paused', 'overflow').reason, 'goal-request-capacity');
  assert.equal(h.apply('resume', 'retained').replayed, true);
  assert.equal(h.apply('leave-paused', 'retained').reason, 'goal-request-conflict');
  assert.deepEqual(h.writes, ['\r']);
});

test('only explicit native options and complete identities are accepted', async () => {
  const h = fixture(); const state = await h.manual();
  for (const change of [{ action: 'stop' }, { action: 'stop-goal' }, { requestId: '' },
    { requestId: 'line\nbreak' }, { requestId: 'x'.repeat(257) }, { operationId: '' }]) {
    const result = h.controller.applyGoalAction('T', {
      operationId: state.operationId, requestId: 'valid', action: 'resume', ...change,
    });
    assert.equal(result.reason, 'invalid-goal-action');
  }
  assert.deepEqual(h.writes, []);
  assert.equal(h.counters.stops, 0);
});
