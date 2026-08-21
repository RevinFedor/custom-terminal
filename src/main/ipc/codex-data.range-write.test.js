'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-range-write-'));
process.env.CODEX_HOME = testHome;
const { _api } = require('./codex-data');
const { resolveCodexSourceSettingsProof } = require('../codex-source-settings');

test.after(async () => {
  await fs.promises.rm(testHome, { recursive: true, force: true });
});

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const stamp = (index) => `2026-08-18T01:00:${String(index).padStart(2, '0')}.000Z`;

async function createSession({ withSettings = true } = {}) {
  const sessionId = crypto.randomUUID();
  const dir = path.join(testHome, 'sessions', '2026', '08', '18');
  await fs.promises.mkdir(dir, { recursive: true });
  const records = [{
    timestamp: stamp(0),
    type: 'session_meta',
    payload: { id: sessionId, session_id: sessionId, cwd: '/tmp/range-write' },
  }];
  if (withSettings) {
    records.push({
      timestamp: stamp(1),
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'max' },
    });
  }
  for (const [index, text] of ['keep', 'delete'].entries()) {
    records.push({
      timestamp: stamp(2 + index * 3),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    records.push({
      timestamp: stamp(3 + index * 3),
      type: 'event_msg',
      payload: { type: 'user_message', message: text },
    });
    records.push({
      timestamp: stamp(4 + index * 3),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer:${text}` }] },
    });
  }
  const filePath = path.join(dir, `rollout-2026-08-18T01-00-00-${sessionId}.jsonl`);
  await fs.promises.writeFile(filePath, jsonl(records));
  return { sessionId, filePath, dir };
}

async function targetUuid(sessionId, content) {
  const loaded = await _api.loadSessionRecords(sessionId, '/tmp/range-write');
  assert.equal(loaded.success, true);
  const target = _api.buildCodexTimeline(loaded.records, sessionId)
    .find((entry) => entry.content === content);
  assert.ok(target);
  return target.uuid;
}

test('delete writes a validated child, preserves source bytes and carries source settings', async () => {
  const source = await createSession();
  const sourceBytes = await fs.promises.readFile(source.filePath);
  const uuid = await targetUuid(source.sessionId, 'delete');
  const beforePreflight = new Set(await fs.promises.readdir(source.dir));
  const preflight = await _api.deleteCodexRange({
    sessionId: source.sessionId,
    cwd: '/tmp/range-write',
    startUuid: uuid,
    endUuid: uuid,
    validateOnly: true,
  });
  assert.equal(preflight.success, true);
  assert.equal(preflight.validationOnly, true);
  assert.deepEqual(new Set(await fs.promises.readdir(source.dir)), beforePreflight);
  const result = await _api.deleteCodexRange({
    sessionId: source.sessionId,
    cwd: '/tmp/range-write',
    startUuid: uuid,
    endUuid: uuid,
  });
  assert.equal(result.success, true);
  assert.equal(result.removedUsers, 1);
  assert.equal(result.remainingUsers, 1);
  assert.deepEqual(await fs.promises.readFile(source.filePath), sourceBytes);
  assert.notEqual(result.filePath, source.filePath);

  const child = await _api.loadSessionRecords(result.newSessionId, '/tmp/range-write');
  assert.equal(child.success, true);
  assert.deepEqual(
    _api.buildCodexTimeline(child.records, result.newSessionId)
      .filter((entry) => entry.type === 'user')
      .map((entry) => entry.content),
    ['keep'],
  );
  const proof = resolveCodexSourceSettingsProof(child.records, result.newSessionId);
  assert.deepEqual(
    { status: proof.status, model: proof.model, effort: proof.effort },
    { status: 'found', model: 'gpt-5.6-sol', effort: 'max' },
  );
});

test('delete child preserves retained compact image bytes instead of persisting cache placeholders', async () => {
  const sessionId = crypto.randomUUID();
  const dir = path.join(testHome, 'sessions', '2026', '08', '18');
  await fs.promises.mkdir(dir, { recursive: true });
  const dataUrl = 'data:image/png;base64,' + 'U'.repeat(20_000);
  const records = [
    {
      timestamp: stamp(0),
      type: 'session_meta',
      payload: { id: sessionId, session_id: sessionId, cwd: '/tmp/range-write' },
    },
    {
      timestamp: stamp(1),
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'max' },
    },
    ...[
      {
        timestamp: stamp(2),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep' }] },
      },
      {
        timestamp: stamp(3),
        type: 'event_msg',
        payload: { type: 'user_message', message: 'keep' },
      },
      {
        timestamp: stamp(4),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer:keep' }] },
      },
    ],
    {
      timestamp: stamp(5),
      type: 'compacted',
      payload: {
        replacement_history: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: dataUrl }],
        }],
      },
    },
    ...[
      {
        timestamp: stamp(6),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'delete' }] },
      },
      {
        timestamp: stamp(7),
        type: 'event_msg',
        payload: { type: 'user_message', message: 'delete' },
      },
      {
        timestamp: stamp(8),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer:delete' }] },
      },
    ],
  ];
  const filePath = path.join(dir, `rollout-2026-08-18T01-00-00-${sessionId}.jsonl`);
  await fs.promises.writeFile(filePath, jsonl(records));

  const uuid = await targetUuid(sessionId, 'delete');
  const result = await _api.deleteCodexRange({
    sessionId,
    cwd: '/tmp/range-write',
    startUuid: uuid,
    endUuid: uuid,
  });
  assert.equal(result.success, true);
  const childRaw = await fs.promises.readFile(result.filePath, 'utf8');
  assert.equal(childRaw.includes('[image omitted]'), false);
  assert.equal(childRaw.includes(dataUrl), true);
  const childRows = childRaw.trim().split('\n').map(JSON.parse);
  assert.equal(childRows.some((record) => Object.hasOwn(record, '__byteOffset')), false);
});

test('owner-matched renderer proof safely seeds a legacy source without turn_context', async () => {
  const source = await createSession({ withSettings: false });
  const uuid = await targetUuid(source.sessionId, 'delete');
  const result = await _api.deleteCodexRange({
    sessionId: source.sessionId,
    cwd: '/tmp/range-write',
    startUuid: uuid,
    endUuid: uuid,
    codexSettingsProof: {
      sessionId: source.sessionId,
      model: 'gpt-5.6-sol',
      effort: 'high',
      proofAt: Date.now(),
    },
  });
  assert.equal(result.success, true);
  const child = await _api.loadSessionRecords(result.newSessionId, '/tmp/range-write');
  const proof = resolveCodexSourceSettingsProof(child.records, result.newSessionId);
  assert.deepEqual(
    { status: proof.status, model: proof.model, effort: proof.effort },
    { status: 'found', model: 'gpt-5.6-sol', effort: 'high' },
  );
});

test('edit-range uses the same exact identity and validated settings-preserving child path', async () => {
  const source = await createSession();
  const uuid = await targetUuid(source.sessionId, 'delete');
  const result = await _api.editCodexRange({
    sessionId: source.sessionId,
    cwd: '/tmp/range-write',
    startUuid: uuid,
    endUuid: uuid,
    compactText: 'replacement summary',
  });
  assert.equal(result.success, true);
  const child = await _api.loadSessionRecords(result.newSessionId, '/tmp/range-write');
  assert.deepEqual(
    _api.buildCodexTimeline(child.records, result.newSessionId)
      .filter((entry) => entry.type === 'user')
      .map((entry) => entry.content),
    ['keep', 'replacement summary'],
  );
  assert.equal(resolveCodexSourceSettingsProof(child.records, result.newSessionId).status, 'found');
});

test('missing settings proof fails before child publication', async () => {
  const source = await createSession({ withSettings: false });
  const before = new Set(await fs.promises.readdir(source.dir));
  const uuid = await targetUuid(source.sessionId, 'delete');
  const result = await _api.deleteCodexRange({
    sessionId: source.sessionId,
    cwd: '/tmp/range-write',
    startUuid: uuid,
    endUuid: uuid,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'codex_history_mutation_settings_unproven');
  assert.deepEqual(new Set(await fs.promises.readdir(source.dir)), before);
});
