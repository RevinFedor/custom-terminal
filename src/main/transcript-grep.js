'use strict';

// Литеральный grep по сырым файлам транскриптов Claude/Codex.
//
// Зачем отдельно от `searchSessionCatalog`: тот отвечает на «где я это
// обсуждал» и смотрит только на текст промпта и видимый ответ ассистента
// (`_collectAssistantBlocks` собирает блоки thinking/text). Правки файлов туда
// не попадают вообще — ни apply_patch, ни Edit/Write, ни их вывод. Поэтому
// вопрос «какая сессия трогала вот этот идентификатор» через него не решается.
//
// Здесь противоположный подход: никакой модели turn'ов, никакого разбора
// сессии целиком. Файл читается чанками, строки сравниваются побайтово через
// Buffer.indexOf, и JSON парсится ТОЛЬКО у совпавших строк. На корпусе ~23 ГБ
// (158 rollout'ов Codex, 85 из них крупнее 50 МБ) полный проход укладывается в
// секунды, тогда как построение turn-модели для одного rollout'а на 300 МБ уже
// стоит дороже, чем весь этот скан.

const fs = require('fs');

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
// Строка транскрипта — это одна запись. У Codex вывод команды/патч легко даёт
// мегабайты; парсить такое ради классификации незачем, маркеров достаточно.
const MAX_PARSE_CHARS = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;

const CLAUDE_EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch']);

function clampInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function collectPaths(value, out, depth = 0) {
  if (!value || depth > 4 || out.length >= 8) return out;
  if (typeof value === 'string') {
    if (value.startsWith('/') && value.length < 400 && !value.includes('\n')) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) collectPaths(value[key], out, depth + 1);
  }
  return out;
}

function claudeEditPaths(content) {
  const paths = [];
  if (!Array.isArray(content)) return paths;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'tool_use') continue;
    if (!CLAUDE_EDIT_TOOLS.has(String(block.name || '').toLowerCase())) continue;
    const filePath = block.input && typeof block.input === 'object' ? block.input.file_path : null;
    if (typeof filePath === 'string' && filePath) paths.push(filePath);
  }
  return paths;
}

// Классификация нужна ровно для одного вопроса: совпадение прилетело из правки
// файла или просто из чтения/обсуждения. Идентификатор из уже закоммиченного
// кода встречается в десятках сессий, которые его только читали.
function classifyTranscriptRecord(lineText) {
  const result = { kind: 'other', timestamp: null, paths: [], toolName: null };
  const text = String(lineText || '');
  if (!text) return result;

  let record = null;
  if (text.length <= MAX_PARSE_CHARS) {
    try {
      record = JSON.parse(text);
    } catch {
      record = null;
    }
  }

  if (!record || typeof record !== 'object') {
    // Гигантская или битая строка: маркеров хватает, чтобы не соврать про тип.
    const timestampMatch = text.slice(0, 600).match(/"timestamp"\s*:\s*"([^"]{4,40})"/);
    if (timestampMatch) result.timestamp = timestampMatch[1];
    if (text.includes('*** Begin Patch') || text.includes('patch_apply_')) result.kind = 'edit';
    else if (text.includes('"tool_use"') || text.includes('custom_tool_call')) result.kind = 'tool';
    return result;
  }

  if (typeof record.timestamp === 'string') result.timestamp = record.timestamp;

  const payload = record.payload && typeof record.payload === 'object' ? record.payload : null;
  if (payload) {
    // Codex rollout.
    const payloadType = String(payload.type || '');
    if (typeof payload.timestamp === 'string' && !result.timestamp) result.timestamp = payload.timestamp;
    if (payloadType === 'patch_apply_begin' || payloadType === 'patch_apply_end') {
      result.kind = 'edit';
      result.toolName = 'apply_patch';
      if (payload.changes && typeof payload.changes === 'object') {
        result.paths = Object.keys(payload.changes).slice(0, 8);
      }
      return result;
    }
    if (payloadType === 'custom_tool_call' || payloadType === 'function_call') {
      const input = typeof payload.input === 'string' ? payload.input : '';
      result.toolName = payload.name || null;
      if (input.includes('*** Begin Patch') || input.includes('apply_patch')) {
        result.kind = 'edit';
        const updated = input.match(/\*\*\* (?:Update|Add|Delete) File: ([^\\"\n]+)/g) || [];
        result.paths = updated
          .map((entry) => entry.replace(/\*\*\* (?:Update|Add|Delete) File: /, '').trim())
          .filter(Boolean)
          .slice(0, 8);
      } else {
        result.kind = 'tool';
      }
      return result;
    }
    if (payloadType === 'custom_tool_call_output' || payloadType === 'function_call_output') {
      result.kind = 'tool';
      return result;
    }
    if (payloadType === 'message') {
      result.kind = payload.role === 'user' ? 'prompt' : 'reply';
      return result;
    }
    if (payloadType === 'reasoning') {
      result.kind = 'reply';
      return result;
    }
    return result;
  }

  // Claude JSONL.
  const message = record.message && typeof record.message === 'object' ? record.message : null;
  const content = message ? message.content : null;
  if (record.type === 'assistant' && Array.isArray(content)) {
    const editPaths = claudeEditPaths(content);
    if (editPaths.length > 0) {
      result.kind = 'edit';
      result.paths = editPaths;
      result.toolName = 'edit';
      return result;
    }
    const usesTool = content.some((block) => block && block.type === 'tool_use');
    if (usesTool) {
      result.kind = 'tool';
      const named = content.find((block) => block && block.type === 'tool_use');
      result.toolName = named ? named.name || null : null;
      if (named && named.input) result.paths = collectPaths(named.input, []).slice(0, 4);
      return result;
    }
    result.kind = 'reply';
    return result;
  }
  if (record.type === 'user') {
    const hasToolResult = Array.isArray(content)
      && content.some((block) => block && block.type === 'tool_result');
    result.kind = hasToolResult ? 'tool' : 'prompt';
    return result;
  }
  return result;
}

function buildSnippet(lineText, matchIndex, snippetChars) {
  const half = Math.max(20, Math.floor(snippetChars / 2));
  const start = Math.max(0, matchIndex - half);
  const end = Math.min(lineText.length, matchIndex + half);
  const raw = lineText.slice(start, end);
  return (start > 0 ? '…' : '') + raw.replace(/\s+/g, ' ').trim() + (end < lineText.length ? '…' : '');
}

// Скан одного файла. Строки режутся по '\n' вручную: subarray не копирует, а в
// строку конвертируется только совпавшая запись.
//
// Чтение асинхронное намеренно. Полный проход по корпусу — это десятки
// гигабайт и секунды работы; синхронный readSync в main-процессе на это время
// заморозил бы весь UI (тот же запрет, что на execSync и на синхронное чтение
// больших JSONL). await между чанками возвращает управление event loop'у.
async function scanTranscriptFile({
  filePath,
  needle,
  caseSensitive = true,
  maxMatches = 3,
  snippetChars = 220,
  kinds = null,
  chunkBytes = DEFAULT_CHUNK_BYTES,
} = {}) {
  const wanted = String(needle || '');
  const empty = { matches: [], matchCount: 0, bytesScanned: 0, truncated: false, error: null };
  if (!filePath || !wanted) return empty;

  const limit = clampInt(maxMatches, 3, 1, 50);
  const kindFilter = Array.isArray(kinds) && kinds.length > 0 ? new Set(kinds) : null;
  const needleBuffer = Buffer.from(wanted, 'utf8');
  const lowerNeedle = wanted.toLowerCase();

  let handle = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch (error) {
    return { ...empty, error: String(error?.code || error?.message || error) };
  }

  const matches = [];
  let matchCount = 0;
  let bytesScanned = 0;
  let truncated = false;

  const inspectLine = (lineBuffer) => {
    if (lineBuffer.length === 0) return;
    let index = -1;
    let lineText = null;
    if (caseSensitive) {
      index = lineBuffer.indexOf(needleBuffer);
      if (index < 0) return;
      lineText = lineBuffer.toString('utf8');
      index = lineText.indexOf(wanted);
    } else {
      lineText = lineBuffer.toString('utf8');
      index = lineText.toLowerCase().indexOf(lowerNeedle);
    }
    if (index < 0) return;
    const classified = classifyTranscriptRecord(lineText);
    if (kindFilter && !kindFilter.has(classified.kind)) return;
    matchCount += 1;
    if (matches.length < limit) {
      matches.push({
        kind: classified.kind,
        timestamp: classified.timestamp,
        toolName: classified.toolName,
        paths: classified.paths,
        snippet: buildSnippet(lineText, index, snippetChars),
      });
    }
  };

  try {
    const stat = await handle.stat();
    const size = stat.size;
    const chunk = Buffer.allocUnsafe(clampInt(chunkBytes, DEFAULT_CHUNK_BYTES, 64 * 1024, 32 * 1024 * 1024));
    let position = 0;
    let carry = null;
    while (position < size) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      bytesScanned += bytesRead;
      let view = chunk.subarray(0, bytesRead);
      if (carry) {
        view = Buffer.concat([carry, view]);
        carry = null;
      }
      let offset = 0;
      let done = false;
      while (offset < view.length) {
        const newline = view.indexOf(0x0a, offset);
        if (newline < 0) {
          const tail = view.subarray(offset);
          // Одна запись длиннее лимита — дальше её не накапливаем, иначе
          // «поиск» превращается в чтение файла в память.
          carry = tail.length > MAX_LINE_BYTES ? Buffer.from(tail.subarray(0, MAX_LINE_BYTES)) : Buffer.from(tail);
          if (tail.length > MAX_LINE_BYTES) truncated = true;
          break;
        }
        inspectLine(view.subarray(offset, newline));
        offset = newline + 1;
        if (matches.length >= limit) {
          // Ранний выход: точное число совпадений в файле не требуется, важна
          // сама сессия и первые доказательства.
          truncated = truncated || position < size;
          carry = null;
          done = true;
          break;
        }
      }
      if (done) break;
    }
    if (carry) inspectLine(carry);
    return { matches, matchCount, bytesScanned, truncated, error: null };
  } catch (error) {
    return { matches, matchCount, bytesScanned, truncated, error: String(error?.code || error?.message || error) };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Окно дат для grep'а по транскриптам считается по времени записи файла, а не
// по датам каталога вкладок. Даты каталога — это когда вкладка создана или
// закрыта; долгая сессия, открытая 17 августа и правившая файл 10 сентября,
// под «сегодня» по created_at не попадает вообще. Для вопроса «кто менял это
// сегодня» такой фильтр даёт пустоту, неотличимую от «не найдено».
async function filterByTranscriptWindow({
  candidates = [],
  fileBySessionKey = new Map(),
  fromMs = null,
  toMs = null,
  stat = null,
} = {}) {
  const hasWindow = Number.isFinite(fromMs) || Number.isFinite(toMs);
  if (!hasWindow) return { candidates, dropped: 0 };
  const statFile = typeof stat === 'function'
    ? stat
    : (filePath) => fs.promises.stat(filePath).then((value) => value.mtimeMs).catch(() => null);
  const mtimeByPath = new Map();
  const kept = [];
  for (const candidate of candidates) {
    const entry = fileBySessionKey.get(candidate.provider + ':' + candidate.sessionId);
    const filePath = entry && entry.filePath ? entry.filePath : null;
    if (!filePath) {
      // Нечего сканировать — пусть решает общий проход, он посчитает это как
      // ограничение охвата, а не как несовпадение по дате.
      kept.push(candidate);
      continue;
    }
    if (!mtimeByPath.has(filePath)) mtimeByPath.set(filePath, await statFile(filePath));
    const mtime = mtimeByPath.get(filePath);
    // Время файла неизвестно — не выбрасываем: пустой ответ хуже лишнего скана.
    if (!Number.isFinite(mtime)) { kept.push(candidate); continue; }
    if (Number.isFinite(fromMs) && mtime < fromMs) continue;
    if (Number.isFinite(toMs) && mtime >= toMs) continue;
    kept.push(candidate);
  }
  return { candidates: kept, dropped: candidates.length - kept.length };
}

// Сборка результата по списку сессий-кандидатов. Живёт здесь, а не в main.js,
// потому что в main эту ветку нельзя выполнить в тесте: она появляется только
// внутри запущенного Electron, и первая же ошибка проявилась бы у пользователя
// после сборки. Зависимости передаются снаружи, поэтому тест подставляет свои.
async function collectTranscriptMatches({
  candidates = [],
  fileBySessionKey = new Map(),
  query,
  caseSensitive = true,
  kinds = null,
  matchesPerSession = 3,
  scan = scanTranscriptFile,
} = {}) {
  const matches = [];
  const errors = [];
  // Сессия без файла на диске — это не сбой поиска: транскрипт мог быть удалён,
  // а у Codex id вкладки в базе может указывать на предка, чей rollout не
  // сохранился. Держать это в errors означало бы отдавать десятки записей шума
  // на каждый запрос и прятать в них настоящие ошибки чтения.
  const unresolved = [];
  let scannedSessions = 0;
  let bytesScanned = 0;
  const seenFiles = new Set();

  for (const candidate of candidates) {
    const entry = fileBySessionKey.get(candidate.provider + ':' + candidate.sessionId);
    if (!entry || !entry.filePath) {
      unresolved.push({
        sessionId: candidate.sessionId,
        title: candidate.title,
        provider: candidate.provider,
      });
      continue;
    }
    // Открытая вкладка и её же закрытая запись в истории указывают на один
    // файл. Читать его дважды — это удвоенное время скана и дубли в выдаче.
    if (seenFiles.has(entry.filePath)) continue;
    seenFiles.add(entry.filePath);

    const result = await scan({
      filePath: entry.filePath,
      needle: query,
      caseSensitive,
      kinds,
      maxMatches: matchesPerSession,
    });
    scannedSessions += 1;
    bytesScanned += Number(result?.bytesScanned) || 0;
    if (result?.error) {
      errors.push({ sessionId: candidate.sessionId, title: candidate.title, error: result.error });
      continue;
    }
    for (const match of result?.matches || []) {
      matches.push({
        status: candidate.status,
        tabId: candidate.tabId,
        historyId: candidate.historyId,
        title: candidate.title,
        projectId: candidate.projectId,
        projectName: candidate.projectName,
        projectPath: candidate.projectPath,
        cwd: candidate.cwd,
        provider: candidate.provider,
        sessionId: candidate.sessionId,
        archived: entry.location === 'archived',
        kind: match.kind,
        timestamp: match.timestamp,
        toolName: match.toolName,
        paths: match.paths,
        snippet: match.snippet,
      });
    }
  }

  // Новее — выше. У Codex resume копирует транскрипт предка в новый rollout,
  // поэтому одна историческая правка честно встречается сразу в нескольких
  // сессиях; сортировка по времени ставит наверх ту, где правка произошла.
  matches.sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));

  return { matches, errors, unresolved, scannedSessions, bytesScanned };
}

module.exports = {
  CLAUDE_EDIT_TOOLS,
  classifyTranscriptRecord,
  collectTranscriptMatches,
  filterByTranscriptWindow,
  scanTranscriptFile,
};
