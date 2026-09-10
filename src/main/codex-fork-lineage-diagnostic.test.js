'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { describeCodexForkPrefixFailure } = require('./codex-fork-lineage-diagnostic');
const codexData = require('./ipc/codex-data');
const { SessionTranscriptService } = require('./session-transcript-service');

const SOURCE = '01a02eb0-f7dc-7910-9969-1bffae88d8d3';
const CHILD = '01a02ed8-e41e-7522-97ad-dedf6e7233ac';
const TAB = 'tab-fork-diagnostic';
const TAG = '[CodexForkLineage:PrefixMismatch] ';
const meta = (id, parent) => ({ type: 'session_meta', payload: {
  id, history_mode: 'legacy', cli_version: '0.153.0', ...(parent ? { forked_from_id: parent } : {}),
} });
const sourceRecords = () => [
  meta(SOURCE),
  { type: 'event_msg', payload: { type: 'task_started' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'private prompt' } },
  { type: 'response_item', payload: { type: 'function_call', name: 'exec_command',
    call_id: 'call-test', arguments: '{"cmd":"private command"}' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-test', output: 'private output' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: 'private answer' }] } },
  { type: 'event_msg', payload: { type: 'task_complete' } },
  { type: 'compacted', payload: { message: 'private compact', encrypted_content: 'private capsule' } },
];
const jsonl = (records) => records.map(record => JSON.stringify(record)).join('\n') + '\n';

async function fixture(t, records = sourceRecords()) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fork-prefix-diagnostic-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.jsonl');
  const childPath = path.join(dir, 'child.jsonl');
  const source = records;
  const child = [meta(CHILD, SOURCE), ...source.map(record => ({ ...record, timestamp: '2026-09-09T22:45:50.000Z' }))];
  // Blank physical lines ensure reducer indices cannot masquerade as addresses.
  await fs.promises.writeFile(sourcePath, source.map(record => JSON.stringify(record)).join('\n\n') + '\n');
  await fs.promises.writeFile(childPath, jsonl(child));
  const paths = new Map([[SOURCE, sourcePath], [CHILD, childPath]]);
  let loads = 0;
  const loadSessionRecords = async (sessionId) => {
    loads += 1;
    const filePath = paths.get(sessionId);
    const stat = await fs.promises.stat(filePath);
    const parsed = await codexData._api.readJsonlRange(filePath, 0, stat.size - 1);
    return { success: parsed.errors === 0, records: parsed.records, filePath,
      sourceSnapshot: { filePath, size: stat.size, mtimeMs: stat.mtimeMs } };
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null, webBroadcast: null, claudeData: null,
    codexData: { _api: { ...codexData._api, loadSessionRecords,
      findCodexSessionFile: async id => ({ filePath: paths.get(id) }) } },
    sessionHistoryStore: { getSessionHistoryEvents: () => [] },
  });
  const snapshot = await service.captureCodexForkSourceSnapshot({ sessionId: SOURCE, cwd: dir });
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const prepare = (kind = 'fork', selectedSnapshot = snapshot) => service._prepareCodexLineageFromSnapshot({
    snapshot: selectedSnapshot, childSessionId: CHILD, childTabId: TAB, cwd: dir, operationKind: kind,
  });
  const logs = () => warnings.filter(line => line.startsWith(TAG)).map(line => JSON.parse(line.slice(TAG.length)));
  return { service, source, child, sourcePath, childPath, snapshot, prepare, logs, warnings, getLoads: () => loads,
    writeChild: records => fs.promises.writeFile(childPath, jsonl(records)) };
}

test('actual native Fork logs the first optional-field difference and original physical addresses', async t => {
  const f = await fixture(t);
  assert.equal((await f.prepare()).success, true, 'ordinary full copy with restamped timestamps remains accepted');
  assert.equal(f.logs().length, 0);
  await f.writeChild(f.child.map(record => record.payload?.type === 'function_call'
    ? { ...record, payload: { ...record.payload, status: null } } : record));
  const rejected = await f.prepare();
  assert.deepEqual(rejected, { required: true, success: false, reason: 'fork-materialized-prefix-mismatch' });
  const log = f.logs()[0];
  assert.equal(log.tabId, TAB);
  assert.equal(log.sourceSessionId, SOURCE);
  assert.equal(log.childSessionId, CHILD);
  assert.equal(log.snapshotCapturedAt, f.snapshot.capturedAt);
  assert.equal(log.childCliVersion, '0.153.0');
  assert.equal(log.check, 'carrier-payload');
  assert.deepEqual(log.difference, { path: '/payload/status', expected: { type: 'missing' }, actual: { type: 'null' } });
  assert.equal(log.sourceRecord.line, 6, 'source line includes blank lines, unlike the reducer index');
  assert.equal(log.childRecord.line, 4);
  assert.equal(log.sourceRecord.physicalSessionId, SOURCE);
  assert.equal(log.childRecord.physicalSessionId, CHILD);
  assert.ok(log.sourceRecord.byteOffset > 0);
  assert.equal(log.counts.expectedCarriers, log.counts.actualCarriers);
  assert.equal(f.warnings.join('\n').includes('private'), false, 'no prompt, tool body or compact is dumped');
  await f.prepare();
  assert.equal(f.logs().length, 1, 'unchanged discovery retries do not repeat the detailed diagnostic');
  assert.equal(f.getLoads(), 2, 'an unchanged rejection does not reparse the full child');

  await f.writeChild(f.child.map(record => record.payload?.type === 'function_call'
    ? { ...record, payload: { ...record.payload, status: 'different' } } : record));
  await f.prepare();
  assert.equal(f.logs().length, 2);
  assert.equal(f.logs()[1].difference.actual.type, 'string');
  await f.prepare('rewind');
  assert.equal(f.logs().length, 3, 'Rewind has its own diagnostic scope');
  assert.equal(f.logs()[2].operationKind, 'rewind');
});

test('actual prefix diagnostic distinguishes snapshot/timeline/carrier failures without altering verdict', async t => {
  const f = await fixture(t);
  await f.prepare('fork', { ...f.snapshot, entryUuids: [...f.snapshot.entryUuids, 'extra'] });
  assert.equal(f.logs().at(-1).check, 'snapshot-entry-count');
  await f.prepare('fork', { ...f.snapshot, entryUuids: f.snapshot.entryUuids.map((id, i) => i ? id : 'wrong-uuid') });
  assert.equal(f.logs().at(-1).check, 'snapshot-entry-uuid');

  await f.writeChild(f.child.map(record => record.payload?.type === 'user_message'
    ? { ...record, payload: { ...record.payload, message: 'changed prompt' } } : record));
  assert.equal((await f.prepare()).success, false);
  assert.equal(f.logs().at(-1).check, 'timeline-content');
  assert.equal(f.logs().at(-1).difference.path, '/content');

  await f.writeChild(f.child.map(record => record.type === 'compacted'
    ? { ...record, payload: { ...record.payload, encrypted_content: 'changed capsule' } } : record));
  assert.equal((await f.prepare()).success, false);
  assert.equal(f.logs().at(-1).check, 'carrier-payload');
  assert.equal(f.logs().at(-1).difference.path, '/payload/encrypted_content');
  assert.equal(f.warnings.join('\n').includes('capsule'), false);

  await f.writeChild([meta(CHILD, SOURCE)]);
  assert.equal((await f.prepare()).reason, 'fork-materialized-prefix-incomplete');
  assert.equal(f.logs().at(-1).check, 'child-timeline-empty');
  await f.writeChild(f.child);
  assert.equal((await f.prepare()).success, true);
  assert.equal(f.service.codexForkPrefixDiagnosticSignatures.size, 0, 'success clears the diagnostic signature');
});

test('diagnostic errors cannot replace the original materialized-prefix rejection', async t => {
  const f = await fixture(t);
  await f.writeChild([meta(CHILD, SOURCE)]);
  t.mock.method(f.service.codexForkPrefixDiagnosticSignatures, 'get', () => { throw new Error('test diagnostic failure'); });
  assert.equal((await f.prepare()).reason, 'fork-materialized-prefix-incomplete');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^\[CodexForkLineage:DiagnosticFailed\]/);
  t.mock.method(console, 'warn', () => { throw new Error('test log unavailable'); });
  assert.equal((await f.prepare()).reason, 'fork-materialized-prefix-incomplete');
});

test('nested payload diagnostics expose array order/type and exact string digests without content', () => {
  const describe = (expected, actual) => describeCodexForkPrefixFailure({
    snapshot: { sourceSessionId: SOURCE, sourceSegments: [] }, childSessionId: CHILD,
    meta: {}, counts: {}, failure: { check: 'carrier-payload', path: '/payload', expected, actual },
  }).difference;
  assert.deepEqual(describe({ a: [] }, { a: null }), {
    path: '/payload/a', expected: { type: 'array', length: 0 }, actual: { type: 'null' },
  });
  const text = 'secret'.repeat(6_000) + '😀';
  const diff = describe({ content: [{ text }] }, { content: [{ text: text + 'x' }] });
  assert.equal(diff.path, '/payload/content/0/text');
  assert.equal(diff.firstDifferentUtf16Offset, text.length);
  assert.equal(diff.expected.sha256Utf16, createHash('sha256').update(Buffer.from(text, 'utf16le')).digest('hex'));
  assert.ok(JSON.stringify(diff).length < 500);
  assert.equal(JSON.stringify(diff).includes('secret'), false);
  assert.equal(describe({ a: 1, b: 2 }, { b: 2, a: 1 }), null, 'key order is not a difference');
});

test('native compact serializer defaults preserve full Fork/Rewind while nonempty or unknown differences reject', async t => {
  const f = await fixture(t);
  const copied = f.child.map(record => record.type === 'compacted'
    ? { ...record, payload: { ...record.payload, compaction_response_id: null, latest_token_usage_record: null } }
    : record);
  await f.writeChild(copied);
  for (const kind of ['fork', 'rewind']) {
    const result = await f.prepare(kind);
    assert.equal(result.success, true, kind + ': absent and null both mean no optional compact reference/usage');
    assert.equal(result.event.operationKind, kind);
    assert.equal(result.event.entryUuids.length, f.snapshot.entryUuids.length);
    assert.ok(result.event.entryMappings.length > 0);
  }
  for (const changed of [
    { compaction_response_id: 'response-other' },
    { latest_token_usage_record: { total_tokens: 7 } },
    { unknown_future_field: null },
    { encrypted_content: 'different capsule' },
  ]) {
    await f.writeChild(copied.map(record => record.type === 'compacted'
      ? { ...record, payload: { ...record.payload, ...changed } } : record));
    assert.equal((await f.prepare()).reason, 'fork-materialized-prefix-mismatch', Object.keys(changed)[0]);
  }
});

test('native copied reasoning uses one wire contract inside both compact checkpoints and outside them', async t => {
  const reasoning = { type: 'reasoning', summary: [], encrypted_content: 'opaque-private' };
  const records = sourceRecords();
  records.splice(6, 0, { type: 'response_item', payload: reasoning });
  records.at(-1).payload.guardian_history = Array.from({ length: 76 }, () => ({ ...reasoning }));
  records.at(-1).payload.replacement_history = [{ ...reasoning }];
  const f = await fixture(t, records);
  const copied = f.child.map(record => record.type === 'compacted'
    ? { ...record, payload: { ...record.payload,
      compaction_response_id: null, latest_token_usage_record: null,
      guardian_history: record.payload.guardian_history.map(item => ({ ...item, content: null })),
      replacement_history: record.payload.replacement_history.map(item => ({ ...item, content: null })),
    } }
    : record.payload?.type === 'reasoning' ? { ...record, payload: { ...record.payload, content: null } } : record);
  await f.writeChild(copied);
  for (const kind of ['fork', 'rewind']) {
    const result = await f.prepare(kind);
    assert.equal(result.success, true, kind);
    assert.equal(result.event.operationKind, kind);
    assert.equal(result.event.entryMappings.length, f.snapshot.entryUuids.length);
  }
  assert.equal(Object.hasOwn(reasoning, 'content'), false, 'validation never edits source records');
  for (const checkpoint of ['guardian_history', 'replacement_history']) {
    for (const patch of [
      { content: [] }, { content: [{ type: 'reasoning_text', text: 'changed' }] },
      { encrypted_content: 'changed' }, { unknown: null }, { type: 'message' },
    ]) {
      const broken = structuredClone(copied);
      Object.assign(broken.at(-1).payload[checkpoint].at(-1), patch);
      await f.writeChild(broken);
      assert.equal((await f.prepare()).reason, 'fork-materialized-prefix-mismatch', checkpoint + ':' + Object.keys(patch)[0]);
    }
  }
  const message = { type: 'message', role: 'assistant' };
  const { codexForkCopyPayload } = require('./codex-fork-copy-payload');
  assert.notDeepEqual(
    codexForkCopyPayload({ type: 'compacted', payload: { guardian_history: [message] } }),
    codexForkCopyPayload({ type: 'compacted', payload: { guardian_history: [{ ...message, content: null }] } }),
    'missing content on a message is not the optional reasoning field',
  );
});

test('unchanged incomplete child avoids reparsing and append releases the rejection', async t => {
  const f = await fixture(t);
  await f.writeChild([meta(CHILD, SOURCE)]);
  const first = await f.prepare();
  assert.equal(first.reason, 'fork-materialized-prefix-incomplete');
  const repeated = await Promise.all(Array.from({ length: 4 }, () => f.prepare()));
  assert.equal(repeated.every(result => result.reason === first.reason), true);
  assert.equal(f.getLoads(), 1, 'all unchanged retries cost file stats, not full JSONL reads');
  await f.writeChild(f.child);
  assert.equal((await f.prepare()).success, true, 'new complete child earns the full proof');
  assert.equal(f.getLoads(), 2);
  await f.prepare();
  assert.equal(f.getLoads(), 3, 'positive adoption is never cached by file metadata');
});

test('source rewrite with restored size/mtime cannot retain a stale validation result', async t => {
  const f = await fixture(t);
  const initial = await fs.promises.stat(f.sourcePath);
  await fs.promises.utimes(f.sourcePath, initial.atime, new Date(Math.floor(initial.mtimeMs)));
  await f.writeChild([meta(CHILD, SOURCE)]);
  assert.equal((await f.prepare()).reason, 'fork-materialized-prefix-incomplete');
  const before = await fs.promises.stat(f.sourcePath);
  const contents = await fs.promises.readFile(f.sourcePath, 'utf8');
  await fs.promises.writeFile(f.sourcePath, contents.replace('private prompt', 'changed prompt'));
  await fs.promises.utimes(f.sourcePath, before.atime, before.mtime);
  const after = await fs.promises.stat(f.sourcePath);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.notEqual(after.ctimeMs, before.ctimeMs);
  assert.equal((await f.prepare()).reason, 'fork-source-snapshot-digest-changed');
  await f.writeChild(f.child);
  assert.equal((await f.prepare()).success, false, 'a complete child cannot hide a changed frozen source');
});

test('parallel source proof shares an in-flight read and releases all raw records afterwards', async t => {
  const f = await fixture(t);
  const original = f.service._verifyCodexForkSourceSnapshotInner.bind(f.service);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  t.mock.method(f.service, '_verifyCodexForkSourceSnapshotInner', async (...args) => {
    calls += 1;
    await gate;
    return original(...args);
  });
  const a = f.service._verifyCodexForkSourceSnapshot(f.snapshot, '/fixture', { includeRecords: true });
  const b = f.service._verifyCodexForkSourceSnapshot({ ...f.snapshot, capturedAt: f.snapshot.capturedAt + 1 }, '/fixture', { includeRecords: true });
  assert.equal(calls, 1);
  release();
  const results = await Promise.all([a, b]);
  assert.equal(results.every(result => result.success), true);
  assert.equal(f.service.codexForkSourceProofInflight.size, 0);
  await f.service._verifyCodexForkSourceSnapshot(f.snapshot, '/fixture', { includeRecords: true });
  assert.equal(calls, 2, 'a later validation does not trust a retained raw cache');
});

test('same-size repaired child with restored mtime is revalidated and can be adopted', async t => {
  const f = await fixture(t);
  await f.writeChild(f.child.map(record => record.payload?.role === 'assistant'
    ? { ...record, payload: { ...record.payload, content: [{ type: 'output_text', text: 'changed answer' }] } } : record));
  const firstStat = await fs.promises.stat(f.childPath);
  await fs.promises.utimes(f.childPath, firstStat.atime, new Date(Math.floor(firstStat.mtimeMs)));
  const before = await fs.promises.stat(f.childPath);
  assert.equal((await f.prepare()).reason, 'fork-materialized-prefix-mismatch');
  await f.writeChild(f.child);
  await fs.promises.utimes(f.childPath, before.atime, before.mtime);
  const after = await fs.promises.stat(f.childPath);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.notEqual(after.ctimeMs, before.ctimeMs);
  assert.equal((await f.prepare()).success, true);
  assert.equal(f.getLoads(), 2);
});
