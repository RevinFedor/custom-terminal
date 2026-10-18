'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { _api: api } = require('./ipc/codex-data');
const { createCodexCatalogSearchReader } = require('./codex-catalog-search');
const { createCodexResultSourceResolver } = require('./codex-result-source');
const event = (type, rest = {}) => ({ type: 'event_msg', payload: { type, ...rest } });
const user = message => event('user_message', { message });
const answer = text => ({ type: 'response_item', payload: { type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text }] } });
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function fixture(t, rows, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-busy-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'rollout.jsonl');
  fs.writeFileSync(file, encode(rows));
  const codexApi = { ...api, findCodexSessionFile: async () => ({ filePath: file }) };
  const resolver = createCodexResultSourceResolver({ codexApi });
  let lineage = { kind: 'physical' };
  const reader = createCodexCatalogSearchReader({ codexApi, onRead: options.onRead && ((...args) => options.onRead(f, ...args)) });
  const f = { directory, file, codexApi, reader,
    setLineage: value => { lineage = value; },
    read: extra => reader.snapshot({ sessionId: 'fixture', limit: 4, maxChars: 2000,
      resolveSource: () => resolver.resolve({ sessionId: 'fixture', lineage, verifyDigests: false }),
      assertLogicalCurrent: source => source.revisionKey === require('./codex-result-source').codexResultSourceRevisionKey('fixture', lineage),
      ...extra }) };
  return f;
}

test('busy user and partial answer survive append; next request advances its cutoff', async t => {
  let appended = false;
  const f = fixture(t, [event('task_started', { turn_id: 'turn-1' }), user('current task'), answer('partial')], {
    onRead(f, { phase }) {
      if (phase !== 'scan' || appended) return;
      appended = true;
      fs.appendFileSync(f.file, encode([answer('later'), event('task_complete', { turn_id: 'turn-1' })]));
    },
  });
  const first = await f.read();
  assert.equal(first.entries.at(-1).user.text, 'current task');
  assert.equal(first.entries.at(-1).assistant.text, 'partial');
  assert.equal(first.entries.at(-1).status, 'in_progress');
  assert.equal(first.entries.at(-1).responseComplete, false);
  assert.equal(first.entries.at(-1).turnId, 'turn-1');
  assert.equal(first.totalIterations, 1);
  const second = await f.read();
  assert.equal(second.entries.at(-1).assistant.text, 'partial\n\nlater');
  assert.equal(second.entries.at(-1).responseComplete, true);
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.ok(second.cutoff[0].toByte > first.cutoff[0].toByte);
});

test('an already existing user is visible without any assistant record or idle signal', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'open' }), user('please do this')]);
  const result = await f.read();
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].user.text, 'please do this');
  assert.equal(result.entries[0].assistant.text, '');
  assert.equal(result.entries[0].status, 'in_progress');
});

test('partial UTF8/JSON tail is excluded even when completed during the read', async t => {
  let written = false;
  const f = fixture(t, [event('task_started', { turn_id: 'open' }), user('visible')], {
    onRead(f, { phase }) { if (phase === 'scan' && !written) { written = true; fs.appendFileSync(f.file, partial.subarray(cut)); } },
  });
  const partial = Buffer.from(encode([answer('unicode \u65e5\ud83d\ude42')]));
  const cut = partial.indexOf(Buffer.from('\ud83d\ude42')) + 2;
  fs.appendFileSync(f.file, partial.subarray(0, cut));
  const first = await f.read();
  assert.equal(first.entries[0].assistant.text, '');
  assert.ok(first.coverage.trailingPartialBytes > 0);
  assert.equal(first.coverage.completeRecordsOnly, true);
  assert.equal((await f.read()).entries[0].assistant.text, 'unicode \u65e5\ud83d\ude42');
});

for (const mode of ['rewrite', 'growth-rewrite', 'truncate', 'replace', 'lineage']) {
  test('snapshot rejects ' + mode + ' instead of returning a mixed prefix', async t => {
    let changed = false;
    const f = fixture(t, [event('task_started', { turn_id: 'open' }), user('original'), answer('part')], {
      onRead(f, { phase }) {
        if (phase !== 'hydrate' || changed) return;
        changed = true;
        if (mode === 'lineage') { f.setLineage({ kind: 'physical', legacyForkEvent: { eventKey: 'new-view' } }); return; }
        if (mode === 'truncate') { fs.truncateSync(f.file, 5); return; }
        const body = fs.readFileSync(f.file, 'utf8').replace('original', 'modified');
        if (mode === 'replace') { fs.renameSync(f.file, f.file + '.old'); fs.writeFileSync(f.file, body); }
        else fs.writeFileSync(f.file, body + (mode === 'growth-rewrite' ? encode([answer('growth')]) : ''));
      },
    });
    await assert.rejects(f.read(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  });
}

test('bounded latest entries retain canonical indexes, noise and compact coordinates', async t => {
  const f = fixture(t, [user('first'), answer('first answer'), { type: 'compacted', payload: { message: 'summary' } },
    event('compact_completed'), event('task_started', { turn_id: 'second' }), user('second'), answer('x'.repeat(2500)),
    event('task_complete', { turn_id: 'second' }), event('task_started', { turn_id: 'third' }), user('third')]);
  const result = await f.read({ limit: 2, maxChars: 100 });
  assert.deepEqual(result.entries.map(row => [row.iterationIndex, row.turnIndex, row.user.text]), [[1, 2, 'second'], [2, 3, 'third']]);
  assert.equal(result.totalIterations, 3);
  assert.equal(result.entries[0].assistant.truncated, true);
  assert.equal(result.entries[0].assistant.chars, 2500);
  assert.equal(result.entries[1].responseComplete, false);
  assert.equal(result.coverage.earlierIterationsOmitted, 1);
});

test('a foreign view owner is refused even when its bytes and path remain stable', async t => {
  const f = fixture(t, [user('own task')]);
  const source = await createCodexResultSourceResolver({ codexApi: f.codexApi }).resolve({ sessionId: 'fixture', lineage: { kind: 'physical' }, verifyDigests: false });
  await assert.rejects(f.read({ resolveSource: async () => ({ ...source, viewOwnerSessionId: 'foreign' }) }), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
});

test('many assistant blocks retain a bounded prefix while reporting the complete character count', async t => {
  const blocks = Array.from({ length: 100 }, (_, index) => answer(String(index) + 'x'.repeat(32000)));
  const f = fixture(t, [event('task_started', { turn_id: 'large-answer' }), user('task'), ...blocks]);
  const result = await f.read({ maxChars: 127 });
  const expectedChars = blocks.reduce((sum, row) => sum + row.payload.content[0].text.length, 0) + 99 * 2;
  assert.equal(result.entries[0].assistant.chars, expectedChars);
  assert.equal(result.entries[0].assistant.text.length, 127);
  assert.equal(result.entries[0].assistant.truncated, true);
  assert.ok(JSON.stringify(result).length < 4000);
});

test('oversized selected values refuse before decoding; oversized ignored telemetry stays streaming', async t => {
  const large = 'x'.repeat(require('./codex-catalog-search').SNAPSHOT_LIMITS.encodedValueBytes + 1);
  const f = fixture(t, [event('task_started', { turn_id: 'open' }), user('task'), event('telemetry', { ignored: large })]);
  assert.equal((await f.read()).entries[0].user.text, 'task');
  fs.appendFileSync(f.file, encode([answer(large)]));
  await assert.rejects(f.read(), { code: 'HISTORY_SNAPSHOT_BUDGET_EXCEEDED' });
});

test('virtual view verifies ancestor bytes and tolerates only append beyond frozen range', async t => {
  let append = true;
  const f = fixture(t, [event('task_started', { turn_id: 'child' }), user('child task')], {
    onRead(f, { phase }) { if (phase === 'scan' && append) { append = false; fs.appendFileSync(parent, encode([user('outside frozen range')])); } },
  });
  const parent = path.join(f.directory, 'parent.jsonl'), prefix = encode([user('parent task'), answer('parent answer')]);
  fs.writeFileSync(parent, prefix);
  const digest = createHash('sha256').update(prefix).digest('hex');
  const makeSource = async () => {
    const physical = await createCodexResultSourceResolver({ codexApi: f.codexApi }).resolve({ sessionId: 'fixture', lineage: { kind: 'physical' }, verifyDigests: false });
    const stat = fs.statSync(parent);
    return { ...physical, kind: 'virtual', revisionKey: 'virtual-fixture', eventKey: 'fork', manifestDigest: 'manifest',
      childPrefix: { fromByte: 0, toByte: 0, digest: createHash('sha256').digest('hex') },
      segments: [{ segmentId: 'frozen', physicalSessionId: 'parent', filePath: parent, fromByte: 0,
        toByte: Buffer.byteLength(prefix), startLine: 0, endLine: 2, frozen: true, digest,
        sourceSnapshot: { filePath: parent, dev: stat.dev, ino: stat.ino, fileIdentity: stat.dev + ':' + stat.ino,
          size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } }, ...physical.segments] };
  };
  const result = await f.read({ resolveSource: makeSource, assertLogicalCurrent: () => true });
  assert.deepEqual(result.entries.map(row => row.user.text), ['parent task', 'child task']);
  assert.equal(result.entries[0].physicalSessionId, 'parent');
  fs.writeFileSync(parent, prefix.replace('parent task', 'changedtask'));
  await assert.rejects(f.read({ resolveSource: makeSource, assertLogicalCurrent: () => true }), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
});
