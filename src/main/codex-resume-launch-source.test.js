'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexResumeSourceReader } = require('./codex-resume-source');
const api = require('./ipc/codex-data')._api;

const SID = '11111111-2222-4333-8444-555555555555';
const meta = patch => ({ type: 'session_meta', payload: { id: SID, ...patch } });
const settings = (model = 'source-model', effort = 'max') => ({ type: 'turn_context', payload: { model, effort } });
const event = (type, patch) => ({ type: 'event_msg', payload: { type, ...patch } });
const user = message => event('user_message', { message });
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const quiet = { log() {}, warn() {} };
const LIMIT = 64 * 1024 + 2 * 1024 * 1024;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-launch-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'rollout-' + SID + '.jsonl');
  let currentPath = filePath;
  let findCalls = 0;
  let onFind = null;
  const reader = createCodexResumeSourceReader({
    findSessionFile: async () => { findCalls++; await onFind?.(findCalls); return { filePath: currentPath }; },
    readJsonlRange: api.readJsonlRange, createTimelineProjector: api.createCodexTimelineProjector, log: quiet,
  });
  const write = (tail = [settings(), user('latest own prompt')], { header = meta(), megabytes = 4 } = {}) => {
    // Finite private VALID ignored tool rows, never production rollout bytes.
    const fd = fs.openSync(filePath, 'w');
    try {
      fs.writeSync(fd, jsonl([header, settings('old', 'low'), user('older user')]));
      const row = jsonl([{ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(1024 * 1024) } }]);
      for (let index = 0; index < megabytes; index++) fs.writeSync(fd, row);
      fs.writeSync(fd, jsonl(tail));
    } finally { fs.closeSync(fd); }
  };
  return { root, filePath, reader, write, setPath: next => { currentPath = next; },
    onFind: fn => { onFind = fn; },
    load: options => reader.load(SID, root, { purpose: 'launch', ...options }) };
}

test('launch purpose reads bounded header/tail, not a complete 32MiB tool history', async t => {
  const h = fixture(t); h.write(undefined, { megabytes: 32 });
  const result = await h.load();
  assert.equal(result.success, true, result.error);
  t.diagnostic('private sourceBytes=' + fs.statSync(h.filePath).size
    + ' readBytes=' + h.reader.stats().bytesRead + ' mode=' + result.mode);
  assert.ok(h.reader.stats().bytesRead <= LIMIT, 'launch must not scan the entire rollout');
  assert.equal(result.mode, 'launch-window');
  assert.equal(result.sourceSettingsProof.model, 'source-model');
  assert.equal(result.sourceSettingsProof.effort, 'max');
  assert.equal(result.sourceSettingsProof.recordIndex, null, 'tail ordinal is not a full-file ordinal');
  assert.equal(result.sourceMaterialization.materialized, true);
  assert.equal(result.sourceMaterialization.metadataOnly, false);
  assert.equal(result.sourceMaterialization.userRecords, null);
  assert.equal(result.sourceMaterialization.userTurns, null);
  assert.equal(result.parsedRecords, null, 'window counts are not global counts');
  assert.equal(Object.hasOwn(result, 'records'), false);
  assert.equal(h.reader.stats().views, 0, 'bounded proof never contaminates exact-count views');
});

test('launch bounded proof does not satisfy the default exact-count reader/cache', async t => {
  const h = fixture(t); h.write();
  const launch = await h.load();
  assert.equal(launch.sourceMaterialization.userTurns, null);
  const before = h.reader.stats().bytesRead;
  const exact = await h.load({ purpose: undefined });
  assert.equal(exact.mode, 'rebuild');
  assert.equal(exact.sourceMaterialization.userTurns, 2);
  assert.equal(exact.sourceMaterialization.userRecords, 2);
  assert.ok(h.reader.stats().bytesRead - before >= fs.statSync(h.filePath).size);
  const after = h.reader.stats().bytesRead;
  assert.equal((await h.load()).mode, 'unchanged', 'an existing exact version is reusable');
  assert.equal(h.reader.stats().bytesRead, after);
});

for (const [name, latest, expected] of [
  ['structured thread settings', event('thread_settings_applied', {
    thread_settings: { model: 'latest', reasoning_effort: 'high' } }), { status: 'found', model: 'latest', effort: 'high' }],
  ['incomplete latest pair', settings('latest', null), { status: 'invalid', reason: 'settings-pair-incomplete' }],
  ['conflicting latest effort aliases', { type: 'turn_context', payload: {
    model: 'latest', effort: 'low', reasoning_effort: 'max' } }, { status: 'invalid', reason: 'settings-effort-conflict' }],
]) test('bounded launch preserves latest semantics: ' + name, async t => {
  const h = fixture(t); h.write([settings(), user('own prompt'), latest]);
  const result = await h.load();
  assert.equal(result.mode, 'launch-window');
  for (const [key, value] of Object.entries(expected)) assert.equal(result.sourceSettingsProof[key], value);
  assert.equal(result.sourceSettingsProof.recordByteOffset,
    fs.statSync(h.filePath).size - Buffer.byteLength(jsonl([latest])));
});

test('complete tail preserves Unicode, escaped/duplicate keys and ignores malformed/unfinished lines', async t => {
  const h = fixture(t); h.write([settings(), user('🙂 русский input')]);
  fs.appendFileSync(h.filePath, '{bad}\n{"type":"turn_context","payload":{"model":"ignored","model":"последняя🙂","effort":"low","effort":"max"}}\n'
    + '{"type":"turn_context","payload":{"model":"unfinished"');
  const result = await h.load();
  assert.equal(result.mode, 'launch-window');
  assert.equal(result.sourceSettingsProof.model, 'последняя🙂');
  assert.equal(result.sourceSettingsProof.effort, 'max');
});

for (const [name, rows, bounded] of [
  ['canonical user', [user('ordinary')], true],
  ['response-only user', [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'response only' }] } }], true],
  ['image-only user', [event('user_message', { message: '', images: ['/private/fixture.png'] })], true],
  ['native Goal continuation', [user('<codex_internal_context source="goal">continue</codex_internal_context>')], true],
  ['service abort carrier', [user('<turn_aborted>\ninterrupted\n</turn_aborted>')], false],
  ['subagent service', [user('<subagent_notification>done</subagent_notification>')], false],
  ['environment service', [user('<environment_context>\nfixture\n</environment_context>')], false],
  ['project instructions', [user('# AGENTS.md instructions for /fixture\n<INSTRUCTIONS>fixture</INSTRUCTIONS>')], false],
  ['rollback with no later user', [user('removed'), event('thread_rolled_back', { num_turns: 1 })], false],
  ['rollback with later user', [user('removed'), event('thread_rolled_back', { num_turns: 1 }), user('kept')], true],
  ['all users rolled back', [event('thread_rolled_back', { num_turns: 999 })], false],
]) test('canonical history witness: ' + name, async t => {
  const h = fixture(t); h.write([settings(), ...rows]);
  const result = await h.load();
  assert.equal(result.success, true, result.error);
  assert.equal(result.mode === 'launch-window', bounded);
  if (bounded) assert.equal(result.sourceMaterialization.materialized, true);
  else {
    const stat = fs.statSync(h.filePath);
    const raw = await api.readJsonlRange(h.filePath, 0, stat.size - 1);
    assert.deepEqual(result.sourceMaterialization, api.inspectConversationMaterialization(raw.records, SID));
  }
});

for (const [name, header] of [
  ['foreign first identity', meta({ id: 'foreign' })],
  ['conflicting identity aliases', meta({ session_id: 'foreign' })],
]) test('bounded metadata cannot replace canonical invalid identity: ' + name, async t => {
  const h = fixture(t); h.write(undefined, { header });
  const result = await h.load();
  assert.equal(result.mode, 'rebuild');
  assert.equal(result.sourceSettingsProof.status, 'invalid');
  assert.equal(result.sourceSettingsProof.reason, 'session-meta-mismatch');
});

test('missing tail settings and giant clipped user preserve canonical fallback capability', async t => {
  const h = fixture(t); h.write([user('x'.repeat(3 * 1024 * 1024))]);
  const result = await h.load();
  assert.equal(result.mode, 'rebuild');
  assert.equal(result.sourceSettingsProof.model, 'old');
  assert.equal(result.sourceMaterialization.userTurns, 2);
});

test('thin/fork metadata and copied foreign headers keep the original root identity', async t => {
  const h = fixture(t);
  h.write([meta({ id: 'ancestor' }), settings('current', 'high'), user('fork own prompt')], {
    header: meta({ forked_from_id: 'ancestor', history_mode: 'thin', history_base: { id: 'ancestor', turns: 3 } }),
  });
  const result = await h.load();
  assert.equal(result.mode, 'launch-window');
  assert.equal(result.sourceMetadata.id, SID);
  assert.equal(result.sourceMetadata.history_mode, 'thin');
  assert.equal(result.sourceSettingsProof.model, 'current');
});

test('small/metadata-only source retains the existing exact empty-session path', async t => {
  const h = fixture(t); fs.writeFileSync(h.filePath, jsonl([meta()]));
  const result = await h.load();
  assert.equal(result.mode, 'rebuild');
  assert.equal(result.sourceSettingsProof.status, 'absent');
  assert.equal(result.sourceMaterialization.metadataOnly, true);
  assert.equal(result.sourceMaterialization.userTurns, 0);
});

for (const kind of ['append', 'rewrite-growth', 'same-size-rewrite', 'inode-replace', 'rediscovery']) {
  test('fresh capture rejects stale window and retries after ' + kind, async t => {
    const h = fixture(t); h.write([settings('before', 'low'), user('kept')]);
    h.onFind(async count => {
      if (count !== 2) return;
      const latest = [settings('after!', 'max'), user('kept')];
      if (kind === 'append') fs.appendFileSync(h.filePath, jsonl(latest));
      else if (kind === 'rediscovery') {
        const next = path.join(h.root, 'next.jsonl');
        fs.copyFileSync(h.filePath, next); fs.appendFileSync(next, jsonl(latest)); h.setPath(next);
      } else if (kind === 'inode-replace') {
        fs.renameSync(h.filePath, path.join(h.root, 'old.jsonl')); h.write(latest);
      } else h.write(kind === 'rewrite-growth' ? [...latest, user('extra')] : latest);
    });
    const result = await h.load();
    assert.equal(result.mode, 'launch-window');
    assert.equal(result.sourceSettingsProof.model, 'after!');
    assert.equal(result.sourceSettingsProof.effort, 'max');
    assert.equal(h.reader.stats().reads, 2);
  });
}

test('continually changing source remains unproven, not a stale settings/default grant', async t => {
  const h = fixture(t); h.write();
  h.onFind(async count => { if (count % 2 === 0) fs.appendFileSync(h.filePath, jsonl([settings('changed' + count)])); });
  const result = await h.load();
  assert.equal(result.success, false);
  assert.equal(result.error, 'codex-resume-source-changed-during-read');
  assert.equal(h.reader.stats().views, 0);
});

test('same-source launch/default callers stay serialized; caller mutation never seeds exact proof', async t => {
  const h = fixture(t); h.write();
  const [launch, exact] = await Promise.all([h.load(), h.load({ purpose: undefined })]);
  assert.equal(launch.mode, 'launch-window');
  assert.equal(exact.sourceMaterialization.userTurns, 2);
  launch.sourceSettingsProof.model = 'foreign';
  assert.equal((await h.load()).sourceSettingsProof.model, 'source-model');
});

test('metadata outside the header window falls back without inventing source identity', async t => {
  const h = fixture(t); h.write(undefined, { header: meta({ note: 'x'.repeat(80 * 1024) }) });
  const result = await h.load();
  assert.equal(result.mode, 'rebuild');
  assert.equal(result.sourceMetadata.id, SID);
  assert.equal(result.sourceSettingsProof.model, 'source-model');
});

test('short bounded read closes its descriptor and uses the same canonical fallback', async t => {
  const h = fixture(t); h.write();
  const open = fs.promises.open;
  let closed = 0;
  try {
    fs.promises.open = async (...args) => {
      const handle = await open.apply(fs.promises, args);
      if (args[0] !== h.filePath) return handle;
      return { stat: () => handle.stat(), read: async () => ({ bytesRead: 0 }),
        close: async () => { closed++; await handle.close(); } };
    };
    const result = await h.load();
    assert.equal(result.mode, 'rebuild');
    assert.equal(result.sourceSettingsProof.model, 'source-model');
    assert.equal(closed, 1);
  } finally { fs.promises.open = open; }
});

test('bounded read IO error closes its descriptor and is not a launch grant', async t => {
  const h = fixture(t); h.write();
  const open = fs.promises.open;
  let closed = 0;
  try {
    fs.promises.open = async (...args) => {
      const handle = await open.apply(fs.promises, args);
      if (args[0] !== h.filePath) return handle;
      return { stat: () => handle.stat(), read: async () => { throw Error('controlled EIO'); },
        close: async () => { closed++; await handle.close(); } };
    };
    const result = await h.load();
    assert.equal(result.success, false);
    assert.equal(result.error, 'controlled EIO');
    assert.equal(closed, 1);
    assert.equal(h.reader.stats().views, 0);
  } finally { fs.promises.open = open; }
});

test('dense bounded suffix does not retain/project every history row', async t => {
  const h = fixture(t); h.write();
  const fd = fs.openSync(h.filePath, 'a');
  try {
    const chunk = jsonl(Array.from({ length: 600 }, () => user('small own fixture')));
    for (let index = 0; index < 24; index++) fs.writeSync(fd, chunk);
    fs.writeSync(fd, jsonl([settings('final', 'high')]));
  } finally { fs.closeSync(fd); }
  let probes = 0, maxEntries = 0;
  const reader = createCodexResumeSourceReader({
    findSessionFile: async () => ({ filePath: h.filePath }), readJsonlRange: api.readJsonlRange, log: quiet,
    createTimelineProjector: (...args) => {
      const projector = api.createCodexTimelineProjector(...args);
      return { feed: row => { probes++; projector.feed(row); maxEntries = Math.max(maxEntries, projector.peekEntries().length); },
        peekEntries: () => projector.peekEntries() };
    },
  });
  const result = await reader.load(SID, h.root, { purpose: 'launch' });
  assert.equal(result.mode, 'launch-window');
  assert.equal(result.sourceSettingsProof.model, 'final');
  assert.ok(probes <= 3, 'only one positive witness is needed, not thousands of retained turns');
  assert.equal(maxEntries, 1);
  assert.ok(reader.stats().bytesRead <= LIMIT);
});
