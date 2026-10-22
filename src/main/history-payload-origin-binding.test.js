'use strict';
// Real canonical reducer/dehydrator/cache/locator, with a finite own physical
// source and an explicit fixture generation certificate. No app/provider I/O.
process.env.NOTED_HISTORY_READER_PROCESS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('./ipc/codex-data')._api;
const { dehydrateHistoryEntries } = require('./history-payload-dehydrate');
const { HistoryPreparedCache } = require('./history-prepared-cache');
const { findDirectCodexPayloadSourceLeaf } = require('./codex-payload-source-leaf');
const { readSourceLeafPage } = require('./history-source-leaf');

test('BACKEND-LITERAL-SUFFIX: actual canonical row binds rightmost action suffix and exact output line', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-origin-binding-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionId = 'own-session', providerCallId = 'provider:canonical:0', output = 'literal-provider-output';
  const filePath = path.join(directory, 'own.jsonl'), owner = { sessionId, cwd: directory };
  const records = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'own question' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: providerCallId, name: 'read_file', arguments: '{"path":"own-fixture"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: providerCallId, output } },
  ];
  const projector = api.createCodexHistoryProjector(sessionId); let byteOffset = 0;
  for (let line = 0; line < records.length; line++) {
    const record = { timestamp: '2026-10-22T00:00:00Z', ...records[line] }, jsonl = JSON.stringify(record) + '\n';
    fs.appendFileSync(filePath, jsonl);
    projector.feed({ ...record, __line: line, __byteOffset: byteOffset }); byteOffset += Buffer.byteLength(jsonl);
  }
  const entries = projector.finalize();
  dehydrateHistoryEntries({ toolType: 'codex', sessionId, entries, threshold: 0 });
  const row = entries.find(entry => entry.actions?.some(action => action.rawTool?.resultRef));
  const raw = row.actions[0].rawTool, ref = raw.resultRef;
  assert.equal(raw.toolUseId, 'provider:canonical:0:canonical:0');
  assert.equal(raw.resultSourceLine, 2); assert.equal(ref.payloadId, 'result:' + raw.toolUseId);
  const stat = fs.statSync(filePath), source = { filePath, sessionId, size: stat.size, mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs, fileIdentity: stat.dev + ':' + stat.ino, sourceGeneration: 'fixture-generation' };
  const cache = new HistoryPreparedCache({ directory: path.join(directory, 'cache'), indexBudgetBytes: 0 });
  assert.equal(await cache.savePrepared({ owner, source, context: 'fixture-view', entries }), true);
  cache.clearMemory();
  const binding = cache.readPayloadBinding(owner, ref.payloadId, source, { entryUuid: row.uuid, contentHash: ref.contentHash });
  assert.equal(binding.sourceCallId, providerCallId); assert.equal(binding.sourceRecordLine, 2);
  const hit = await findDirectCodexPayloadSourceLeaf({ filePath, payloadId: ref.payloadId,
    sourceCallId: binding.sourceCallId, sourceRecordLine: binding.sourceRecordLine,
    expectedContentHash: binding.contentHash, totalChars: binding.totalChars, sourceSnapshot: source });
  assert.equal((await readSourceLeafPage({ filePath, ref: hit.ref, offset: 0, limit: 1024 })).payload, output);
  assert.equal(await findDirectCodexPayloadSourceLeaf({ filePath, payloadId: ref.payloadId,
    expectedContentHash: binding.contentHash, totalChars: binding.totalChars }), null,
  'the client payload ID alone is not a provider call relationship');
});
