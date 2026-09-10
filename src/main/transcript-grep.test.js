'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classifyTranscriptRecord,
  collectTranscriptMatches,
  filterByTranscriptWindow,
  scanTranscriptFile,
} = require('./transcript-grep');

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-grep-'));
  const filePath = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return filePath;
}

const codexPatchApply = {
  timestamp: '2026-09-10T09:02:17.172Z',
  type: 'event_msg',
  payload: {
    type: 'patch_apply_end',
    success: true,
    changes: {
      '/repo/src/renderer/components/Workspace/HistoryPanel.tsx': {
        unified_diff: "@@\n+            flushHistoryComposerDrafts();\n",
      },
    },
  },
};

const codexExecPatch = {
  timestamp: '2026-09-10T09:02:17.150Z',
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    name: 'exec',
    input: 'const patch = "*** Begin Patch\\n*** Update File: /repo/src/main/main.js\\n+  flushHistoryComposerDrafts();\\n*** End Patch"',
  },
};

const codexReadOnlyExec = {
  timestamp: '2026-09-10T08:00:00.000Z',
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    name: 'exec',
    input: '{"command":["bash","-lc","rg -n flushHistoryComposerDrafts src"]}',
  },
};

const claudeEdit = {
  timestamp: '2026-09-10T07:00:00.000Z',
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      name: 'Edit',
      input: {
        file_path: '/repo/src/renderer/store/useUIStore.ts',
        old_string: 'const a = 1;',
        new_string: 'flushHistoryComposerDrafts();',
      },
    }],
  },
};

const claudePrompt = {
  timestamp: '2026-09-10T06:00:00.000Z',
  type: 'user',
  message: { role: 'user', content: 'почини flushHistoryComposerDrafts' },
};

test('Codex patch_apply_end распознан как правка и отдаёт изменённые файлы', () => {
  const classified = classifyTranscriptRecord(JSON.stringify(codexPatchApply));
  assert.equal(classified.kind, 'edit');
  assert.equal(classified.toolName, 'apply_patch');
  assert.deepEqual(classified.paths, ['/repo/src/renderer/components/Workspace/HistoryPanel.tsx']);
  assert.equal(classified.timestamp, '2026-09-10T09:02:17.172Z');
});

test('Codex exec с apply_patch — правка, а обычный exec — просто инструмент', () => {
  const patch = classifyTranscriptRecord(JSON.stringify(codexExecPatch));
  assert.equal(patch.kind, 'edit');
  assert.deepEqual(patch.paths, ['/repo/src/main/main.js']);

  const readOnly = classifyTranscriptRecord(JSON.stringify(codexReadOnlyExec));
  assert.equal(readOnly.kind, 'tool');
});

test('Claude Edit tool_use — правка, пользовательское сообщение — промпт', () => {
  const edit = classifyTranscriptRecord(JSON.stringify(claudeEdit));
  assert.equal(edit.kind, 'edit');
  assert.deepEqual(edit.paths, ['/repo/src/renderer/store/useUIStore.ts']);

  const prompt = classifyTranscriptRecord(JSON.stringify(claudePrompt));
  assert.equal(prompt.kind, 'prompt');
});

test('битая строка не роняет классификацию и всё равно узнаёт патч', () => {
  const broken = '{"timestamp": "2026-09-10T09:02:17.172Z", "payload": {"type": "custom_tool_call", "input": "*** Begin Patch';
  const classified = classifyTranscriptRecord(broken);
  assert.equal(classified.kind, 'edit');
  assert.equal(classified.timestamp, '2026-09-10T09:02:17.172Z');
});

test('kinds=edit отсекает сессию, которая символ только читала', async () => {
  const filePath = tmpFile([codexReadOnlyExec, claudePrompt]);
  const any = await scanTranscriptFile({ filePath, needle: 'flushHistoryComposerDrafts' });
  assert.equal(any.matchCount, 2);

  const onlyEdits = await scanTranscriptFile({
    filePath,
    needle: 'flushHistoryComposerDrafts',
    kinds: ['edit'],
  });
  assert.equal(onlyEdits.matchCount, 0);
  assert.deepEqual(onlyEdits.matches, []);
});

test('скан находит правку и отдаёт время, файл и фрагмент диффа', async () => {
  const filePath = tmpFile([claudePrompt, codexExecPatch, codexPatchApply]);
  const result = await scanTranscriptFile({
    filePath,
    needle: 'flushHistoryComposerDrafts',
    kinds: ['edit'],
    maxMatches: 5,
  });
  assert.equal(result.error, null);
  assert.equal(result.matchCount, 2);
  assert.equal(result.matches[0].kind, 'edit');
  assert.match(result.matches[0].snippet, /flushHistoryComposerDrafts/);
  assert.ok(result.matches.every((match) => match.timestamp));
  assert.ok(result.matches.some((match) => match.paths.some((value) => value.endsWith('HistoryPanel.tsx'))));
});

test('регистр по умолчанию строгий, а caseSensitive=false его снимает', async () => {
  const filePath = tmpFile([claudePrompt]);
  const strict = await scanTranscriptFile({ filePath, needle: 'FLUSHHISTORYCOMPOSERDRAFTS' });
  assert.equal(strict.matchCount, 0);

  const loose = await scanTranscriptFile({
    filePath,
    needle: 'FLUSHHISTORYCOMPOSERDRAFTS',
    caseSensitive: false,
  });
  assert.equal(loose.matchCount, 1);
});

test('запись, разорванная границей чанка, всё равно находится', async () => {
  const filler = { type: 'event_msg', payload: { type: 'token_count', filler: 'x'.repeat(4000) } };
  const lines = [];
  for (let index = 0; index < 40; index += 1) lines.push(filler);
  lines.push(codexPatchApply);
  const filePath = tmpFile(lines);
  // Чанк заведомо меньше одной записи: совпадение обязано пережить склейку.
  const result = await scanTranscriptFile({
    filePath,
    needle: 'flushHistoryComposerDrafts',
    kinds: ['edit'],
    chunkBytes: 64 * 1024,
  });
  assert.equal(result.matchCount, 1);
  assert.equal(result.matches[0].kind, 'edit');
});

test('отсутствующий файл возвращает ошибку, а не исключение', async () => {
  const result = await scanTranscriptFile({
    filePath: path.join(os.tmpdir(), 'transcript-grep-missing', 'nope.jsonl'),
    needle: 'anything',
  });
  assert.equal(result.matchCount, 0);
  assert.equal(result.error, 'ENOENT');
});

test('maxMatches ограничивает выдачу и помечает досрочную остановку', async () => {
  const filePath = tmpFile([codexPatchApply, codexExecPatch, codexPatchApply, codexPatchApply]);
  const result = await scanTranscriptFile({
    filePath,
    needle: 'flushHistoryComposerDrafts',
    maxMatches: 2,
  });
  assert.equal(result.matches.length, 2);
});

const openTab = {
  status: 'open',
  tabId: 'tab-4646',
  historyId: null,
  title: 'визуал History',
  projectId: 'proj',
  projectName: 'custom-terminal',
  projectPath: '/repo',
  cwd: '/repo',
  provider: 'codex',
  sessionId: 'a8c78612',
};
const sameSessionClosedRow = { ...openTab, status: 'closed', historyId: 77 };
const claudeTab = { ...openTab, provider: 'claude', sessionId: '5798db4f', tabId: 'tab-1', title: 'claude' };

test('один и тот же файл не сканируется дважды из открытой и закрытой записи', async () => {
  const scanned = [];
  const result = await collectTranscriptMatches({
    candidates: [openTab, sameSessionClosedRow],
    fileBySessionKey: new Map([['codex:a8c78612', { filePath: '/rollout.jsonl', location: 'active' }]]),
    query: 'x',
    scan: async ({ filePath }) => {
      scanned.push(filePath);
      return { matches: [{ kind: 'edit', timestamp: '2026-09-10T09:02:17.150Z', paths: [], snippet: 's' }], bytesScanned: 10, error: null };
    },
  });
  assert.deepEqual(scanned, ['/rollout.jsonl']);
  assert.equal(result.scannedSessions, 1);
  assert.equal(result.matches.length, 1);
});

test('сессия без файла на диске учитывается отдельно от ошибок чтения', async () => {
  const result = await collectTranscriptMatches({
    candidates: [openTab, claudeTab],
    fileBySessionKey: new Map([['claude:5798db4f', { filePath: '/claude.jsonl', location: 'active' }]]),
    query: 'x',
    scan: async () => ({ matches: [], bytesScanned: 5, error: null }),
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].sessionId, 'a8c78612');
  assert.equal(result.scannedSessions, 1);
});

test('ошибка чтения одной сессии не отменяет совпадения из остальных', async () => {
  const result = await collectTranscriptMatches({
    candidates: [openTab, claudeTab],
    fileBySessionKey: new Map([
      ['codex:a8c78612', { filePath: '/broken.jsonl', location: 'active' }],
      ['claude:5798db4f', { filePath: '/claude.jsonl', location: 'archived' }],
    ]),
    query: 'x',
    scan: async ({ filePath }) => (filePath === '/broken.jsonl'
      ? { matches: [], bytesScanned: 0, error: 'EACCES' }
      : { matches: [{ kind: 'edit', timestamp: '2026-09-10T00:00:00.000Z', paths: [], snippet: 's' }], bytesScanned: 7, error: null }),
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].error, 'EACCES');
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].archived, true);
});

test('выдача отсортирована новее-сверху через границы сессий', async () => {
  const older = { ...claudeTab, sessionId: 'older' };
  const result = await collectTranscriptMatches({
    candidates: [older, openTab],
    fileBySessionKey: new Map([
      ['claude:older', { filePath: '/older.jsonl', location: 'active' }],
      ['codex:a8c78612', { filePath: '/newer.jsonl', location: 'active' }],
    ]),
    query: 'x',
    scan: async ({ filePath }) => ({
      matches: [{
        kind: 'edit',
        timestamp: filePath === '/older.jsonl' ? '2026-08-07T18:54:08.873Z' : '2026-09-10T09:02:17.150Z',
        paths: [],
        snippet: 's',
      }],
      bytesScanned: 1,
      error: null,
    }),
  });
  assert.deepEqual(result.matches.map((match) => match.sessionId), ['a8c78612', 'older']);
});

test('поля запроса доходят до сканера без искажения', async () => {
  let seen = null;
  await collectTranscriptMatches({
    candidates: [openTab],
    fileBySessionKey: new Map([['codex:a8c78612', { filePath: '/r.jsonl', location: 'active' }]]),
    query: 'flushHistoryComposerDrafts',
    caseSensitive: false,
    kinds: ['edit'],
    matchesPerSession: 7,
    scan: async (args) => { seen = args; return { matches: [], bytesScanned: 0, error: null }; },
  });
  assert.equal(seen.needle, 'flushHistoryComposerDrafts');
  assert.equal(seen.caseSensitive, false);
  assert.deepEqual(seen.kinds, ['edit']);
  assert.equal(seen.maxMatches, 7);
});

// Вызов по «голому» имени в main.js ничем не проверяется до момента исполнения,
// а роут и определение инструмента живут в разных файлах: без структурной
// проверки MCP-инструмент существует, а endpoint молча отсутствует.
const repoRoot = path.join(__dirname, '..', '..');
const mcpSource = fs.readFileSync(path.join(repoRoot, 'mcp', 'terminal-server.mjs'), 'utf8');
const mainSource = fs.readFileSync(path.join(repoRoot, 'src', 'main', 'main.js'), 'utf8');

test('Terminal MCP отдаёт grep по сырым транскриптам, а main.js его обслуживает', () => {
  assert.match(mcpSource, /name: 'search_transcripts'/);
  assert.match(mcpSource, /case 'search_transcripts':/);
  assert.match(mcpSource, /'\/overseer\/search-transcripts'/);
  assert.match(mainSource, /p === '\/overseer\/search-transcripts'/);
  assert.match(mainSource, /async function searchTranscriptCatalog/);
  assert.match(mainSource, /collectTranscriptMatches,\n  filterByTranscriptWindow,\n} = require\(path\.join\(srcMainDir, 'transcript-grep'\)\)/);
  assert.match(mainSource, /await filterByTranscriptWindow\(\{/);
  assert.match(mainSource, /await collectTranscriptMatches\(\{/);
  assert.match(mainSource, /resolveSessionFiles\(/);
});

test('окно дат считается по времени записи транскрипта, а не по дате вкладки', async () => {
  // Реальный случай: вкладка создана 17 августа, правку сделала 10 сентября.
  const oldTabNewEdit = { ...openTab, sessionId: 'a8c78612' };
  const staleTab = { ...claudeTab, sessionId: 'stale' };
  const todayStart = Date.parse('2026-09-10T00:00:00.000Z');
  const result = await filterByTranscriptWindow({
    candidates: [oldTabNewEdit, staleTab],
    fileBySessionKey: new Map([
      ['codex:a8c78612', { filePath: '/active.jsonl' }],
      ['claude:stale', { filePath: '/stale.jsonl' }],
    ]),
    fromMs: todayStart,
    stat: async (filePath) => (filePath === '/active.jsonl'
      ? Date.parse('2026-09-10T09:02:00.000Z')
      : Date.parse('2026-08-17T07:03:00.000Z')),
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.sessionId), ['a8c78612']);
  assert.equal(result.dropped, 1);
});

test('без окна дат список кандидатов не трогается и файлы не читаются', async () => {
  let statCalls = 0;
  const result = await filterByTranscriptWindow({
    candidates: [openTab, claudeTab],
    fileBySessionKey: new Map(),
    stat: async () => { statCalls += 1; return Date.now(); },
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.dropped, 0);
  assert.equal(statCalls, 0);
});

test('неизвестное время файла не выбрасывает сессию из окна', async () => {
  const result = await filterByTranscriptWindow({
    candidates: [openTab],
    fileBySessionKey: new Map([['codex:a8c78612', { filePath: '/unknown.jsonl' }]]),
    fromMs: Date.parse('2026-09-10T00:00:00.000Z'),
    stat: async () => null,
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.dropped, 0);
});

test('ограничение охвата видно в ответе, а не только в отсутствии совпадений', () => {
  assert.match(mainSource, /unresolvedSessions: unresolved\.length/);
  assert.match(mainSource, /outsideDateWindow: dateFiltered\.dropped/);
  assert.match(mainSource, /dateBasis: 'transcript-file-mtime'/);
  assert.match(mainSource, /unresolvedSample: unresolved\.slice\(0, 5\)/);
});

test('search_sessions честно отсылает к grep для вопросов про правки', () => {
  assert.match(mcpSource, /use search_transcripts instead/);
});
