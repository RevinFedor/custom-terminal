'use strict';

// Actual reader -> virtual source -> compact planner -> streaming writer.
// Only the fork metadata catalog and provider/launch are outside this fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codexData = require('./ipc/codex-data');
const { hashFileSegment } = require('./codex-virtual-transcript');
const { buildCodexForkLineageManifest } = require('./session-history-events');
const { SessionTranscriptService } = require('./session-transcript-service');
const api = codexData._api;
const SOURCE = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const image = color => 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="' + color + '"/></svg>',
).toString('base64');

async function fixture(t, location = 'ancestor', missing = false) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-virtual-compact-image-'));
  const sourcePath = path.join(root, SOURCE + '.jsonl'), childPath = path.join(root, CHILD + '.jsonl');
  const target = path.join(root, 'new-fork.jsonl');
  const images = [image('red'), image('blue'), image('red')];
  const compact = { type: 'compacted', payload: { message: 'synthetic summary', replacement_history: [
    { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'Синтетический Unicode before image — '.repeat(200) },
      { type: 'input_image', image_url: missing ? '[image omitted]' : images[0] },
      { type: 'input_image', imageUrl: images[1] },
      { type: 'input_image', image_url: images[2] },
    ] },
  ] } };
  const sourceRows = [{ type: 'session_meta', payload: { id: SOURCE, cwd: root } },
    ...(location === 'ancestor' ? [compact] : [])];
  const childHeader = [{ type: 'session_meta', payload: { id: CHILD, cwd: root, forked_from_id: SOURCE } }];
  await fs.promises.writeFile(sourcePath, jsonl(sourceRows));
  await fs.promises.writeFile(childPath, jsonl(childHeader));
  const sourceStat = await fs.promises.stat(sourcePath), childStat = await fs.promises.stat(childPath);
  const manifest = buildCodexForkLineageManifest({ sourceSessionId: SOURCE, childSessionId: CHILD,
    sourceSegments: [{ physicalSessionId: SOURCE, fromByte: 0, toByte: sourceStat.size,
      startLine: 0, endLine: sourceRows.length,
      prefixDigest: (await hashFileSegment(sourcePath, 0, sourceStat.size)).sha256 }],
    childTailStart: { byteOffset: childStat.size, line: childHeader.length,
      prefixDigest: (await hashFileSegment(childPath, 0, childStat.size)).sha256 },
  });
  if (location === 'tail') await fs.promises.appendFile(childPath, jsonl([compact]));
  const event = { eventKey: 'fixture-fork', eventType: 'fork', provider: 'codex',
    sessionId: CHILD, childSessionId: CHILD, sourceSessionId: SOURCE,
    snapshotComplete: true, isDirect: true, origin: 'app', forkMode: 'direct-virtual', lineageManifest: manifest };
  const paths = new Map([[SOURCE, sourcePath], [CHILD, childPath]]);
  const service = new SessionTranscriptService({ getMainWindow: () => null,
    codexData: { _api: { ...api, findCodexSessionFile: async id => ({ filePath: paths.get(id) }) } },
    sessionHistoryStore: { getSessionHistoryEvents: id => id === CHILD ? [event] : [] },
  });
  t.after(async () => {
    service.codexVirtualTranscriptStore?.dispose();
    for (const file of paths.values()) api.invalidateJsonlCache(file);
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  return { root, sourcePath, childPath, target, images, compact, service,
    async load() {
      const result = await service.loadCodexOperationSource({ sessionId: CHILD, cwd: root });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.composite, true);
      return result;
    } };
}

for (const location of ['ancestor', 'tail']) test('compact Fork preserves exact image bytes from virtual ' + location, async t => {
  const f = await fixture(t, location);
  const before = new Map(await Promise.all([f.sourcePath, f.childPath].map(async file => [file, await fs.promises.readFile(file)])));
  const loaded = await f.load();
  const compact = loaded.records.find(record => record.type === 'compacted');
  assert.equal(compact.payload.replacement_history[0].content[1].image_url, '[image omitted]');
  const plan = api.planCodexForkFromLatestCompact(loaded.records, CHILD);
  assert.equal(plan.success, true);
  await assert.doesNotReject(api.writeCodexJsonlExclusive(f.target, plan.outputRecords));
  const privateRanges = Object.getOwnPropertySymbols(compact)
    .map(key => Object.getOwnPropertyDescriptor(compact, key))
    .find(descriptor => Array.isArray(descriptor.value?.images));
  assert.ok(privateRanges);
  assert.equal(privateRanges.enumerable, false);
  assert.equal(privateRanges.writable, false);
  assert.equal(privateRanges.value.images.length, 3);
  assert.ok(privateRanges.value.images.every(range => range.filePath ===
    (location === 'ancestor' ? f.sourcePath : f.childPath)), 'writing the child does not retarget source ranges');
  const raw = await fs.promises.readFile(f.target, 'utf8');
  const written = raw.trim().split('\n').map(JSON.parse).find(record => record.type === 'compacted');
  assert.deepEqual(written, f.compact, 'ordered images, duplicate slots and Unicode are preserved exactly');
  assert.equal(raw.includes('[image omitted]'), false);
  assert.equal(raw.includes('__physicalSessionId'), false);
  assert.equal(raw.includes(f.sourcePath), false, 'private range paths must never become provider content');
  for (const [file, bytes] of before) assert.deepEqual(await fs.promises.readFile(file), bytes, 'source is read-only');
});

test('a changed image after virtual read still refuses the write and removes its partial child', async t => {
  const f = await fixture(t);
  const loaded = await f.load();
  const plan = api.planCodexForkFromLatestCompact(loaded.records, CHILD);
  const bytes = await fs.promises.readFile(f.sourcePath, 'utf8');
  // Change bytes inside the exact original range, without changing the length.
  const at = bytes.indexOf(f.images[0]) + f.images[0].length - 5;
  await fs.promises.writeFile(f.sourcePath, bytes.slice(0, at) + (bytes[at] === 'A' ? 'B' : 'A') + bytes.slice(at + 1));
  await assert.rejects(api.writeCodexJsonlExclusive(f.target, plan.outputRecords),
    error => error.code === 'codex_compact_raw_image_source_changed');
  assert.equal(fs.existsSync(f.target), false);
});

test('virtual decoration does not invent missing image bytes or turn an already damaged compact into success', async t => {
  const f = await fixture(t, 'ancestor', true);
  const loaded = await f.load();
  const plan = api.planCodexForkFromLatestCompact(loaded.records, CHILD);
  await assert.rejects(api.writeCodexJsonlExclusive(f.target, plan.outputRecords));
  assert.equal(fs.existsSync(f.target), false);
});
