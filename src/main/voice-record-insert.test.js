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

test('authenticated identity overrides stale discovery and pins the only POST to the live process', async t => {
  const f = fixture(t), calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/api/me') ? {
      ok: true, pid: 987, application: 'voice-record', capabilities: { recordingInsert: { version: 1 } },
    } : { ok: true } };
  };
  assert.deepEqual(await insertTabIdsInVoiceRecord(['project-tab-8'], { ...f, fetchImpl }), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body), { tabIds: ['project-tab-8'], targetPid: 987 });
});

test('old version is an explicit update error and receives no mutation', async t => {
  const f = fixture(t), calls = [];
  const result = await insertTabIdsInVoiceRecord(['tab-8'], { ...f, fetchImpl: async url => {
    calls.push(url); return { ok: true, json: async () => ({ ok: true }) };
  } });
  assert.equal(result.ok, false);
  assert.match(result.error, /Обновите Voice Record/);
  assert.deepEqual(calls, ['http://127.0.0.1:12345/api/me']);
});

test('closed recording and thrown network errors surface honestly without retries', async t => {
  const f = fixture(t);
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/me')) return { ok: true, json: async () => ({ ok: true, application: 'voice-record', pid: 987, capabilities: { recordingInsert: { version: 1 } } }) };
    posts++;
    return { ok: false, json: async () => ({ ok: false, error: 'нет активной записи' }) };
  };
  assert.deepEqual(await insertTabIdsInVoiceRecord(['tab-8'], { ...f, fetchImpl }), { ok: false, error: 'нет активной записи' });
  assert.equal(posts, 1);
});
