'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdleSessionStop } = require('./idle-session-stop');

function fixture(options = {}) {
  let time = 100_000, id = 0;
  const timers = new Map(), calls = [], publications = [], saved = [];
  const rows = new Map(['A', 'B'].map(tabId => [tabId, { tabId, scope: tabId + ':1', workflowId: 'work',
    owner: { live: true, token: {} }, known: true, idle: true, completedAt: 90_000, activityKey: 'one' }]));
  const service = createIdleSessionStop({ now: () => time,
    readPolicy: () => ({ workflowIds: ['work'], minutes: 1 }), savePolicy: value => saved.push(value),
    capture: tabId => structuredRows(tabId ? [rows.get(tabId)].filter(Boolean) : [...rows.values()]),
    sameOwner: (a, b) => b?.live && a.token === b.token,
    observe: async () => ({ known: true }),
    stop: async (tabId, owner, proof, guard) => {
      const verdict = guard(); if (!verdict.allowed) return { success: false, guardRejected: true, error: verdict.reason };
      calls.push(tabId); rows.get(tabId).owner.live = false; return { success: true };
    }, publish: value => publications.push(value),
    setTimer: (callback, delay) => { timers.set(++id, { callback, at: time + delay }); return id; },
    clearTimer: key => timers.delete(key), ...options,
  });
  function structuredRows(values) { return values.map(row => ({ ...row, owner: { ...row.owner } })); }
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const advance = async to => {
    time = to;
    const due = [...timers].filter(([, timer]) => timer.at <= time);
    for (const [key, timer] of due) { timers.delete(key); timer.callback(); }
    await flush();
  };
  return { service, rows, calls, publications, saved, timers, advance, flush };
}

test('already idle deadline uses last completion; each selected process is stopped once', async () => {
  const f = fixture(); f.rows.get('B').workflowId = 'other';
  f.service.refresh(); assert.equal(f.service.snapshot().states.A.deadline, 150_000);
  await f.advance(149_999); assert.deepEqual(f.calls, []);
  await f.advance(150_000); assert.deepEqual(f.calls, ['A']);
  assert.equal(f.service.snapshot().states.A.phase, 'inactive');
  f.service.refresh(); await f.advance(999_999); assert.deepEqual(f.calls, ['A']);
  assert.equal(f.rows.has('A'), true, 'Stop never deletes a tab');
});

test('busy cancels countdown; later completion starts a new complete interval', async () => {
  const f = fixture(); f.rows.delete('B'); f.service.refresh();
  f.rows.get('A').idle = false; f.service.refresh();
  await f.advance(160_000); assert.deepEqual(f.calls, []);
  f.rows.get('A').idle = true; f.rows.get('A').completedAt = 160_000; f.service.refresh();
  assert.equal(f.service.snapshot().states.A.deadline, 220_000);
  await f.advance(220_000); assert.deepEqual(f.calls, ['A']);
});

test('new rules can exclude already idle; a newly observed busy→idle response remains eligible', async () => {
  const f = fixture(); f.rows.delete('B'); f.service.update({ includeAlreadyIdle: false });
  await f.advance(200_000); assert.deepEqual(f.calls, []);
  f.rows.get('A').idle = false; f.service.refresh();
  f.rows.get('A').idle = true; f.rows.get('A').completedAt = 200_000; f.service.refresh();
  assert.equal(f.service.snapshot().states.A.deadline, 260_000);
});

test('unknown/busy/moved/changed owner during observation never signals a process', async () => {
  for (const change of [row => { row.known = false; }, row => { row.idle = false; },
    row => { row.workflowId = 'other'; }, row => { row.scope = 'replacement'; },
    row => { row.owner.token = {}; }, row => { row.activityKey = 'new-preparation'; },
    row => { row.completedAt = 150_000; }]) {
    let f; f = fixture({ observe: async () => { change(f.rows.get('A')); return { known: true }; } });
    f.rows.delete('B'); f.service.refresh(); await f.advance(150_000);
    assert.deepEqual(f.calls, []);
  }
});

test('final signal guard rejects new work after process proof', async () => {
  let f; f = fixture({ stop: async (id, owner, proof, guard) => {
    f.rows.get(id).idle = false;
    assert.equal(guard().allowed, false); return { success: false, guardRejected: true };
  } });
  f.rows.delete('B'); f.service.refresh(); await f.advance(150_000); assert.deepEqual(f.calls, []);
});

test('clear scope and disposal revoke an asynchronous Stop already checking', async () => {
  for (const cancel of [f => f.service.update({ workflowIds: [], allWorkflows: false }), f => f.service.dispose()]) {
    let release; const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ observe: async () => { await pending; return { known: true }; } });
    f.rows.delete('B'); f.service.refresh(); await f.advance(150_000);
    assert.equal(f.service.snapshot().states.A.phase, 'checking');
    cancel(f); release(); await f.flush(); assert.deepEqual(f.calls, []); assert.equal(f.timers.size, 0);
  }
});

test('unknown process/queue/draft proof does not create a retry loop; changed activity allows revalidation', async () => {
  let known = false; const f = fixture({ observe: async () => ({ known }) });
  f.rows.delete('B'); f.service.refresh(); await f.advance(150_000);
  assert.equal(f.service.snapshot().states.A.phase, 'waiting'); assert.equal(f.timers.size, 0);
  f.service.refresh(); assert.equal(f.timers.size, 0); assert.deepEqual(f.calls, []);
  known = true; f.rows.get('A').activityKey = 'proof-arrived'; f.service.refresh();
  await f.advance(150_000); assert.deepEqual(f.calls, ['A']);
});

test('policy survives owner reload; dynamic All includes future workflows and selected empty does not', async () => {
  const f = fixture(); f.rows.get('B').workflowId = 'future'; f.service.update({ allWorkflows: true });
  assert.deepEqual(Object.keys(f.service.snapshot().states), ['A', 'B']);
  const restored = fixture({ readPolicy: () => f.saved.at(-1) });
  assert.equal(restored.service.snapshot().policy.allWorkflows, true);
  f.service.update({ allWorkflows: false, workflowIds: [] });
  await f.advance(150_000); assert.deepEqual(f.calls, []);
});

test('publication sequence advances across runtime-only changes, so a late GET cannot rewind the view', () => {
  const f = fixture(); f.service.refresh(); const first = f.service.snapshot();
  f.rows.get('A').idle = false; f.service.refresh(); const second = f.service.snapshot();
  assert.equal(first.revision, second.revision); assert.ok(second.sequence > first.sequence);
});

test('excluding already idle does not treat startup readiness as a finished response', async () => {
  const f = fixture(); f.rows.delete('B'); const row = f.rows.get('A');
  row.completedAt = 0; row.idle = false; row.working = false;
  f.service.update({ includeAlreadyIdle: false });
  row.idle = true; f.service.refresh(); assert.equal(f.timers.size, 0);
  row.idle = false; row.working = true; f.service.refresh();
  row.idle = true; row.working = false; f.service.refresh();
  assert.equal(f.service.snapshot().states.A.deadline, 160_000);
  await f.advance(160_000); assert.deepEqual(f.calls, ['A']);
});

test('failed persistence does not activate a policy and unknown idle cannot arm', () => {
  const f = fixture({ savePolicy: () => { throw Error('disk'); } });
  assert.throws(() => f.service.update({ allWorkflows: true }), /disk/);
  assert.equal(f.service.snapshot().policy.allWorkflows, false);
  for (const row of f.rows.values()) row.known = false;
  f.service.refresh(); assert.equal(f.timers.size, 0);
});

test('metadata revalidation cannot restart or lose an already observed idle interval', async () => {
  for (const includeAlreadyIdle of [true, false]) {
    const f = fixture(); f.rows.delete('B'); const row = f.rows.get('A');
    row.completedAt = 0; row.idle = false; row.working = true;
    f.service.update({ includeAlreadyIdle });
    row.idle = true; row.working = false; f.service.refresh();
    assert.equal(f.service.snapshot().states.A.deadline, 160_000);
    await f.advance(130_000); row.activityKey = 'unrelated-root-wake'; f.service.refresh();
    assert.equal(f.service.snapshot().states.A.deadline, 160_000);
    await f.advance(160_000); assert.deepEqual(f.calls, ['A']);
  }
});

test('changing minutes or adding another workflow preserves a selected tab idle clock', async () => {
  const f = fixture(); f.rows.get('B').workflowId = 'other'; const row = f.rows.get('A');
  row.completedAt = 0; row.idle = false; row.working = true;
  f.service.update({ includeAlreadyIdle: false });
  row.idle = true; row.working = false; f.service.refresh();
  await f.advance(130_000); f.service.update({ minutes: 2 });
  assert.equal(f.service.snapshot().states.A.deadline, 220_000);
  f.service.update({ workflowIds: ['work', 'other'] });
  assert.equal(f.service.snapshot().states.A.deadline, 220_000);
  assert.equal(f.service.snapshot().states.B.phase, 'waiting', 'newly included old idle is not armed');
  await f.advance(220_000); assert.deepEqual(f.calls, ['A']);
});
