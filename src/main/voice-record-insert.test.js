const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { insertTabIdsInVoiceRecord } = require('./voice-record-insert');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-insert-discovery-'));
  fs.writeFileSync(path.join(directory, 'web-token.txt'), 'fixture-only');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const row = (pid, updatedAt) => fs.writeFileSync(path.join(directory, `voice-web-server-${pid}.json`), JSON.stringify({ pid, port: 12345, updatedAt }));
  row(987, 1); row(555, 2); // stale file is newer, points at the same port
  return { directory };
}

test('actual orchestration/fork IDs cross discovery and the single recording POST unchanged', async t => {
  const f = fixture(t), calls = [];
  const ids = [
    'new_project_1770989259412_9ryw9s-tab-orchestration-9943cdb9-cb5d-4497-9c14-d8bb746ece32',
    'project-tab-orchestration-run-a',
    'project-tab-fork-9943cdb9-cb5d-4497-9c14-d8bb746ece32',
    'L1VzZXJzL2ZlZG9yL0Rlc2t0b3AvY3VzdG9tLXRlcm1pbmFs-tab-3951',
    'tab-8',
  ];
  const result = await insertTabIdsInVoiceRecord(ids, { ...f, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/api/me')
      ? { ok: true, application: 'voice-record', pid: 987, capabilities: { recordingInsert: { version: 2 } } }
      : { ok: true } };
  } });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body).tabIds, ids);
});

test('malformed or oversized IDs fail before discovery or a recording request', async () => {
  for (const id of ['tab-1x', 'project-tab-', 'project-tab-a\nother', 'project-tab-a\n', 'project-tab-a\u2028', 'project-tab-a\0', 'project-tab-a b', 'project-tab-' + 'x'.repeat(1024)]) {
    const result = await insertTabIdsInVoiceRecord([id], { directory: '/nonexistent-discovery', fetchImpl: () => assert.fail('no network') });
    assert.deepEqual(result, { ok: false, error: 'Некорректный ID вкладки' }, id);
  }
});

test('authenticated identity overrides stale discovery and pins the only POST to the live process', async t => {
  const f = fixture(t), calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/api/me') ? {
      ok: true, pid: 987, application: 'voice-record', capabilities: { recordingInsert: { version: 2 } },
    } : { ok: true } };
  };
  assert.deepEqual(await insertTabIdsInVoiceRecord(['project-tab-8'], { ...f, fetchImpl }), { ok: true });
  assert.equal(calls.length, 2);
  const payload = JSON.parse(calls[1].options.body);
  assert.ok(payload.expiresAt > Date.now());
  delete payload.expiresAt;
  assert.deepEqual(payload, { tabIds: ['project-tab-8'], targetPid: 987 });
});

test('old version is an explicit update error and receives no mutation', async t => {
  const f = fixture(t), calls = [];
  const result = await insertTabIdsInVoiceRecord(['tab-8'], { ...f, fetchImpl: async url => {
    calls.push(url); return { ok: true, json: async () => ({ ok: true, application: 'voice-record', pid: 987, capabilities: { recordingInsert: { version: 1 } } }) };
  } });
  assert.equal(result.ok, false);
  assert.match(result.error, /Обновите Voice Record/);
  assert.deepEqual(calls, ['http://127.0.0.1:12345/api/me']);
});

test('closed recording and thrown network errors surface honestly without retries', async t => {
  const f = fixture(t);
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/me')) return { ok: true, json: async () => ({ ok: true, application: 'voice-record', pid: 987, capabilities: { recordingInsert: { version: 2 } } }) };
    posts++;
    return { ok: false, json: async () => ({ ok: false, error: 'нет активной записи' }) };
  };
  assert.deepEqual(await insertTabIdsInVoiceRecord(['tab-8'], { ...f, fetchImpl }), { ok: false, error: 'нет активной записи' });
  assert.equal(posts, 1);
});

 test('timestamp crosses IPC client unchanged; absence of a live app never triggers an app launch', async t => {
  const f = fixture(t), sent = [];
  const timestamp = Date.parse('2026-09-26T23:59:59Z');
  const result = await insertTabIdsInVoiceRecord(['tab-8'], { ...f, timestamp, fetchImpl: async (url, options) => {
    if (url.endsWith('/api/me')) return { ok: true, json: async () => ({ ok: true, application: 'voice-record', pid: 987, capabilities: { recordingInsert: { version: 2 } } }) };
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  assert.equal(result.ok, true);
  assert.equal(sent[0].timestamp, timestamp);
  assert.deepEqual(await insertTabIdsInVoiceRecord(['tab-8'], { ...f, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), { ok: false, error: 'Voice Record не запущен' });
});
