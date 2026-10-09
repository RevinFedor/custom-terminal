'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const codexData = require('./ipc/codex-data');
const {
  createCodexVirtualTranscriptStore,
  hashFileSegment,
} = require('./codex-virtual-transcript');
const {
  buildCodexForkLineageManifest,
} = require('./session-history-events');

const SOURCE = '01a02eb0-f7dc-7910-9969-1bffae88d8d3';
const CHILD = '01a02ed8-e41e-7522-97ad-dedf6e7233ac';
const GRANDCHILD = '01a02f00-0000-7000-8000-000000000003';

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function sessionMeta(id, forkedFromId = null) {
  return {
    timestamp: '2026-08-23T13:00:00.000Z',
    type: 'session_meta',
    payload: {
      id,
      cwd: '/fixture',
      ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
    },
  };
}

function settings() {
  return { type: 'event_msg', payload: { type: 'thread_settings_applied' } };
}

function turn(text, suffix) {
  return [
    { type: 'event_msg', payload: { type: 'task_started', started_at: 1787490000 } },
    {
      timestamp: `2026-08-23T13:00:0${suffix}.000Z`,
      type: 'event_msg',
      payload: { type: 'user_message', message: text },
    },
    {
      timestamp: `2026-08-23T13:00:0${suffix}.500Z`,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'answer-' + suffix }],
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ];
}

async function frozenSegment(filePath, physicalSessionId, startLine = 0, fromByte = 0) {
  const stat = await fs.promises.stat(filePath);
  const parsed = await codexData._api.readJsonlRange(filePath, fromByte, stat.size - 1, {
    lineCount: startLine,
  });
  const digest = await hashFileSegment(filePath, fromByte, stat.size);
  return {
    physicalSessionId,
    fromByte,
    toByte: stat.size,
    startLine,
    endLine: parsed.lineCount,
    prefixDigest: digest.sha256,
  };
}

function descriptor(viewOwnerSessionId, eventKey, manifest) {
  return { viewOwnerSessionId, eventKey, manifest };
}

test('exact production fork IDs project frozen source plus one incremental child tail', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-virtual-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, SOURCE + '.jsonl');
  const childPath = path.join(dir, CHILD + '.jsonl');
  const sourceRecords = [sessionMeta(SOURCE), settings(), ...turn('duplicate prompt', 1), ...turn('duplicate prompt', 2)];
  const childPrelude = [sessionMeta(CHILD, SOURCE), settings()];
  await fs.promises.writeFile(sourcePath, jsonl(sourceRecords));
  await fs.promises.writeFile(childPath, jsonl(childPrelude));
  const sourceSegment = await frozenSegment(sourcePath, SOURCE);
  const childPreludeSize = (await fs.promises.stat(childPath)).size;
  const childPreludeDigest = await hashFileSegment(childPath, 0, childPreludeSize);
  const childTailStart = {
    byteOffset: childPreludeSize,
    line: childPrelude.length,
    prefixDigest: childPreludeDigest.sha256,
  };
  const manifest = buildCodexForkLineageManifest({
    sourceSessionId: SOURCE,
    childSessionId: CHILD,
    sourceSegments: [sourceSegment],
    childTailStart,
  });
  const byId = new Map([[SOURCE, sourcePath], [CHILD, childPath]]);
  const store = createCodexVirtualTranscriptStore({
    codexApi: {
      ...codexData._api,
      findCodexSessionFile: async (sessionId) => (
        byId.has(sessionId) ? { filePath: byId.get(sessionId) } : null
      ),
    },
  });

  const first = await store.project(descriptor(CHILD, `fork:codex:${SOURCE}:${CHILD}`, manifest), dir);
  assert.equal(first.timelineEntries.filter((entry) => entry.type === 'user').length, 2);
  assert.ok(first.historyEntries.length > 0);
  assert.equal(first.timelineEntries.every((entry) => entry.viewOwnerSessionId === CHILD), true);
  assert.equal(first.timelineEntries.every((entry) => entry.physicalSessionId === SOURCE), true);
  assert.equal(new Set(first.timelineEntries.map((entry) => entry.uuid)).size, first.timelineEntries.length,
    'duplicate text remains two exact physical rows');
  for (const entry of first.timelineEntries.filter(entry => entry.type === 'user')) {
    const final = first.historyEntries.find(row => row.uuid === entry.responsePreview?.uuid);
    assert.ok(final, 'inherited final has the same exact History locator');
    assert.deepEqual(entry.responsePreview.entryRef, final.entryRef);
  }

  await fs.promises.appendFile(childPath, jsonl(turn('duplicate prompt', 3)));
  const appended = await store.project(descriptor(CHILD, `fork:codex:${SOURCE}:${CHILD}`, manifest), dir);
  const appendedUsers = appended.timelineEntries.filter((entry) => entry.type === 'user');
  assert.equal(appended.mode, 'append');
  assert.equal(appendedUsers.length, 3);
  assert.equal(appendedUsers.at(-1).physicalSessionId, CHILD);
  assert.equal(new Set(appendedUsers.map((entry) => entry.uuid)).size, 3);

  const unchanged = await store.project(descriptor(CHILD, `fork:codex:${SOURCE}:${CHILD}`, manifest), dir);
  assert.equal(unchanged.mode, 'unchanged');
  assert.equal(unchanged.timelineEntries.filter((entry) => entry.type === 'user').length, 3,
    'the child append is consumed exactly once');

  await fs.promises.appendFile(sourcePath, jsonl(turn('future source turn', 4)));
  const sourceGrew = await store.project(descriptor(CHILD, `fork:codex:${SOURCE}:${CHILD}`, manifest), dir);
  assert.equal(sourceGrew.timelineEntries.filter((entry) => entry.type === 'user').length, 3,
    'source bytes after the frozen cut never enter the child view');
  assert.equal(sourceGrew.timelineEntries.some((entry) => entry.content === 'future source turn'), false);

  const childBytes = await fs.promises.readFile(childPath);
  childBytes[0] = childBytes[0] === 0x7b ? 0x5b : 0x7b;
  await fs.promises.writeFile(childPath, childBytes);
  await assert.rejects(store.project(
    descriptor(CHILD, `fork:codex:${SOURCE}:${CHILD}`, manifest),
    dir,
  ), (error) => (
    error?.code === 'CODEX_LINEAGE_UNRESOLVED'
      && error?.reason === 'child-prefix-digest-mismatch'
  ));
});

test('multi-hop flattened manifest preserves every physical segment and rejects prefix mutation', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-virtual-hop-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, SOURCE + '.jsonl');
  const childPath = path.join(dir, CHILD + '.jsonl');
  const grandchildPath = path.join(dir, GRANDCHILD + '.jsonl');
  const sourceRecords = [sessionMeta(SOURCE), settings(), ...turn('source', 1)];
  const childPrelude = [sessionMeta(CHILD, SOURCE), settings()];
  await fs.promises.writeFile(sourcePath, jsonl(sourceRecords));
  await fs.promises.writeFile(childPath, jsonl(childPrelude));
  const childTailStart = (await fs.promises.stat(childPath)).size;
  await fs.promises.appendFile(childPath, jsonl(turn('child', 2)));
  const grandchildPrelude = [sessionMeta(GRANDCHILD, CHILD), settings()];
  await fs.promises.writeFile(grandchildPath, jsonl(grandchildPrelude));

  const sourceSegment = await frozenSegment(sourcePath, SOURCE);
  const childSegment = await frozenSegment(childPath, CHILD, childPrelude.length, childTailStart);
  const manifest = buildCodexForkLineageManifest({
    sourceSessionId: CHILD,
    childSessionId: GRANDCHILD,
    sourceSegments: [sourceSegment, childSegment],
    childTailStart: {
      byteOffset: (await fs.promises.stat(grandchildPath)).size,
      line: grandchildPrelude.length,
      prefixDigest: (await hashFileSegment(
        grandchildPath,
        0,
        (await fs.promises.stat(grandchildPath)).size,
      )).sha256,
    },
  });
  const byId = new Map([[SOURCE, sourcePath], [CHILD, childPath], [GRANDCHILD, grandchildPath]]);
  const store = createCodexVirtualTranscriptStore({
    codexApi: {
      ...codexData._api,
      findCodexSessionFile: async (sessionId) => (
        byId.has(sessionId) ? { filePath: byId.get(sessionId) } : null
      ),
    },
  });
  const input = descriptor(GRANDCHILD, `fork:codex:${CHILD}:${GRANDCHILD}`, manifest);
  const first = await store.project(input, dir);
  const users = first.timelineEntries.filter((entry) => entry.type === 'user');
  assert.deepEqual(users.map((entry) => entry.physicalSessionId), [SOURCE, CHILD]);
  assert.deepEqual(users.map((entry) => entry.content), ['source', 'child']);

  const original = await fs.promises.readFile(sourcePath);
  const changed = Buffer.from(original);
  changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
  await fs.promises.writeFile(sourcePath, changed);
  await assert.rejects(store.project(input, dir), (error) => (
    error?.code === 'CODEX_LINEAGE_UNRESOLVED'
      && error?.reason === 'source-segment-digest-mismatch'
  ));
});

test('child rollback mutates the inherited source state inside one projector', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-virtual-rollback-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, SOURCE + '.jsonl');
  const childPath = path.join(dir, CHILD + '.jsonl');
  const sourceRecords = [sessionMeta(SOURCE), settings(), ...turn('keep', 1), ...turn('rollback me', 2)];
  const childPrelude = [sessionMeta(CHILD, SOURCE), settings()];
  await fs.promises.writeFile(sourcePath, jsonl(sourceRecords));
  await fs.promises.writeFile(childPath, jsonl(childPrelude));
  const childStart = (await fs.promises.stat(childPath)).size;
  const childPrefix = await hashFileSegment(childPath, 0, childStart);
  await fs.promises.appendFile(childPath, jsonl([{
    type: 'event_msg',
    payload: { type: 'thread_rolled_back', num_turns: 1 },
  }]));
  const manifest = buildCodexForkLineageManifest({
    sourceSessionId: SOURCE,
    childSessionId: CHILD,
    sourceSegments: [await frozenSegment(sourcePath, SOURCE)],
    childTailStart: {
      byteOffset: childStart,
      line: childPrelude.length,
      prefixDigest: childPrefix.sha256,
    },
  });
  const byId = new Map([[SOURCE, sourcePath], [CHILD, childPath]]);
  const store = createCodexVirtualTranscriptStore({
    codexApi: {
      ...codexData._api,
      findCodexSessionFile: async (sessionId) => (
        byId.has(sessionId) ? { filePath: byId.get(sessionId) } : null
      ),
    },
  });
  const projected = await store.project(
    descriptor(CHILD, `fork:codex:${SOURCE}:${CHILD}`, manifest),
    dir,
  );
  assert.deepEqual(
    projected.timelineEntries.filter((entry) => entry.type === 'user').map((entry) => entry.content),
    ['keep'],
  );
  assert.equal(projected.historyEntries.some((entry) => entry.content === 'rollback me'), false);
});
