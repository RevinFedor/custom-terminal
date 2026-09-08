const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentSettingsActivity } = require('./agent-settings-activity');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('old completion cannot clear another outstanding settings operation', () => {
  const events = [];
  const activity = createAgentSettingsActivity({ publish: state => events.push(state) });
  const a = activity.begin({ tabId: 'T', target: 'model', toolType: 'codex' });
  const b = activity.begin({ tabId: 'T', target: 'effort', toolType: 'codex' });
  activity.end(a);
  assert.equal(activity.read('T').busy, true);
  assert.equal(activity.read('T').target, 'effort');
  assert.equal(activity.end(a), false);
  activity.end(b);
  assert.equal(activity.read('T').busy, false);
  assert.ok(events.every((event, i) => !i || event.sequence > events[i - 1].sequence));
});

test('activity survives a reader unmount and is scoped to the live process generation', () => {
  let generation = 'A';
  const activity = createAgentSettingsActivity({ isCurrent: (_tab, runtime) => runtime === generation });
  const token = activity.begin({ tabId: 'T', target: 'effort', toolType: 'claude', runtime: 'A' });
  assert.equal(activity.read('other-T').busy, false);
  assert.equal(activity.read('T').busy, true);
  generation = 'B';
  assert.equal(activity.read('T').busy, false);
  activity.end(token);
});

test('only actual scenario settlement ends activity, not paste or Enter callbacks', async () => {
  let release;
  const proof = new Promise(resolve => { release = resolve; });
  const activity = createAgentSettingsActivity();
  const work = activity.run({ tabId: 'T', target: 'model' }, () => proof);
  await Promise.resolve();
  assert.equal(activity.read('T').busy, true);
  release({ success: true, proof: 'applied' });
  await work;
  assert.equal(activity.read('T').busy, false);
  await assert.rejects(activity.run({ tabId: 'T' }, () => { throw new Error('not confirmed'); }));
  assert.equal(activity.read('T').busy, false, 'error is settlement, not success');
});

test('actual Codex picker request is busy during asynchronous config lookup, before any PTY write', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('async function executeCodexSelectModelEffortRequest(');
  const end = source.indexOf("\nipcMain.handle('codex:select-model-effort'", start);
  const activity = createAgentSettingsActivity();
  let release;
  const lookup = new Promise(resolve => { release = resolve; });
  const fn = vm.runInNewContext(source.slice(start, end) + '\nexecuteCodexSelectModelEffortRequest', {
    terminals: new Map([['T', {}]]), agentSettingsActivity: activity,
    beginAgentSettingsActivity: (tabId, toolType, target) => activity.begin({ tabId, toolType, target }),
    resolveActiveCodexConfigForTab: () => lookup,
    AI_PROCESS_LOOKUP_STATUS: { UNKNOWN: 'unknown' }, console: { log() {}, warn() {} },
  });
  const work = fn({}, { tabId: 'T', model: 'gpt-5.6-luna', effort: 'medium', settingsControl: 'effort' });
  assert.equal(activity.read('T').busy, true);
  assert.equal(activity.read('T').target, 'effort');
  release({ status: 'unknown' });
  const result = await work;
  assert.equal(result.success, false);
  assert.equal(activity.read('T').busy, false);
});
