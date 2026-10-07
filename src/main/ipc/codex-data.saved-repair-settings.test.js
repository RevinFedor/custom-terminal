'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-repair-settings-'));
process.env.CODEX_HOME = fixtureHome;
const { _api: api } = require('./codex-data');
api.setCodexUsageStateStoreForTests({ db: { transaction: fn => fn },
  saveSessionForkEvent: () => ({ eventKey: 'repair-settings-fixture' }) });
test.after(() => fs.promises.rm(fixtureHome, { recursive: true, force: true }));

async function fixture(t) {
  const sid = crypto.randomUUID(), cwd = '/fixture/repair-settings';
  const dir = path.join(fixtureHome, 'sessions', '2026', '10', '06');
  await fs.promises.mkdir(dir, { recursive: true });
  const records = [{ type: 'session_meta', payload: { id: sid, session_id: sid, cwd } },
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'max' } }];
  for (const text of ['keep', 'rewind-here']) records.push(
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: text } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer ' + text }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } });
  records.push({ type: 'compacted', payload: { summary: 'old compact' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'orphan future' }] } });
  records.forEach((row, i) => { row.timestamp = new Date(1791234000000 + i * 1000).toISOString(); });
  const file = path.join(dir, 'rollout-2026-10-06T00-00-00-' + sid + '.jsonl');
  const bytes = records.map(row => JSON.stringify(row) + '\n').join('');
  await fs.promises.writeFile(file, bytes);
  const loaded = await api.loadSessionRecords(sid, cwd);
  const timeline = api.buildCodexTimeline(loaded.records, sid);
  const targetUuid = timeline.find(row => row.content === 'rewind-here').uuid;
  const endUuid = timeline.at(-1).uuid;
  const result = await api.deleteCodexRange({ sessionId: sid, cwd, startUuid: targetUuid, endUuid });
  assert.equal(result.success, true, JSON.stringify(result));
  const previous = { operationId: 'owned-previous', state: 'completed', toolType: 'codex', kind: 'rewind',
    historyMutated: true, bindingCommitted: true, newSessionId: result.newSessionId, endUuid,
    request: { expectedSessionId: sid, targetUuid }, resume: { launchWritten: true, launchId: 'owned-resume' } };
  const childBefore = await fs.promises.readFile(result.filePath);
  const settings = (patch = {}) => ({ type: 'event_msg', timestamp: new Date(Date.now() + 1000).toISOString(),
    payload: { type: 'thread_settings_applied', thread_settings: {
      model: 'gpt-6.1-sol', reasoning_effort: 'max', cwd, session_id: result.newSessionId,
    }, ...patch } });
  t.after(async () => assert.equal(await fs.promises.readFile(file, 'utf8'), bytes, 'original source never changes'));
  return { sid, cwd, previous, result, childBefore, settings,
    append: row => fs.promises.appendFile(result.filePath, JSON.stringify(row) + '\n'),
    inspect: extra => api.inspectCodexSavedRewindRepair({ previous, currentSessionId: result.newSessionId, cwd, ...extra }) };
}

test('actual COW followed by owned same-pair Resume settings remains repairable without a new user', async t => {
  const h = await fixture(t);
  assert.equal((await h.inspect()).success, true);
  await h.append(h.settings());
  const childBytes = await fs.promises.readFile(h.result.filePath);
  const result = await h.inspect();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.childSettingsProof.sessionId, h.result.newSessionId);
  assert.equal(result.childSettingsProof.model, 'gpt-6.1-sol');
  assert.equal(result.childSettingsProof.effort, 'max');
  assert.equal(result.proof.resumeSettingsRecords, 1);
  result.validateChild();
  assert.deepEqual(await fs.promises.readFile(h.result.filePath), childBytes, 'inspection never edits the old child');
});

test('native Resume record may inherit identity from its exact physical child rather than repeat SID fields', async t => {
  const h = await fixture(t), row = h.settings();
  delete row.payload.thread_settings.session_id;
  delete row.payload.thread_settings.cwd;
  await h.append(row);
  assert.equal((await h.inspect()).success, true);
});

for (const [name, mutate] of [
  ['no owned Resume write', h => { h.previous.resume.launchWritten = false; }],
  ['missing Resume lease', h => { delete h.previous.resume; }],
  ['changed model', (_h, row) => { row.payload.thread_settings.model = 'gpt-5.6-luna'; }],
  ['changed effort', (_h, row) => { row.payload.thread_settings.reasoning_effort = 'medium'; }],
  ['partial settings', (_h, row) => { delete row.payload.thread_settings.reasoning_effort; }],
  ['contradictory effort aliases', (_h, row) => { row.payload.thread_settings.effort = 'medium'; }],
  ['foreign nested SID', (_h, row) => { row.payload.thread_settings.session_id = 'foreign'; }],
  ['foreign payload SID', (_h, row) => { row.payload.source_session_id = 'foreign'; }],
  ['foreign root SID', (_h, row) => { row.session_id = 'foreign'; }],
  ['foreign cwd', (_h, row) => { row.payload.thread_settings.cwd = '/foreign'; }],
  ['cold authoring source is not Resume', (_h, row) => { row.payload.source = 'noted-terminal-history-context'; }],
  ['unknown provenance', (_h, row) => { row.payload.source = 'foreign-tool'; }],
  ['copied old timestamp', (_h, row) => { row.timestamp = '2000-01-01T00:00:00.000Z'; }],
  ['missing timestamp', (_h, row) => { delete row.timestamp; }],
]) test('Resume settings do not authorize repair: ' + name, async t => {
  const h = await fixture(t), row = h.settings();
  mutate(h, row); await h.append(row);
  const result = await h.inspect();
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(result.code, 'history_repair_child_has_new_work');
});

for (const [name, row] of [
  ['authored user', { type: 'event_msg', payload: { type: 'user_message', message: 'new work' } }],
  ['response user', { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new work' }] } }],
  ['tool call', { type: 'response_item', payload: { type: 'function_call', name: 'work', call_id: 'new', arguments: '{}' } }],
  ['tool result', { type: 'response_item', payload: { type: 'function_call_output', call_id: 'new', output: 'work' } }],
  ['assistant', { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'work' }] } }],
  ['task started', { type: 'event_msg', payload: { type: 'task_started' } }],
  ['task completed', { type: 'event_msg', payload: { type: 'task_complete' } }],
  ['rollback', { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }],
  ['compact', { type: 'compacted', payload: { summary: 'new' } }],
]) test('a real work record after accepted Resume settings still refuses repair: ' + name, async t => {
  const h = await fixture(t);
  await h.append(h.settings()); await h.append(row);
  assert.equal((await h.inspect()).success, false);
});

test('accepted Resume-settings proof loses write authority when the child changes afterward', async t => {
  const h = await fixture(t);
  await h.append(h.settings());
  const accepted = await h.inspect();
  assert.equal(accepted.success, true, JSON.stringify(accepted));
  await h.append({ type: 'event_msg', payload: { type: 'user_message', message: 'late work' } });
  assert.throws(() => accepted.validateChild(), /history_repair_child_changed/);
});

for (const [name, bytes] of [
  ['unfinished user', '{"type":"event_msg","payload":{"type":"user_message","message":"new work'],
  ['malformed complete row', 'not-json\n'],
]) test('unparsed physical work cannot disappear behind a Resume settings fact: ' + name, async t => {
  const h = await fixture(t);
  await h.append(h.settings());
  await fs.promises.appendFile(h.result.filePath, bytes);
  assert.equal((await h.inspect()).success, false);
});

test('blank physical suffix lines are harmless, not invented user work', async t => {
  const h = await fixture(t);
  await h.append(h.settings());
  await fs.promises.appendFile(h.result.filePath, '\n\n');
  assert.equal((await h.inspect()).success, true);
});
