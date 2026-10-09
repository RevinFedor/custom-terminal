import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutoCompactCoordinator } from './autoCompactCoordinator.mjs';
import { normalizeAutoCompactPolicy, automationWorkflowForProject, autoCompactIncludesTarget,
  autoCompactContextDecision, UNPLACED_AUTOMATION_WORKFLOW } from './autoCompactPolicy.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(overrides = {}) {
  let policy = normalizeAutoCompactPolicy({ enabled: true, armedAt: 100, workflowIds: ['main'] });
  let target = { tabId: 'A', provider: 'codex', sessionId: 'S', workflowId: 'main' };
  let snapshot = { exact: true, sessionId: 'S', pct: 60, observedAt: 200 };
  let readiness = { ready: true, status: 'active' };
  const events = [];
  let blocked = false;
  const coordinator = createAutoCompactCoordinator({
    startedAt: 50, policy: () => policy, target: () => target,
    readiness: async () => readiness, context: async () => snapshot,
    blocked: () => blocked, compact: async () => { events.push('compact'); },
    resume: async () => { events.push('resume'); readiness = { ready: true, status: 'active' }; },
    activity: (_tab, state) => { if (state) events.push(state.phase); },
    failure: (_tab, error) => events.push('error:' + error), release: () => events.push('release'),
    ...overrides,
  });
  const outcome = { at: 250, turnStartedAt: 150, live: true, natural: true, compact: false };
  return { coordinator, events, outcome,
    run: (patch = {}) => coordinator.intercept('A', { ...outcome, ...patch }, () => events.push('continue')),
    policy: (patch) => { policy = { ...policy, ...patch }; coordinator.policyChanged(); },
    target: (patch) => { target = { ...target, ...patch }; },
    snapshot: (patch) => { snapshot = { ...snapshot, ...patch }; },
    readiness: (value) => { readiness = value; }, blocked: (value) => { blocked = value; },
  };
}

test('scope follows directory ownership, independent of placement and focused workflow', () => {
  const spaces = [{ id: 'main', projectIds: ['project'] }, { id: 'other', projectIds: ['elsewhere'] }];
  assert.equal(automationWorkflowForProject(spaces, 'project'), 'main');
  assert.equal(automationWorkflowForProject(spaces, 'forgotten'), UNPLACED_AUTOMATION_WORKFLOW);
  const p = normalizeAutoCompactPolicy({ allWorkflows: true });
  assert.equal(autoCompactIncludesTarget(p, { tabId: 'A', provider: 'claude', workflowId: UNPLACED_AUTOMATION_WORKFLOW }), false);
});
test('old idle, restore, failure and compact completion do not create automatic work', () => {
  for (const patch of [{ at: 99 }, { live: false }, { natural: false }, { compact: true }]) {
    const h = harness(); assert.equal(h.run(patch), false); assert.equal(h.coordinator.has('A'), false);
  }
});
test('new completion reserves owner before async check and continues only after compact proof', async () => {
  let finish;
  const proof = new Promise((resolve) => { finish = resolve; });
  const h = harness({ compact: () => proof });
  assert.equal(h.run(), true);
  assert.equal(h.coordinator.has('A'), true);
  await tick(); assert.equal(h.events.includes('continue'), false);
  finish(); await tick();
  assert.equal(h.coordinator.has('A'), false);
  assert.equal(h.events.filter((s) => s === 'continue').length, 1);
  assert.equal(h.run(), false, 'repeated outcome must not send twice');
});

test('accepted process Stop retires a submitted compact observer quietly without continuing Run After', async () => {
  for (const outcome of ['completed', 'aborted']) {
    let resolve, reject;
    const h = harness({ compact: () => new Promise((yes, no) => { resolve = yes; reject = no; }) });
    h.run(); await tick();
    assert.equal(h.coordinator.cancel('A'), false, 'ordinary Cancel still cannot cancel submitted compact');
    assert.equal(h.coordinator.stop('A'), true);
    assert.equal(h.coordinator.has('A'), false);
    h.readiness({ ready: false, status: 'inactive' });
    const before = [...h.events];
    if (outcome === 'completed') resolve(); else reject(new Error('manual-stop'));
    await tick();
    assert.deepEqual(h.events, before, 'late exact outcome cannot publish activity/error or release old continuation');
    assert.equal(h.events.includes('continue'), false);
    assert.equal(h.events.includes('release'), false);
    assert.equal(h.run({ at: 350 }), true, 'future eligible turn retains the existing policy');
    h.coordinator.dispose();
  }
});

test('accepted process Stop during AutoCompact Resume cannot later send compact', async () => {
  let finishResume;
  const h = harness({ resume: () => new Promise(resolve => { finishResume = resolve; }) });
  h.readiness({ ready: false, status: 'inactive' });
  const result = h.coordinator.request('A', { resume: true }); await tick();
  h.coordinator.stop('A'); h.readiness({ ready: true, status: 'active' });
  const before = [...h.events]; finishResume({ sessionId: 'S' }); await tick();
  assert.deepEqual(await result, { skipped: 'manual-stop' });
  assert.deepEqual(h.events, before);
});
test('a low percentage releases the original continuation without sending', async () => {
  const h = harness(); h.snapshot({ pct: 49 }); h.run(); await tick();
  assert.equal(h.events.includes('compact'), false); assert.equal(h.events.includes('continue'), true);
});
test('unknown or pre-turn context waits for new data without inventing zero', async () => {
  const h = harness(); h.snapshot({ observedAt: 120 }); h.run(); await tick();
  assert.equal(h.coordinator.has('A'), true); assert.equal(h.events.includes('compact'), false);
  h.snapshot({ observedAt: 240 }); h.coordinator.wake('A'); await tick();
  assert.equal(h.events.filter((e) => e === 'compact').length, 1);
});
test('an exclusion survives global off/on and prevents a new request', () => {
  const h = harness(); h.policy({ excludedTabIds: ['A'] });
  h.policy({ enabled: false }); h.policy({ enabled: true }); assert.equal(h.run(), false);
});
test('changing scope while context is being read cancels before send', async () => {
  let resolve;
  const h = harness({ context: () => new Promise((done) => { resolve = done; }) });
  h.run(); await tick(); h.policy({ workflowIds: ['other'] });
  resolve({ exact: true, sessionId: 'S', pct: 90, observedAt: 220 }); await tick();
  assert.equal(h.events.includes('compact'), false); assert.equal(h.coordinator.has('A'), false);
});
test('session replacement cannot receive the previous response compact', async () => {
  const h = harness(); h.blocked(true); h.run(); h.target({ sessionId: 'replacement' });
  h.blocked(false); h.coordinator.wake('A'); await tick();
  assert.equal(h.events.includes('compact'), false); assert.equal(h.events.includes('continue'), false);
});
test('ordinary automation never resumes stopped sessions; explicit selected session can', async () => {
  const h = harness(); h.readiness({ ready: false, status: 'inactive' }); h.run(); await tick();
  assert.equal(h.events.includes('resume'), false);
  const result = await h.coordinator.request('A', { resume: true });
  assert.equal(result.completed, true); assert.equal(h.events.includes('resume'), true);
});
test('editing pauses the candidate, unlock checks the current percentage', async () => {
  const h = harness(); h.blocked(true); h.run(); await tick();
  h.snapshot({ pct: 20 }); h.blocked(false); h.coordinator.wake('A'); await tick();
  assert.equal(h.events.includes('compact'), false); assert.equal(h.events.includes('continue'), true);
});
test('explicit resume may adopt the new session proven by its result, never an unrelated replacement', async () => {
  let h;
  h = harness({ resume: async () => {
    h.target({ sessionId: 'resumed-child' });
    h.snapshot({ sessionId: 'resumed-child' });
    h.readiness({ ready: true, status: 'active' });
    return { success: true, sessionId: 'resumed-child' };
  } });
  h.readiness({ ready: false, status: 'inactive' });
  assert.equal((await h.coordinator.request('A', { resume: true })).completed, true);
  const foreign = harness({ resume: async () => {
    foreign.target({ sessionId: 'unrelated' });
    return { success: true, sessionId: 'expected-child' };
  } });
  foreign.readiness({ ready: false, status: 'inactive' });
  assert.match((await foreign.coordinator.request('A', { resume: true })).error, /Сессия изменилась/);
});
test('error keeps the continuation unsent and reports its actual cause', async () => {
  const h = harness({ compact: async () => { throw new Error('provider-error'); } });
  h.run(); await tick();
  assert.equal(h.events.includes('error:provider-error'), true); assert.equal(h.events.includes('continue'), false);
});
test('repeated explicit apply joins one pending request', async () => {
  const h = harness(); h.blocked(true);
  const a = h.coordinator.request('A'); const b = h.coordinator.request('A'); assert.equal(a, b);
  h.coordinator.cancel('A'); assert.equal((await a).skipped, 'cancelled');
});
test('new unrelated task cannot complete a cancelled candidate asynchronously', async () => {
  let resolve;
  const h = harness({ context: () => new Promise((done) => { resolve = done; }) });
  h.run(); await tick(); h.coordinator.cancel('A', false);
  resolve({ exact: true, sessionId: 'S', pct: 90, observedAt: 220 }); await tick();
  assert.equal(h.events.includes('compact'), false); assert.equal(h.events.includes('continue'), false);
});
test('context decision accepts a true zero but rejects a foreign session', () => {
  assert.equal(autoCompactContextDecision({ exact: true, sessionId: 'S', pct: 0, observedAt: 3 }, { sessionId: 'S', percent: 50 }), 'skip');
  assert.equal(autoCompactContextDecision({ exact: true, sessionId: 'OTHER', pct: 90, observedAt: 3 }, { sessionId: 'S', percent: 50 }), 'wait');
});
test('unrelated workspace updates do not poll the context reader', async () => {
  let reads = 0;
  const h = harness({ context: async () => { reads += 1; return { exact: false }; } });
  h.run(); await tick();
  for (let n = 0; n < 100; n += 1) h.coordinator.targetsChanged();
  await tick(); assert.equal(reads, 1);
  h.coordinator.cancel('A');
});
test('a later native queued reply replaces a still-waiting completion, including its context freshness boundary', async () => {
  const h = harness(); h.blocked(true); h.run();
  h.coordinator.intercept('A', { ...h.outcome, at: 450, turnStartedAt: 300 }, () => h.events.push('continue-new'));
  h.blocked(false); h.coordinator.wake('A'); await tick();
  assert.equal(h.events.includes('compact'), false, 'old context snapshot cannot qualify the later reply');
  h.snapshot({ observedAt: 440 }); h.coordinator.wake('A'); await tick();
  assert.equal(h.events.includes('continue'), false);
  assert.equal(h.events.includes('continue-new'), true);
});
test('compact proof before the busy=false event preserves the original response continuation', async () => {
  let h;
  h = harness({ compact: async () => { h.blocked(true); } });
  h.run(); await tick();
  assert.equal(h.coordinator.has('A'), true);
  assert.equal(h.events.includes('continue'), false);
  h.coordinator.intercept('A', { ...h.outcome, compact: true, natural: false, at: 400 }, () => h.events.push('compact-edge'));
  h.blocked(false); h.coordinator.wake('A'); await tick();
  assert.equal(h.events.filter((event) => event === 'continue').length, 1);
  assert.equal(h.events.includes('compact-edge'), false);
});
