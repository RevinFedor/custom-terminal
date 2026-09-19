'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCodexAuditAddress: resolve } = require('./codex-audit-address');
const { createCodexAuditAddressReader: createReader } = require('./codex-audit-address-reader');
const { promptAuditFingerprint: hashText } = require('./prompt-audit-fingerprint');
const { codexUserMessageAuditText } = require('./codex-prompt-audit');
const api = require('./ipc/codex-data')._api;
const line = value => JSON.stringify(value) + '\n';
const SID = 'session-a';

function fixture(t, { prefix, suffix = '', message = 'same prompt', newline = '\n', ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-audit-locator-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'rollout.jsonl');
  const record = { type: 'event_msg', payload: { type: 'user_message', message }, timestamp: '2026-09-19T16:47:17.123Z' };
  prefix ??= line({ type: 'session_meta', payload: { id: SID } }) + ' \n\nnot-json\n'
    + line({ ...record, timestamp: '2026-09-19T16:40:00.123Z' });
  const offset = Buffer.byteLength(prefix);
  fs.writeFileSync(filePath, prefix + JSON.stringify(record) + newline + suffix);
  const reader = createReader({ readJsonlRange: api.readJsonlRange, log: {}, ...options });
  const text = codexUserMessageAuditText(record, { preserveProviderImageMarkup: true });
  const audit = { actualHash: hashText(text), actualLen: text.length, auditTimestamp: record.timestamp,
    recordByteOffset: offset, sourceIdentity: 'codex-user-source-' + SID + '-' + offset };
  return { filePath, sessionId: SID, record, reader, offset, audit, readAddress: reader.read, hashText };
}
async function canonical(f) {
  return (await api.readJsonlRange(f.filePath, 0, fs.statSync(f.filePath).size - 1)).records.find(r => r.__byteOffset === f.offset);
}

test('canonical physical UUID counts empty/malformed rows and UTF-8 bytes; only target is parsed', async t => {
  const f = fixture(t, { message: 'Юникод 🦉\nsecond line' });
  assert.equal((await canonical(f)).__line, 5);
  assert.deepEqual(await resolve(f), { entryUuid: `codex-user-${SID}-5`, sourceIdentity: f.audit.sourceIdentity, recordByteOffset: f.offset });
  assert.equal(f.reader.stats().recordsParsed, 1);
});

test('unchanged version reuses locator and reads one row, independent of raw cache eviction', async t => {
  const f = fixture(t), expected = await resolve(f), cold = f.reader.stats();
  api.invalidateJsonlCache(f.filePath);
  assert.deepEqual(await resolve(f), expected);
  const warm = f.reader.stats();
  assert.equal(warm.scanBytes, cold.scanBytes); assert.equal(warm.verificationBytes, 0);
  assert.equal(warm.bodyBytes - cold.bodyBytes, fs.statSync(f.filePath).size - f.offset);
  assert.equal(warm.cacheHits, 1);
});

test('wrong identity, mid-line offset, source session, length and record kind reject', async t => {
  const f = fixture(t);
  for (const patch of [
    { sourceIdentity: `codex-user-source-${SID}-${f.offset + 1}`, recordByteOffset: f.offset + 1 },
    { sourceIdentity: `codex-user-source-other-${f.offset}` },
    { sourceIdentity: `codex-user-source-${SID}-2026-09-19T16:47:17Z` },
    { sourceIdentity: `codex-user-source-${SID}-9007199254740992` },
    { recordByteOffset: 0 }, { actualHash: 'wrong' }, { actualHash: '' },
    { auditTimestamp: '2026-09-19T16:47:18.123Z' }, { actualLen: 99 },
  ]) assert.equal(await resolve({ ...f, audit: { ...f.audit, ...patch } }), null, JSON.stringify(patch));
  assert.equal(await resolve(fixture(t, { prefix: line({ type: 'session_meta', payload: { id: 'foreign' } }) })), null);
  const addressed = await f.readAddress(f.filePath, f.offset);
  for (const patch of [{ __line: undefined }, { __line: -1 }, { __byteOffset: 0 }, { type: 'turn_context' }])
    assert.equal(await resolve({ ...f, readAddress: async () => ({ ...addressed, record: { ...addressed.record, ...patch } }) }), null);
});

test('unfinished tail waits for real LF; one-byte chunks preserve UTF-8 and physical lines', async t => {
  const f = fixture(t, { newline: '', message: 'Привет 🐈', chunkBytes: 1 });
  assert.equal(await resolve(f), null); fs.appendFileSync(f.filePath, '\n');
  assert.equal((await resolve(f)).entryUuid, `codex-user-${SID}-5`);
});

test('metadata JSON semantics: escaped/duplicate keys, late metadata, BOM/CRLF, malformed ignored fields', async t => {
  for (const prefix of [
    '\ufeff\r\n{bad json}\r\n{"payload":{"id":"session-a"},"ty\\u0070e":"session_meta"}\r\n',
    line({ type: 'response_item', payload: { output: 'x'.repeat(1024 * 1024) } })
      + '{"type":"wrong","type":"session_meta","payload":{"id":"wrong","id":"session-a"}}\n',
    '\n'.repeat(150) + line({ type: 'session_meta', payload: { id: SID } }),
  ]) {
    const f = fixture(t, { prefix, chunkBytes: 4093 });
    assert.equal((await resolve(f)).entryUuid, `codex-user-${SID}-${(await canonical(f)).__line}`);
  }
  assert.equal((await resolve(fixture(t, { prefix: '\n', suffix: line({ type: 'session_meta', payload: { id: SID } }) }))).entryUuid, `codex-user-${SID}-1`);
  assert.equal(await resolve(fixture(t, { prefix: '{"type":"session_meta","payload":{"id":"session-a"},"ignored":[0,]}\n' })), null);
  assert.equal(await resolve(fixture(t, { prefix: line({ type: 'session_meta', payload: { id: 'wrong' } })
    + line({ type: 'session_meta', payload: { id: SID } }) })), null, 'first metadata wins');
});

test('rewrite+growth invalidates old line counts even at the same target offset/text', async t => {
  const f = fixture(t); assert.equal((await resolve(f)).entryUuid, `codex-user-${SID}-5`);
  const b = fs.readFileSync(f.filePath); b[b.indexOf(Buffer.from(' \n'))] = 10;
  fs.writeFileSync(f.filePath, Buffer.concat([b, Buffer.from('\n')]));
  assert.equal((await resolve(f)).entryUuid, `codex-user-${SID}-6`);
  assert.equal(f.reader.stats().scans, 2);
});

test('replacement, shrink and same-size rewrite during target read reject and discard locator', async t => {
  for (const kind of ['replace', 'shrink', 'rewrite']) {
    const f = fixture(t, { readJsonlRange: async (...args) => {
      const out = await api.readJsonlRange(...args), file = args[0], before = fs.statSync(file), b = fs.readFileSync(file);
      if (kind === 'replace') { fs.writeFileSync(file + '.new', b); fs.renameSync(file + '.new', file); }
      if (kind === 'shrink') fs.truncateSync(file, b.length - 1);
      if (kind === 'rewrite') { b[b.indexOf(Buffer.from(' \n'))] = 10; fs.writeFileSync(file, b); fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 1000)); }
      return out;
    } });
    assert.equal(await resolve(f), null, kind); assert.equal(f.reader.stats().files, 0);
  }
});

test('concurrent append preserves capability; rewrite+growth revalidates physical coordinates, not only prompt hash', async t => {
  for (const rewrite of [false, true]) {
    const f = fixture(t, { readJsonlRange: async (...args) => {
      const out = await api.readJsonlRange(...args);
      if (rewrite) { const b = fs.readFileSync(args[0]); b[b.indexOf(Buffer.from(' \n'))] = 10; fs.writeFileSync(args[0], b); }
      fs.appendFileSync(args[0], line({ type: 'event_msg', payload: { type: 'token_count' } }));
      return out;
    } });
    assert.equal((await resolve(f))?.entryUuid || null, rewrite ? null : `codex-user-${SID}-5`);
    assert.ok(f.reader.stats().verificationBytes > 0);
  }
});

test('growth verification covers metadata and exact target; unrelated bytes with the same coordinates are not transcript authority', async t => {
  for (const kind of ['metadata', 'target', 'unrelated']) {
    const f = fixture(t, { readJsonlRange: async (...args) => {
      const out = await api.readJsonlRange(...args);
      let text = fs.readFileSync(args[0], 'utf8');
      if (kind === 'metadata') text = text.replace('session-a', 'session-b');
      if (kind === 'target') { const last = text.lastIndexOf('same prompt'); text = text.slice(0, last) + text.slice(last).replace('same prompt', 'fake prompt'); }
      if (kind === 'unrelated') text = text.replace('not-json', 'bad-json');
      fs.writeFileSync(args[0], text + '\n');
      return out;
    } });
    const result = await resolve(f);
    assert.equal(result?.entryUuid || null, kind === 'unrelated' ? `codex-user-${SID}-5` : null, kind);
    if (result) assert.equal(result.entryUuid, `codex-user-${SID}-${(await canonical(f)).__line}`);
  }
});

test('failed same-file flight leaves no cursor, and queued retry succeeds', async t => {
  let calls = 0;
  const f = fixture(t, { readJsonlRange: async (...args) => { if (++calls === 1) throw Error('injected read failure'); return api.readJsonlRange(...args); } });
  // FIFO starts at reader.read, not at resolve's preceding asynchronous stat.
  // Calling two resolvers and expecting their stat replies in submission order
  // made this regression flaky under the combined ElectronNode suite.
  const out = await Promise.allSettled([
    f.reader.read(f.filePath, f.offset), f.reader.read(f.filePath, f.offset),
  ]);
  assert.equal(out[0].status, 'rejected'); assert.equal(out[1].status, 'fulfilled');
  assert.equal(out[1].value.record.__line, 5);
  assert.equal((await resolve(f)).entryUuid, `codex-user-${SID}-5`);
  assert.equal(f.reader.stats().inflight, 0); assert.equal(f.reader.stats().addresses, 1);
});

test('parallel resolvers preserve one failed attempt and one exact result regardless of preflight completion order', async t => {
  let calls = 0;
  const f = fixture(t, { readJsonlRange: async (...args) => { if (++calls === 1) throw Error('injected read failure'); return api.readJsonlRange(...args); } });
  const out = await Promise.allSettled([resolve(f), resolve(f)]);
  assert.deepEqual(out.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.match(out.find(result => result.status === 'rejected').reason.message, /injected read failure/);
  assert.equal(out.find(result => result.status === 'fulfilled').value.entryUuid, `codex-user-${SID}-5`);
  assert.equal(f.reader.stats().inflight, 0); assert.equal(f.reader.stats().addresses, 1);
});

test('metadata cache is bounded across files; eviction never calls full raw parser', async t => {
  const a = fixture(t), b = fixture(t), c = fixture(t);
  const reader = createReader({ readJsonlRange: api.readJsonlRange, maxFiles: 2, maxAddressesPerFile: 1, log: {} });
  for (const f of [a, b, c, a]) assert.ok(await resolve({ ...f, readAddress: reader.read }));
  assert.equal(reader.stats().files, 2); assert.equal(reader.stats().addresses, 2); assert.equal(reader.stats().scans, 4);
});
