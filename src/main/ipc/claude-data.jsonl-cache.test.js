'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadJsonlRecords,
  _api,
} = require('./claude-data');

let tempDir;

function record(sessionId, index) {
  return JSON.stringify({
    type: index % 7 === 0 ? 'assistant' : 'user',
    uuid: sessionId + '-uuid-' + index,
    parentUuid: index > 0 ? sessionId + '-uuid-' + (index - 1) : null,
    sessionId,
    message: {
      content: 'payload-' + index,
    },
  });
}

function writeRecords(filePath, sessionId, count) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(record(sessionId, index));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jsonl-cache-'));
  _api.resetJsonlCacheForTests();
});

test.afterEach(() => {
  _api.resetJsonlCacheForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('large full parse yields to the event loop in bounded batches', async () => {
  const sessionId = 'yield-session';
  const filePath = path.join(tempDir, sessionId + '.jsonl');
  writeRecords(filePath, sessionId, 4_500);

  const result = await loadJsonlRecords(filePath);
  const stats = _api.getJsonlCacheStats();

  assert.equal(result.recordMap.size, 4_500);
  assert.ok(stats.parseYields >= 2);
  assert.equal(stats.files, 1);
  assert.equal(stats.rawBytes, fs.statSync(filePath).size);
});

test('parallel reads of one file join one in-flight parse', async () => {
  const sessionId = 'single-flight-session';
  const filePath = path.join(tempDir, sessionId + '.jsonl');
  writeRecords(filePath, sessionId, 4_500);

  const first = loadJsonlRecords(filePath);
  const second = loadJsonlRecords(filePath);
  const third = loadJsonlRecords(filePath);
  const results = await Promise.all([first, second, third]);
  const stats = _api.getJsonlCacheStats();

  assert.equal(stats.inflightJoins, 2);
  assert.equal(stats.inflight, 0);
  assert.equal(results[0].recordMap, results[1].recordMap);
  assert.equal(results[1].recordMap, results[2].recordMap);
});

test('incremental append preserves the existing Map and adds only new records', async () => {
  const sessionId = 'append-session';
  const filePath = path.join(tempDir, sessionId + '.jsonl');
  writeRecords(filePath, sessionId, 3);

  const first = await loadJsonlRecords(filePath);
  fs.appendFileSync(filePath, record(sessionId, 3) + '\n', 'utf8');
  const second = await loadJsonlRecords(filePath);

  assert.equal(second.recordMap, first.recordMap);
  assert.equal(second.recordMap.size, 4);
  assert.equal(second.lastRecord.uuid, sessionId + '-uuid-3');
  assert.equal(_api.getJsonlCacheStats().rawBytes, fs.statSync(filePath).size);
});

test('full and incremental parses preserve exact UTF-8 byte offsets', async () => {
  const sessionId = 'byte-offset-session';
  const filePath = path.join(tempDir, sessionId + '.jsonl');
  const firstLine = JSON.stringify({
    type: 'user',
    uuid: 'offset-user-1',
    sessionId,
    message: { content: 'привет' },
  });
  const secondLine = JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    sessionId,
    content: 'дальше',
  });
  const thirdLine = JSON.stringify({
    type: 'assistant',
    uuid: 'offset-assistant-2',
    sessionId,
    message: { content: 'готово' },
  });
  fs.writeFileSync(filePath, firstLine + '\n' + secondLine + '\n', 'utf8');

  const first = await loadJsonlRecords(filePath);
  assert.equal(first.recordMap.get('offset-user-1').__byteOffset, 0);
  assert.equal(
    first.queueOperations[0].__byteOffset,
    Buffer.byteLength(firstLine, 'utf8') + 1,
  );

  fs.appendFileSync(filePath, thirdLine + '\n', 'utf8');
  const second = await loadJsonlRecords(filePath);
  assert.equal(
    second.recordMap.get('offset-assistant-2').__byteOffset,
    Buffer.byteLength(firstLine + '\n' + secondLine + '\n', 'utf8'),
  );
});

test('explicit invalidation during a yielded parse cannot republish stale data', async () => {
  const sessionId = 'invalidate-session';
  const filePath = path.join(tempDir, sessionId + '.jsonl');
  writeRecords(filePath, sessionId, 4_500);

  const pending = loadJsonlRecords(filePath);
  _api.invalidateJsonlCache(filePath);
  fs.appendFileSync(filePath, record(sessionId, 4_500) + '\n', 'utf8');

  const result = await pending;
  const stats = _api.getJsonlCacheStats();
  assert.equal(result.recordMap.size, 4_501);
  assert.equal(result.lastRecord.uuid, sessionId + '-uuid-4500');
  assert.equal(stats.files, 1);
  assert.equal(stats.inflight, 0);
});

test('LRU retains at most three parsed Claude files', async () => {
  const filePaths = [];
  for (let index = 0; index < 4; index += 1) {
    const sessionId = 'lru-session-' + index;
    const filePath = path.join(tempDir, sessionId + '.jsonl');
    writeRecords(filePath, sessionId, 2);
    filePaths.push(filePath);
    await loadJsonlRecords(filePath);
  }

  const stats = _api.getJsonlCacheStats();
  assert.equal(stats.files, 3);
  assert.deepEqual(stats.filePaths, filePaths.slice(1));
  assert.equal(
    stats.rawBytes,
    filePaths.slice(1).reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0),
  );
});

test('chunked full read parses records split across chunk boundaries', async () => {
  // Prod 17.08: reading the whole file at once held the raw buffer, its string
  // copy AND the split-line array at the same moment — a 111MB transcript cost
  // ~700MB before a single record existed, and the main process aborted with
  // «FatalProcessOutOfMemory» three times. The read is streamed now, so a
  // record almost certainly straddles a chunk boundary; none may be lost or
  // truncated, and byte offsets must stay exact.
  const sessionId = 'chunk-boundary-session';
  const filePath = path.join(tempDir, sessionId + '.jsonl');
  const lines = [];
  for (let index = 0; index < 4000; index += 1) {
    lines.push(JSON.stringify({
      type: index % 5 === 0 ? 'assistant' : 'user',
      uuid: sessionId + '-uuid-' + index,
      sessionId,
      // Multi-byte payload: a naive chunk split would also corrupt UTF-8.
      message: { content: 'полезная нагрузка ' + index + ' ' + 'ы'.repeat(1200) },
    }));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

  const loaded = await loadJsonlRecords(filePath);
  assert.equal(loaded.recordMap.size, 4000);
  assert.equal(loaded.recordMap.get(sessionId + '-uuid-0').__byteOffset, 0);
  // Every record's stored offset must point at its real first byte.
  let expectedOffset = 0;
  for (let index = 0; index < 4000; index += 1) {
    const entry = loaded.recordMap.get(sessionId + '-uuid-' + index);
    assert.ok(entry, 'record ' + index + ' survived the chunk boundary');
    assert.equal(entry.__byteOffset, expectedOffset);
    assert.equal(entry.message.content.endsWith('ы'), true);
    expectedOffset += Buffer.byteLength(lines[index], 'utf8') + 1;
  }

  // The cached source size must match the file, or the next incremental read
  // would re-parse from a wrong offset.
  assert.equal(
    _api.getJsonlCacheStats().rawBytes,
    fs.statSync(filePath).size,
  );

  // And an append on top of a streamed base still lands incrementally.
  const extra = JSON.stringify({
    type: 'user',
    uuid: sessionId + '-uuid-tail',
    sessionId,
    message: { content: 'хвост' },
  });
  fs.appendFileSync(filePath, extra + '\n', 'utf8');
  const appended = await loadJsonlRecords(filePath);
  assert.equal(appended.recordMap.size, 4001);
  assert.equal(
    appended.recordMap.get(sessionId + '-uuid-tail').__byteOffset,
    expectedOffset,
  );
});

test('a timestamp shift alone does not re-parse the file', async () => {
  // Прод 18.08: живой транскрипт на 111 МБ разбирался ДВАЖДЫ подряд —
  // «full … reason=first-read», сразу за ним «full … reason=rewrite-or-shrink».
  // Причина: совпадения размера было мало, требовалось ещё и совпадение времени
  // изменения, а оно уезжает само по себе. Файлы дописываются только в конец,
  // поэтому одинаковый размер = одинаковое содержимое.
  const filePath = path.join(tempDir, 'touch-only.jsonl');
  writeRecords(filePath, 'touch-only', 400);

  const first = await loadJsonlRecords(filePath);
  assert.equal(first.recordMap.size, 400);
  const parsedMap = first.recordMap;

  // Трогаем время, не меняя ни одного байта.
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(filePath, future, future);

  const second = await loadJsonlRecords(filePath);
  assert.equal(second.recordMap.size, 400);
  assert.equal(
    second.recordMap, parsedMap,
    'должен вернуться ТОТ ЖЕ разобранный набор, а не свежая копия',
  );

  // И дозапись поверх этого по-прежнему работает как приращение.
  fs.appendFileSync(filePath, record('touch-only', 400) + '\n', 'utf8');
  const third = await loadJsonlRecords(filePath);
  assert.equal(third.recordMap.size, 401);
  assert.equal(third.recordMap, parsedMap, 'дозапись дополняет тот же набор');
});

test('materialization of a growing session costs a stat, not a full read', async () => {
  // Прод 18.08 00:05–00:07: пользователь прокручивал историю в одной вкладке и
  // ловил жёсткие подёргивания. Причина — в главном процессе: на каждое
  // изменение транскрипта живой сессии выполнялось СИНХРОННОЕ чтение всего
  // файла целиком, только чтобы ответить «в сессии есть записи?». На файле в
  // 111 МБ это ~450 мс полной остановки главного процесса, и повторялось это
  // каждые пару секунд. Замер главного цикла в те минуты: паузы 660–810 мс.
  const { getSessionMaterialization, _api: api } = require('./claude-data');
  api.resetSessionMaterializationCacheForTests();

  const sessionId = 'materialization-growth-' + process.pid;
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const projectDir = path.join(projectsDir, '-tmp-materialization-test-' + process.pid);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, sessionId + '.jsonl');

  const realReadFileSync = fs.readFileSync;
  let fullReads = 0;
  fs.readFileSync = function patched(target, ...rest) {
    if (target === filePath) fullReads += 1;
    return realReadFileSync.call(this, target, ...rest);
  };

  try {
    writeRecords(filePath, sessionId, 50);

    const first = getSessionMaterialization(sessionId, null);
    assert.equal(first.materialized, true);
    assert.equal(fullReads, 1, 'первый ответ честно читает файл');

    // Файл не менялся — ответ из кэша.
    getSessionMaterialization(sessionId, null);
    assert.equal(fullReads, 1);

    // Дозапись: файл только вырос. Ответ «сессия непустая» измениться не мог.
    for (let i = 0; i < 5; i += 1) {
      fs.appendFileSync(filePath, record(sessionId, 50 + i) + '\n', 'utf8');
      const next = getSessionMaterialization(sessionId, null);
      assert.equal(next.materialized, true);
      assert.equal(next.fileSize, fs.statSync(filePath).size, 'размер отдаётся свежий');
    }
    assert.equal(fullReads, 1, 'ни одного повторного чтения файла на пять дозаписей');

    // Переписывание файла (откат/форк) — честный пересчёт, кэш не обманывает.
    fs.writeFileSync(filePath, '', 'utf8');
    const afterRewrite = getSessionMaterialization(sessionId, null);
    assert.equal(afterRewrite.materialized, false, 'опустевшая сессия распознана');
    assert.equal(fullReads, 2);
  } finally {
    fs.readFileSync = realReadFileSync;
    api.resetSessionMaterializationCacheForTests();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
