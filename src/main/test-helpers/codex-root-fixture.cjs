'use strict';

// Finite synthetic source files only. Never opens the application's storage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const assert = require('node:assert/strict');
const api = require('../ipc/codex-data')._api;
const { HistoryPagedStore } = require('../history-paged-store');
const { CodexRootProjectionOwner } = require('../codex-root-projection-owner');
const { encodeHistoryStream } = require('../history-stream-codec');
const { HistoryByteSender, HistoryByteReceiver } = require('../history-byte-stream');
const time = '2026-10-22T00:00:00Z';
const user = text => ({ type: 'event_msg',timestamp: time,payload: { type: 'user_message',message: text } });
const answer = text => ({ type: 'response_item',timestamp: time,
  payload: { type: 'message',role: 'assistant',content: [{ type: 'output_text',text }] } });
const call = (id, name = 'read_file', args = { path: 'own-' + id }) => ({ type: 'response_item',timestamp: time,
  payload: { type: 'function_call',call_id: id,name,arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const output = (id, text) => ({ type: 'response_item',timestamp: time,
  payload: { type: 'function_call_output',call_id: id,output: text } });

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'codex-root-fixture-'));
  const sessionId = crypto.randomUUID();
  const filePath = path.join(dir,'rollout-' + sessionId + '.jsonl');
  const store = new HistoryPagedStore({ filename: path.join(dir,'pages.sqlite'),pageBytes: 1024,
    indexBytes: options.indexBytes ?? 2048,residentPages: 3,...options.store });
  const owner = new CodexRootProjectionOwner(store,{ checkpointEvery: options.checkpointEvery ?? 17 });
  let offset = 0, line = 0;
  fs.writeFileSync(filePath,'');
  const append = record => {
    const encoded = JSON.stringify(record) + '\n';
    const located = { ...record,__byteOffset: offset,__line: line };
    fs.appendFileSync(filePath,encoded); offset += Buffer.byteLength(encoded); line++;
    return located;
  };
  const header = append({ type: 'session_meta',payload: { id: sessionId,cwd: dir,...options.header } });
  const read = options => api.projectCodexFullHistoryFromFile(sessionId,dir,
    { rootedOwner: owner,sessionsDir: dir,highWaterMark: 64,...options });
  t.after(() => { api.invalidateJsonlCache(filePath); owner.close(); store.close(); fs.rmSync(dir,{ recursive: true,force: true }); });
  return { dir,sessionId,filePath,store,owner,append,read,header,
    get offset() { return offset; },get line() { return line; } };
}

// Hash expected rows one at a time, and hash the actual 1KiB byte stream.
// No whole actual wire String, second whole oracle graph or ordered-ID array.
function digestRows() {
  const hash = crypto.createHash('sha256'), ids = crypto.createHash('sha256');
  let count = 0,bytes = 1;
  hash.update('[');
  return {
    add(row) {
      const text = JSON.stringify(row);
      if (count) { hash.update(','); bytes++; }
      hash.update(text); bytes += Buffer.byteLength(text);
      ids.update(String(count++) + ':' + row.uuid + '\n');
    },
    finish() { hash.update(']'); return { hash: hash.digest('hex'),ids: ids.digest('hex'),rows: count,bytes: bytes + 1 }; },
  };
}
const smallText = cursor => {
  assert.ok(cursor.length <= 4096,'only small semantic/ID fields may be joined in this harness');
  return [...cursor.textChunks()].join('');
};
async function hashRoot(result, { credit = true } = {}) {
  const hash = crypto.createHash('sha256'), ids = crypto.createHash('sha256');
  let bytes = 0, rows = 0,maxFrame = 0;
  for (const row of result.entries.rows()) ids.update(String(rows++) + ':' + smallText(row.field('uuid')) + '\n');
  const encoder = encodeHistoryStream(result.entries,{ frameBytes: 1024 });
  const senderStats = {}, receiverStats = {};
  let source = encoder, pumping;
  if (credit) {
    const receiver = new HistoryByteReceiver({ id: 'root',frameBytes: 1024,credits: 2,stats: receiverStats,
      send: message => message.event === 'stream-credit' ? sender.credit(message) : sender.cancel() });
    const sender = new HistoryByteSender({ id: 'root',frameBytes: 1024,credits: 2,stats: senderStats,
      send: message => receiver.accept(message) });
    pumping = sender.pump(encoder,{ representation: result.representation });
    source = receiver;
  }
  for await (const part of source) {
    hash.update(part); bytes += part.length; maxFrame = Math.max(maxFrame,part.length);
  }
  await pumping;
  assert.ok(maxFrame <= 1024);
  if (credit) {
    assert.ok(senderStats.maxOutstandingBytes <= 2048); assert.ok(senderStats.maxBoundaryCount <= 2);
    assert.ok(receiverStats.maxQueuedFrames <= 2); assert.ok(receiverStats.maxOutstandingBytes <= 2048);
  }
  return { hash: hash.digest('hex'),ids: ids.digest('hex'),rows,bytes };
}
function intervalAudit(indexBytes = 2048) {
  const max = { nativeRows: 0,nativeMapEntries: 0,nativeOwnFields: 0,handleCache: 0,pageCache: 0,
    indexBytes: 0,inputIdentitySlots: 0,peakInputObjects: 0,heapUsed: 0,external: 0,rss: 0 };
  const phases = {};
  return { max,phases,observe(stats) {
    phases[stats.phase] = (phases[stats.phase] || 0) + 1;
    for (const [name,value] of Object.entries(stats.ownership)) max[name] = Math.max(max[name] || 0,value);
    max.peakInputObjects = Math.max(max.peakInputObjects,stats.peakInputObjects);
    const memory = process.memoryUsage();
    for (const name of ['heapUsed','external','rss']) max[name] = Math.max(max[name],memory[name]);
    // Actual native targets behind internal handles, plus actual cache bytes.
    assert.equal(stats.ownership.nativeRows,0);
    assert.equal(stats.ownership.nativeMapEntries,0);
    assert.equal(stats.ownership.nativeOwnFields,0);
    assert.equal(stats.ownership.inputIdentitySlots,0);
    assert.ok(stats.ownership.handleCache <= 3);
    assert.ok(stats.store.peakCachedPages <= 3);
    assert.ok(stats.store.peakIndexBytes <= indexBytes);
    assert.equal(stats.store.legacyCaptureValues,0);
    assert.ok(stats.store.peakPageReadBytes <= 1024);
    assert.ok(stats.store.peakPageWriteBytes <= 1024);
  } };
}
function legacyRows(sessionId, records, options) {
  const projector = api.createCodexHistoryProjector(sessionId);
  for (const record of records) projector.feed(record);
  return projector.finalize(options);
}
async function smallRows(result) {
  assert.ok(result.entries.length <= 32,'semantic oracle must remain a small fixture');
  let wire = ''; const decoder = new StringDecoder('utf8');
  for await (const part of encodeHistoryStream(result.entries,{ frameBytes: 1024 })) wire += decoder.write(part);
  wire += decoder.end();
  assert.ok(Buffer.byteLength(wire) < 64 * 1024);
  return JSON.parse(wire);
}
module.exports = { api,fixture,user,answer,call,output,digestRows,hashRoot,intervalAudit,legacyRows,smallRows,smallText };
