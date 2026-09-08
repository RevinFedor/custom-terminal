'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _api } = require('./codex-data');

const CHILD = '01a07982-32cc-7773-a777-4841a2be8007';
const PARENT = 'a880c1bd-0b94-4703-91bc-d22a467956ec';
const GRAND = '01a07900-0000-7000-8000-000000000001';
const meta = (id, parent, physicalSessionId, line = 0) => ({
  type: 'session_meta', __line: line,
  ...(physicalSessionId ? { __physicalSessionId: physicalSessionId } : {}),
  payload: { id, session_id: id, cwd: '/fixture/' + id,
    timestamp: '2026-09-07T01:36:10.000Z',
    ...(parent ? { forked_from_id: parent } : {}) },
});

test('native full Fork keeps its own first header when copied parent headers follow', () => {
  const projector = _api.createCodexTimelineProjector(CHILD);
  projector.feed(meta(CHILD, PARENT, null, 0));
  assert.equal(projector.getSessionMeta().id, CHILD);
  projector.finalize();
  projector.feed(meta(PARENT, GRAND, null, 1));
  projector.feed(meta(GRAND, null, null, 2));
  assert.equal(projector.getSessionMeta().id, CHILD);
  assert.equal(projector.getSessionMeta().forked_from_id, PARENT);
  assert.equal(projector.getSessionMeta().cwd, '/fixture/' + CHILD);
});

test('virtual projection upgrades to the physical child header, not its copied ancestry', () => {
  const projector = _api.createCodexTimelineProjector(CHILD);
  projector.feed(meta(GRAND, null, GRAND));
  projector.feed(meta(PARENT, GRAND, PARENT));
  projector.feed(meta(CHILD, PARENT, CHILD));
  projector.feed(meta(PARENT, GRAND, CHILD, 1));
  assert.equal(projector.getSessionMeta().id, CHILD);
  assert.equal(projector.getSessionMeta().forked_from_id, PARENT);
});

test('a matching ID inside a copied body cannot launder a different physical file header', () => {
  const projector = _api.createCodexTimelineProjector(CHILD);
  projector.feed(meta(PARENT, GRAND));
  projector.feed(meta(CHILD, PARENT, null, 1));
  assert.equal(projector.getSessionMeta().id, PARENT,
    'the scenario must still reject a real header/session mismatch');
});

test('actual cold and appended file projection keep native Fork metadata stable', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-fork-header-'));
  t.after(async () => {
    _api.invalidateCodexHistoryProjectors();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const filePath = path.join(dir, 'rollout-2026-09-07T01-36-10-' + CHILD + '.jsonl');
  const serialize = (record) => JSON.stringify({ type: record.type, payload: record.payload }) + '\n';
  await fs.writeFile(filePath, serialize(meta(CHILD, PARENT)) + serialize(meta(PARENT, GRAND)));
  const cold = await _api.projectCodexTimelineFromFile(CHILD, '/fixture', { sessionsDir: dir });
  assert.equal(cold.success, true);
  assert.equal(cold.sessionMeta.id, CHILD);
  assert.equal(cold.sessionMeta.forked_from_id, PARENT);
  await fs.appendFile(filePath, serialize(meta(GRAND)));
  const appended = await _api.projectCodexTimelineFromFile(CHILD, '/fixture', { sessionsDir: dir });
  assert.equal(appended.success, true);
  assert.equal(appended.sessionMeta.id, CHILD);
  assert.equal(appended.sessionMeta.forked_from_id, PARENT);
});
