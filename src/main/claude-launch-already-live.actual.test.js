'use strict';
// Decision 01.11 (Fedor): "состояния должны складываться" — two launch requests
// for one tab add up. On restore, AutoResume and Run After both ask; the first
// starts Claude, the second finds THAT SAME session alive and must simply join
// the live launch. Pre-fix it surfaced as a red "Claude start failed · Claude
// session is already starting/running" card while the Run After message was in
// fact delivered one second later (01.11 03:46:02, tab 876b4ac1376c).
//
// A session owned by a DIFFERENT tab or an external process is still a real
// refusal: starting a second writer on one transcript corrupts it.
//
// Real registry + the real renderer reducer that paints the card.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createAgentLaunchPreparationRegistry } = require('./agent-launch-preparation');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const TAB = 'tab-65f4bd3d-2c82-493f-b291-876b4ac1376c';
const SESSION = '70009b47-0000-4000-8000-000000000000';

function registry() {
  const states = [];
  const api = createAgentLaunchPreparationRegistry({ onChange: (state) => states.push(state) });
  return { api, states, last: () => states.at(-1) };
}

const begin = (api) => api.begin({
  tabId: TAB, toolType: 'claude', sessionId: SESSION,
  command: 'claude-c', phase: 'repairing-history', reason: 'resume-requested',
});

test('joining this tab\'s own live launch leaves no rejection for the UI', () => {
  const { api, last } = registry();
  const preparation = begin(api);
  assert.equal(api.finish(TAB, preparation.token, {
    accepted: false, joined: true, reason: 'launch-already-live', error: null,
  }), true);
  const state = last();
  assert.equal(state.preparing, false);
  assert.equal(state.accepted, false);
  assert.equal(state.cleared, true, 'a join is cleared, not a failure');
  assert.equal(state.error ?? null, null);
  assert.equal(state.reason, 'launch-already-live');
});

test('a real refusal still keeps its exact error', () => {
  const { api, last } = registry();
  const preparation = begin(api);
  api.finish(TAB, preparation.token, {
    accepted: false, reason: 'launch-rejected', error: 'Claude session is already starting/running',
  });
  const state = last();
  assert.equal(state.cleared ?? false, false);
  assert.equal(state.accepted, false);
  assert.equal(state.error, 'Claude session is already starting/running');
});

test('the renderer paints a card for the refusal and nothing for the join', async () => {
  const { applyAgentLaunchPreparationSnapshot, describeLaunchPreparationFailure } =
    await import('../renderer/utils/sessionStartingState.mjs');
  const info = { tabId: TAB, engine: 'claude', sessionId: SESSION };
  const { api, last } = registry();

  const refused = begin(api);
  api.finish(TAB, refused.token, { accepted: false, reason: 'launch-rejected',
    error: 'Claude session is already starting/running' });
  const refusedState = applyAgentLaunchPreparationSnapshot(null, info, last());
  assert.equal(refusedState.launchPreparationStatus, 'rejected');
  assert.deepEqual(describeLaunchPreparationFailure(refusedState), {
    subtitle: 'Claude session is already starting/running',
    detail: 'The saved Claude session was not changed',
  });

  const joined = begin(api);
  api.finish(TAB, joined.token, { accepted: false, joined: true, reason: 'launch-already-live' });
  // Pre-fix this produced the same rejected state and the same red card.
  assert.equal(applyAgentLaunchPreparationSnapshot(refusedState, info, last()), null,
    'the join clears the previous presentation instead of adding a failure');
});

test('wired: only this tab\'s own live owner joins; another owner stays a refusal', () => {
  assert.ok(main.includes("const sameTabOwner = repairResult?.reason === 'claude-jsonl-owner-alive'\n"
    + '            && !!repairResult.ownerTabId && repairResult.ownerTabId === tabId;'),
    'the join requires the live owner to be THIS tab');
  assert.ok(main.includes("...(sameTabOwner ? { alreadyLaunching: true, code: 'claude_launch_already_live' } : {}),"));
  assert.ok(main.includes("const joined = result?.alreadyLaunching === true && result?.accepted !== true;"));
  assert.ok(main.includes("joined,\n        reason: result?.accepted === true ? 'launch-accepted'\n"
    + "          : joined ? 'launch-already-live' : 'launch-rejected',"));
  // The caller still learns the launch did not happen here and waits for the
  // one already running; the join must not fake an acceptance.
  assert.ok(main.includes('            success: false,\n            accepted: false,\n'
    + "            ...(sameTabOwner ? { alreadyLaunching: true, code: 'claude_launch_already_live' } : {}),"));
});
