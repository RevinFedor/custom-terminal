const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { performance: nodePerformance } = require('node:perf_hooks');
const {
  dehydrateHistoryEntries,
  historyPayloadStash,
  capPayloadForRender,
} = require('../history-payload-dehydrate');
const {
  buildHistoryRevision,
  validateHistoryRevision,
} = require('../history-revision');
const {
  deriveConfirmedClaudeSettings,
  traceClaudeActiveBranch,
} = require('../claude-confirmed-settings');
const {
  decorateHistoryPromptPresentations,
} = require('../history-prompt-presentations');
const {
  decorateHistoryResponseTimings,
} = require('../history-response-timings');

let _projectManager = null;
let _getClaudeEditableLastPromptState = null;

let _localPerfOpSeq = 0;
function _beginPerfOp(kind, detail = {}) {
  const ops = global.__notedPerfOps;
  if (!ops || typeof ops.set !== 'function') return null;
  const id = kind + '-claude-data-' + (++_localPerfOpSeq);
  const startMs = nodePerformance.now();
  ops.set(id, {
    id,
    kind,
    detail,
    startMs,
    startAbs: nodePerformance.timeOrigin + startMs
  });
  return id;
}
function _endPerfOp(id) {
  if (!id) return;
  const ops = global.__notedPerfOps;
  if (ops && typeof ops.delete === 'function') ops.delete(id);
}

function shortKnowledgeDocsPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = filePath.replace(/\\/g, '/').trim();
  if (!normalized) return null;
  const segs = normalized.split('/').filter(Boolean);
  const baseName = segs[segs.length - 1] || '';
  const docsIndex = segs.findIndex((seg) => seg.toLowerCase() === 'docs');
  const lower = normalized.toLowerCase();
  const semanticIndexSibling = (() => {
    if (docsIndex < 0 || !path.isAbsolute(normalized)) return false;
    try {
      const parent = path.join('/', ...segs.slice(0, docsIndex));
      return fs.existsSync(path.join(parent, '.semantic-index.json'));
    } catch {
      return false;
    }
  })();
  const isDocsPath = docsIndex >= 0 && (
    !path.isAbsolute(normalized) ||
    semanticIndexSibling ||
    lower === 'docs' ||
    lower.startsWith('docs/') ||
    lower.includes('/docs/')
  );
  const isClaudeMd = baseName === 'CLAUDE.md';
  if (!isDocsPath && !isClaudeMd) return null;
  return segs.length >= 2 ? segs.slice(-2).join('/') : segs[0];
}

// ========== JSONL INCREMENTAL CACHE ==========
// JSONL is append-only — when file grows we only parse NEW bytes, not the whole file.
// For a 159MB session file: first read ~3.5s, all subsequent reads ~0ms (if no new entries)
// or microseconds (if only a few new lines added).
const _jsonlCache = new Map();
// Dedup keys for [JsonlChainDiag:ChainBreak] log line — Timeline polls every 2s,
// without this Set the same break writes 30+ identical lines per minute, drowning the log.
// Key: `${sessionId}:${missingParentUuid}` — first hit logs, subsequent hits silently skip.
const _jsonlChainDiagLogged = new Set();

// Classify an orphan entry into a human-readable flavor so users see WHAT
// triggered the break (mcp_instructions_delta reconnect / slash command /
// thinking-only abort / etc.), not just "orphanType=attachment".
// Used by both the diagnostic log line and the toast that fires in renderer.
function _classifyOrphanFlavor(entry) {
  if (!entry || typeof entry !== 'object') return { flavor: 'unknown', short: 'неизвестный тип' };
  const t = entry.type;

  if (t === 'attachment') {
    const sub = entry.attachment?.type || '';
    if (sub === 'mcp_instructions_delta') {
      const added = entry.attachment?.addedNames || [];
      const name = added.join(',');
      return { flavor: 'attachment:mcp_instructions_delta', short: 'MCP подключился (' + (name || 'unknown') + ')', subtype: sub, addedNames: added };
    }
    if (sub === 'skill_listing') {
      return { flavor: 'attachment:skill_listing', short: 'новый skill подключился', subtype: sub };
    }
    if (sub === 'image' || (entry.message?.content || []).some?.(b => b.type === 'image')) {
      return { flavor: 'attachment:image', short: 'drag&drop файла/скриншота', subtype: sub || 'image' };
    }
    return { flavor: 'attachment:' + (sub || 'unknown'), short: 'вложение типа ' + (sub || '?'), subtype: sub };
  }

  if (t === 'assistant') {
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content.map(b => b?.type).filter(Boolean) : [];
    const hasThinking = blocks.includes('thinking');
    const hasText = blocks.includes('text');
    const hasToolUse = blocks.includes('tool_use');
    if (hasThinking && !hasText && !hasToolUse) {
      return { flavor: 'assistant:thinking-only', short: 'Claude прервался во время размышления', blocks };
    }
    return { flavor: 'assistant:' + blocks.join('|'), short: 'оборванный ответ ассистента', blocks };
  }

  if (t === 'user') {
    const c = entry.message?.content;
    if (typeof c === 'string') {
      const slashMatch = c.match(/<command-name>([^<]+)<\/command-name>/);
      if (slashMatch) {
        return { flavor: 'user:slash:' + slashMatch[1], short: 'slash-команда ' + slashMatch[1] };
      }
      if (c.startsWith('<local-command-')) {
        return { flavor: 'user:command-result', short: 'результат локальной команды' };
      }
      return { flavor: 'user:text', short: 'твой текстовый промпт', contentSample: c.substring(0, 100) };
    }
    if (Array.isArray(c)) {
      const blocks = c.map(b => b?.type).filter(Boolean);
      if (blocks.includes('image')) return { flavor: 'user:image-paste', short: 'юзер вставил изображение', blocks };
      if (blocks.includes('tool_result')) return { flavor: 'user:tool_result', short: 'результат инструмента', blocks };
      return { flavor: 'user:' + blocks.join('|'), short: 'промпт с блоками: ' + blocks.join(','), blocks };
    }
    return { flavor: 'user:empty', short: 'пустой user-entry' };
  }

  if (t === 'system') {
    return { flavor: 'system:' + (entry.subtype || 'unknown'), short: 'system: ' + (entry.subtype || '?'), subtype: entry.subtype };
  }

  return { flavor: t || 'unknown', short: t || 'неизвестно' };
}

function extractQueuedCommandPromptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (prompt && typeof prompt.text === 'string') return prompt.text;
  return '';
}

function formatSlashCommandDisplay(name, args = '') {
  const cleanName = String(name || '').trim().replace(/^\/+/, '');
  if (!cleanName) return null;
  const cleanArgs = String(args || '').trim();
  if (!cleanArgs) return '/' + cleanName;
  return '/' + cleanName + ' ' + cleanArgs;
}

function slashCommandDisplayFromText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('<command-name>')) return null;
  const name = (trimmed.match(/<command-name>([^<]+)<\/command-name>/)?.[1] || '').trim();
  const args = (trimmed.match(/<command-args>([^<]*)/)?.[1] || '').trim();
  const content = formatSlashCommandDisplay(name, args);
  return content ? { content, name, args } : null;
}
// filePath → { size, mtimeMs, recordMap, lastRecord, bridgeSessionId, progressEntries, queueOperations }

// ========== SESSION CHAIN HELPERS ==========

// Find a JSONL session file by ID, searching cwd-based path first, then all project dirs
function findSessionFile(sessionId, cwd) {
  try {
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

    if (cwd) {
      const projectSlug = cwd.replace(/\//g, '-');
      const primaryPath = path.join(claudeProjectsDir, projectSlug, `${sessionId}.jsonl`);
      if (fs.existsSync(primaryPath)) {
        return { filePath: primaryPath, projectDir: path.join(claudeProjectsDir, projectSlug) };
      }
    }

    if (fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
      for (const dir of projectDirs) {
        const checkPath = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(checkPath)) {
          return { filePath: checkPath, projectDir: path.join(claudeProjectsDir, dir) };
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

function readSessionCwdFromFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf-8', 0, bytesRead);
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.cwd === 'string' && entry.cwd.trim()) {
          return entry.cwd;
        }
      } catch {}
    }
  } catch (e) {
    console.warn('[Claude SessionCwd] failed to read head of', filePath, e.message);
  }
  return null;
}

// Tail-only cleanup of the just-injected `/effort` slash-command pair.
//
// Why tail-only:
//   Сессия может быть >100 MB. Полный read+JSON.parse+stringify+write блокирует
//   main process на 2-3 секунды → юзер видит залипший shimmer и не может
//   переключить модель. Исторические `/effort` записи трогать смысла нет —
//   они уже глубоко в parentUuid chain, Claude `--resume` их пройдёт линейно
//   как обычные user-записи без каких-либо последствий. Чистим **только**
//   ту пару которую только что инжектнули (она гарантированно последняя или
//   предпоследняя в файле — Claude пишет wrapper + paired stdout
//   синхронно при submit slash-команды).
//
// Что пробовали и почему отброшено:
//   - Полный rewrite файла (всё что выше): корректно, но 3 сек CPU-блок на 115 MB
//     сессии — неприемлемо. Юзер: «вертикальная черта идёт очень долго».
//   - Streaming JSONL parser: тот же CPU-стоимостный JSON.parse на каждой строке,
//     просто без full-file alloc — экономит память, не время.
//   - Skip-cleanup для больших файлов: оставляет накопление в активной сессии.
//
// Algorithm:
//   1. fs.read последние TAIL_BYTES байт файла.
//   2. Split на строки, дропнуть partial-prefix (первая строка может быть
//      разорвана если TAIL_BYTES пришлось на середину записи).
//   3. Парсить каждую найденную строку, искать `<command-name>/effort` wrapper
//      и paired `<local-command-stdout>Set effort level` следом.
//   4. Если нашли — truncate файл до начала первой удаляемой строки + дозаписать
//      оставшиеся (которые после удаляемых, если такие есть).
//
// Relink: НЕ нужен. Удаляемые записи — самые свежие в файле, никаких потомков
// у них ещё нет (Claude не успел продолжить turn — мы стартанули cleanup сразу
// после fs.watch event'а о появлении wrapper'а в JSONL).
const TAIL_BYTES = 16 * 1024; // 16 KB достаточно для 2-3 последних записей claude
const STARTUP_SLASH_TRIM_TAIL_BYTES = 512 * 1024; // покрывает десятки хвостовых /model + /effort блоков без full-file parse

async function _deleteEffortEntries(sessionId, cwd, projectManager) {
  if (!sessionId) return { success: false, error: 'No sessionId' };
  try {
    const found = findSessionFile(sessionId, cwd);
    if (!found) return { success: false, error: 'Session file not found' };
    const filePath = found.filePath;

    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;
    if (fileSize === 0) return { success: true, deleted: 0, relinked: 0 };

    const readSize = Math.min(TAIL_BYTES, fileSize);
    const startOffset = fileSize - readSize;
    const buf = Buffer.alloc(readSize);
    const fd = await fs.promises.open(filePath, 'r');
    try {
      await fd.read(buf, 0, readSize, startOffset);
    } finally {
      await fd.close();
    }
    const tailText = buf.toString('utf8');

    // Если читали не с начала файла — первая «строка» может быть partial-prefix
    // от записи, которая началась раньше нашего offset'а. Дропаем её, ища первый
    // \n в буфере. Также храним offset начала каждой строки относительно файла
    // (нужен потом для truncate point).
    const lines = [];                                  // { text, startOffset }
    let cursor = 0;
    let absStart = startOffset;
    if (startOffset > 0) {
      const firstNL = tailText.indexOf('\n');
      if (firstNL === -1) return { success: true, deleted: 0, relinked: 0 };
      cursor = firstNL + 1;
      absStart = startOffset + cursor;
    }
    while (cursor < tailText.length) {
      const nl = tailText.indexOf('\n', cursor);
      const end = nl === -1 ? tailText.length : nl;
      const lineText = tailText.slice(cursor, end);
      if (lineText.trim()) {
        lines.push({ text: lineText, startOffset: absStart });
      }
      if (nl === -1) break;
      cursor = nl + 1;
      absStart = startOffset + cursor;
    }

    // Найти самую правую пару [wrapper, paired-stdout]. Wrapper — наша инжекция,
    // paired-stdout — ответ Claude, опционально (может ещё не быть на диске
    // в момент cleanup'а на быстром turn'е). Если есть только wrapper — чистим
    // его, paired-stdout прилетит и останется orphan'ом — это OK, юзер увидит
    // одну лишнюю запись вместо двух, на следующий запуск она тоже будет видна,
    // но новый cleanup её схватит из хвоста (TAIL_BYTES покрывает).
    let wrapperIdx = -1;
    let pairedIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = (() => { try { return JSON.parse(lines[i].text); } catch { return null; } })();
      if (!rec || rec.type !== 'user') continue;
      const c = rec.message?.content;
      if (typeof c !== 'string') continue;
      if (/^<command-name>\/effort<\/command-name>/.test(c.trim())) {
        wrapperIdx = i;
        // Look forward for paired stdout (next user-record with stdout signature).
        for (let j = i + 1; j < lines.length; j++) {
          const r2 = (() => { try { return JSON.parse(lines[j].text); } catch { return null; } })();
          if (!r2 || r2.type !== 'user') continue;
          const c2 = r2.message?.content;
          if (typeof c2 !== 'string') continue;
          if (/^<local-command-stdout>Set effort level to/.test(c2.trim())) {
            pairedIdx = j;
          }
          break;
        }
        break;
      }
    }

    if (wrapperIdx === -1) {
      return { success: true, deleted: 0, relinked: 0 };
    }

    // Truncate at wrapper start, then re-append any lines that came AFTER the
    // paired stdout (or after the wrapper if no paired stdout was on disk yet).
    const truncateAt = lines[wrapperIdx].startOffset;
    const tailStartIdx = (pairedIdx >= 0 ? pairedIdx : wrapperIdx) + 1;
    const keepLines = lines.slice(tailStartIdx);
    const keepText = keepLines.length > 0
      ? keepLines.map(l => l.text).join('\n') + '\n'
      : '';

    await fs.promises.truncate(filePath, truncateAt);
    if (keepText.length > 0) {
      await fs.promises.appendFile(filePath, keepText, 'utf8');
    }
    _jsonlCache.delete(filePath);

    const removed = (wrapperIdx >= 0 ? 1 : 0) + (pairedIdx >= 0 ? 1 : 0);
    const removedUuids = [];
    try {
      const w = JSON.parse(lines[wrapperIdx].text);
      if (w?.uuid) removedUuids.push(w.uuid);
    } catch {}
    if (pairedIdx >= 0) {
      try {
        const p = JSON.parse(lines[pairedIdx].text);
        if (p?.uuid) removedUuids.push(p.uuid);
      } catch {}
    }
    if (projectManager?.db && removedUuids.length > 0) {
      try {
        const stmt = projectManager.db.db.prepare('DELETE FROM timeline_notes WHERE entry_uuid = ?');
        for (const uuid of removedUuids) stmt.run(uuid);
      } catch (e) {
        console.warn('[DeleteEffortEntries] timeline_notes cleanup failed:', e.message);
      }
    }

    console.log('[DeleteEffortEntries] session=' + sessionId.slice(0, 8) + ' tail-mode removed=' + removed + ' (wrapper=' + (wrapperIdx >= 0) + ' paired=' + (pairedIdx >= 0) + ')');
    return { success: true, deleted: removed, relinked: 0 };
  } catch (error) {
    console.error('[DeleteEffortEntries] Error:', error);
    return { success: false, error: error.message };
  }
}

// ─── On-restart trailing startup slash-command trim (sync, called BEFORE claude --resume) ───
//
// Назначение: убрать накопившиеся `/model` и `/effort` slash-команды из ХВОСТА
// JSONL перед тем как заново открыть сессию. Каждый запуск Claude может
// авто-инжектить `/model <default>` и `/effort <default>`. Без чистки после N
// перезапусков подряд в хвосте копится N пар wrapper+stdout, видимых в Claude TUI
// scrollback и rewind-меню (в нашем Timeline они и так скрыты tag-фильтром).
//
// ПОЧЕМУ ЭТО НЕ ТОТ САМЫЙ phantom-баг (важно): удалённый EffortCleanup watcher
// чистил slash-command пока Claude ЖИВ — и через 40 сек юзер дописывал prompt с
// parentUuid на стёртую запись → phantom. Здесь чистка идёт ТОЛЬКО в момент
// claude-c перед `term.write(--resume)`, когда старый процесс УЖЕ МЁРТВ. Никто
// не допишет ребёнка к удаляемой записи. Phantom физически невозможен.
//
// ПОЧЕМУ ТОЛЬКО ХВОСТ И ТОЛЬКО ЕСЛИ slash-command = последнее: parentUuid всегда
// указывает НАЗАД. Если после `/model`/`/effort` есть реальное сообщение — у команды
// появился потомок, и резать нельзя (порвём цепочку). Поэтому строгий suffix-match:
// режем только когда максимальный хвост это [caveat? wrapper stdout trailing-meta*]
// и НИЧЕГО реального после. Если после команды хоть одна real-запись — no-op.
// Никакого re-append, никакого relink — чистый truncate. Verified dry-run на 455
// сессиях: срабатывает редко, remaining-refs-into-deleted всегда NONE.
function _trimTrailingStartupSlashEntriesFromFile(filePath, sessionId = 'unknown') {
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    if (fileSize === 0) return { success: true, trimmed: 0 };

    const readSize = Math.min(STARTUP_SLASH_TRIM_TAIL_BYTES, fileSize);
    const startOffset = fileSize - readSize;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    try { fs.readSync(fd, buf, 0, readSize, startOffset); }
    finally { fs.closeSync(fd); }

    // Split on byte 0x0A (\n) working in BYTE offsets, NOT string indices.
    // Critical: JSONL with Cyrillic/emoji content is multi-byte UTF-8, so
    // String.indexOf('\n') returns a CHARACTER index that diverges from the
    // byte offset — adding it to startOffset gives a wrong truncate point that
    // cuts mid-record (file corruption). We compute every offset from the Buffer.
    // See methodology/переносимый-дизайн.md::Ink TUI (bytes ≠ chars).
    const lines = []; // { rec|null, byteStart } — byteStart is absolute file offset of line start
    let lineStartInBuf = 0;
    if (startOffset > 0) {
      // We didn't read from byte 0 — first line may be a torn partial. Drop up to first \n.
      const firstNL = buf.indexOf(0x0A);
      if (firstNL === -1) return { success: true, trimmed: 0 };
      lineStartInBuf = firstNL + 1;
    }
    let p = lineStartInBuf;
    while (p < readSize) {
      let nl = buf.indexOf(0x0A, p);
      const end = nl === -1 ? readSize : nl;
      const lineBuf = buf.subarray(p, end);
      const lineText = lineBuf.toString('utf8');
      if (lineText.trim()) {
        let rec = null;
        try { rec = JSON.parse(lineText); } catch { rec = null; }
        lines.push({ rec, byteStart: startOffset + p });
      }
      if (nl === -1) break;
      p = nl + 1;
    }
    if (lines.length === 0) return { success: true, trimmed: 0 };

    const entryText = (rec) => {
      const c = rec?.message?.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.map((block) => {
          if (!block || typeof block !== 'object') return '';
          if (typeof block.text === 'string') return block.text;
          if (typeof block.content === 'string') return block.content;
          return '';
        }).join('\n');
      }
      return '';
    };
    const classify = (rec) => {
      if (!rec) return 'unparseable';
      if (!rec.uuid) return 'meta'; // last-prompt / permission-mode / ai-title / queue-operation
      const text = entryText(rec);
      if (rec.type === 'assistant' && text.trim() === 'No response requested.') {
        return 'startup-ack';
      }
      const c = rec.message && rec.message.content;
      if (typeof c === 'string') {
        const s = text.trim();
        if (s.startsWith('<command-name>/effort')) return { kind: 'wrapper', command: 'effort' };
        if (s.startsWith('<command-name>/model')) return { kind: 'wrapper', command: 'model' };
        if (s.startsWith('<local-command-stdout>Set effort level')) return { kind: 'stdout', command: 'effort' };
        if (s.startsWith('<local-command-stdout>Set model to')) return { kind: 'stdout', command: 'model' };
        if (s.startsWith('<local-command-caveat>')) return 'caveat';
      }
      return 'real';
    };
    const classKind = (line) => {
      const c = classify(line.rec);
      return typeof c === 'string' ? c : c.kind;
    };
    const classCommand = (line) => {
      const c = classify(line.rec);
      return typeof c === 'string' ? null : c.command;
    };

    // Strict suffix walk from the end. The tail may contain SEVERAL startup
    // `/model` or `/effort` blocks from repeated launches with no real prompt in
    // between. Claude inserts an assistant "No response requested." after local
    // slash commands; for this suffix-only cleanup it is part of startup noise,
    // not a real conversation barrier. We peel blocks one at a time and STOP at
    // the first real user/assistant record so no remaining parentUuid can point
    // into deleted tail records.
    //
    // An unparseable trailing line (torn write) bails immediately — never
    // truncate next to corrupted bytes.
    let i = lines.length - 1;
    if (classKind(lines[i]) === 'unparseable') return { success: true, trimmed: 0 };
    let cutIdx = -1; // lowest index we will truncate from; -1 = nothing matched yet
    const removedByCommand = { model: 0, effort: 0 };
    const skipIgnorable = (fromIdx, allowStartupAck) => {
      let j = fromIdx;
      while (j >= 0) {
        const kind = classKind(lines[j]);
        if (kind === 'meta' || (allowStartupAck && kind === 'startup-ack')) {
          j--;
          continue;
        }
        break;
      }
      return j;
    };
    while (i >= 0) {
      // Skip trailing/inter-block metadata and assistant "No response requested.".
      // A lone ack at file tail still stays intact: we only truncate after a
      // full stdout+wrapper startup slash block is found behind it.
      let j = skipIgnorable(i, true);
      // expect stdout(command=X) then wrapper(command=X)
      if (j < 0 || classKind(lines[j]) !== 'stdout') break;
      const stdoutIdx = j;
      const command = classCommand(lines[j]);
      j--;
      j = skipIgnorable(j, false);
      if (j < 0 || classKind(lines[j]) !== 'wrapper' || classCommand(lines[j]) !== command) break;
      let blockStart = j; // wrapper
      // optional single caveat right before the wrapper
      j = skipIgnorable(j - 1, false);
      if (j >= 0 && lines[j].rec && classKind(lines[j]) === 'caveat') {
        blockStart = j;
      }
      if (command === 'model' || command === 'effort') removedByCommand[command] += (stdoutIdx - blockStart + 1);
      cutIdx = blockStart;     // extend the cut down to this block's start
      i = blockStart - 1;      // continue: maybe another startup slash block precedes it
    }

    if (cutIdx === -1) return { success: true, trimmed: 0 };

    const truncateAt = lines[cutIdx].byteStart;
    fs.truncateSync(filePath, truncateAt);
    _jsonlCache.delete(filePath);

    const removed = lines.length - cutIdx;
    console.log('[TrimStartupSlash] session=' + String(sessionId).slice(0, 8) + ' trimmed trailing startup slash blocks (' + removed + ' lines, model=' + removedByCommand.model + ', effort=' + removedByCommand.effort + ') at offset ' + truncateAt);
    return { success: true, trimmed: removed, model: removedByCommand.model, effort: removedByCommand.effort };
  } catch (error) {
    console.error('[TrimStartupSlash] Error:', error.message);
    return { success: false, error: error.message };
  }
}

function _trimTrailingEffortEntries(sessionId, cwd) {
  if (!sessionId) return { success: false, error: 'No sessionId' };
  const found = findSessionFile(sessionId, cwd);
  if (!found) return { success: true, trimmed: 0 }; // fresh session, no file yet
  return _trimTrailingStartupSlashEntriesFromFile(found.filePath, sessionId);
}

// Parse JSONL lines into an existing recordMap (shared logic for full + incremental reads)
function _parseJsonlLines(lines, sessionId, recordMap, progressEntries, queueOperations, startFileIndex, bridgeSessionIdIn, startQueueIndex = 0) {
  let lastRecord = null;
  let bridgeSessionId = bridgeSessionIdIn;
  let fileIndex = startFileIndex;
  let queueIndex = startQueueIndex;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'progress' && entry.data?.type === 'agent_progress' && entry.parentToolUseID) {
        progressEntries.push(entry);
      }
      if (entry.type === 'queue-operation') {
        entry._fromFile = sessionId;
        entry._queueSortIndex = fileIndex - 0.5;
        entry._queueIndex = queueIndex++;
        entry._queueId = 'queue-' + sessionId + '-' + entry._queueIndex + '-' + (entry.operation || 'op');
        queueOperations.push(entry);
      }
      if (entry.uuid) {
        entry._fileIndex = fileIndex++;
        entry._fromFile = sessionId;
        recordMap.set(entry.uuid, entry);
        lastRecord = entry;
        if (bridgeSessionId === null && entry.sessionId && entry.sessionId !== sessionId) {
          bridgeSessionId = entry.sessionId;
          entry._isBridge = true;
        } else if (bridgeSessionId === null && entry.sessionId === sessionId) {
          bridgeSessionId = undefined;
        }
      }
    } catch {}
  }

  return { lastRecord, bridgeSessionId, fileIndex, queueIndex };
}

// Load all records from a JSONL file into a Map (uuid → record)
// Incremental: JSONL is append-only — when file grows we only parse NEW bytes.
// First read of a 159MB file takes ~3.5s (CPU-bound JSON parse).
// Subsequent reads with new entries only parse the delta — near-instant.
async function loadJsonlRecords(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return {
      recordMap: new Map(),
      lastRecord: null,
      bridgeSessionId: null,
      progressEntries: [],
      queueOperations: [],
      sourceSnapshot: null,
    };
  }

  const cached = _jsonlCache.get(filePath);
  const sessionId = path.basename(filePath, '.jsonl');
  const sourceSnapshot = {
    filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sessionId,
  };

  // ── Case 1: File unchanged → return cached result immediately ──────────────
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return {
      recordMap: cached.recordMap,
      lastRecord: cached.lastRecord,
      bridgeSessionId: cached.bridgeSessionId,
      progressEntries: cached.progressEntries,
      queueOperations: cached.queueOperations || [],
      sourceSnapshot,
    };
  }

  // ── Case 2: File grew (normal for active sessions) → read ONLY new bytes ──
  if (cached && stat.size > cached.size) {
    // CRITICAL: Snapshot cache state BEFORE any await — concurrent loadJsonlRecords
    // calls for the same file can mutate cached.size/leftover between await points,
    // causing the read offset to jump forward and SKIP records permanently.
    const prevSize = cached.size;
    const prevLeftover = cached.leftover || '';
    const prevBridgeSessionId = cached.bridgeSessionId;
    const prevFileIndex = cached.fileIndex;
    const prevQueueIndex = cached.queueIndex || (cached.queueOperations?.length || 0);

    const fd = await fs.promises.open(filePath, 'r');
    let newContent = '';
    try {
      const newByteCount = stat.size - prevSize;
      const buf = Buffer.allocUnsafe(newByteCount);
      await fd.read(buf, 0, newByteCount, prevSize);
      newContent = buf.toString('utf-8');
    } finally {
      await fd.close();
    }

    // The first "line" may be a partial line from the previous read — prepend leftover
    const content = prevLeftover + newContent;
    const lines = content.split('\n');
    // Last element may be incomplete (file written mid-line) — save as leftover
    const leftover = lines.pop();

    const queueOperations = cached.queueOperations || [];
    const { lastRecord, bridgeSessionId, fileIndex, queueIndex } = _parseJsonlLines(
      lines, sessionId, cached.recordMap, cached.progressEntries, queueOperations,
      prevFileIndex, prevBridgeSessionId, prevQueueIndex
    );

    const newLastRecord = lastRecord || cached.lastRecord;
    const newBridgeId = bridgeSessionId !== undefined ? bridgeSessionId : cached.bridgeSessionId;

    // Only advance cache if we're ahead — prevents concurrent call from reverting state
    if (stat.size >= cached.size) {
      _jsonlCache.set(filePath, {
        size: stat.size, mtimeMs: stat.mtimeMs, leftover: leftover || '',
        recordMap: cached.recordMap, lastRecord: newLastRecord,
        bridgeSessionId: newBridgeId, progressEntries: cached.progressEntries,
        queueOperations, fileIndex, queueIndex
      });
    }

    return {
      recordMap: cached.recordMap,
      lastRecord: newLastRecord,
      bridgeSessionId: newBridgeId,
      progressEntries: cached.progressEntries,
      queueOperations,
      sourceSnapshot,
    };
  }

  // ── Case 3: First read or file shrunk (shouldn't happen for JSONL) → full read ──
  const content = await fs.promises.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const leftover = lines.pop(); // may be incomplete last line

  const recordMap = new Map();
  const progressEntries = [];
  const queueOperations = [];
  const { lastRecord, bridgeSessionId, fileIndex, queueIndex } = _parseJsonlLines(
    lines, sessionId, recordMap, progressEntries, queueOperations, 0, null, 0
  );

  _jsonlCache.set(filePath, {
    size: stat.size, mtimeMs: stat.mtimeMs, leftover: leftover || '',
    recordMap, lastRecord, bridgeSessionId: bridgeSessionId || null,
    progressEntries, queueOperations, fileIndex, queueIndex
  });

  return {
    recordMap,
    lastRecord,
    bridgeSessionId: bridgeSessionId || null,
    progressEntries,
    queueOperations,
    sourceSnapshot,
  };
}

function _injectQueueOperationsIntoBranch(activeBranch, queueOperations) {
  if (!Array.isArray(activeBranch) || activeBranch.length === 0 || !Array.isArray(queueOperations) || queueOperations.length === 0) {
    return activeBranch;
  }

  const boundsByFile = new Map();
  const fileOrder = new Map();
  let nextFileOrder = 0;
  for (const record of activeBranch) {
    const fileId = record?._fromFile;
    if (!fileId || typeof record._fileIndex !== 'number') continue;
    if (!fileOrder.has(fileId)) fileOrder.set(fileId, nextFileOrder++);
    const current = boundsByFile.get(fileId) || { min: Infinity, max: -Infinity };
    current.min = Math.min(current.min, record._fileIndex);
    current.max = Math.max(current.max, record._fileIndex);
    boundsByFile.set(fileId, current);
  }

  const relevantQueueOps = [];
  for (const op of queueOperations) {
    if (!op || op.type !== 'queue-operation') continue;
    const fileId = op._fromFile;
    const bounds = boundsByFile.get(fileId);
    if (!bounds) continue;
    const sortIndex = typeof op._queueSortIndex === 'number' ? op._queueSortIndex : op._fileIndex;
    if (typeof sortIndex !== 'number') continue;
    // Queue ops are UUID-less meta lines. Keep only ops physically after the
    // first active UUID and up through the live tail after the last active UUID.
    if (sortIndex <= bounds.min || sortIndex > bounds.max + 1) continue;
    relevantQueueOps.push(op);
  }

  if (relevantQueueOps.length === 0) return activeBranch;

  const orderOf = (record) => {
    const fileId = record?._fromFile;
    const fileRank = fileOrder.has(fileId) ? fileOrder.get(fileId) : Number.MAX_SAFE_INTEGER;
    const inFile = record?.type === 'queue-operation'
      ? (typeof record._queueSortIndex === 'number' ? record._queueSortIndex : Number.MAX_SAFE_INTEGER)
      : (typeof record?._fileIndex === 'number' ? record._fileIndex : Number.MAX_SAFE_INTEGER);
    const tie = record?.type === 'queue-operation' ? (record._queueIndex || 0) / 1000000 : 0;
    return fileRank * 1000000000 + inFile + tie;
  };

  return [...activeBranch, ...relevantQueueOps].sort((a, b) => orderOf(a) - orderOf(b));
}

// Resolve the full chain of JSONL files by following bridge entries backwards.
// Returns a merged recordMap with all records from all files in the chain,
// plus metadata about session boundaries.
// sessionBoundaries: array of { childSessionId, parentSessionId, bridgeUuid }
async function resolveSessionChain(sessionId, cwd, maxDepth = 10) {
  const mergedMap = new Map();
  const allProgressEntries = [];
  const allQueueOperations = [];
  const sessionBoundaries = [];
  const historySources = [];
  let currentSessionId = sessionId;
  let lastRecord = null;
  let depth = 0;

  while (currentSessionId && depth < maxDepth) {
    const found = findSessionFile(currentSessionId, cwd);
    if (!found) {
      console.log('[SessionChain] File not found for:', currentSessionId);
      break;
    }

    const {
      recordMap,
      lastRecord: fileLastRecord,
      bridgeSessionId,
      progressEntries,
      queueOperations,
      sourceSnapshot,
    } = await loadJsonlRecords(found.filePath);
    const historySource = {
      ...(sourceSnapshot || {
        filePath: found.filePath,
        size: 0,
        mtimeMs: 0,
        sessionId: currentSessionId,
      }),
      sessionId: currentSessionId,
      parentSessionId: null,
      linkKind: 'end',
    };
    historySources.push(historySource);
    if (progressEntries.length > 0) {
      allProgressEntries.push(...progressEntries);
    }
    if (queueOperations?.length > 0) {
      allQueueOperations.push(...queueOperations);
    }

    // On the first file (newest), capture the lastRecord for backtrace start
    if (depth === 0) {
      lastRecord = fileLastRecord;
    }

    // Merge records (don't overwrite newer records from child files)
    for (const [uuid, record] of recordMap) {
      if (!mergedMap.has(uuid)) {
        mergedMap.set(uuid, record);
      }
    }

    // SessionChain load logged silently (use [Claude Export] logs for debug)

    if (bridgeSessionId) {
      historySource.parentSessionId = bridgeSessionId;
      historySource.linkKind = 'jsonl';
      sessionBoundaries.push({
        childSessionId: currentSessionId,
        parentSessionId: bridgeSessionId,
      });
      currentSessionId = bridgeSessionId;
    } else {
      // No JSONL bridge — check SQLite for session link (Clear Context without bridge entry)
      try {
        const parentId = _projectManager?.db?.getSessionParent(currentSessionId);
        console.log('[SessionChain] SQLite check for', currentSessionId.substring(0, 8) + ':', parentId ? parentId.substring(0, 8) : 'null', '_projectManager=' + !!_projectManager, 'db=' + !!_projectManager?.db);
        if (parentId) {
          // Liveness guard: the row in session_links must point to a real JSONL on disk.
          // Subagent fork-flow used to leave dead entries (child UUID = subagent directory,
          // not a file) — see fix-dead-session-link-overwrite.md. Honouring those rows
          // makes the merged record map empty and breaks chain backtrace silently.
          if (!findSessionFile(parentId, cwd)) {
            console.warn('[SessionChain] SQLite link → parent', parentId.substring(0, 8), 'has no JSONL on disk — skipping (dead link)');
          } else {
            historySource.parentSessionId = parentId;
            historySource.linkKind = 'sqlite';
            console.log('[SessionChain] SQLite link:', currentSessionId.substring(0, 8) + '...', '→ parent:', parentId.substring(0, 8) + '...');
            sessionBoundaries.push({
              childSessionId: currentSessionId,
              parentSessionId: parentId,
            });
            currentSessionId = parentId;
            depth++;
            continue;
          }
        }
      } catch (e) {
        console.error('[SessionChain] SQLite check FAILED for', currentSessionId.substring(0, 8) + ':', e.message);
      }
      break;
    }

    depth++;
  }

  return {
    mergedMap,
    lastRecord,
    sessionBoundaries,
    progressEntries: allProgressEntries,
    queueOperations: allQueueOperations,
    historySources,
  };
}

// Find the latest (tip) session in a chain starting from a given session.
// Walks FORWARD: looks for any JSONL file whose first entry bridges FROM this session.
function resolveLatestSessionInChain(sessionId, cwd) {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  let currentId = sessionId;
  const visited = new Set();

  while (!visited.has(currentId)) {
    visited.add(currentId);

    // Look for a child file that bridges from currentId
    const found = findSessionFile(currentId, cwd);
    if (!found) break;

    // Scan project dir for files that reference currentId as bridge
    let childId = null;
    try {
      const files = fs.readdirSync(found.projectDir);
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
      for (const f of files) {
        if (!uuidPattern.test(f)) continue;
        const fId = f.replace('.jsonl', '');
        if (fId === currentId || visited.has(fId)) continue;

        // Read just the first line to check for bridge
        const fPath = path.join(found.projectDir, f);
        const fd = fs.openSync(fPath, 'r');
        const buf = Buffer.alloc(2048);
        const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
        fs.closeSync(fd);

        const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
        try {
          const entry = JSON.parse(firstLine);
          if (entry.sessionId === currentId && entry.uuid) {
            // Check: is this a fork copy or a real bridge?
            // Fork copies (our copyFileSync) have original sessionId but are NOT bridges.
            // Real bridges are created by Clear Context and are NOT fork targets.
            try {
              const forkInfo = _projectManager.db.getParentSession(fId);
              if (forkInfo) {
                // This is a fork target — skip, not a bridge
                continue;
              }
            } catch {}
            childId = fId;
            break;
          }
        } catch {}
      }
    } catch {}

    if (childId) {
      // SessionChain child found silently
      currentId = childId;
    } else {
      // No JSONL bridge child — check SQLite for session link (Clear Context without bridge entry)
      try {
        const sqliteChild = _projectManager.db.getSessionChild(currentId);
        if (sqliteChild && !visited.has(sqliteChild)) {
          // Liveness guard: child must exist as a real JSONL file. Subagent fork-flow
          // creates a directory named `<uuid>/subagents/` inside the project dir, which
          // looks like a session UUID but has no JSONL. Old session_links rows that
          // pointed at such directories caused Timeline to overwrite the store with a
          // dead UUID and render empty (see fix-dead-session-link-overwrite.md).
          if (!findSessionFile(sqliteChild, cwd)) {
            console.warn('[SessionChain] SQLite forward link →', sqliteChild.substring(0, 8), 'has no JSONL on disk — skipping (dead link)');
            break;
          }
          console.log('[SessionChain] SQLite forward link:', currentId.substring(0, 8) + '...', '→ child:', sqliteChild.substring(0, 8) + '...');
          currentId = sqliteChild;
          continue;
        }
      } catch (e) {}
      break; // No child found, currentId is the tip
    }
  }

  return currentId;
}

// ========== TIMELINE PARSER FUNCTION ==========
// Shared function to parse Timeline entries from JSONL file using Backtrace algorithm
// Returns array of entry UUIDs in display order (for fork marker snapshot)
function parseTimelineUuids(sourcePath) {
  try {
    const content = fs.readFileSync(sourcePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    const recordMap = new Map();
    let lastRecord = null;
    let fileIndex = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.uuid) {
          entry._fileIndex = fileIndex++;
          recordMap.set(entry.uuid, entry);
          lastRecord = entry;
        }
      } catch {}
    }

    if (!lastRecord) return [];

    // BACKTRACE: Walk backwards from last record following parentUuid
    const activeBranch = [];
    let currentUuid = lastRecord.uuid;
    const seen = new Set();

    while (currentUuid && !seen.has(currentUuid)) {
      seen.add(currentUuid);
      const record = recordMap.get(currentUuid);
      if (!record) {
        // Recovery: parentUuid points to a record not in this file.
        // Causes: (1) compact_boundary with dangling logicalParentUuid,
        //         (2) proxy crash mid-stream — assistant response never written to JSONL,
        //             api_error/next entries reference the lost in-flight record.
        let recovered = false;
        if (activeBranch.length > 0) {
          const lastAdded = activeBranch[0];

          // Case 1: compact_boundary recovery (existing)
          if (lastAdded.type === 'system' && lastAdded.subtype === 'compact_boundary' &&
              lastAdded.logicalParentUuid === currentUuid) {
            if (lastAdded.parentUuid && recordMap.has(lastAdded.parentUuid) && !seen.has(lastAdded.parentUuid)) {
              currentUuid = lastAdded.parentUuid;
              recovered = true;
            } else {
              let bestPred = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fileIndex < lastAdded._fileIndex) {
                  if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                    bestPred = entry;
                  }
                }
              }
              if (bestPred) {
                currentUuid = bestPred.uuid;
                recovered = true;
              }
            }
          }

          // Case 2: generic broken chain (proxy crash, missing record).
          // Find the record with the highest _fileIndex that's before lastAdded and not yet visited.
          if (!recovered) {
            let bestPred = null;
            for (const [uuid, entry] of recordMap) {
              if (seen.has(uuid)) continue;
              if (entry._fileIndex < lastAdded._fileIndex) {
                if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                  bestPred = entry;
                }
              }
            }
            if (bestPred) {
              console.log('[Timeline:Backtrace] CHAIN BREAK recovery: ' + currentUuid?.slice(0, 8) + ' missing, jumping to ' + bestPred.uuid?.slice(0, 8) + ' (fileIdx ' + bestPred._fileIndex + ', type=' + bestPred.type + ')');
              currentUuid = bestPred.uuid;
              recovered = true;
            }
          }
        }
        if (recovered) continue;
        break;
      }
      activeBranch.unshift(record);
      currentUuid = record.logicalParentUuid || record.parentUuid;
    }

    // Filter for Timeline display (same logic as get-timeline handler)
    const uuids = [];
    for (const entry of activeBranch) {
      if (entry.isSidechain || entry.type === 'summary') continue;

      if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
        const rawContent = extractQueuedCommandPromptText(entry.attachment.prompt).trim();
        if (!rawContent || entry.isMeta) continue;
        if (slashCommandDisplayFromText(rawContent)) continue;
        uuids.push(entry.uuid);
      } else if (entry.type === 'user') {
        let rawContent = entry.message?.content;
        if (Array.isArray(rawContent)) {
          if (rawContent.some(item => item.type === 'tool_result')) continue;
          const textBlock = rawContent.find(item => item.type === 'text' && item.text);
          rawContent = textBlock?.text || null;
        }
        if (!rawContent || typeof rawContent !== 'string') continue;
        if (entry.isMeta) continue;
        if (rawContent.includes('<command-name>') ||
            rawContent.includes('<system-reminder>') ||
            rawContent.includes('<task-notification>') ||
            rawContent.includes('<local-command-stdout>') ||
            rawContent.includes('<local-command-stderr>') ||
            rawContent.startsWith('[Request interrupted')) continue;

        uuids.push(entry.uuid);
      } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        uuids.push(entry.uuid);
      }
    }

    return uuids;
  } catch (e) {
    console.error('[parseTimelineUuids] Error:', e.message);
    return [];
  }
}

function parseClaudeStructuredPatchHunks(structuredPatch) {
  if (!Array.isArray(structuredPatch) || structuredPatch.length === 0) return null;
  const hunks = [];
  for (const rawHunk of structuredPatch) {
    const oldStart = Number(rawHunk?.oldStart);
    const newStart = Number(rawHunk?.newStart);
    const oldLines = Number(rawHunk?.oldLines);
    const newLines = Number(rawHunk?.newLines);
    if (
      !Number.isInteger(oldStart) || oldStart < 0
      || !Number.isInteger(newStart) || newStart < 0
      || !Number.isInteger(oldLines) || oldLines < 0
      || !Number.isInteger(newLines) || newLines < 0
      || !Array.isArray(rawHunk?.lines)
    ) {
      return null;
    }
    const entries = [];
    for (const rawLine of rawHunk.lines) {
      if (typeof rawLine !== 'string') return null;
      if (rawLine === '\\ No newline at end of file') continue;
      const prefix = rawLine[0];
      if (prefix === ' ') entries.push({ tag: 'eq', line: rawLine.slice(1) });
      else if (prefix === '+') entries.push({ tag: 'add', line: rawLine.slice(1) });
      else if (prefix === '-') entries.push({ tag: 'del', line: rawLine.slice(1) });
      else return null;
    }
    const actualOldLines = entries.reduce(
      (count, item) => count + (item.tag === 'add' ? 0 : 1),
      0,
    );
    const actualNewLines = entries.reduce(
      (count, item) => count + (item.tag === 'del' ? 0 : 1),
      0,
    );
    if (actualOldLines !== oldLines || actualNewLines !== newLines) return null;
    hunks.push({ oldStart, newStart, entries });
  }
  return hunks;
}

function normalizeClaudeHistoryToolPath(filePath, cwd) {
  const value = String(filePath || '').trim();
  if (!value) return '';
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value));
}

function extractClaudeToolDiffHunks({
  assistantEntry,
  toolBlock,
  resultEntry,
  resultBlock,
}) {
  if (
    !assistantEntry?.uuid
    || !toolBlock?.id
    || resultBlock?.tool_use_id !== toolBlock.id
    || resultEntry?.sourceToolAssistantUUID !== assistantEntry.uuid
  ) {
    return null;
  }
  const resultBlocks = Array.isArray(resultEntry?.message?.content)
    ? resultEntry.message.content.filter((item) => item?.type === 'tool_result')
    : [];
  // `toolUseResult` is top-level and has no per-block key. A batched user
  // record is therefore ambiguous even when one inner tool_result id matches.
  if (resultBlocks.length !== 1 || resultBlocks[0] !== resultBlock) return null;

  const metadata = resultEntry.toolUseResult;
  if (!metadata || typeof metadata !== 'object') return null;
  const input = toolBlock.input && typeof toolBlock.input === 'object'
    ? toolBlock.input
    : {};
  const expectedPath = normalizeClaudeHistoryToolPath(
    input.file_path || input.path,
    assistantEntry.cwd || resultEntry.cwd,
  );
  const actualPath = normalizeClaudeHistoryToolPath(
    metadata.filePath || metadata.file?.filePath,
    resultEntry.cwd || assistantEntry.cwd,
  );
  if (!expectedPath || expectedPath !== actualPath) return null;

  if (
    typeof metadata.oldString === 'string'
    && typeof input.old_string === 'string'
    && metadata.oldString !== input.old_string
  ) return null;
  if (
    typeof metadata.newString === 'string'
    && typeof input.new_string === 'string'
    && metadata.newString !== input.new_string
  ) return null;
  if (
    typeof metadata.content === 'string'
    && typeof input.content === 'string'
    && metadata.content !== input.content
  ) return null;
  if (
    typeof metadata.replaceAll === 'boolean'
    && typeof input.replace_all === 'boolean'
    && metadata.replaceAll !== input.replace_all
  ) return null;

  return parseClaudeStructuredPatchHunks(metadata.structuredPatch);
}

// Programmatic API for handlers below. Populated by register() so that other
// modules (HTTP routes in main.js, overseer MCP endpoints) can call the SAME
// implementation that IPC uses, without going through ipcMain.
// Each entry is the raw async function with payload argument (no `event`).
const _api = {
  forkSessionFile: null,   // ({sourceSessionId, cwd, skipChainResolve?}) → {success, newSessionId, forkEntryCount}
  editRange: null,         // ({sessionId, cwd, startUuid, endUuid, compactText}) → {success, removedCount, ...}
  deleteRange: null,       // ({sessionId, cwd, startUuid, endUuid}) → {success, removedCount, fileDeleted}
  getConfirmedSettings: null, // ({tabId, sessionId?, cwd?}) → active-branch model/effort proof
  parseClaudeStructuredPatchHunks,
  extractClaudeToolDiffHunks,
  rebuildHistoryPayloadStash,
};

// Stash-miss recovery for dehydrated Claude payloads. Payload identity is
// deterministic per source record (result:<tool_use_id>, thinking:<uuid>), so
// the originals can be re-extracted from the cached recordMap without
// re-running the whole projection. The session chain read is LRU-cached by
// loadJsonlRecords, so a cold call costs one chain walk.
async function rebuildHistoryPayloadStash({ sessionId, cwd, stash }) {
  if (!sessionId || !stash) return { rebuilt: 0 };
  const { recordMap } = await resolveSessionChain(sessionId, cwd);
  let rebuilt = 0;
  // Background notifications first: the projection appends them to the
  // acceptance result text, so the rebuilt payload must match byte-for-byte.
  const notifications = new Map();
  for (const [, rec] of recordMap) {
    if (rec?.type !== 'user') continue;
    const content = rec.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content.find((part) => part?.type === 'text')?.text || '')
        : '';
    if (!text.includes('<task-notification>')) continue;
    const useId = (text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/) || [])[1];
    if (!useId) continue;
    notifications.set(useId.trim(), {
      status: ((text.match(/<status>([^<]+)<\/status>/) || [])[1] || 'completed').trim(),
      summary: ((text.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '').trim(),
      result: ((text.match(/<result>([\s\S]*?)<\/result>/) || [])[1] || '').trim(),
    });
  }
  // Background identity mirrors the projection: the CALL's explicit
  // run_in_background arg, never result-text phrases.
  const backgroundCallIds = new Set();
  for (const [, rec] of recordMap) {
    if (rec?.type !== 'assistant' || !Array.isArray(rec.message?.content)) continue;
    for (const part of rec.message.content) {
      if (part?.type === 'tool_use' && part.id && part.input?.run_in_background === true) {
        backgroundCallIds.add(part.id);
      }
    }
  }
  for (const [, rec] of recordMap) {
    if (rec?.type === 'user' && Array.isArray(rec.message?.content)) {
      for (const part of rec.message.content) {
        if (part?.type === 'tool_result' && part.tool_use_id) {
          const rc = part.content;
          let text = typeof rc === 'string' ? rc
            : Array.isArray(rc) ? rc.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
          if (!text) continue;
          const notification = notifications.get(part.tool_use_id);
          if (notification && backgroundCallIds.has(part.tool_use_id)) {
            const notificationBody = [
              '— background ' + (notification.status || 'completed') + ' —',
              notification.summary,
              notification.result,
            ].filter(Boolean).join('\n');
            text = text.trimEnd() + '\n\n' + notificationBody;
          }
          stash.set('claude', sessionId, 'result:' + part.tool_use_id, text);
          rebuilt += 1;
        }
      }
      continue;
    }
    if (rec?.type === 'assistant' && Array.isArray(rec.message?.content)) {
      const thinkingParts = [];
      for (const part of rec.message.content) {
        if (part?.type === 'thinking' && part.thinking) thinkingParts.push(part.thinking);
      }
      if (thinkingParts.length > 0 && rec.uuid) {
        stash.set('claude', sessionId, 'thinking:' + rec.uuid, thinkingParts.join('\n\n---\n\n'));
        rebuilt += 1;
      }
    }
  }
  return { rebuilt };
}

function _normalizePromptStatusText(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _boundClaudeAssistantContext(blocks, maxChars = 8000) {
  const values = (Array.isArray(blocks) ? blocks : [])
    .map((value) => String(value || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
    .filter(Boolean);
  if (values.length === 0) return '';
  const limit = Math.max(500, Math.min(16000, Number(maxChars) || 8000));
  const joined = values.join('\n\n');
  if (joined.length <= limit) return joined;
  const first = values[0];
  const last = values[values.length - 1];
  if (values.length === 1) {
    const head = Math.floor(limit * 0.4);
    return first.slice(0, head).trimEnd() + '\n…\n' + first.slice(-(limit - head - 3)).trimStart();
  }
  const firstLimit = Math.min(Math.floor(limit * 0.35), first.length);
  const lastLimit = Math.max(0, limit - firstLimit - 3);
  return first.slice(0, firstLimit).trimEnd() + '\n…\n' + last.slice(-lastLimit).trimStart();
}

function _applyEditableLastPromptStatus(entries, promptState) {
  if (!Array.isArray(entries) || promptState?.status !== 'editable-last-prompt') return null;
  const targetUuid = String(promptState.targetUuid || '');
  if (!targetUuid) return null;
  const matchedEntry = entries.find(entry => entry && entry.role === 'user' && entry.uuid === targetUuid) || null;
  if (!matchedEntry) return null;
  if (_normalizePromptStatusText(promptState.targetText || '') &&
      _normalizePromptStatusText(promptState.targetText || '') !== _normalizePromptStatusText(matchedEntry.content || '')) {
    return null;
  }
  matchedEntry.deliveryStatus = 'editable-last-prompt';
  matchedEntry.statusReason = 'claude-native-rewind';
  matchedEntry.deliveryStatusSource = promptState.source || 'unknown';
  return matchedEntry;
}

function _claudeHistoryContext(promptState, discovery) {
  return JSON.stringify({
    discovery: discovery || null,
    editableLastPrompt: promptState?.status === 'editable-last-prompt'
      ? {
        status: promptState.status,
        targetUuid: String(promptState.targetUuid || ''),
        source: String(promptState.source || ''),
        targetTextHash: crypto
          .createHash('sha256')
          .update(_normalizePromptStatusText(promptState.targetText || ''))
          .digest('hex'),
      }
      : null,
  });
}

async function _validateClaudeHistoryTopology(sources, cwd) {
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const next = sources[index + 1] || null;

    if (next) {
      if (source.linkKind === 'end' ||
          source.parentSessionId !== next.sessionId) {
        return false;
      }
      const foundParent = findSessionFile(next.sessionId, cwd);
      if (!foundParent || path.resolve(foundParent.filePath) !== path.resolve(next.filePath)) {
        return false;
      }
    }

    if (source.linkKind === 'sqlite') {
      const currentParent = _projectManager?.db?.getSessionParent?.(source.sessionId) || null;
      if (currentParent !== source.parentSessionId) return false;
    } else if (source.linkKind === 'end') {
      const currentParent = _projectManager?.db?.getSessionParent?.(source.sessionId) || null;
      // A dead SQLite link is intentionally ignored by resolveSessionChain. It
      // becomes topology only once its target JSONL really exists.
      if (currentParent && findSessionFile(currentParent, cwd)) return false;
    }
  }
  return true;
}

function register({ projectManager, formatToolAction, getClaudeEditableLastPromptState }) {
  _projectManager = projectManager;
  _getClaudeEditableLastPromptState = typeof getClaudeEditableLastPromptState === 'function' ? getClaudeEditableLastPromptState : null;

  // Export a range of messages from Claude session
  ipcMain.handle('claude:copy-range', async (event, {
    sessionId, cwd, startUuid, endUuid,
    includeEditing = false, includeReading = false,
    includeSubagentResult = false, includeSubagentHistory = false,
    // Hierarchical copy settings (P-tab → see fact-clipboard-tools.md).
    // Defaults preserve old behavior when caller doesn't pass them.
    includeUser = true, includeClaude = true,
    includeText = true, includeThinking = true,
    includeBash = false, includeTools = false,
    includeWebSearch = false, includeToolSearch = false, includeOtherTools = includeTools,
    assistantOnly = false, maxChars = 8000,
  }) => {
    console.log('[Claude Export] Exporting range from', startUuid, 'to', endUuid);

    if (!sessionId) return { success: false, error: 'No session ID' };

    try {
      // Use the same chain resolution as claude:get-timeline
      // This ensures we can find UUIDs across plan mode boundaries
      const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = await resolveSessionChain(sessionId, cwd);

      // Build progress entries index by parentToolUseID
      const progressByToolUseId = new Map();
      for (const pe of allProgressEntries) {
        const key = pe.parentToolUseID;
        if (!progressByToolUseId.has(key)) progressByToolUseId.set(key, []);
        progressByToolUseId.get(key).push(pe);
      }

      if (!lastRecord) return { success: false, error: 'No records found' };

      // BACKTRACE: identical to claude:get-timeline
      const activeHistory = [];
      let current = lastRecord.uuid;
      const seen = new Set();

      while (current && !seen.has(current)) {
        seen.add(current);
        const record = recordMap.get(current);
        if (!record) {
          let recovered = false;
          if (activeHistory.length > 0) {
            const lastAdded = activeHistory[0];
            if (lastAdded.type === 'system' && lastAdded.subtype === 'compact_boundary' &&
                lastAdded.logicalParentUuid === current) {
              if (lastAdded.parentUuid && recordMap.has(lastAdded.parentUuid) && !seen.has(lastAdded.parentUuid)) {
                current = lastAdded.parentUuid;
                recovered = true;
              } else {
                let bestPred = null;
                for (const [uuid, entry] of recordMap) {
                  if (seen.has(uuid)) continue;
                  if (entry._fromFile === lastAdded._fromFile &&
                      entry._fileIndex < lastAdded._fileIndex) {
                    if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                      bestPred = entry;
                    }
                  }
                }
                if (bestPred) {
                  current = bestPred.uuid;
                  recovered = true;
                }
              }
            }
          }
          if (recovered) continue;
          break;
        }

        activeHistory.unshift(record);

        let nextUuid = record.logicalParentUuid || record.parentUuid;
        if (!nextUuid && sessionBoundaries.length > 0) {
          for (const [uuid, entry] of recordMap) {
            if (seen.has(uuid)) continue;
            if (entry._isBridge && entry.parentUuid && entry.sessionId !== record.sessionId &&
                !seen.has(entry.parentUuid)) {
              nextUuid = entry.parentUuid;
              break;
            }
          }
          if (!nextUuid && record.sessionId) {
            const boundary = sessionBoundaries.find(b => b.childSessionId === record.sessionId);
            if (boundary) {
              let parentLast = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fromFile === boundary.parentSessionId) {
                  if (!parentLast || entry._fileIndex > parentLast._fileIndex) parentLast = entry;
                }
              }
              if (parentLast) nextUuid = parentLast.uuid;
            }
          }
        }

        current = nextUuid;
      }

      // Find the range in the active history
      const startIndex = activeHistory.findIndex(e => e.uuid === startUuid);
      const endIndex = activeHistory.findIndex(e => e.uuid === endUuid);

      if (startIndex === -1 || endIndex === -1) {
        return { success: false, error: 'Selected range not found in active history' };
      }

      if (startUuid === endUuid) {
        const selected = activeHistory[startIndex];
        if (selected?.type === 'user' && selected.isCompactSummary) {
          let rawContent = selected.message?.content;
          if (Array.isArray(rawContent)) {
            rawContent = rawContent.find(item => item.type === 'text')?.text || '';
          }
          const compactSummary = typeof rawContent === 'string'
            ? rawContent
              .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
              .replace(/\[200~/g, '')
              .replace(/~\]/g, '')
              .trim()
            : '';
          let output = `# Claude Session Export (Range)\nSession: ${sessionId}\n\n---\n\n`;
          output += '\n═══ HISTORY COMPACTED ═══\n';
          if (compactSummary) output += '\n' + compactSummary + '\n';
          output += '\n';
          return { success: true, content: output };
        }
      }

      const minIdx = Math.min(startIndex, endIndex);
      let maxIdx = Math.max(startIndex, endIndex);

      // EXPAND RANGE: Include all assistant responses and system messages
      // that follow the last selected message, until the next real user prompt
      // (or compact_boundary) starts. tool_result entries are stored with
      // type: 'user' in Claude JSONL — a naïve break on type==='user' truncates
      // the turn at the first tool reply. Same forward-expand trap as
      // fix-timeline-docs-attribute-loop.md and fact-timeline.md::Forward-expand ловушка.
      for (let i = maxIdx + 1; i < activeHistory.length; i++) {
        const entry = activeHistory[i];
        // Compact boundary is always a real terminator.
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') break;
        if (entry.type === 'user' && !entry.isSidechain) {
          const nc = entry.message?.content;
          const isToolResult = Array.isArray(nc) && nc.some(b => b && b.type === 'tool_result');
          const ncStr = typeof nc === 'string' ? nc : '';
          const isTaskNotif = ncStr.startsWith('<task-notification>');
          // Synthetic command wrappers (slash-commands & their stdout, local-command-caveat
          // banner) are not real user prompts — they live inside a turn together with
          // assistant entries and must not terminate forward-expand. The same set is
          // filtered out at the render step below (`includes('<command-name>')` etc).
          const isSyntheticCmd = ncStr.startsWith('<command-name>')
            || ncStr.startsWith('<local-command-stdout>')
            || ncStr.startsWith('<local-command-caveat>')
            || ncStr.startsWith('<bash-notification>')
            || ncStr.startsWith('<system-reminder>')
            || ncStr.startsWith('Caveat: The messages below');
          // Image-meta wrapper: when user pastes a prompt with attachments, Claude Code
          // writes TWO user entries — the real prompt + base64 images, followed by a
          // synthetic entry whose text blocks are ALL `[Image: source: <path>]` references
          // to the local image-cache. Without this guard a single-click copy on the real
          // prompt terminates forward-expand on the image-meta wrapper, producing a copy
          // with just the user prompt and zero assistant output.
          const isImageMetaWrapper = Array.isArray(nc) && nc.length > 0 && nc.every(b =>
            b && b.type === 'text' && typeof b.text === 'string' && /^\s*\[Image: source: /.test(b.text)
          );
          if (!isToolResult && !isTaskNotif && !isSyntheticCmd && !isImageMetaWrapper) break;
        }
        maxIdx = i; // Include this assistant/system record (and the skipped tool/system noise)
      }

      const range = activeHistory.slice(minIdx, maxIdx + 1);

      if (assistantOnly) {
        const assistantBlocks = [];
        for (const entry of range) {
          if (entry?.type !== 'assistant' || entry.isSidechain || entry.type === 'summary') continue;
          const content = entry.message?.content;
          if (typeof content === 'string') {
            if (content.trim()) assistantBlocks.push(content);
            continue;
          }
          if (!Array.isArray(content)) continue;
          const text = content
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n\n')
            .trim();
          if (text) assistantBlocks.push(text);
        }
        const assistantText = _boundClaudeAssistantContext(assistantBlocks, maxChars);
        return assistantText
          ? { success: true, assistantText, assistantMessageCount: assistantBlocks.length }
          : { success: false, error: 'No completed assistant response found' };
      }

      // Group-based filtering flags forwarded to formatToolAction.
      // reading/editing keep their legacy meaning, bash/tools are new.
      const groupFlags = {
        reading: !!includeReading,
        editing: !!includeEditing,
        bash: !!includeBash,
        mcp: !!includeTools,
        web: !!includeWebSearch,
        toolSearch: !!includeToolSearch,
        tools: !!includeOtherTools,
      };
      // Used to decide whether ANY action label is worth attaching to a Claude turn.
      // Without this guard a turn that contains only a filtered-out tool_use would still
      // emit an empty "## Claude" block with the user prefix.
      const claudeHasActionAppetite = includeReading || includeEditing || includeBash || includeTools || includeWebSearch || includeToolSearch || includeOtherTools || includeSubagentResult || includeSubagentHistory;

      // Format the range
      let output = `# Claude Session Export (Range)\nSession: ${sessionId}\n\n---\n\n`;

      for (let i = 0; i < range.length; i++) {
        const entry = range[i];
        if (entry.isSidechain || entry.type === 'summary') continue;

        if (entry.type === 'user') {
          let rawContent = entry.message?.content;
          if (Array.isArray(rawContent)) {
            if (rawContent.some(item => item.type === 'tool_result')) continue;
            // Image-meta wrapper: skip entirely (sibling of the real prompt, see forward-expand).
            const isImageMetaWrapper = rawContent.length > 0 && rawContent.every(b =>
              b && b.type === 'text' && typeof b.text === 'string' && /^\s*\[Image: source: /.test(b.text)
            );
            if (isImageMetaWrapper) continue;
            const textBlock = rawContent.find(item => item.type === 'text');
            rawContent = textBlock?.text || '';
          }
          if (!rawContent || typeof rawContent !== 'string') continue;

          if (entry.isCompactSummary) {
            let pairedCompactBoundaryUuid = null;
            const idxInHistory = activeHistory.findIndex(e => e.uuid === entry.uuid);
            for (let j = idxInHistory - 1; j >= 0; j--) {
              const prev = activeHistory[j];
              if (!prev || prev.isSidechain || prev.type === 'summary') continue;
              if (prev.type === 'system' && prev.subtype === 'compact_boundary') {
                pairedCompactBoundaryUuid = prev.uuid;
              }
              break;
            }
            const pairedBoundaryAlreadyInRange = !!pairedCompactBoundaryUuid
              && range.some(e => e.uuid === pairedCompactBoundaryUuid);
            if (!pairedBoundaryAlreadyInRange) {
              output += '\n═══ HISTORY COMPACTED ═══\n';
              output += '\n' + rawContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\[200~/g, '').replace(/~\]/g, '').trim() + '\n\n';
            }
            continue;
          }

          if (rawContent.includes('[Request interrupted')) continue;
          if (rawContent.includes('<command-name>') ||
              rawContent.includes('<command-message>') ||
              rawContent.includes('<local-command-stdout>') ||
              rawContent.includes('<system-reminder>') ||
              rawContent.includes('<bash-notification>') ||
              rawContent.startsWith('Caveat: The messages below')) continue;

          if (!includeUser) continue;

          output += '## User\n' + rawContent.replace(/\[200~/g, '').replace(/~\]/g, '').trim() + '\n\n';
        }
        else if (entry.type === 'assistant') {
          if (!includeClaude) continue;
          const msgContent = entry.message?.content;
          if (!msgContent) continue;

          let textContent = '';
          const toolActions = [];

          if (typeof msgContent === 'string') {
            if (includeText) textContent = msgContent;
          } else if (Array.isArray(msgContent)) {
            const textParts = [];
            for (const block of msgContent) {
              if (block.type === 'thinking' && block.thinking && includeThinking) {
                textParts.push('<thinking>\n' + block.thinking + '\n</thinking>');
              }
              if (block.type === 'text' && block.text && includeText) {
                textParts.push(block.text);
              }
              if (block.type === 'tool_use') {
                // Label-always semantics: tool_use ALWAYS produces a one-line label
                // (`📄 Чтение (path)`, `🔌 MCP server/method`, etc.) even when its group toggle
                // is OFF. The toggle controls DEPTH (fenced content block), not VISIBILITY.
                // This preserves the chronology of Claude's actions in the copy — reader
                // sees what Claude did, just without the dumps when toggles are off.
                // Visibility is still controlled by `includeClaude` master toggle above.
                //
                // Group classification stays for one optimization: skip the toolResult
                // search when the group is off, since formatToolAction will return label-only
                // anyway. O(n) inner loop * O(toolUse) per turn matters on long ranges.
                const group = (() => {
                  if (block.name === 'Read' || block.name === 'NotebookRead') return 'reading';
                  if (block.name === 'Edit' || block.name === 'Write' || block.name === 'NotebookEdit') return 'editing';
                  if (block.name === 'Bash' || block.name === 'Monitor' || block.name === 'Grep' || block.name === 'Glob') return 'bash';
                  if (block.name === 'Task' || block.name === 'Agent') return 'subagent';
                  if (block.name === 'WebSearch' || block.name === 'WebFetch') return 'web';
                  if (typeof block.name === 'string' && block.name.startsWith('mcp__')) return 'mcp';
                  return 'tools';
                })();
                const groupOn = (group === 'reading' && groupFlags.reading)
                  || (group === 'editing' && groupFlags.editing)
                  || (group === 'bash' && groupFlags.bash)
                  || (group === 'mcp' && groupFlags.mcp)
                  || (group === 'web' && groupFlags.web)
                  || (group === 'toolSearch' && groupFlags.toolSearch)
                  || (group === 'tools' && groupFlags.tools)
                  || (group === 'subagent' && (includeSubagentResult || includeSubagentHistory));

                let toolResult = null;
                if (groupOn) {
                  // Range scan first (keeps copy semantics range-scoped), then
                  // the recordMap-wide fallback: parallel tool calls park
                  // sibling tool_results OFF the parentUuid branch, so a
                  // branch/range-only scan misses every result but the last.
                  for (let j = i + 1; j < range.length; j++) {
                    const nextEntry = range[j];
                    if (nextEntry.type === 'user' && Array.isArray(nextEntry.message?.content)) {
                      const res = nextEntry.message.content.find(c => c.type === 'tool_result' && c.tool_use_id === block.id);
                      if (res) {
                        toolResult = res;
                        break;
                      }
                    }
                  }
                  if (!toolResult) {
                    for (const [, rec] of recordMap) {
                      if (rec?.type !== 'user' || !Array.isArray(rec.message?.content)) continue;
                      const res = rec.message.content.find(c => c?.type === 'tool_result' && c.tool_use_id === block.id);
                      if (res) {
                        toolResult = res;
                        break;
                      }
                    }
                  }
                }
                const isSubagentTool = block.name === 'Task' || block.name === 'Agent';
                const taskProgress = isSubagentTool && block.id && groupOn ? (progressByToolUseId.get(block.id) || []) : [];
                const action = formatToolAction(block.name, block.input || {}, toolResult, includeEditing, includeReading, {
                  includeSubagentResult, includeSubagentHistory, progressEntries: taskProgress, flags: groupFlags,
                });
                if (action) toolActions.push(action);
              }
            }
            textContent = textParts.join('\n\n');
          }

          if (textContent.trim() || toolActions.length > 0) {
            output += '## Claude\n';
            if (textContent.trim()) output += textContent + '\n';
            if (toolActions.length > 0) {
              if (claudeHasActionAppetite) {
                output += '\n**Actions:**\n' + toolActions.join('\n\n') + '\n';
              } else {
                output += '   [Действия: ' + toolActions.join(', ') + ']\n';
              }
            }
            output += '\n';
          }
        }
        else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          // Look ahead in the full activeHistory (not just range) for the
          // isCompactSummary user entry — it holds the actual summary text.
          let compactSummary = '';
          const compactIdxInHistory = activeHistory.findIndex(e => e.uuid === entry.uuid);
          if (compactIdxInHistory >= 0) {
            for (let j = compactIdxInHistory + 1; j < activeHistory.length; j++) {
              const next = activeHistory[j];
              if (next.isCompactSummary && next.type === 'user') {
                const raw = typeof next.message?.content === 'string'
                  ? next.message.content
                  : Array.isArray(next.message?.content)
                    ? (next.message.content.find(c => c.type === 'text')?.text || '')
                    : '';
                compactSummary = raw
                  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
                  .replace(/\[200~/g, '').replace(/~\]/g, '').trim();
                break;
              }
              // Stop at first non-summary user — summary lives right after compact_boundary
              if (next.type === 'user' && !next.isSidechain) break;
            }
          }
          output += '\n═══ HISTORY COMPACTED ═══\n';
          if (compactSummary) output += '\n' + compactSummary + '\n';
          output += '\n';
        }
      }

      return { success: true, content: output };
    } catch (error) {
      console.error('[Claude Export] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // Estimate token breakdown for a range — "max upper bound" assuming ALL toggles ON.
  // Used by Timeline range-action popup to show ↑XXK + hover breakdown by category.
  // Renderer doesn't replicate the copy pipeline; backend walks the same backtrace +
  // forward-expand as copy-range, then categorizes chars by (entry.type × tool group).
  ipcMain.handle('claude:estimate-range-tokens', async (event, { sessionId, cwd, startUuid, endUuid }) => {
    if (!sessionId) return { success: false, error: 'No session ID' };
    try {
      const { mergedMap: recordMap, lastRecord, sessionBoundaries } = await resolveSessionChain(sessionId, cwd);
      if (!lastRecord) return { success: false, error: 'No records found' };

      // BACKTRACE — identical to copy-range above.
      const activeHistory = [];
      let current = lastRecord.uuid;
      const seen = new Set();
      while (current && !seen.has(current)) {
        seen.add(current);
        const record = recordMap.get(current);
        if (!record) {
          let recovered = false;
          if (activeHistory.length > 0) {
            const lastAdded = activeHistory[0];
            if (lastAdded.type === 'system' && lastAdded.subtype === 'compact_boundary' &&
                lastAdded.logicalParentUuid === current) {
              if (lastAdded.parentUuid && recordMap.has(lastAdded.parentUuid) && !seen.has(lastAdded.parentUuid)) {
                current = lastAdded.parentUuid;
                recovered = true;
              } else {
                let bestPred = null;
                for (const [uuid, entry] of recordMap) {
                  if (seen.has(uuid)) continue;
                  if (entry._fromFile === lastAdded._fromFile &&
                      entry._fileIndex < lastAdded._fileIndex) {
                    if (!bestPred || entry._fileIndex > bestPred._fileIndex) bestPred = entry;
                  }
                }
                if (bestPred) { current = bestPred.uuid; recovered = true; }
              }
            }
          }
          if (recovered) continue;
          break;
        }
        activeHistory.unshift(record);
        let nextUuid = record.logicalParentUuid || record.parentUuid;
        if (!nextUuid && sessionBoundaries.length > 0) {
          for (const [uuid, entry] of recordMap) {
            if (seen.has(uuid)) continue;
            if (entry._isBridge && entry.parentUuid && entry.sessionId !== record.sessionId &&
                !seen.has(entry.parentUuid)) { nextUuid = entry.parentUuid; break; }
          }
          if (!nextUuid && record.sessionId) {
            const boundary = sessionBoundaries.find(b => b.childSessionId === record.sessionId);
            if (boundary) {
              let parentLast = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fromFile === boundary.parentSessionId) {
                  if (!parentLast || entry._fileIndex > parentLast._fileIndex) parentLast = entry;
                }
              }
              if (parentLast) nextUuid = parentLast.uuid;
            }
          }
        }
        current = nextUuid;
      }

      const startIndex = activeHistory.findIndex(e => e.uuid === startUuid);
      const endIndex = activeHistory.findIndex(e => e.uuid === endUuid);
      if (startIndex === -1 || endIndex === -1) {
        return { success: false, error: 'Selected range not found in active history' };
      }
      const minIdx = Math.min(startIndex, endIndex);
      let maxIdx = Math.max(startIndex, endIndex);

      // Forward-expand — same guard as copy-range so the LAST turn's tool_result chain counts in.
      for (let i = maxIdx + 1; i < activeHistory.length; i++) {
        const entry = activeHistory[i];
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') break;
        if (entry.type === 'user' && !entry.isSidechain) {
          const nc = entry.message?.content;
          const isToolResult = Array.isArray(nc) && nc.some(b => b && b.type === 'tool_result');
          const ncStr = typeof nc === 'string' ? nc : '';
          const isTaskNotif = ncStr.startsWith('<task-notification>');
          const isSyntheticCmd = ncStr.startsWith('<command-name>')
            || ncStr.startsWith('<local-command-stdout>')
            || ncStr.startsWith('<local-command-caveat>')
            || ncStr.startsWith('<bash-notification>')
            || ncStr.startsWith('<system-reminder>')
            || ncStr.startsWith('Caveat: The messages below');
          if (!isToolResult && !isTaskNotif && !isSyntheticCmd) break;
        }
        maxIdx = i;
      }

      const range = activeHistory.slice(minIdx, maxIdx + 1);

      // Char accumulator per category. Final tokens = ceil(chars/3.5).
      const chars = {
        user: 0, claudeText: 0, claudeThinking: 0,
        read: 0, edit: 0, bash: 0, tools: 0,
        subagentResult: 0, subagentHistory: 0,
        compact: 0,
      };
      // Authoritative downstream token count from assistant.message.usage.output_tokens.
      // Same source as the `responseTokens` field on user-entries in claude:get-timeline,
      // but summed directly across all assistant entries in the range — covers turns
      // where look-ahead didn't attach a responseTokens to the user-entry yet (e.g. last
      // turn still streaming, or selection ends mid-turn).
      let downTokens = 0;
      // API metrics — что Anthropic реально билит за этот range. Cache touches
      // только input side (output не кэшируется — Claude каждый раз генерирует
      // его заново), поэтому output одно поле, input — три раздельных:
      //   • apiInputUncached    = usage.input_tokens (свежий промпт, full price)
      //   • apiInputCacheCreate = usage.cache_creation_input_tokens (1.25× cost)
      //   • apiInputCacheRead   = usage.cache_read_input_tokens (0.1× cost)
      // apiInputTokens = uncached + create + read — оставлен для backward compat
      // c уже-задеплоенным renderer'ом (показывал ОДНУ цифру Input). Renderer
      // теперь рендерит три строки разделённых, но если backend старее — fallback.
      let apiInputTokens = 0;
      let apiInputUncached = 0;
      let apiInputCacheCreate = 0;
      let apiInputCacheRead = 0;
      let apiOutputTokens = 0;

      // Same tool→group classifier as the inline ones in copy-range (and getToolGroup).
      const classifyTool = (name) => {
        if (name === 'Read' || name === 'NotebookRead') return 'read';
        if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return 'edit';
        if (name === 'Bash' || name === 'Monitor' || name === 'Grep' || name === 'Glob') return 'bash';
        if (name === 'Task' || name === 'Agent') return 'subagent';
        return 'tools';
      };

      // Match tool_result to its tool_use by id — same lookup as copy-range.
      const resultByUseId = new Map();
      for (const entry of range) {
        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
          for (const b of entry.message.content) {
            if (b && b.type === 'tool_result' && b.tool_use_id) {
              const rc = b.content;
              let resStr = '';
              if (typeof rc === 'string') resStr = rc;
              else if (Array.isArray(rc)) {
                for (const blk of rc) {
                  if (!blk) continue;
                  if (blk.type === 'text' && typeof blk.text === 'string') resStr += blk.text;
                  else if (blk.type === 'image' && blk.source) {
                    // Same placeholder length we emit in formatToolAction default branch.
                    const mime = blk.source.media_type || 'image/?';
                    const sizeBytes = (blk.source.data || '').length;
                    const sizeKB = sizeBytes > 0 ? Math.round(sizeBytes / 1024) : 0;
                    resStr += '[image: ' + mime + (sizeKB ? ', ~' + sizeKB + 'KB' : '') + ' base64 omitted]';
                  }
                }
              }
              resultByUseId.set(b.tool_use_id, resStr);
            }
          }
        }
      }

      for (const entry of range) {
        if (entry.isSidechain || entry.type === 'summary') continue;

        if (entry.type === 'user') {
          let rawContent = entry.message?.content;
          if (Array.isArray(rawContent)) {
            // tool_result entries are accounted via their tool_use match above —
            // don't double-count them as user content.
            if (rawContent.some(item => item && item.type === 'tool_result')) continue;
            const textBlock = rawContent.find(item => item && item.type === 'text');
            rawContent = textBlock?.text || '';
          }
          if (!rawContent || typeof rawContent !== 'string') continue;
          if (rawContent.includes('[Request interrupted')) continue;
          if (rawContent.includes('<command-name>') ||
              rawContent.includes('<command-message>') ||
              rawContent.includes('<local-command-stdout>') ||
              rawContent.includes('<system-reminder>') ||
              rawContent.includes('<bash-notification>') ||
              rawContent.startsWith('Caveat: The messages below')) continue;
          chars.user += rawContent.length;
        }
        else if (entry.type === 'assistant') {
          const usage = entry.message?.usage;
          const ot = usage?.output_tokens;
          if (typeof ot === 'number') { downTokens += ot; apiOutputTokens += ot; }
          if (usage) {
            if (typeof usage.input_tokens === 'number') {
              apiInputTokens += usage.input_tokens;
              apiInputUncached += usage.input_tokens;
            }
            if (typeof usage.cache_creation_input_tokens === 'number') {
              apiInputTokens += usage.cache_creation_input_tokens;
              apiInputCacheCreate += usage.cache_creation_input_tokens;
            }
            if (typeof usage.cache_read_input_tokens === 'number') {
              apiInputTokens += usage.cache_read_input_tokens;
              apiInputCacheRead += usage.cache_read_input_tokens;
            }
          }
          const msgContent = entry.message?.content;
          if (!msgContent) continue;
          if (typeof msgContent === 'string') {
            chars.claudeText += msgContent.length;
          } else if (Array.isArray(msgContent)) {
            for (const block of msgContent) {
              if (block.type === 'thinking' && block.thinking) chars.claudeThinking += block.thinking.length;
              else if (block.type === 'text' && block.text) chars.claudeText += block.text.length;
              else if (block.type === 'tool_use') {
                const group = classifyTool(block.name);
                const inputStr = (() => {
                  try {
                    const cleanInput = (block.input && typeof block.input === 'object') ? { ...block.input } : block.input;
                    if (cleanInput && typeof cleanInput === 'object' && 'caller' in cleanInput) delete cleanInput.caller;
                    return JSON.stringify(cleanInput || {});
                  } catch { return ''; }
                })();
                const resStr = (block.id && resultByUseId.get(block.id)) || '';
                const totalLen = inputStr.length + resStr.length;
                if (group === 'read') chars.read += totalLen;
                else if (group === 'edit') chars.edit += totalLen;
                else if (group === 'bash') chars.bash += totalLen;
                else if (group === 'subagent') chars.subagentResult += totalLen;
                else chars.tools += totalLen;
              }
            }
          }
        }
        else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          // Compact summary is appended in copy-range output. Approximate via metadata.preTokens
          // if present (it's already in tokens, not chars). We'll convert back to fake chars to keep
          // single tokens formula consistent — preTokens * 3.5.
          const pre = entry.compactMetadata?.preTokens;
          if (typeof pre === 'number') chars.compact += pre * 3.5;
        }
      }

      const toTokens = (c) => Math.ceil(c / 3.5);
      const categories = {
        user: toTokens(chars.user),
        claudeText: toTokens(chars.claudeText),
        claudeThinking: toTokens(chars.claudeThinking),
        read: toTokens(chars.read),
        edit: toTokens(chars.edit),
        bash: toTokens(chars.bash),
        tools: toTokens(chars.tools),
        subagentResult: toTokens(chars.subagentResult),
        subagentHistory: toTokens(chars.subagentHistory),
        compact: toTokens(chars.compact),
      };
      const total = Object.values(categories).reduce((a, b) => a + b, 0);
      return {
        success: true, categories, total,
        downTotal: downTokens,
        apiInputTokens, apiOutputTokens,
        apiInputUncached, apiInputCacheCreate, apiInputCacheRead,
      };
    } catch (error) {
      console.error('[Claude EstimateRangeTokens] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // Create a pre-filled Claude JSONL session (user question + assistant analysis)
  // Used by Update API: API response is embedded as assistant message, then Claude --resume shows it
  ipcMain.handle('claude:create-prefilled-session', async (event, { content, cwd }) => {
    try {
      const sessionId = crypto.randomUUID();
      const uuid1 = crypto.randomUUID();
      const uuid2 = crypto.randomUUID();
      const now = new Date().toISOString();

      const projectSlug = cwd.replace(/\//g, '-');
      const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
      if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

      // Entry 1: user message with FULL API response (visible in Claude TUI)
      const userEntry = {
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId,
        version: '1.0.0',
        type: 'user',
        message: { role: 'user', content: 'Результат анализа сессии внешним AI-агентом:\n\n' + content },
        uuid: uuid1,
        timestamp: now
      };

      // Entry 2: short assistant ack (completes the turn so Claude shows prompt on resume)
      const assistantEntry = {
        parentUuid: uuid1,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId,
        version: '1.0.0',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Принял. Готов применить изменения из анализа выше. Подтвердите командой.' }],
          model: 'external-api',
          stop_reason: 'end_turn',
          stop_sequence: null
        },
        uuid: uuid2,
        timestamp: new Date(Date.now() + 1000).toISOString()
      };

      const filePath = path.join(projectDir, sessionId + '.jsonl');
      fs.writeFileSync(filePath, JSON.stringify(userEntry) + '\n' + JSON.stringify(assistantEntry) + '\n', 'utf-8');

      console.log('[Claude Prefilled] Created: ' + filePath + ' (' + content.length + ' chars)');
      return { success: true, sessionId, filePath, totalChars: content.length };
    } catch (error) {
      console.error('[Claude Prefilled] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // Locate a Claude JSONL by UUID and return its origin cwd. `claude --resume <uuid>`
  // refuses to launch unless invoked from the same project slug — the CLI rebuilds the
  // slug from process.cwd(), checks `~/.claude/projects/<slug>/<uuid>.jsonl`, and if that
  // path is missing reports "No conversation found with session ID". Manual ✎ on a tab
  // whose shell sits in a different project triggers this every time.
  //
  // We can fix it at our layer: every JSONL stores the original cwd inside the very first
  // record (`entry.cwd`). Returning {filePath, projectDir, sessionCwd} lets the renderer
  // `cd <sessionCwd>` in the PTY before invoking claude-c, so the slug matches.
  ipcMain.handle('claude:resolve-session-cwd', async (event, { sessionId }) => {
    if (!sessionId) return { success: false, error: 'No session ID' };
    try {
      const found = findSessionFile(sessionId, null);
      if (!found) return { success: false, error: 'Session file not found on disk' };
      const sessionCwd = readSessionCwdFromFile(found.filePath);
      return { success: true, filePath: found.filePath, projectDir: found.projectDir, sessionCwd };
    } catch (error) {
      console.error('[Claude ResolveCwd] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // Fork Claude session file: copy .jsonl with new UUID
  // Searches ALL project directories under ~/.claude/projects/ to find the session file
  _api.forkSessionFile = async function ({ sourceSessionId, cwd, skipChainResolve }) {
    console.log('[Claude Fork] ========================================');
    console.log('[Claude Fork] Requested source session:', sourceSessionId, 'skipChainResolve:', !!skipChainResolve);
    console.log('[Claude Fork] Current cwd:', cwd);

    try {
      // Resolve the LATEST session in the chain (in case "Clear Context" created child sessions)
      // Skip for SDK forks — user explicitly chose which session to fork
      let resolvedSourceId = sourceSessionId;
      if (!skipChainResolve) {
        resolvedSourceId = resolveLatestSessionInChain(sourceSessionId, cwd);
        if (resolvedSourceId !== sourceSessionId) {
          console.log('[Claude Fork] Chain resolved: ', sourceSessionId, '→', resolvedSourceId);
        }
      }

      // Find the resolved source file
      const found = findSessionFile(resolvedSourceId, cwd);
      if (!found) {
        console.error('[Claude Fork] ✗ Source file not found for:', resolvedSourceId);
        return { success: false, error: 'Session file not found: ' + resolvedSourceId };
      }

      const sourcePath = found.filePath;
      const sessionCwd = readSessionCwdFromFile(sourcePath) || cwd;
      const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
      const projectDir = sessionCwd
        ? path.join(claudeProjectsDir, sessionCwd.replace(/\//g, '-'))
        : found.projectDir;
      console.log('[Claude Fork] Source file:', sourcePath);
      console.log('[Claude Fork] Session cwd:', sessionCwd || '(unknown)');
      console.log('[Claude Fork] Destination project dir:', projectDir);

      // Check source file is not empty
      const stats = fs.statSync(sourcePath);
      if (stats.size === 0) {
        console.error('[Claude Fork] Source file is empty:', sourcePath);
        return { success: false, error: 'Source session is empty' };
      }

      // Generate new UUID
      const newSessionId = crypto.randomUUID();
      console.log('[Claude Fork] New session ID:', newSessionId);

      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }
      const destPath = path.join(projectDir, `${newSessionId}.jsonl`);

      // Get Timeline UUIDs snapshot using Backtrace algorithm (same as Timeline UI)
      const entryUuids = parseTimelineUuids(sourcePath);
      console.log('[Claude Fork] Timeline entries:', entryUuids.length);

      // Copy the file and rewrite all sessionIds to newSessionId
      // This prevents a false "Clear Context" boundary in Timeline
      // (old entries had source sessionId, new ones get forked sessionId)
      fs.copyFileSync(sourcePath, destPath);
      const rawLines = fs.readFileSync(destPath, 'utf-8').split('\n');
      const rewritten = rawLines.map(line => {
        if (!line.trim()) return line;
        try {
          const rec = JSON.parse(line);
          if (rec.sessionId) rec.sessionId = newSessionId;
          return JSON.stringify(rec);
        } catch { return line; }
      });
      fs.writeFileSync(destPath, rewritten.join('\n'));
      console.log('[Claude Fork] Copied and rewrote sessionIds:', sourcePath, '->', destPath);

      // Save fork marker with UUIDs snapshot (always save, even if empty — marks fork at beginning)
      try {
        projectManager.db.saveForkMarker(resolvedSourceId, newSessionId, entryUuids);
        console.log('[Claude Fork] Fork marker saved with', entryUuids.length, 'UUIDs');
      } catch (e) {
        console.warn('[Claude Fork] Could not save fork marker:', e.message);
      }

      // Carry timeline notes (purple stickers) and rewind markers (pink dots) over to
      // the fork. They're keyed on (entry_uuid, session_id) — fork rewrote sessionIds
      // so without an explicit copy they wouldn't show up on the new tab's Timeline.
      try {
        const allUuids = [];
        for (const line of rewritten) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            if (r.uuid) allUuids.push(r.uuid);
          } catch {}
        }
        const copied = projectManager.db.copyTimelineMetadataForFork(newSessionId, allUuids, null);
        if (copied.notes > 0 || copied.rewindMarkers > 0) {
          console.log('[Claude Fork] Copied timeline metadata: notes=' + copied.notes + ' rewindMarkers=' + copied.rewindMarkers);
        }
      } catch (e) {
        console.warn('[Claude Fork] Could not copy timeline metadata:', e.message);
      }

      // Wait for Claude to index the new file
      await new Promise(resolve => setTimeout(resolve, 500));

      return { success: true, newSessionId, forkEntryCount: entryUuids.length, sessionCwd, projectDir };
    } catch (error) {
      console.error('[Claude Fork] Error:', error);
      return { success: false, error: error.message };
    }
  };
  ipcMain.handle('claude:fork-session-file', (event, payload) => _api.forkSessionFile(payload));

  // Edit range: remove entries from JSONL and insert compact summary
  // Flow: read file → backtrace → remove range → insert compact entry → relink → write atomically
  _api.editRange = async function ({ sessionId, cwd, startUuid, endUuid, compactText }) {
    console.log('[EditRange] ========================================');
    console.log('[EditRange] Session:', sessionId, 'Range:', startUuid?.slice(0, 8), '→', endUuid?.slice(0, 8));

    try {
      const found = findSessionFile(sessionId, cwd);
      if (!found) return { success: false, error: 'Session file not found' };

      const filePath = found.filePath;
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      // Parse all records
      const allRecords = [];
      const recordMap = new Map();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          allRecords.push(entry);
          if (entry.uuid) recordMap.set(entry.uuid, entry);
        } catch { allRecords.push(null); }
      }

      // Build backtrace chain (active branch)
      const lastRecord = allRecords.filter(r => r?.uuid).pop();
      if (!lastRecord) return { success: false, error: 'No records in file' };

      // Build fileIndex map for recovery (proxy crash can leave broken parentUuid)
      const fileIndexMap = new Map();
      allRecords.forEach((r, i) => { if (r?.uuid) fileIndexMap.set(r.uuid, i); });

      const activeBranch = [];
      let cur = lastRecord.uuid;
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const rec = recordMap.get(cur);
        if (!rec) {
          // Broken chain: find nearest predecessor by file position
          if (activeBranch.length > 0) {
            const lastAddedIdx = fileIndexMap.get(activeBranch[0].uuid) || 0;
            let bestIdx = -1, bestUuid = null;
            for (const [uuid, idx] of fileIndexMap) {
              if (!seen.has(uuid) && idx < lastAddedIdx && idx > bestIdx) {
                bestIdx = idx; bestUuid = uuid;
              }
            }
            if (bestUuid) {
              console.log('[EditRange:Backtrace] CHAIN BREAK recovery: ' + cur?.slice(0, 8) + ' missing, jumping to ' + bestUuid?.slice(0, 8));
              cur = bestUuid;
              continue;
            }
          }
          break;
        }
        activeBranch.unshift(rec);
        cur = rec.logicalParentUuid || rec.parentUuid;
      }

      // Find range in active branch by UUID
      const startIdx = activeBranch.findIndex(e => e.uuid === startUuid);
      const endIdx = activeBranch.findIndex(e => e.uuid === endUuid);
      if (startIdx === -1 || endIdx === -1) {
        return { success: false, error: 'Range UUIDs not found in active branch' };
      }
      const rangeStart = Math.min(startIdx, endIdx);
      const rangeEnd = Math.max(startIdx, endIdx);

      // Remove everything from startUuid to endUuid inclusive.
      // If endUuid is a user entry, also remove the SINGLE assistant response right after it
      // (but NOT system entries like turn_duration — they may belong to entries outside the range).
      const removeUuids = new Set();
      for (let i = rangeStart; i <= rangeEnd; i++) {
        removeUuids.add(activeBranch[i].uuid);
      }
      // Forward-expand: remove the ENTIRE response chain after the range until
      // the next REAL human-typed user message. Includes:
      //   - assistant entries (tool_use, thinking, text responses)
      //   - user entries with tool_result content (API tool responses)
      //   - user entries with <task-notification> (sub-agent automation)
      //   - system entries (turn_duration metadata between turns)
      //   - progress entries (streaming progress)
      // Stops ONLY at a real user text message (human-typed prompt).
      for (let i = rangeEnd + 1; i < activeBranch.length; i++) {
        const entry = activeBranch[i];
        if (entry.type === 'assistant' || entry.type === 'system' || entry.type === 'progress') {
          removeUuids.add(entry.uuid);
        } else if (entry.type === 'user') {
          const content = entry.message?.content;
          const isToolResult = Array.isArray(content) && content.some(b => b.type === 'tool_result');
          const contentStr = typeof content === 'string' ? content : '';
          const isTaskNotification = contentStr.startsWith('<task-notification>');
          if (isToolResult || isTaskNotification) {
            removeUuids.add(entry.uuid);
          } else {
            break; // Real user message — stop
          }
        } else {
          removeUuids.add(entry.uuid); // unknown type — include in removal
        }
      }

      // Also remove progress entries linked to removed entries
      for (const rec of allRecords) {
        if (!rec || !rec.parentToolUseID) continue;
        if (rec.type !== 'progress') continue;
        for (const uuid of removeUuids) {
          const entry = recordMap.get(uuid);
          if (entry?.type === 'assistant' && Array.isArray(entry.message?.content) &&
              entry.message.content.some(b => b.type === 'tool_use' && b.id === rec.parentToolUseID)) {
            removeUuids.add(rec.uuid);
            break;
          }
        }
      }

      // Find actual last removed index in activeBranch (after forward expand)
      let actualEnd = rangeEnd;
      for (let i = rangeEnd + 1; i < activeBranch.length; i++) {
        if (removeUuids.has(activeBranch[i].uuid)) actualEnd = i;
        else break;
      }

      // Create compact replacement entry
      const entryBefore = rangeStart > 0 ? activeBranch[rangeStart - 1] : null;
      const entryAfter = actualEnd < activeBranch.length - 1 ? activeBranch[actualEnd + 1] : null;

      console.log('[EditRange] Range:', rangeStart, '→', rangeEnd, '→ actualEnd:', actualEnd,
        'of', activeBranch.length, 'active. Removing', removeUuids.size, 'records');
      console.log('[EditRange] Active branch:', activeBranch.map((e, i) => `${i}:${e.type}(${e.uuid?.slice(0,6)})`).join(' '));
      console.log('[EditRange] entryBefore:', entryBefore?.uuid?.slice(0,8), entryBefore?.type, '| entryAfter:', entryAfter?.uuid?.slice(0,8), entryAfter?.type);
      console.log('[EditRange] File records:', allRecords.filter(r => r).length, '→ Keeping:', allRecords.filter(r => r && !removeUuids.has(r.uuid)).length);
      const compactUuid = crypto.randomUUID();

      // Compact entry sessionId logic:
      // - If compact is in the MIDDLE (entryAfter exists): use entryAfter's sessionId.
      //   Entries around the compact may have a different sessionId than the tab's chain root
      //   (after clear context / plan mode). Mismatched sessionId → Timeline shows false
      //   "Clear Context" boundary between compact and entryAfter.
      // - If compact is at the END (no entryAfter): use tab's sessionId (IPC parameter).
      //   Claude --resume picks the newest leaf by timestamp; sessionId must match what
      //   Claude expects. Using a stale file sessionId causes DAG fork.
      const fileSessionId = entryAfter?.sessionId || sessionId;
      // Timestamp: if compact is in the MIDDLE (entryAfter exists), must be older than entryAfter.
      // If compact is at the END (no entryAfter), use NOW — must be newest leaf for Claude DAG.
      // Bug: using entryBefore.timestamp creates identical timestamps → Claude can't pick newest leaf.
      const compactTs = entryAfter?.timestamp
        ? new Date(new Date(entryAfter.timestamp).getTime() - 1).toISOString()
        : new Date().toISOString();
      console.log('[EditRange] Compact: sid=' + fileSessionId?.slice(0, 8) + ' ts=' + compactTs?.slice(0, 19) + ' uuid=' + compactUuid?.slice(0, 8));
      const compactEntry = {
        parentUuid: entryBefore?.uuid || null,
        isSidechain: false,
        userType: 'external',
        cwd: cwd || '',
        sessionId: fileSessionId,
        version: '1.0.0',
        type: 'user',
        message: { role: 'user', content: compactText },
        uuid: compactUuid,
        timestamp: compactTs
      };

      // Clean up: if the VERY LAST entry in active chain is [Request interrupted],
      // remove it — it was created by our Ctrl+C when exiting Claude.
      // Only remove ONE (the last). If user had their own interrupted before — leave it.
      const lastEntry = activeBranch[activeBranch.length - 1];
      if (lastEntry && !removeUuids.has(lastEntry.uuid)) {
        const lastContent = lastEntry.message?.content;
        if (typeof lastContent === 'string' && lastContent.startsWith('[Request interrupted')) {
          removeUuids.add(lastEntry.uuid);
          console.log('[EditRange] Removing Ctrl+C interrupted:', lastEntry.uuid?.slice(0, 8));
        }
      }

      // If editing from start (rangeStart=0), remove ALL records that are not
      // in the active branch AFTER the deleted range. This cleans bridge entries,
      // dead branches, last-prompt markers from parent sessions, etc.
      if (rangeStart === 0) {
        const keepUuids = new Set();
        // Keep: entries after range in active branch
        for (let i = (entryAfter ? activeBranch.indexOf(entryAfter) : activeBranch.length); i < activeBranch.length; i++) {
          if (i >= 0) keepUuids.add(activeBranch[i].uuid);
        }
        // Mark everything else for removal
        for (const rec of allRecords) {
          if (!rec) continue;
          if (rec.uuid && !keepUuids.has(rec.uuid) && !removeUuids.has(rec.uuid)) {
            removeUuids.add(rec.uuid);
          }
        }
        console.log('[EditRange] rangeStart=0: keeping', keepUuids.size, 'post-range entries, total removing', removeUuids.size);
      }

      // CRITICAL: Relink entryAfter BEFORE orphan cleanup.
      // Without this, entryAfter's parentUuid still points to a deleted entry →
      // orphan cleanup cascades through ALL entries after the range, destroying the
      // entire conversation after the edit point. Bug found: user edited 4 entries
      // (115-118), lost 1481 records including 40+ real user conversations.
      if (entryAfter) {
        entryAfter.parentUuid = compactUuid;
        console.log('[EditRange] Relinked entryAfter ' + entryAfter.uuid?.slice(0, 8) + ' → compact ' + compactUuid?.slice(0, 8));
      }

      // Orphan cleanup: remove entries whose parentUuid points to a deleted record.
      // After edit-range removes part of active branch, tool_result entries from dead
      // rewind branches may survive with dangling parentUuid → they become newest leaves
      // in Claude's DAG → Claude resumes from an empty branch (0% context).
      let orphanPass = 0;
      let orphanCleaned = 0;
      const survivingUuids = new Set();
      survivingUuids.add(compactUuid); // compact entry is not in allRecords yet but will survive
      for (const rec of allRecords) {
        if (rec?.uuid && !removeUuids.has(rec.uuid)) survivingUuids.add(rec.uuid);
      }
      let foundOrphans = true;
      while (foundOrphans) {
        foundOrphans = false;
        orphanPass++;
        for (const rec of allRecords) {
          if (!rec?.uuid || removeUuids.has(rec.uuid)) continue;
          const parent = rec.parentUuid;
          if (parent && !survivingUuids.has(parent)) {
            removeUuids.add(rec.uuid);
            survivingUuids.delete(rec.uuid);
            orphanCleaned++;
            foundOrphans = true;
          }
        }
      }
      if (orphanCleaned > 0) {
        console.log('[EditRange] Orphan cleanup: removed ' + orphanCleaned + ' entries in ' + orphanPass + ' passes');
      }

      // Build output: filter removed + remove orphan last-prompt/non-uuid entries
      const outputLines = [];
      for (const rec of allRecords) {
        if (!rec) continue;
        if (rec.uuid && removeUuids.has(rec.uuid)) continue;
        // Remove last-prompt entries when editing from start (clean slate)
        if (rangeStart === 0 && rec.type === 'last-prompt') continue;

        // Relink safety net (already done before orphan cleanup, but verify)
        if (entryAfter && rec.uuid === entryAfter.uuid && rec.parentUuid !== compactUuid) {
          console.log('[EditRange] WARN: entryAfter relink missed, fixing in output loop');
          rec.parentUuid = compactUuid;
        }

        // Strip userType:'external' from surviving entries — Claude CLI skips external
        // entries when loading context, causing 4% instead of 25%. Only OUR compact
        // entry should have userType:'external', not the original conversation records.
        if (rec.userType === 'external') {
          delete rec.userType;
        }

        outputLines.push(JSON.stringify(rec));
      }

      // Insert compact + ack entries (before the entry-after-range for logical order)
      if (entryAfter) {
        const afterIdx = outputLines.findIndex(l => {
          try { return JSON.parse(l).uuid === entryAfter.uuid; } catch { return false; }
        });
        if (afterIdx !== -1) {
          outputLines.splice(afterIdx, 0, JSON.stringify(compactEntry));
        } else {
          outputLines.push(JSON.stringify(compactEntry));
        }
      } else {
        outputLines.push(JSON.stringify(compactEntry));
      }

      // Write atomically: tmp file → rename
      const tmpPath = filePath + '.edit-tmp';
      await fs.promises.writeFile(tmpPath, outputLines.join('\n') + '\n', 'utf-8');
      await fs.promises.rename(tmpPath, filePath);

      // Invalidate cache
      _jsonlCache.delete(filePath);

      // If range started from beginning (bridge removed), clean session_links
      // so resolveSessionChain doesn't re-attach parent session
      if (rangeStart === 0 && projectManager?.db) {
        try {
          projectManager.db.db.prepare('DELETE FROM session_links WHERE child_session_id = ?').run(fileSessionId);
          console.log('[EditRange] Cleaned session_links for', fileSessionId?.slice(0, 8));
        } catch (e) {
          console.warn('[EditRange] Could not clean session_links:', e.message);
        }
      }

      // Count removed by type. removedUsers = only REAL human-typed messages
      // (not tool_result, not <task-notification>)
      let removedUsers = 0, removedAssistants = 0, removedOther = 0;
      for (const uuid of removeUuids) {
        const rec = recordMap.get(uuid);
        if (!rec) continue;
        if (rec.type === 'user') {
          const content = rec.message?.content;
          const isToolResult = Array.isArray(content) && content.some(b => b.type === 'tool_result');
          const contentStr = typeof content === 'string' ? content : '';
          const isTaskNotification = contentStr.startsWith('<task-notification>');
          if (!isToolResult && !isTaskNotification) removedUsers++;
          else removedOther++;
        } else if (rec.type === 'assistant') removedAssistants++;
        else removedOther++;
      }

      console.log('[EditRange] Written', outputLines.length, 'records. Removed:', removeUuids.size,
        `(${removedUsers} user, ${removedAssistants} assistant, ${removedOther} other)`);

      // Save rewind marker to DB — pink dot on Timeline
      try {
        projectManager.db.saveRewindMarker(compactUuid, sessionId);
      } catch (e) {
        console.error('[EditRange] Failed to save rewind marker:', e.message);
      }

      return { success: true, removedCount: removeUuids.size, removedUsers, removedAssistants, compactUuid, fileSessionId };

    } catch (error) {
      console.error('[EditRange] Error:', error);
      return { success: false, error: error.message };
    }
  };
  ipcMain.handle('claude:edit-range', (event, payload) => _api.editRange(payload));

  // Delete range: remove entries from JSONL WITHOUT inserting a compact replacement.
  // Used by Timeline "Удалить историю" button. If the resulting file is empty (or only
  // non-uuid entries remain), the file is deleted entirely and session_links is cleaned
  // so resolveSessionChain doesn't re-attach a parent session.
  _api.deleteRange = async function ({ sessionId, cwd, startUuid, endUuid }) {
    console.log('[DeleteRange] ========================================');
    console.log('[DeleteRange] Session:', sessionId, 'Range:', startUuid?.slice(0, 8), '→', endUuid?.slice(0, 8));

    try {
      const found = findSessionFile(sessionId, cwd);
      if (!found) return { success: false, error: 'Session file not found' };

      const filePath = found.filePath;
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      const allRecords = [];
      const recordMap = new Map();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          allRecords.push(entry);
          if (entry.uuid) recordMap.set(entry.uuid, entry);
        } catch { allRecords.push(null); }
      }

      const lastRecord = allRecords.filter(r => r?.uuid).pop();
      if (!lastRecord) return { success: false, error: 'No records in file' };

      const fileIndexMap = new Map();
      allRecords.forEach((r, i) => { if (r?.uuid) fileIndexMap.set(r.uuid, i); });

      // Build active branch via backtrace
      const activeBranch = [];
      let cur = lastRecord.uuid;
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const rec = recordMap.get(cur);
        if (!rec) {
          if (activeBranch.length > 0) {
            const lastAddedIdx = fileIndexMap.get(activeBranch[0].uuid) || 0;
            let bestIdx = -1, bestUuid = null;
            for (const [uuid, idx] of fileIndexMap) {
              if (!seen.has(uuid) && idx < lastAddedIdx && idx > bestIdx) {
                bestIdx = idx; bestUuid = uuid;
              }
            }
            if (bestUuid) {
              console.log('[DeleteRange:Backtrace] CHAIN BREAK recovery: ' + cur?.slice(0, 8) + ' missing, jumping to ' + bestUuid?.slice(0, 8));
              cur = bestUuid;
              continue;
            }
          }
          break;
        }
        activeBranch.unshift(rec);
        cur = rec.logicalParentUuid || rec.parentUuid;
      }

      const startIdx = activeBranch.findIndex(e => e.uuid === startUuid);
      const endIdx = activeBranch.findIndex(e => e.uuid === endUuid);
      if (startIdx === -1 || endIdx === -1) {
        return { success: false, error: 'Range UUIDs not found in active branch' };
      }
      const rangeStart = Math.min(startIdx, endIdx);
      const rangeEnd = Math.max(startIdx, endIdx);

      const removeUuids = new Set();
      for (let i = rangeStart; i <= rangeEnd; i++) {
        removeUuids.add(activeBranch[i].uuid);
      }

      // Forward-expand: remove the entire response chain after the range until the next
      // real human-typed user message (same logic as edit-range — without it, orphan
      // tool_result entries become newest leaves and break Claude --resume).
      for (let i = rangeEnd + 1; i < activeBranch.length; i++) {
        const entry = activeBranch[i];
        if (entry.type === 'assistant' || entry.type === 'system' || entry.type === 'progress') {
          removeUuids.add(entry.uuid);
        } else if (entry.type === 'user') {
          const c = entry.message?.content;
          const isToolResult = Array.isArray(c) && c.some(b => b.type === 'tool_result');
          const cs = typeof c === 'string' ? c : '';
          const isTaskNotification = cs.startsWith('<task-notification>');
          if (isToolResult || isTaskNotification) {
            removeUuids.add(entry.uuid);
          } else {
            break;
          }
        } else {
          removeUuids.add(entry.uuid);
        }
      }

      // Drop progress entries linked to removed assistant tool_use blocks
      for (const rec of allRecords) {
        if (!rec || !rec.parentToolUseID) continue;
        if (rec.type !== 'progress') continue;
        for (const uuid of removeUuids) {
          const entry = recordMap.get(uuid);
          if (entry?.type === 'assistant' && Array.isArray(entry.message?.content) &&
              entry.message.content.some(b => b.type === 'tool_use' && b.id === rec.parentToolUseID)) {
            removeUuids.add(rec.uuid);
            break;
          }
        }
      }

      let actualEnd = rangeEnd;
      for (let i = rangeEnd + 1; i < activeBranch.length; i++) {
        if (removeUuids.has(activeBranch[i].uuid)) actualEnd = i;
        else break;
      }

      const entryBefore = rangeStart > 0 ? activeBranch[rangeStart - 1] : null;
      const entryAfter = actualEnd < activeBranch.length - 1 ? activeBranch[actualEnd + 1] : null;

      console.log('[DeleteRange] Range:', rangeStart, '→', rangeEnd, '→ actualEnd:', actualEnd,
        'of', activeBranch.length, 'active. Removing', removeUuids.size, 'records');

      // Clean up trailing [Request interrupted] left by our Ctrl+C
      const lastEntry = activeBranch[activeBranch.length - 1];
      if (lastEntry && !removeUuids.has(lastEntry.uuid)) {
        const lc = lastEntry.message?.content;
        if (typeof lc === 'string' && lc.startsWith('[Request interrupted')) {
          removeUuids.add(lastEntry.uuid);
        }
      }

      // Clean slate when deleting from start: drop everything that's not in the active
      // branch after the range (bridge entries, dead branches, last-prompt markers).
      if (rangeStart === 0) {
        const keepUuids = new Set();
        for (let i = (entryAfter ? activeBranch.indexOf(entryAfter) : activeBranch.length); i < activeBranch.length; i++) {
          if (i >= 0) keepUuids.add(activeBranch[i].uuid);
        }
        for (const rec of allRecords) {
          if (!rec) continue;
          if (rec.uuid && !keepUuids.has(rec.uuid) && !removeUuids.has(rec.uuid)) {
            removeUuids.add(rec.uuid);
          }
        }
      }

      // Relink entryAfter directly to entryBefore (or null) — no compact entry inserted.
      // Must happen BEFORE orphan cleanup: otherwise entryAfter's parentUuid still points
      // at a deleted record → cascade through everything that follows.
      if (entryAfter) {
        entryAfter.parentUuid = entryBefore ? entryBefore.uuid : null;
        console.log('[DeleteRange] Relinked entryAfter ' + entryAfter.uuid?.slice(0, 8) + ' → ' + (entryBefore?.uuid?.slice(0, 8) || 'null'));
      }

      // If the relink straddles a sessionId boundary (entryBefore.sid !== entryAfter.sid),
      // Timeline would render a false Plan Mode / Clear Context teal stripe right at the
      // delete point — even though no real Plan Mode exit happened (the original boundary
      // sat inside the deleted range, not between entryBefore and entryAfter). Fix: rewrite
      // sessionId on the older side (entryBefore and all its ancestors in the active
      // branch) to entryAfter's sessionId. We rewrite the OLDER side because Claude
      // --resume keys on the newest leaf's sessionId — touching entryAfter or its chain
      // could break --resume; ancestors are display-only at this point.
      if (entryBefore && entryAfter && entryBefore.sessionId && entryAfter.sessionId &&
          entryBefore.sessionId !== entryAfter.sessionId) {
        const targetSid = entryAfter.sessionId;
        const oldSid = entryBefore.sessionId;
        const ancestorUuids = new Set();
        // Walk back from entryBefore through parentUuid in activeBranch
        for (let i = activeBranch.indexOf(entryBefore); i >= 0; i--) {
          ancestorUuids.add(activeBranch[i].uuid);
        }
        let rewritten = 0;
        for (const rec of allRecords) {
          if (!rec?.uuid) continue;
          if (removeUuids.has(rec.uuid)) continue;
          if (!ancestorUuids.has(rec.uuid)) continue;
          if (rec.sessionId === targetSid) continue;
          rec.sessionId = targetSid;
          rewritten++;
        }
        console.log('[DeleteRange] Rewrote sessionId ' + oldSid.slice(0, 8) + '→' + targetSid.slice(0, 8) + ' on ' + rewritten + ' ancestor entries to suppress false Plan Mode boundary');
      }

      // Orphan cleanup
      let orphanPass = 0;
      let orphanCleaned = 0;
      const survivingUuids = new Set();
      for (const rec of allRecords) {
        if (rec?.uuid && !removeUuids.has(rec.uuid)) survivingUuids.add(rec.uuid);
      }
      let foundOrphans = true;
      while (foundOrphans) {
        foundOrphans = false;
        orphanPass++;
        for (const rec of allRecords) {
          if (!rec?.uuid || removeUuids.has(rec.uuid)) continue;
          const parent = rec.parentUuid;
          if (parent && !survivingUuids.has(parent)) {
            removeUuids.add(rec.uuid);
            survivingUuids.delete(rec.uuid);
            orphanCleaned++;
            foundOrphans = true;
          }
        }
      }
      if (orphanCleaned > 0) {
        console.log('[DeleteRange] Orphan cleanup: removed ' + orphanCleaned + ' entries in ' + orphanPass + ' passes');
      }

      const outputLines = [];
      for (const rec of allRecords) {
        if (!rec) continue;
        if (rec.uuid && removeUuids.has(rec.uuid)) continue;
        if (rangeStart === 0 && rec.type === 'last-prompt') continue;
        if (rec.userType === 'external') delete rec.userType;
        outputLines.push(JSON.stringify(rec));
      }

      const survivingUuidCount = outputLines.reduce((n, l) => {
        try { return n + (JSON.parse(l).uuid ? 1 : 0); } catch { return n; }
      }, 0);

      let fileDeleted = false;

      if (survivingUuidCount === 0) {
        // Whole active history wiped out — remove the file entirely. Claude --resume on
        // this sessionId will fail, so the renderer must clear claudeSessionId on the tab.
        try {
          await fs.promises.unlink(filePath);
          fileDeleted = true;
          console.log('[DeleteRange] File unlinked:', filePath);
        } catch (e) {
          console.error('[DeleteRange] Failed to unlink file:', e.message);
          return { success: false, error: 'Failed to unlink file: ' + e.message };
        }

        // Clean SQLite session_links so resolveSessionChain stops walking to a parent
        // (otherwise Timeline pulls the parent session back in on next refresh)
        if (projectManager?.db) {
          try {
            projectManager.db.db.prepare('DELETE FROM session_links WHERE child_session_id = ?').run(sessionId);
            projectManager.db.db.prepare('DELETE FROM session_links WHERE parent_session_id = ?').run(sessionId);
            console.log('[DeleteRange] Cleaned session_links for', sessionId?.slice(0, 8));
          } catch (e) {
            console.warn('[DeleteRange] session_links cleanup failed:', e.message);
          }
        }
      } else {
        // Atomic write
        const tmpPath = filePath + '.delete-tmp';
        await fs.promises.writeFile(tmpPath, outputLines.join('\n') + '\n', 'utf-8');
        await fs.promises.rename(tmpPath, filePath);

        // If we cut from the very beginning, drop session_links pointing to a parent
        // (the bridge to the previous session no longer exists in this file).
        if (rangeStart === 0 && projectManager?.db) {
          try {
            projectManager.db.db.prepare('DELETE FROM session_links WHERE child_session_id = ?').run(sessionId);
          } catch (e) {
            console.warn('[DeleteRange] session_links cleanup failed:', e.message);
          }
        }
      }

      _jsonlCache.delete(filePath);

      // Count removed by type for the toast message
      let removedUsers = 0, removedAssistants = 0, removedOther = 0;
      for (const uuid of removeUuids) {
        const rec = recordMap.get(uuid);
        if (!rec) continue;
        if (rec.type === 'user') {
          const c = rec.message?.content;
          const isToolResult = Array.isArray(c) && c.some(b => b.type === 'tool_result');
          const cs = typeof c === 'string' ? c : '';
          const isTaskNotification = cs.startsWith('<task-notification>');
          if (!isToolResult && !isTaskNotification) removedUsers++;
          else removedOther++;
        } else if (rec.type === 'assistant') removedAssistants++;
        else removedOther++;
      }

      console.log('[DeleteRange] Done. fileDeleted=' + fileDeleted + ' removed=' + removeUuids.size +
        ` (${removedUsers} user, ${removedAssistants} assistant, ${removedOther} other)`);

      return {
        success: true,
        removedCount: removeUuids.size,
        removedUsers,
        removedAssistants,
        fileDeleted,
      };

    } catch (error) {
      console.error('[DeleteRange] Error:', error);
      return { success: false, error: error.message };
    }
  };
  ipcMain.handle('claude:delete-range', (event, payload) => _api.deleteRange(payload));

  // Delete a single user-prompt entry from JSONL.
  // Keeps the assistant response, relinks any direct children's parentUuid to the
  // deleted entry's parent so the chain stays intact for Claude --resume.
  // Rejects: root entry (no parentUuid), tool_result, synthetic-command wrappers,
  // compact summary. Does NOT stop Claude — caller is expected to invoke this when
  // the target turn is complete (same trust as delete-range).
  ipcMain.handle('claude:delete-user-entry', async (event, { sessionId, cwd, uuid }) => {
    console.log('[DeleteUserEntry] ============================================');
    console.log('[DeleteUserEntry] Session:', sessionId, 'Entry:', uuid?.slice(0, 8));

    try {
      const found = findSessionFile(sessionId, cwd);
      if (!found) return { success: false, error: 'Session file not found' };

      const filePath = found.filePath;
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      const allRecords = [];
      const recordMap = new Map();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          allRecords.push(entry);
          if (entry.uuid) recordMap.set(entry.uuid, entry);
        } catch { allRecords.push(null); }
      }

      const target = recordMap.get(uuid);
      if (!target) return { success: false, error: 'Entry not found in file' };

      // Must be a real human-typed user prompt
      if (target.type !== 'user') return { success: false, error: 'Not a user entry' };
      const tc = target.message?.content;
      const isToolResult = Array.isArray(tc) && tc.some(b => b && b.type === 'tool_result');
      const tcStr = typeof tc === 'string' ? tc : '';
      const isWrapper = tcStr.startsWith('<command-name>')
        || tcStr.startsWith('<local-command-stdout>')
        || tcStr.startsWith('<local-command-caveat>')
        || tcStr.startsWith('<bash-notification>')
        || tcStr.startsWith('<system-reminder>')
        || tcStr.startsWith('<task-notification>')
        || tcStr.startsWith('Caveat: The messages below');
      if (isToolResult || isWrapper) {
        return { success: false, error: 'Entry is a tool result or system wrapper, not a user prompt' };
      }
      if (target.isCompactSummary) {
        return { success: false, error: 'Cannot delete compact summary' };
      }

      // Root entry cannot be deleted — its children would lose their anchor and
      // Claude --resume would refuse the file.
      if (!target.parentUuid) {
        return { success: false, error: 'Cannot delete the first message of a session' };
      }
      const newParent = target.parentUuid;

      // Relink any record that pointed at the target as its parent.
      // Both parentUuid and logicalParentUuid (used by compact_boundary entries).
      let relinked = 0;
      for (const rec of allRecords) {
        if (!rec) continue;
        if (rec.parentUuid === uuid) {
          rec.parentUuid = newParent;
          relinked++;
        }
        if (rec.logicalParentUuid === uuid) {
          rec.logicalParentUuid = newParent;
        }
      }

      // Write the file back without the target line.
      const outputLines = [];
      for (const rec of allRecords) {
        if (!rec) continue;
        if (rec.uuid === uuid) continue;
        outputLines.push(JSON.stringify(rec));
      }

      const tmpPath = filePath + '.delete-entry-tmp';
      await fs.promises.writeFile(tmpPath, outputLines.join('\n') + '\n', 'utf-8');
      await fs.promises.rename(tmpPath, filePath);

      _jsonlCache.delete(filePath);

      // Drop any timeline note attached to this UUID — there's nothing to anchor it to.
      if (projectManager?.db) {
        try {
          projectManager.db.db.prepare('DELETE FROM timeline_notes WHERE entry_uuid = ?').run(uuid);
        } catch (e) {
          console.warn('[DeleteUserEntry] timeline_notes cleanup failed:', e.message);
        }
      }

      console.log('[DeleteUserEntry] Done. Removed 1 user entry, relinked ' + relinked + ' child reference(s) → parent ' + newParent.slice(0, 8));
      return { success: true, relinkedChildren: relinked, newParent };

    } catch (error) {
      console.error('[DeleteUserEntry] Error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('claude:delete-effort-entries', async (event, { sessionId, cwd }) => {
    return _deleteEffortEntries(sessionId, cwd, projectManager);
  });

  // Get fork markers for a session (for Timeline blue lines)
  ipcMain.handle('claude:get-fork-markers', async (event, { sessionId }) => {
    if (!sessionId) return { success: false, error: 'No session ID', markers: [] };
    try {
      const markers = projectManager.db.getForkMarkers(sessionId);
      return { success: true, markers };
    } catch (error) {
      console.error('[Fork Markers] Error:', error);
      return { success: false, error: error.message, markers: [] };
    }
  });

  ipcMain.handle('claude:session-materialization', async (event, { sessionId, cwd }) => {
    return getSessionMaterialization(sessionId, cwd);
  });

  // Get Claude session timeline for navigation
  // Reads JSONL file and returns filtered entries for Timeline component
  // Uses BACKTRACE algorithm to handle Escape/Undo branches correctly
  ipcMain.handle('claude:get-timeline', async (event, {
    sessionId,
    cwd,
    source = 'unknown',
    reason = 'unknown',
    tabId = '',
    visible = null,
    instanceId = ''
  }) => {
    const timelineStartedAt = nodePerformance.now();
    const timelineStartAbs = nodePerformance.timeOrigin + timelineStartedAt;
    const shortSession = sessionId ? sessionId.substring(0, 8) : 'none';
    const shortTab = tabId ? tabId.slice(-8) : 'none';
    const opId = _beginPerfOp('timelineIPC', { sessionId, tabId, source, reason, visible });

    if (!sessionId) {
      console.warn(
        '[Perf:TimelineIPC] outcome=no-session' +
        ' source=' + source +
        ' reason=' + reason +
        ' inst=' + (instanceId || 'none') +
        ' tab=' + shortTab +
        ' session=none' +
        ' startAbs=' + timelineStartAbs.toFixed(1) +
        ' endAbs=' + (nodePerformance.timeOrigin + nodePerformance.now()).toFixed(1) +
        ' durMs=' + (nodePerformance.now() - timelineStartedAt).toFixed(1)
      );
      _endPerfOp(opId);
      return { success: false, error: 'No session ID provided' };
    }

    try {
      // Resolve the full session chain (follows bridge entries across "Clear Context" boundaries)
      const resolveStartedAt = nodePerformance.now();
      let { mergedMap: recordMap, lastRecord, sessionBoundaries } = await resolveSessionChain(sessionId, cwd);
      const resolveMs = nodePerformance.now() - resolveStartedAt;

      if (!lastRecord) {
        console.log('[Timeline:Backtrace] No lastRecord for session:', sessionId.substring(0, 8));
        console.warn(
          '[Perf:TimelineIPC] outcome=no-last-record' +
          ' source=' + source +
          ' reason=' + reason +
          ' inst=' + (instanceId || 'none') +
          ' tab=' + shortTab +
          ' session=' + shortSession +
          ' visible=' + visible +
          ' startAbs=' + timelineStartAbs.toFixed(1) +
          ' endAbs=' + (nodePerformance.timeOrigin + nodePerformance.now()).toFixed(1) +
          ' resolveMs=' + resolveMs.toFixed(1) +
          ' totalMs=' + (nodePerformance.now() - timelineStartedAt).toFixed(1)
        );
        _endPerfOp(opId);
        return { success: true, entries: [] };
      }

      console.log('[Timeline:Backtrace] session=' + sessionId.substring(0, 8) + ' recordMap.size=' + recordMap.size + ' lastRecord=' + lastRecord.uuid.substring(0, 8) + ' type=' + lastRecord.type + ' boundaries=' + sessionBoundaries.length);

      // BACKTRACE: Walk backwards from the last record following parentUuid
      // Now works across file boundaries thanks to merged recordMap
      const backtraceStartedAt = nodePerformance.now();
      let _cacheInvalidated = false; // Track if we already retried with fresh cache
      const activeBranch = [];
      let currentUuid = lastRecord.uuid;
      const seen = new Set();
      let _compactRecoveryCount = 0;
      let _compactPassthroughCount = 0; // compact_boundary → physical predecessor jumps (intentional /compact, NOT a bug)
      let _bridgeFollowCount = 0;
      const _chainBreaks = []; // Generic CHAIN BREAK recovery hits (proxy crash, lost in-flight assistant records)

      while (currentUuid && !seen.has(currentUuid)) {
        seen.add(currentUuid);
        const record = recordMap.get(currentUuid);
        if (!record) {
          // Recovery: dangling logicalParentUuid from compact_boundary
          // The compact removed the referenced entry but pre-compact entries still exist in the file
          let recovered = false;
          if (activeBranch.length > 0) {
            const lastAdded = activeBranch[0];
            if (lastAdded.type === 'system' && lastAdded.subtype === 'compact_boundary' &&
                lastAdded.logicalParentUuid === currentUuid) {
              // Option 1: try parentUuid of the compact_boundary
              if (lastAdded.parentUuid && recordMap.has(lastAdded.parentUuid) && !seen.has(lastAdded.parentUuid)) {
                currentUuid = lastAdded.parentUuid;
                recovered = true;
                _compactRecoveryCount++;
                console.log('[Timeline:Backtrace] Compact gap recovery L1: logicalParent=' + lastAdded.logicalParentUuid.substring(0, 8) + ' → parentUuid=' + lastAdded.parentUuid.substring(0, 8));
              } else {
                // Option 2: find physical predecessor in the same JSONL file
                let bestPred = null;
                for (const [uuid, entry] of recordMap) {
                  if (seen.has(uuid)) continue;
                  if (entry._fromFile === lastAdded._fromFile &&
                      entry._fileIndex < lastAdded._fileIndex) {
                    if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                      bestPred = entry;
                    }
                  }
                }
                if (bestPred) {
                  currentUuid = bestPred.uuid;
                  recovered = true;
                  _compactRecoveryCount++;
                  console.log('[Timeline:Backtrace] Compact gap recovery L2: physicalPred=' + bestPred.uuid.substring(0, 8) + ' fileIndex=' + bestPred._fileIndex);
                } else {
                  console.log('[Timeline:Backtrace] Compact gap recovery FAILED: logicalParent=' + currentUuid.substring(0, 8) + ' parentUuid=' + (lastAdded.parentUuid || 'null') + ' _fromFile=' + lastAdded._fromFile?.substring(0, 8));
                }
              }
            } else {
              // Recovery: cache race condition may have skipped records during concurrent
              // incremental reads. Invalidate ALL JSONL caches and retry with full re-read (once).
              if (!_cacheInvalidated) {
                _cacheInvalidated = true;
                console.log('[Timeline:Backtrace] BREAK at uuid=' + currentUuid.substring(0, 8) + ' — invalidating JSONL cache and retrying');
                _jsonlCache.clear();
                const fresh = await resolveSessionChain(sessionId, cwd);
                if (fresh.mergedMap.has(currentUuid)) {
                  recordMap = fresh.mergedMap;
                  lastRecord = fresh.lastRecord;
                  sessionBoundaries = fresh.sessionBoundaries;
                  activeBranch.length = 0;
                  seen.clear();
                  currentUuid = lastRecord.uuid;
                  _compactRecoveryCount = 0;
                  _bridgeFollowCount = 0;
                  console.log('[Timeline:Backtrace] Cache recovery SUCCESS — restarting from ' + lastRecord.uuid.substring(0, 8) + ' mergedMap.size=' + recordMap.size);
                  continue;
                }
                console.log('[Timeline:Backtrace] Cache recovery FAILED — uuid=' + currentUuid.substring(0, 8) + ' still missing after full re-read');
              }

              // Generic CHAIN BREAK recovery: proxy crash or lost in-flight assistant record.
              // Next user prompt references a parentUuid that was in Claude's memory but
              // never made it to disk. Jump to the physical predecessor in the same file.
              let bestPred = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fromFile === lastAdded._fromFile &&
                    typeof entry._fileIndex === 'number' &&
                    typeof lastAdded._fileIndex === 'number' &&
                    entry._fileIndex < lastAdded._fileIndex) {
                  if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                    bestPred = entry;
                  }
                }
              }
              if (bestPred) {
                const _classified = _classifyOrphanFlavor(lastAdded);

                // Post-compact attachment init — NOT a real chain break.
                // After /compact, Claude Code writes a series of attachment
                // entries (skill_listing, mcp_instructions_delta, etc.) whose
                // parentUuid points into Claude's in-RAM session-init state
                // that was never serialized to JSONL. Recovery jumps over
                // them safely; no user data was lost. Suppress these from
                // _chainBreaks so toast/red-paint don't lie.
                //
                // Heuristic: orphan is attachment AND bestPred is one of
                // {compact_boundary, isCompactSummary user, post-compact slash
                // command artifact} that physically sits in the same backfill
                // window. Detected by walking from bestPred backwards a few
                // entries to see if a compact_boundary is within reach.
                let isPostCompactInit = false;
                if (lastAdded.type === 'attachment') {
                  // Look at up to 10 entries around bestPred for a compact_boundary
                  const predIdx = bestPred._fileIndex;
                  for (const [, entry] of recordMap) {
                    if (entry._fromFile !== bestPred._fromFile) continue;
                    if (typeof entry._fileIndex !== 'number') continue;
                    if (entry._fileIndex < predIdx - 10 || entry._fileIndex > lastAdded._fileIndex) continue;
                    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
                      isPostCompactInit = true;
                      break;
                    }
                  }
                }

                if (isPostCompactInit) {
                  console.log('[Timeline:Backtrace] CHAIN BREAK suppressed (post-compact init): orphan=' + lastAdded.uuid.substring(0, 8) + ' type=attachment near compact_boundary — Claude internal init, not data loss');
                  currentUuid = bestPred.uuid;
                  recovered = true;
                  // Skip the rest of this if-block (no _chainBreaks.push,
                  // no diag log) — fall through to outer `if (recovered) continue`.
                } else {
                _chainBreaks.push({
                  missingUuid: currentUuid,
                  recoveredFromUuid: lastAdded.uuid,
                  jumpedToUuid: bestPred.uuid,
                  // Classification surfaces in the toast — UI shows "MCP X reconnected"
                  // not just "history recovered: 1 break".
                  flavor: _classified.flavor,
                  short: _classified.short,
                  subtype: _classified.subtype || null,
                  addedNames: _classified.addedNames || null,
                  orphanTimestamp: lastAdded.timestamp || null,
                });
                console.log('[Timeline:Backtrace] CHAIN BREAK recovery: ' + currentUuid.substring(0, 8) + ' missing, jumping to ' + bestPred.uuid.substring(0, 8) + ' (fileIdx ' + bestPred._fileIndex + ', type=' + bestPred.type + ')');
                const _diagKey = sessionId + ':' + currentUuid;
                if (!_jsonlChainDiagLogged.has(_diagKey)) {
                  _jsonlChainDiagLogged.add(_diagKey);
                  // Content sample helps post-mortem ("which prompt did the user
                  // type when this happened") without sweeping the whole file.
                  let contentSample = '';
                  try {
                    const c = lastAdded.message?.content;
                    if (typeof c === 'string') contentSample = c.substring(0, 100).replace(/\n/g, ' ');
                    else if (Array.isArray(c)) {
                      const text = c.find(b => b.type === 'text')?.text;
                      contentSample = (text || c.map(b => b.type).join('|')).substring(0, 100);
                    }
                  } catch {}
                  console.log('[JsonlChainDiag:ChainBreak] session=' + sessionId.substring(0, 8) +
                    ' orphanUuid=' + lastAdded.uuid.substring(0, 8) +
                    ' orphanType=' + lastAdded.type +
                    ' flavor=' + _classified.flavor +
                    ' orphanTimestamp=' + (lastAdded.timestamp || '?') +
                    ' missingParent=' + currentUuid.substring(0, 8) +
                    ' jumpedToUuid=' + bestPred.uuid.substring(0, 8) +
                    ' jumpedType=' + bestPred.type +
                    ' jumpedTimestamp=' + (bestPred.timestamp || '?') +
                    ' fileIdx ' + bestPred._fileIndex + '→' + lastAdded._fileIndex +
                    ' gapEntries=' + (lastAdded._fileIndex - bestPred._fileIndex - 1) +
                    (contentSample ? ' content="' + contentSample + '"' : '') +
                    ' (subsequent occurrences for this orphan deduped)');
                }
                currentUuid = bestPred.uuid;
                recovered = true;
                } // end of else (not isPostCompactInit)
              } else {
                console.log('[Timeline:Backtrace] BREAK: uuid=' + currentUuid.substring(0, 8) + ' not in recordMap. lastAdded.type=' + lastAdded.type + ' subtype=' + (lastAdded.subtype || 'none'));
              }
            }
          } else {
            console.log('[Timeline:Backtrace] BREAK: uuid=' + currentUuid.substring(0, 8) + ' not in recordMap (activeBranch empty)');
          }
          if (recovered) continue;
          break;
        }

        activeBranch.unshift(record);

        // Move to parent (use logicalParentUuid for compact boundaries, else parentUuid)
        let nextUuid = record.logicalParentUuid || record.parentUuid;

        // ── Compact passthrough ──
        // When backtrace arrives at a compact_boundary, logicalParentUuid usually
        // points FORWARD into post-compact entries (already in `seen`) or to a
        // dangling UUID, while parentUuid is null. Result: backtrace stops at
        // compact and pre-compact history (still physically present in JSONL)
        // becomes invisible to Timeline/History — even though the user only ran
        // /compact, no UUID-corruption happened. This is NOT a chain break and
        // must NOT trigger ghost-styling or toasts. Jump to the physical
        // predecessor in the same file to keep walking backwards through the
        // pre-compact tail.
        if (record.type === 'system' && record.subtype === 'compact_boundary') {
          const isDeadEnd = !nextUuid || seen.has(nextUuid) || !recordMap.has(nextUuid);
          if (isDeadEnd) {
            let bestPred = null;
            for (const [uuid, entry] of recordMap) {
              if (seen.has(uuid)) continue;
              if (entry._fromFile === record._fromFile &&
                  typeof entry._fileIndex === 'number' &&
                  typeof record._fileIndex === 'number' &&
                  entry._fileIndex < record._fileIndex) {
                if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                  bestPred = entry;
                }
              }
            }
            if (bestPred) {
              nextUuid = bestPred.uuid;
              _compactPassthroughCount++;
              console.log('[Timeline:Backtrace] Compact passthrough: compact=' + record.uuid.substring(0, 8) + ' fileIdx=' + record._fileIndex + ' → predecessor=' + bestPred.uuid.substring(0, 8) + ' fileIdx=' + bestPred._fileIndex);
            }
          }
        }

        // If we hit the root (parentUuid=null), check for bridge entry to parent session.
        // Bridge entry has a DIFFERENT sessionId and its parentUuid points into the parent file.
        // We need to follow the bridge to continue backtrace into the parent chain.
        if (!nextUuid && sessionBoundaries.length > 0) {
          // Method 1: Find JSONL bridge entry (classic Clear Context with bridge)
          for (const [uuid, entry] of recordMap) {
            if (seen.has(uuid)) continue;
            if (entry._isBridge && entry.parentUuid && entry.sessionId !== record.sessionId &&
                !seen.has(entry.parentUuid)) {
              nextUuid = entry.parentUuid;
              _bridgeFollowCount++;
              console.log('[Timeline:Backtrace] Bridge follow: ' + record.sessionId.substring(0, 8) + ' → bridge.parentUuid=' + entry.parentUuid.substring(0, 8) + ' bridge.sessionId=' + entry.sessionId.substring(0, 8));
              break;
            }
          }

          // Method 2: SQLite session link fallback (Clear Context without JSONL bridge)
          // When no _isBridge entry exists, use sessionBoundaries to find the parent session's last record
          if (!nextUuid && record.sessionId) {
            const boundary = sessionBoundaries.find(b => b.childSessionId === record.sessionId);
            if (boundary) {
              // Find the last record (by _fileIndex) in the parent session
              let parentLastRecord = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fromFile === boundary.parentSessionId) {
                  if (!parentLastRecord || entry._fileIndex > parentLastRecord._fileIndex) {
                    parentLastRecord = entry;
                  }
                }
              }
              if (parentLastRecord) {
                nextUuid = parentLastRecord.uuid;
                _bridgeFollowCount++;
                console.log('[Timeline:Backtrace] SQLite bridge: ' + record.sessionId.substring(0, 8) + ' → parent last record: ' + parentLastRecord.uuid.substring(0, 8));
              }
            }
          }
        }

        currentUuid = nextUuid;
      }

      console.log('[Timeline:Backtrace] DONE session=' + sessionId.substring(0, 8) + ' activeBranch=' + activeBranch.length + ' compactRecoveries=' + _compactRecoveryCount + ' compactPassthrough=' + _compactPassthroughCount + ' bridgeFollows=' + _bridgeFollowCount + ' chainBreaks=' + _chainBreaks.length + ' root=' + (activeBranch.length > 0 ? activeBranch[0].uuid.substring(0, 8) + '/' + activeBranch[0].type : 'empty'));
      const backtraceMs = nodePerformance.now() - backtraceStartedAt;

      // Now filter the active branch for Timeline display
      const filterStartedAt = nodePerformance.now();
      const entries = [];
      let skippedSidechain = 0, skippedSummary = 0, skippedToolResult = 0, skippedNoContent = 0, skippedSystem = 0;
      for (const entry of activeBranch) {
        // Skip sidechain entries (internal Claude operations)
        if (entry.isSidechain) { skippedSidechain++; continue; }

        // Skip summary type (internal)
        if (entry.type === 'summary') { skippedSummary++; continue; }

        // Include: user messages, compact boundaries
        if (entry.type === 'user') {
          // Normalize content - can be string or array of objects
          let rawContent = entry.message?.content;
          let hasImage = false;

          // Skip tool_result entries - these are automatic, not user input
          if (Array.isArray(rawContent)) {
            const hasToolResult = rawContent.some(item => item.type === 'tool_result');
            if (hasToolResult) {
              skippedToolResult++;
              continue;
            }
            // Detect image blocks (Claude Code shows these as [Image #N] in terminal)
            hasImage = rawContent.some(item => item.type === 'image');
            // Find first text block for other array types
            const textBlock = rawContent.find(item => item.type === 'text' && item.text);
            rawContent = textBlock?.text || (hasImage ? '[Image]' : null);
          }

          // Skip if no valid content
          if (!rawContent || typeof rawContent !== 'string') {
            skippedNoContent++;
            continue;
          }

          // Skip system messages that look like user messages
          if (rawContent === '[Request interrupted by user]' ||
              rawContent.startsWith('[Request interrupted') ||
              rawContent === '[User cancelled]') {
            skippedSystem++;
            continue;
          }

          // Skip meta messages (isMeta: true) - these are Claude internal markers
          if (entry.isMeta) {
            skippedSystem++;
            continue;
          }

          // Skip local command artifacts - these appear after /compact and other slash commands
          if (rawContent.includes('<command-name>') ||
              rawContent.includes('<command-message>') ||
              rawContent.includes('<command-args>') ||
              rawContent.includes('<local-command-stdout>') ||
              rawContent.includes('<local-command-stderr>') ||
              rawContent.includes('<bash-notification>') ||
              rawContent.includes('<shell-id>') ||
              rawContent.includes('<user-prompt-submit-hook>') ||
              rawContent.includes('<task-notification>') ||
              rawContent.startsWith('Caveat: The messages below')) {
            skippedSystem++;
            continue;
          }

          // Strip <system-reminder>...</system-reminder> blocks injected by Claude Code
          // These appear in user messages but don't represent actual user input
          // Strip them first, then check if real content remains
          let cleanContent = rawContent
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
            .replace(/\[200~/g, '')
            .replace(/~\]/g, '')
            .trim();

          // Skip if content became empty after cleanup
          if (!cleanContent) {
            continue;
          }

          // Detect "continued session" summary (context overflow recovery)
          const isContinued = cleanContent.startsWith('This session is being continued from a previous conversation');

          // Look ahead: sum output_tokens AND capture provider model + thinking flag across this turn's assistants.
          // Model = last non-synthetic assistant.message.model (after tool_use chain it usually stays the same provider).
          // hasThinking = any assistant entry contains a content block with type==='thinking'.
          // Also collect docs_edit / docs_search markers from assistant tool_use blocks in this turn,
          // so they attach to the originating user entry (no separate timeline dots).
          let responseTokens = 0;
          let responseModel;
          let responseHasThinking = false;
          const docsEditedSet = new Set();
          const docsSearchQueriesSet = new Set();
          const entryIdx = activeBranch.indexOf(entry);
          for (let j = entryIdx + 1; j < activeBranch.length; j++) {
            const next = activeBranch[j];
            if (next.type === 'assistant' && next.message?.usage) {
              responseTokens += (next.message.usage.output_tokens || 0);
              const mdl = next.message.model;
              if (mdl && mdl !== '<synthetic>') responseModel = mdl;
              const content = next.message.content;
              if (Array.isArray(content)) {
                if (content.some(c => c && c.type === 'thinking')) responseHasThinking = true;
                for (const block of content) {
                  if (block.type !== 'tool_use') continue;
                  if ((block.name === 'Edit' || block.name === 'Write')) {
                    const fp = block.input?.file_path || '';
                    const shortName = shortKnowledgeDocsPath(fp);
                    if (shortName) {
                      docsEditedSet.add(shortName);
                    }
                  }
                  if (block.name === 'mcp__knowledge__docs_search') {
                    const q = block.input?.query || '';
                    if (q) docsSearchQueriesSet.add(q);
                  }
                }
              }
            }
            // Stop only on the next REAL user prompt — skip tool_result entries (they have
            // type:'user' too) and <task-notification> auto-messages from sub-agents.
            // Without this guard, look-ahead breaks at the first tool_result and Edit/Write
            // blocks from later assistants in the same turn are missed (green dot stays grey).
            // Same forward-expand trap as edit-range — see fact-timeline.md::Forward-expand ловушка.
            if (next.type === 'user' && !next.isSidechain) {
              const nc = next.message?.content;
              const isToolResult = Array.isArray(nc) && nc.some(b => b && b.type === 'tool_result');
              const ncStr = typeof nc === 'string' ? nc : '';
              const isTaskNotif = ncStr.startsWith('<task-notification>');
              if (!isToolResult && !isTaskNotif) break;
            }
          }
          if (!responseTokens) responseTokens = undefined;

          entries.push({
            uuid: entry.uuid,
            type: isContinued ? 'continued' : 'user',
            timestamp: entry.timestamp,
            content: cleanContent,
            hasImage: hasImage || undefined,
            isCompactSummary: entry.isCompactSummary || false,
            sessionId: entry.sessionId || entry._fromFile,
            isPlan: !!entry.planContent,
            responseTokens,
            responseModel,
            responseHasThinking: responseHasThinking || undefined,
            // Attached to user-entry so timeline shows a single dot per prompt instead of
            // separate docs_edit/docs_search dots. Empty arrays omitted to keep entry shape clean.
            docsEdited: docsEditedSet.size > 0 ? Array.from(docsEditedSet) : undefined,
            docsSearchQueries: docsSearchQueriesSet.size > 0 ? Array.from(docsSearchQueriesSet) : undefined,
          });
        } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          entries.push({
            uuid: entry.uuid,
            type: 'compact',
            timestamp: entry.timestamp,
            content: 'Conversation compacted',
            preTokens: entry.compactMetadata?.preTokens,
            sessionId: entry.sessionId || entry._fromFile
          });
        }
        // Note: docs_edit / docs_search markers are no longer emitted as separate entries —
        // they're collected in the user-entry look-ahead loop above and stored as
        // `docsEdited[]` / `docsSearchQueries[]` fields on the originating user prompt.
        // Frontend recolors user dot and renders inline tooltip block instead of separate dots.
      }

      console.log('[Timeline:Backtrace] session=' + sessionId.substring(0, 8) + ' entries=' + entries.length + ' skipped: sidechain=' + skippedSidechain + ' toolResult=' + skippedToolResult + ' noContent=' + skippedNoContent + ' system=' + skippedSystem + ' summary=' + skippedSummary);
      const filterMs = nodePerformance.now() - filterStartedAt;

      // Resolve the latest session ID in the chain (tip)
      // This helps the renderer detect if claudeSessionId needs updating
      const latestStartedAt = nodePerformance.now();
      const latestSessionId = resolveLatestSessionInChain(sessionId, cwd);
      const latestMs = nodePerformance.now() - latestStartedAt;

      // Claude's own backtrace stops at the first orphan — everything before
      // is invisible to the live Claude process even though it's on disk.
      // Surface that boundary so UI can grey out entries Claude doesn't remember.
      // The boundary uuid is the LAST entry Claude still sees (i.e. lastAdded at
      // the moment the first chain break fired — the youngest entry of the
      // pre-orphan tail). Everything in activeBranch with an index lower than
      // this uuid's index is invisible to Claude.
      const claudeMemoryBoundaryUuid = _chainBreaks.length > 0 ? _chainBreaks[0].recoveredFromUuid : null;
      console.warn(
        '[Perf:TimelineIPC] outcome=success' +
        ' source=' + source +
        ' reason=' + reason +
        ' inst=' + (instanceId || 'none') +
        ' tab=' + shortTab +
        ' session=' + shortSession +
        ' visible=' + visible +
        ' startAbs=' + timelineStartAbs.toFixed(1) +
        ' endAbs=' + (nodePerformance.timeOrigin + nodePerformance.now()).toFixed(1) +
        ' recordMap=' + recordMap.size +
        ' activeBranch=' + activeBranch.length +
        ' entries=' + entries.length +
        ' boundaries=' + sessionBoundaries.length +
        ' resolveMs=' + resolveMs.toFixed(1) +
        ' backtraceMs=' + backtraceMs.toFixed(1) +
        ' filterMs=' + filterMs.toFixed(1) +
        ' latestMs=' + latestMs.toFixed(1) +
        ' totalMs=' + (nodePerformance.now() - timelineStartedAt).toFixed(1)
      );
      _endPerfOp(opId);
      return { success: true, entries: entries, latestSessionId, sessionBoundaries, chainBreaks: _chainBreaks, claudeMemoryBoundaryUuid };

    } catch (error) {
      console.error('[Claude Timeline] Error:', error);
      console.warn(
        '[Perf:TimelineIPC] outcome=error' +
        ' source=' + source +
        ' reason=' + reason +
        ' inst=' + (instanceId || 'none') +
        ' tab=' + shortTab +
        ' session=' + shortSession +
        ' visible=' + visible +
        ' startAbs=' + timelineStartAbs.toFixed(1) +
        ' endAbs=' + (nodePerformance.timeOrigin + nodePerformance.now()).toFixed(1) +
        ' totalMs=' + (nodePerformance.now() - timelineStartedAt).toFixed(1) +
        ' error=' + error.message
      );
      _endPerfOp(opId);
      return { success: false, error: error.message };
    }
  });

  // Export Claude session as clean text (with options and backtrace)
  ipcMain.handle('claude:export-clean-session', async (event, {
    sessionId, cwd,
    includeEditing = false, includeReading = false,
    includeCode, fromStart = true,
    includeSubagentResult = false, includeSubagentHistory = false,
    // Hierarchical copy settings — see fact-clipboard-tools.md::Hierarchical groups.
    includeUser = true, includeClaude = true,
    includeText = true, includeThinking = true,
    includeBash = false, includeTools = false,
    includeWebSearch = false, includeToolSearch = false, includeOtherTools = includeTools,
  }) => {
    // Backward compat: old callers may pass includeCode
    if (includeCode !== undefined && includeEditing === undefined) {
      includeEditing = includeCode;
      includeReading = includeCode;
    }
    console.log('[Claude Export] ========================================');
    console.log('[Claude Export] Exporting session:', sessionId);
    console.log('[Claude Export] Options:', { includeEditing, includeReading, fromStart, includeSubagentResult, includeSubagentHistory, cwd });

    if (!sessionId) {
      return { success: false, error: 'No session ID provided' };
    }

    try {
      // Resolve the full session chain (follows bridge entries across "Clear Context" boundaries)
      // Same as Timeline — loads all JSONL files in the chain and merges records
      const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = await resolveSessionChain(sessionId, cwd);

      console.log('[Claude Export] Merged records:', recordMap.size, '| Chain depth:', sessionBoundaries.length + 1, '| Progress entries:', allProgressEntries.length);
      console.log('[Claude Export] Last record type:', lastRecord?.type);

      if (!lastRecord) {
        console.log('[Claude Export] Empty session - no records with UUID');
        return { success: true, content: '# Empty session' };
      }

      // BACKTRACE: Walk backwards from the last record following parentUuid
      // Same logic as Timeline — follows bridge entries across file boundaries
      const activeBranch = [];
      let currentUuid = lastRecord.uuid;
      const seen = new Set();

      while (currentUuid && !seen.has(currentUuid)) {
        seen.add(currentUuid);
        const record = recordMap.get(currentUuid);
        if (!record) {
          // Recovery: dangling logicalParentUuid from compact_boundary
          let recovered = false;
          if (activeBranch.length > 0) {
            const lastAdded = activeBranch[0];
            if (lastAdded.type === 'system' && lastAdded.subtype === 'compact_boundary' &&
                lastAdded.logicalParentUuid === currentUuid) {
              console.log('[Claude Export] Dangling logicalParentUuid:', currentUuid.slice(0, 12), '- recovering');
              if (lastAdded.parentUuid && recordMap.has(lastAdded.parentUuid) && !seen.has(lastAdded.parentUuid)) {
                currentUuid = lastAdded.parentUuid;
                recovered = true;
                console.log('[Claude Export] Recovered via parentUuid:', currentUuid.slice(0, 12));
              } else {
                let bestPred = null;
                for (const [uuid, entry] of recordMap) {
                  if (seen.has(uuid)) continue;
                  if (entry._fromFile === lastAdded._fromFile &&
                      entry._fileIndex < lastAdded._fileIndex) {
                    if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                      bestPred = entry;
                    }
                  }
                }
                if (bestPred) {
                  currentUuid = bestPred.uuid;
                  recovered = true;
                  console.log('[Claude Export] Recovered via physical predecessor:', currentUuid.slice(0, 12));
                }
              }
            }
          }
          if (recovered) continue;
          console.log('[Claude Export] Backtrace ended - UUID not found:', currentUuid);
          break;
        }

        activeBranch.unshift(record);

        let nextUuid = record.logicalParentUuid || record.parentUuid;

        // If we hit the root (parentUuid=null), check for bridge entry to parent session
        // Only follow bridges whose target has not been visited yet (prevents cycling)
        if (!nextUuid && sessionBoundaries.length > 0) {
          for (const [uuid, entry] of recordMap) {
            if (seen.has(uuid)) continue;
            if (entry._isBridge && entry.parentUuid && entry.sessionId !== record.sessionId &&
                !seen.has(entry.parentUuid)) {
              console.log('[Claude Export] Following bridge:', uuid.slice(0, 12), '\u2192 parent:', entry.parentUuid?.slice(0, 12));
              nextUuid = entry.parentUuid;
              break;
            }
          }
          if (!nextUuid && record.sessionId) {
            const boundary = sessionBoundaries.find(b => b.childSessionId === record.sessionId);
            if (boundary) {
              let parentLast = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fromFile === boundary.parentSessionId) {
                  if (!parentLast || entry._fileIndex > parentLast._fileIndex) parentLast = entry;
                }
              }
              if (parentLast) nextUuid = parentLast.uuid;
            }
          }
        }

        currentUuid = nextUuid;
      }

      console.log('[Claude Export] Backtrace complete, active branch size:', activeBranch.length);

      // Debug: log sessionId distribution in activeBranch
      const sidCounts = {};
      for (const entry of activeBranch) {
        const sid = (entry.sessionId || 'NO-SID').slice(0, 8);
        sidCounts[sid] = (sidCounts[sid] || 0) + 1;
      }
      console.log('[Claude Export] SessionId distribution:', JSON.stringify(sidCounts));

      // 3. FORK MARKERS: Precompute which UUIDs are fork boundaries
      // Helper: check if a record is a Timeline-eligible entry (user message or compact boundary)
      const isTimelineEntry = (rec) => {
        if (rec.type === 'system' && rec.subtype === 'compact_boundary') return true;
        if (rec.type !== 'user') return false;
        if (rec.isSidechain || rec.isMeta) return false;
        const content = rec.message?.content;
        if (Array.isArray(content) && content.some(item => item.type === 'tool_result')) return false;
        return true;
      };

      const forkBoundaryUuids = new Set();
      let hasForkAtBeginning = false; // Fork with empty snapshot = fork before any entries
      let forkMarkers = [];
      try {
        forkMarkers = projectManager.db.getForkMarkers(sessionId);
        console.log('[Claude Export] Fork markers found:', forkMarkers.length);
        for (const marker of forkMarkers) {
          const snapshotSet = new Set(marker.entry_uuids || []);
          if (snapshotSet.size === 0) {
            hasForkAtBeginning = true;
            continue;
          }
          // Find boundary: last Timeline-eligible entry in snapshot where next Timeline-eligible entry is NOT in snapshot
          for (let idx = 0; idx < activeBranch.length; idx++) {
            const rec = activeBranch[idx];
            if (!snapshotSet.has(rec.uuid)) continue;
            let nextTimelineEntry = null;
            for (let j = idx + 1; j < activeBranch.length; j++) {
              if (isTimelineEntry(activeBranch[j])) {
                nextTimelineEntry = activeBranch[j];
                break;
              }
            }
            if (!nextTimelineEntry) {
              forkBoundaryUuids.add(rec.uuid);
            } else if (!snapshotSet.has(nextTimelineEntry.uuid)) {
              forkBoundaryUuids.add(rec.uuid);
            }
          }
        }
        console.log('[Claude Export] Fork boundary UUIDs:', forkBoundaryUuids.size, 'hasForkAtBeginning:', hasForkAtBeginning);
      } catch (e) {
        console.warn('[Claude Export] Could not load fork markers:', e.message);
      }

      // 4. fromStart=false: trim activeBranch to start from the last fork boundary
      if (!fromStart && forkBoundaryUuids.size > 0) {
        let lastForkIdx = -1;
        for (let i = activeBranch.length - 1; i >= 0; i--) {
          if (forkBoundaryUuids.has(activeBranch[i].uuid)) {
            lastForkIdx = i;
            break;
          }
        }
        if (lastForkIdx >= 0) {
          const trimmedUuid = activeBranch[lastForkIdx].uuid;
          activeBranch.splice(0, lastForkIdx + 1);
          forkBoundaryUuids.delete(trimmedUuid);
          hasForkAtBeginning = true; // Show FORK separator at the beginning of trimmed output
          console.log('[Claude Export] Trimmed to fork boundary, remaining entries:', activeBranch.length);
        }
      }

      // Build session tree segments from sessionId boundaries in activeBranch
      // This captures BOTH fork transitions and clear-context transitions
      const treeSegments = [];
      let currentTreeSid = null;

      for (let i = 0; i < activeBranch.length; i++) {
        const entry = activeBranch[i];
        const entrySid = entry.sessionId || 'unknown';

        if (entrySid !== currentTreeSid) {
          currentTreeSid = entrySid;
          treeSegments.push({
            startIdx: i,
            endIdx: i,
            sessionLabel: entrySid.slice(0, 8),
            fullSessionId: entrySid,
          });
        }
        // Update endIdx of current segment
        if (treeSegments.length > 0) {
          treeSegments[treeSegments.length - 1].endIdx = i;
        }
      }

      // Determine segment types using bridge entries from recordMap
      // Bridge entry (_isBridge=true) with sessionId matching PREVIOUS segment = clear-context/plan mode
      // No matching bridge = fork (entries were copied, not bridged)
      for (let i = 0; i < treeSegments.length; i++) {
        const seg = treeSegments[i];

        if (i === 0) {
          seg.type = 'root';
        } else {
          // Check if a bridge entry exists with sessionId matching the previous segment
          // This means the transition was a clear-context (plan mode)
          let hasBridge = false;
          for (const [, entry] of recordMap) {
            if (entry._isBridge && entry.sessionId === treeSegments[i - 1].fullSessionId) {
              hasBridge = true;
              break;
            }
          }
          seg.type = hasBridge ? 'clear-context' : 'fork';
        }
      }

      // If the current export session has no entries in activeBranch, add it as final segment
      // This happens when a fork was just created and Claude hasn't written new entries yet
      const lastSeg = treeSegments[treeSegments.length - 1];
      if (lastSeg.fullSessionId !== sessionId) {
        // Determine type: check fork markers (source = last segment = fork) or session boundary
        const isForkFromLast = forkMarkers.some(m => m.source_session_id === lastSeg.fullSessionId);
        treeSegments.push({
          startIdx: activeBranch.length,
          endIdx: activeBranch.length - 1,
          sessionLabel: sessionId.slice(0, 8),
          fullSessionId: sessionId,
          type: isForkFromLast ? 'fork' : 'clear-context',
          messages: 0, compacts: 0,
        });
      }

      // Mark current session
      for (let i = 0; i < treeSegments.length; i++) {
        treeSegments[i].isCurrent = i === treeSegments.length - 1;
      }

      // Compute per-segment stats
      for (const seg of treeSegments) {
        let messages = 0, compacts = 0;
        for (let i = seg.startIdx; i <= seg.endIdx && i < activeBranch.length; i++) {
          const entry = activeBranch[i];
          if (entry.isSidechain) continue;
          if (entry.type === 'user') {
            const c = entry.message?.content;
            if (Array.isArray(c) && c.some(item => item.type === 'tool_result')) continue;
            if (typeof c === 'string' && (c.startsWith('[Request interrupted') || c.includes('<command-name>'))) continue;
            messages++;
          } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
            compacts++;
          }
        }
        seg.messages = messages;
        seg.compacts = compacts;
      }

      console.log('[Claude Export] Tree segments:', treeSegments.length, treeSegments.map(s => `${s.sessionLabel}(${s.type})`).join(' → '));

      const outputParts = [];
      outputParts.push(`# Claude Session Export`);
      outputParts.push(`Session: ${sessionId}`);
      outputParts.push(`CWD: ${cwd || 'unknown'}`);
      outputParts.push('');

      // Render hierarchical session tree
      outputParts.push('Session Tree:');
      for (let i = 0; i < treeSegments.length; i++) {
        const seg = treeSegments[i];
        const depth = i;
        const indent = depth > 0 ? '    '.repeat(depth - 1) + '\u2514\u2500\u2500 ' : '';

        let tag = '';
        if (seg.type === 'root' && treeSegments.length > 1) tag = ' (root)';
        else if (seg.type === 'clear-context') tag = ' (plan mode)';
        else if (seg.type === 'fork') tag = ' (fork)';
        if (seg.isCurrent && treeSegments.length > 1) tag += ' *';

        const stats = [];
        if (seg.compacts > 0) stats.push(`\u267B\uFE0F \u00D7${seg.compacts}`);
        if (seg.messages > 0) stats.push(`${seg.messages} message${seg.messages !== 1 ? 's' : ''}`);

        const statsStr = stats.length > 0 ? ` \u2014 ${stats.join(', ')}` : '';
        outputParts.push(`${indent}${seg.sessionLabel}${tag}${statsStr}`);
      }
      outputParts.push('');
      outputParts.push(`Markers:`);
      outputParts.push(`  \uD83D\uDD35 FORK  \u2014 session branched (search "FORK")`);
      outputParts.push(`  \u2550\u2550\u2550 COMPACTED \u2550\u2550\u2550 \u2014 context window compacted (search "COMPACTED")`);
      outputParts.push('');

      // Insert FORK separator at the beginning if fork was before any entries or trimmed
      if (hasForkAtBeginning) {
        outputParts.push('');
        outputParts.push('\uD83D\uDD35\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 FORK \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\uD83D\uDD35');
        outputParts.push('');
      }

      // Build progress entries index by parentToolUseID for fast lookup
      const progressByToolUseId = new Map();
      for (const pe of allProgressEntries) {
        const key = pe.parentToolUseID;
        if (!progressByToolUseId.has(key)) progressByToolUseId.set(key, []);
        progressByToolUseId.get(key).push(pe);
      }

      // Sibling tool_result records from parallel tool calls live OFF the
      // parentUuid branch (only the last result continues it) — an all-records
      // index by tool_use_id is the exact-identity lookup the export needs.
      const exportToolResultByUseId = new Map();
      for (const [, rec] of recordMap) {
        if (rec?.type !== 'user' || !Array.isArray(rec.message?.content)) continue;
        for (const part of rec.message.content) {
          if (part?.type === 'tool_result' && part.tool_use_id
            && !exportToolResultByUseId.has(part.tool_use_id)) {
            exportToolResultByUseId.set(part.tool_use_id, part);
          }
        }
      }

      const groupFlags = {
        reading: !!includeReading,
        editing: !!includeEditing,
        bash: !!includeBash,
        mcp: !!includeTools,
        web: !!includeWebSearch,
        toolSearch: !!includeToolSearch,
        tools: !!includeOtherTools,
      };
      const claudeHasActionAppetite = includeReading || includeEditing || includeBash || includeTools || includeWebSearch || includeToolSearch || includeOtherTools || includeSubagentResult || includeSubagentHistory;

      // Delegate to shared formatToolAction with current session's settings
      const formatTool = (toolName, input, toolResult = null, toolUseId = null) => {
        const isSubagentTool = toolName === 'Task' || toolName === 'Agent';
        const taskProgress = isSubagentTool && toolUseId ? (progressByToolUseId.get(toolUseId) || []) : [];
        return formatToolAction(toolName, input, toolResult, includeEditing, includeReading, {
          includeSubagentResult, includeSubagentHistory, progressEntries: taskProgress, flags: groupFlags,
        });
      };

      // Process the active branch
      for (let i = 0; i < activeBranch.length; i++) {
        const entry = activeBranch[i];

        if (entry.isSidechain || entry.type === 'summary') continue;

        if (entry.type === 'user') {
          if (!includeUser) continue;
          let rawContent = entry.message?.content;

          // tool_result entries are stored as user messages in JSONL
          if (Array.isArray(rawContent) && rawContent.some(item => item.type === 'tool_result')) {
            // If we are including code, these are handled by matching them to tool_use in formatToolAction
            // or we can list them here. But cleaner to ignore them if they are just results of previous assistant tools.
            continue;
          }

          if (typeof rawContent !== 'string') {
            if (Array.isArray(rawContent)) {
              rawContent = rawContent.find(item => item.type === 'text')?.text || null;
            } else {
              rawContent = null;
            }
          }

          if (!rawContent) continue;

          // Skip system-like messages
          if (rawContent.startsWith('[Request interrupted') || rawContent === '[User cancelled]') continue;
          if (rawContent.includes('<command-name>') || rawContent.includes('<local-command-stdout>')) continue;

          let cleanContent = rawContent.replace(/\[200~/g, '').replace(/~\]/g, '').trim();
          if (!cleanContent) continue;

          outputParts.push('---');
          outputParts.push('');
          outputParts.push('\uD83D\uDC64 USER:');
          outputParts.push(cleanContent);
          outputParts.push('');
        }

        else if (entry.type === 'assistant') {
          if (!includeClaude) continue;
          const msgContent = entry.message?.content;
          if (!msgContent) continue;

          let textContent = '';
          const toolActions = [];

          if (typeof msgContent === 'string') {
            if (includeText) textContent = msgContent;
          } else if (Array.isArray(msgContent)) {
            const textParts = [];
            for (const block of msgContent) {
              if (block.type === 'thinking' && block.thinking && includeThinking) {
                textParts.push(`<thinking>\n${block.thinking}\n</thinking>`);
              }
              if (block.type === 'text' && block.text && includeText) {
                textParts.push(block.text);
              }
              if (block.type === 'tool_use') {
                // Label-always — see same note in claude:copy-range.
                // Group classification gates only the toolResult search (perf optimization).
                const group = (() => {
                  if (block.name === 'Read' || block.name === 'NotebookRead') return 'reading';
                  if (block.name === 'Edit' || block.name === 'Write' || block.name === 'NotebookEdit') return 'editing';
                  if (block.name === 'Bash' || block.name === 'Monitor' || block.name === 'Grep' || block.name === 'Glob') return 'bash';
                  if (block.name === 'Task' || block.name === 'Agent') return 'subagent';
                  if (block.name === 'WebSearch' || block.name === 'WebFetch') return 'web';
                  if (typeof block.name === 'string' && block.name.startsWith('mcp__')) return 'mcp';
                  return 'tools';
                })();
                const groupOn = (group === 'reading' && groupFlags.reading)
                  || (group === 'editing' && groupFlags.editing)
                  || (group === 'bash' && groupFlags.bash)
                  || (group === 'mcp' && groupFlags.mcp)
                  || (group === 'web' && groupFlags.web)
                  || (group === 'toolSearch' && groupFlags.toolSearch)
                  || (group === 'tools' && groupFlags.tools)
                  || (group === 'subagent' && (includeSubagentResult || includeSubagentHistory));

                const toolResult = groupOn
                  ? (exportToolResultByUseId.get(block.id) || null)
                  : null;
                const action = formatTool(block.name, block.input || {}, toolResult, block.id);
                if (action) toolActions.push(action);
              }
            }
            textContent = textParts.join('\n\n');
          }

          if (textContent.trim() || toolActions.length > 0) {
            outputParts.push('\uD83E\uDD16 CLAUDE:');
            if (textContent.trim()) outputParts.push(textContent);
            if (toolActions.length > 0) {
              if (claudeHasActionAppetite) {
                outputParts.push('\n**Actions:**\n' + toolActions.join('\n\n'));
              } else {
                outputParts.push(`   [\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044F: ${toolActions.join(', ')}]`);
              }
            }
            outputParts.push('');
          }
        }

        else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          outputParts.push('');
          outputParts.push('\u2550\u2550\u2550 COMPACTED \u2550\u2550\u2550');
          outputParts.push('');
        }

        // Insert fork separator after boundary entries
        if (forkBoundaryUuids.has(entry.uuid)) {
          outputParts.push('');
          outputParts.push('\uD83D\uDD35\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 FORK \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\uD83D\uDD35');
          outputParts.push('');
        }
      }

      const finalContent = outputParts.join('\n');
      console.log('[Claude Export] Export complete:', {
        outputLines: outputParts.length,
        totalLength: finalContent.length,
        preview: finalContent.substring(0, 200) + '...'
      });
      console.log('[Claude Export] ========================================');

      return { success: true, content: finalContent };

    } catch (error) {
      console.error('[Claude Export] Error:', error);
      console.error('[Claude Export] Stack:', error.stack);
      return { success: false, error: error.message };
    }
  });

  _api.getConfirmedSettings = async function ({
    tabId,
    sessionId: requestedSessionId,
    cwd: requestedCwd,
  } = {}) {
    const cleanTabId = String(tabId || '').trim();
    let sessionId = String(requestedSessionId || '').trim() || null;
    let cwd = String(requestedCwd || '').trim() || null;

    if (cleanTabId) {
      let row = null;
      try {
        row = projectManager?.db?.db?.prepare(
          'SELECT claude_session_id, cwd FROM tabs WHERE tab_id = ? LIMIT 1'
        ).get(cleanTabId) || null;
      } catch (error) {
        return {
          success: false,
          reason: 'tab-lookup-failed',
          error: error?.message || String(error),
        };
      }
      const boundSessionId = String(row?.claude_session_id || '').trim() || null;
      if (sessionId && boundSessionId && sessionId !== boundSessionId) {
        return {
          success: false,
          reason: 'stale-session',
          sessionId: boundSessionId,
          requestedSessionId: sessionId,
        };
      }
      sessionId = boundSessionId || sessionId;
      cwd = String(row?.cwd || '').trim() || cwd;
    }

    if (!sessionId) {
      return { success: false, reason: 'session-missing', sessionId: null };
    }

    try {
      const {
        mergedMap: recordMap,
        lastRecord,
        sessionBoundaries,
      } = await resolveSessionChain(sessionId, cwd);
      if (!lastRecord) {
        return {
          success: true,
          sessionId,
          model: null,
          effort: null,
          proof: 'active-jsonl-branch',
        };
      }
      const { activeBranch } = traceClaudeActiveBranch({
        recordMap,
        lastRecord,
        sessionBoundaries,
        log: (message) => console.log(
          '[ClaudeConfirmedSettings:Backtrace] tab='
          + (cleanTabId ? cleanTabId.slice(-12) : '-')
          + ' '
          + message
        ),
      });
      const confirmed = deriveConfirmedClaudeSettings(activeBranch);
      return {
        success: true,
        sessionId,
        latestSessionId: resolveLatestSessionInChain(sessionId, cwd),
        model: confirmed?.model?.value || null,
        effort: confirmed?.effort?.value || null,
        modelProofAt: confirmed?.model?.proofAt || 0,
        effortProofAt: confirmed?.effort?.proofAt || 0,
        modelProofSessionId: confirmed?.model?.proofSessionId || null,
        effortProofSessionId: confirmed?.effort?.proofSessionId || null,
        proof: 'active-jsonl-branch',
      };
    } catch (error) {
      return {
        success: false,
        reason: 'settings-read-failed',
        sessionId,
        error: error?.message || String(error),
      };
    }
  };

  ipcMain.handle(
    'claude:get-confirmed-settings',
    (_event, payload = {}) => _api.getConfirmedSettings(payload)
  );

  // Get full chat history for History Panel (structured entries, not markdown)
  ipcMain.handle('claude:get-full-history', async (event, payload = {}) => {
    const { sessionId, cwd, tabId, ifRevision } = payload;
    if (!sessionId) {
      return { success: false, error: 'No session ID provided' };
    }

    try {
      let editablePromptState = null;
      let promptStateLookupFailed = false;
      if (tabId && _getClaudeEditableLastPromptState) {
        try {
          editablePromptState = await _getClaudeEditableLastPromptState(
            tabId,
            'claude-get-full-history-revision'
          );
        } catch (e) {
          promptStateLookupFailed = true;
          console.warn('[FullHistory:Revision] prompt state lookup failed tab=' +
            String(tabId).slice(-12) + ' error=' + (e?.message || e));
        }
      }
      // A resume/fork child can appear without changing the source JSONL. A new
      // child changes the project directory metadata, so keep that cheap witness
      // in the revision instead of rescanning every JSONL head on every tab switch.
      const primaryFound = findSessionFile(sessionId, cwd);
      let discovery = null;
      if (primaryFound?.projectDir) {
        try {
          const stat = await fs.promises.stat(primaryFound.projectDir);
          discovery = {
            projectDir: path.resolve(primaryFound.projectDir),
            mtimeMs: stat.mtimeMs,
          };
        } catch {}
      }
      const baseRevisionContext = _claudeHistoryContext(editablePromptState, discovery);
      const presentationRevision = _projectManager?.db?.getHistoryPromptPresentationRevision
        ? _projectManager.db.getHistoryPromptPresentationRevision('claude', sessionId)
        : 'none';
      const responseTimingRevision = _projectManager?.db?.getHistoryResponseTimingRevision
        ? _projectManager.db.getHistoryResponseTimingRevision('claude', sessionId, tabId || null)
        : 'none';
      const revisionContext = JSON.stringify({
        base: baseRevisionContext,
        promptPresentationRevision: presentationRevision,
        responseTimingRevision,
      });

      if (ifRevision && !promptStateLookupFailed) {
        const validation = await validateHistoryRevision(
          ifRevision,
          { toolType: 'claude', sessionId, cwd },
          {
            context: revisionContext,
            resolvePrimaryFile: async () => primaryFound?.filePath || null,
            validateTopology: (sources) => _validateClaudeHistoryTopology(sources, cwd),
          }
        );
        const presentationStillCurrent =
          !_projectManager?.db?.getHistoryPromptPresentationRevision
          || _projectManager.db.getHistoryPromptPresentationRevision('claude', sessionId)
            === presentationRevision;
        const responseTimingStillCurrent =
          !_projectManager?.db?.getHistoryResponseTimingRevision
          || _projectManager.db.getHistoryResponseTimingRevision('claude', sessionId, tabId || null)
            === responseTimingRevision;
        if (validation.unchanged && presentationStillCurrent && responseTimingStillCurrent) {
          return {
            success: true,
            unchanged: true,
            revision: ifRevision,
          };
        }
      }

      const {
        mergedMap: recordMap,
        lastRecord,
        sessionBoundaries,
        progressEntries: allProgressEntries,
        queueOperations: allQueueOperations,
        historySources,
      } = await resolveSessionChain(sessionId, cwd);
      // Build progress entries index by parentToolUseID
      const progressByToolUseId = new Map();
      for (const pe of allProgressEntries) {
        const key = pe.parentToolUseID;
        if (!progressByToolUseId.has(key)) progressByToolUseId.set(key, []);
        progressByToolUseId.get(key).push(pe);
      }

      if (!lastRecord) {
        const revision = buildHistoryRevision(
          { toolType: 'claude', sessionId, cwd },
          historySources,
          { context: revisionContext }
        );
        return {
          success: true,
          entries: [],
          latestSessionId: sessionId,
          revision,
        };
      }

      // Full History and confirmed session settings must walk one identical
      // logical branch. Rewind leaves abandoned records physically on disk, so
      // a second "scan the last lines" implementation would eventually disagree
      // with the conversation shown to the user.
      const {
        activeBranch,
        firstOrphanRecoveredFromUuid: _firstOrphanRecoveredFromUuid,
      } = traceClaudeActiveBranch({
        recordMap,
        lastRecord,
        sessionBoundaries,
        log: (message) => console.log('[FullHistory:Backtrace] ' + message),
      });

      // Parallel tool calls write sibling records: assistant tool_use blocks
      // chain A1←A2←A3, while their tool_result user-records attach to their
      // OWN parents (R1←A1, R2←A2) and only the last result continues the
      // branch. A branch-only forward scan therefore never finds R1/R2 and the
      // finished Bash/MCP card spins forever. tool_use ids are globally unique
      // per call, so an all-records index is exact identity — and it also
      // removes the O(n²) forward scan on long sessions. Rewind abandons a
      // tool_use together with its result, so off-branch results here can only
      // belong to on-branch calls.
      const toolResultRecordByUseId = new Map();
      for (const [, rec] of recordMap) {
        if (rec?.type !== 'user' || !Array.isArray(rec.message?.content)) continue;
        for (const part of rec.message.content) {
          if (part?.type === 'tool_result' && part.tool_use_id
            && !toolResultRecordByUseId.has(part.tool_use_id)) {
            toolResultRecordByUseId.set(part.tool_use_id, { record: rec, block: part });
          }
        }
      }

      // Background work (Bash run_in_background, async Agent/Task) resolves in
      // two steps: an immediate acceptance tool_result ("running in background
      // with ID…"), then a <task-notification> user-record carrying the real
      // outcome. The notification is filtered from History as service-noise,
      // so without this index the card keeps showing only the acceptance text.
      // <tool-use-id> inside the notification is exact identity.
      const taskNotificationByToolUseId = new Map();
      for (const [, rec] of recordMap) {
        if (rec?.type !== 'user') continue;
        const content = rec.message?.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content.find((part) => part?.type === 'text')?.text || '')
            : '';
        if (!text.includes('<task-notification>')) continue;
        const useId = (text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/) || [])[1];
        if (!useId) continue;
        const status = (text.match(/<status>([^<]+)<\/status>/) || [])[1] || 'completed';
        const summary = (text.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '';
        const resultBody = (text.match(/<result>([\s\S]*?)<\/result>/) || [])[1] || '';
        // Latest notification wins: a task can notify more than once.
        taskNotificationByToolUseId.set(useId.trim(), {
          status: status.trim(),
          summary: summary.trim(),
          result: resultBody.trim(),
          timestamp: rec.timestamp || '',
        });
      }

      // Format tool action label (standalone, no includeCode dependency)
      const mkFileAction = (toolName, input) => {
        const base = { tool: toolName, filePath: input.file_path || '?' };
        if (toolName === 'Edit') {
          return { ...base, oldString: input.old_string || '', newString: input.new_string || '' };
        }
        if (toolName === 'Write') {
          const content = input.content || '';
          const lines = content.split('\n');
          return { ...base, content: lines.length > 100
            ? lines.slice(0, 100).join('\n') + '\n... (' + lines.length + ' lines total)'
            : content };
        }
        return base;
      };

      const fmtAction = (toolName, input, toolUseId = null) => {
        switch (toolName) {
          case 'Read': return { tool: 'Read', filePath: input.file_path || '?' };
          case 'Bash': {
            const cmd = (input.command || '').substring(0, 60);
            return '\u{1F5A5} ' + cmd + (input.command?.length > 60 ? '...' : '');
          }
          case 'Glob': return '\u{1F50D} glob ' + (input.pattern || '?');
          case 'Grep': return '\u{1F50D} grep ' + (input.pattern || '?');
          case 'Task': {
            const taskObj = {
              tool: 'Task',
              description: input.description || input.prompt?.substring(0, 60) || 'Task agent',
              toolUseId: toolUseId,
            };
            // Attach progress history from agent_progress entries
            const taskProgress = toolUseId ? (progressByToolUseId.get(toolUseId) || []) : [];
            if (taskProgress.length > 0) {
              taskObj.history = [];
              for (const pe of taskProgress) {
                const msg = pe.data?.message;
                if (!msg) continue;
                const turn = { type: msg.type };
                if (msg.type === 'user') {
                  const c = msg.message?.content;
                  turn.content = typeof c === 'string' ? c : Array.isArray(c)
                    ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
                } else if (msg.type === 'assistant') {
                  const mc = msg.message?.content;
                  if (typeof mc === 'string') {
                    turn.content = mc;
                  } else if (Array.isArray(mc)) {
                    turn.content = mc.filter(x => x.type === 'text').map(x => x.text).join('\n');
                    const tools = mc.filter(x => x.type === 'tool_use');
                    if (tools.length > 0) {
                      turn.tools = tools.map(t => {
                        if (t.name === 'Bash') return '\u{1F5A5} ' + (t.input?.command || '').substring(0, 80);
                        if (t.name === 'Read' || t.name === 'Edit' || t.name === 'Write') return '\u{1F4C4} ' + t.name + ' (' + (t.input?.file_path || '?') + ')';
                        return '\u{2699}\u{FE0F} ' + t.name;
                      });
                    }
                  }
                }
                taskObj.history.push(turn);
              }
            }
            return taskObj;
          }
          case 'WebSearch': return '\u{1F310} WebSearch';
          case 'WebFetch': return '\u{1F310} WebFetch';
          default: return '\u{2699}\u{FE0F} ' + toolName;
        }
      };

      // Fork-at-beginning detection (empty snapshot = fork before any entries)
      let hasForkAtBeginning = false;
      try {
        const forkMarkers = projectManager.db.getForkMarkers(sessionId);
        for (const marker of forkMarkers) {
          if ((marker.entry_uuids || []).length === 0) {
            hasForkAtBeginning = true;
            break;
          }
        }
      } catch (e) {
        // Fork markers not available — that's OK
      }

      // Build structured entries
      const entries = [];
      let prevSessionId = null;
      let lastWasCompact = false;

      if (hasForkAtBeginning) {
        entries.push({ uuid: 'fork-begin', role: 'fork', timestamp: '', content: 'FORK', sessionId: '' });
      }

      const historyBranch = _injectQueueOperationsIntoBranch(activeBranch, allQueueOperations);
      const pendingQueueEntries = [];
      const normalizeQueuedText = (text) => String(text || '')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/\[200~/g, '').replace(/~\]/g, '').trim();
      const slashCommandEntryFromText = (text, uuid, timestamp, entrySid) => {
        const slash = slashCommandDisplayFromText(text);
        if (!slash) return null;
        return {
          uuid,
          role: 'slash',
          timestamp: timestamp || '',
          content: slash.content,
          sessionId: entrySid
        };
      };
      const shouldSkipPromptText = (text) => {
        if (!text) return true;
        if (text.startsWith('[Request interrupted') || text === '[User cancelled]') return true;
        if (text.includes('<local-command-stdout>') || text.includes('<local-command-caveat>')) return true;
        if (text.includes('<bash-notification>') || text.includes('<shell-id>')) return true;
        if (text.includes('<user-prompt-submit-hook>') || text.includes('<task-notification>')) return true;
        if (text.startsWith('Caveat: The messages below')) return true;
        return false;
      };
      const dropMatchingQueuedEntry = (cleanContent) => {
        const normalized = normalizeQueuedText(cleanContent);
        let idx = -1;
        for (let qIdx = pendingQueueEntries.length - 1; qIdx >= 0; qIdx--) {
          if (normalizeQueuedText(pendingQueueEntries[qIdx].content) === normalized) {
            idx = qIdx;
            break;
          }
        }
        if (idx < 0) return;
        const queued = pendingQueueEntries[idx];
        pendingQueueEntries.splice(idx, 1);
        const renderedIdx = entries.findIndex(e => e.uuid === queued.uuid);
        if (renderedIdx >= 0) entries.splice(renderedIdx, 1);
      };

      for (let i = 0; i < historyBranch.length; i++) {
        const entry = historyBranch[i];
        if (entry.isSidechain || entry.type === 'summary') continue;

        // Plan mode / clear context boundary detection
        const entrySid = entry.sessionId || entry._fromFile;
        const isQueueOperation = entry.type === 'queue-operation';
        if (!isQueueOperation && prevSessionId && entrySid !== prevSessionId && !lastWasCompact) {
          // Check if bridge-based transition (clear context) or fork
          // Skip after compact — compact already serves as the boundary marker
          let hasBridge = false;
          for (const [, rec] of recordMap) {
            if (rec._isBridge && rec.sessionId === prevSessionId) { hasBridge = true; break; }
          }
          entries.push({
            uuid: 'boundary-' + entry.uuid,
            role: hasBridge ? 'plan-mode' : 'fork',
            timestamp: entry.timestamp || '',
            content: hasBridge ? 'CLEAR CONTEXT' : 'FORK',
            sessionId: entrySid
          });
        }
        if (!isQueueOperation) {
          lastWasCompact = (entry.type === 'system' && entry.subtype === 'compact_boundary');
          prevSessionId = entrySid;
        }

        if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
          const cleanContent = normalizeQueuedText(extractQueuedCommandPromptText(entry.attachment.prompt));
          if (!cleanContent || shouldSkipPromptText(cleanContent)) continue;
          dropMatchingQueuedEntry(cleanContent);
          const slashEntry = slashCommandEntryFromText(cleanContent, entry.uuid, entry.timestamp, entrySid);
          if (slashEntry) {
            entries.push(slashEntry);
          } else {
            entries.push({
              uuid: entry.uuid,
              role: 'user',
              timestamp: entry.timestamp || '',
              content: cleanContent,
              queueStatus: 'sent',
              sessionId: entrySid
            });
          }
          continue;
        }

        if (entry.type === 'queue-operation') {
          if (entry.operation === 'enqueue') {
            const cleanContent = normalizeQueuedText(entry.content || '');
            if (shouldSkipPromptText(cleanContent)) continue;
            const queuedEntry = {
              uuid: entry._queueId || ('queue-' + (entry.sessionId || entry._fromFile || 'unknown') + '-' + (entry.timestamp || pendingQueueEntries.length)),
              role: 'queued',
              timestamp: entry.timestamp || '',
              content: cleanContent,
              queueStatus: 'queued',
              sessionId: entrySid
            };
            pendingQueueEntries.push(queuedEntry);
            entries.push(queuedEntry);
          } else if (entry.operation === 'dequeue') {
            const queued = pendingQueueEntries.find(q => q.queueStatus === 'queued');
            if (queued) queued.queueStatus = 'sent';
          } else if (entry.operation === 'remove') {
            const idx = pendingQueueEntries.findIndex(q => q.queueStatus === 'queued');
            if (idx >= 0) {
              const queued = pendingQueueEntries[idx];
              // Claude can emit `remove` when a queued prompt is consumed after an
              // interactive AskUserQuestion form without writing a normal user row.
              // Keep it visible as sent; a later matching user row replaces it via
              // dropMatchingQueuedEntry().
              queued.queueStatus = 'sent';
            }
          } else if (entry.operation === 'popAll') {
            for (const queued of pendingQueueEntries) {
              if (queued.queueStatus === 'queued') queued.queueStatus = 'sent';
            }
          }
          continue;
        }

        if (entry.type === 'user') {
          let rawContent = entry.message?.content;
          if (Array.isArray(rawContent) && rawContent.some(item => item.type === 'tool_result')) continue;
          if (typeof rawContent !== 'string') {
            if (Array.isArray(rawContent)) {
              rawContent = rawContent.find(item => item.type === 'text')?.text || null;
            } else {
              rawContent = null;
            }
          }
          if (!rawContent) continue;
          if (shouldSkipPromptText(rawContent)) continue;
          if (entry.isMeta) continue;

          let cleanContent = normalizeQueuedText(rawContent);
          if (!cleanContent) continue;
          dropMatchingQueuedEntry(cleanContent);

          if (entry.isCompactSummary) {
            let pairedWithCompactBoundary = false;
            for (let j = i - 1; j >= 0; j--) {
              const prev = historyBranch[j];
              if (!prev || prev.isSidechain || prev.type === 'summary') continue;
              pairedWithCompactBoundary = prev.type === 'system' && prev.subtype === 'compact_boundary';
              break;
            }
            if (pairedWithCompactBoundary) {
              continue;
            }
            entries.push({
              uuid: entry.uuid,
              role: 'compact',
              timestamp: entry.timestamp || '',
              content: 'COMPACTED',
              compactSummary: cleanContent,
              sessionId: entrySid
            });
            continue;
          }

          const slashEntry = slashCommandEntryFromText(rawContent, entry.uuid, entry.timestamp, entrySid);
          if (slashEntry) {
            entries.push(slashEntry);
            continue;
          }

          const isContinued = cleanContent.startsWith('This session is being continued from a previous conversation');

          entries.push({
            uuid: entry.uuid,
            role: isContinued ? 'continued' : 'user',
            timestamp: entry.timestamp || '',
            content: cleanContent,
            sessionId: entrySid
          });
        } else if (entry.type === 'assistant') {
          const msgContent = entry.message?.content;
          if (!msgContent) continue;

          let textContent = '';
          const thinkingParts = [];
          const actions = [];

          if (typeof msgContent === 'string') {
            textContent = msgContent;
          } else if (Array.isArray(msgContent)) {
            const textParts = [];
            for (const block of msgContent) {
              if (block.type === 'thinking' && block.thinking) {
                thinkingParts.push(block.thinking);
              }
              if (block.type === 'text' && block.text) {
                textParts.push(block.text);
              }
              if (block.type === 'tool_use') {
                const name = block.name;
                const input = block.input || {};

                // Generic tool_result finder — exact identity lookup over ALL
                // records (parallel tool calls park sibling results off the
                // parentUuid branch; a branch-only forward walk missed them and
                // left finished Bash/MCP cards spinning forever). Used both for
                // Task (final answer) AND for the raw-tool carrier below.
                const findToolResult = () => {
                  const found = toolResultRecordByUseId.get(block.id);
                  if (!found) return null;
                  const res = found.block;
                  const rc = res.content;
                  let text = typeof rc === 'string' ? rc
                    : Array.isArray(rc) ? rc.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
                  // Background handoff: the immediate result only ACCEPTED the
                  // work ("running in background…"). The real outcome arrives
                  // later as a <task-notification> keyed by this tool_use id —
                  // append it so the card reaches a terminal state instead of
                  // spinning on the acceptance text forever.
                  const notification = taskNotificationByToolUseId.get(block.id);
                  // Background identity comes from the CALL (explicit
                  // run_in_background arg), never from phrases in the result
                  // text: docs_search/Read outputs legitimately contain the
                  // words "running in background" and were spawning phantom
                  // background chips for ordinary finished tools.
                  const isBackgroundAccepted = input?.run_in_background === true;
                  if (notification && isBackgroundAccepted) {
                    const notificationBody = [
                      '— background ' + (notification.status || 'completed') + ' —',
                      notification.summary,
                      notification.result,
                    ].filter(Boolean).join('\n');
                    text = text.trimEnd() + '\n\n' + notificationBody;
                  }
                  const diffHunks = extractClaudeToolDiffHunks({
                    assistantEntry: entry,
                    toolBlock: block,
                    resultEntry: found.record,
                    resultBlock: res,
                  });
                  return {
                    text,
                    isError: !!res.is_error,
                    diffHunks: diffHunks || undefined,
                    // Accepted-but-unnotified background work is RUNNING: the
                    // acceptance result exists (so the card is not spinning),
                    // but the real outcome has not arrived yet — the chips
                    // bar shows it as an active background task.
                    backgroundStatus: notification
                      ? (notification.status || 'completed')
                      : (isBackgroundAccepted ? 'running' : undefined),
                  };
                };

                if (name === 'Task') {
                  // Subagents keep the legacy SubAgentBlock path — NOT touched.
                  const actionObj = fmtAction(name, input, block.id);
                  if (typeof actionObj === 'object' && actionObj.tool === 'Task') {
                    const rr = findToolResult();
                    if (rr) actionObj.result = rr.text;
                  }
                  actions.push(actionObj);
                } else {
                  // Raw tool carrier — full (untruncated) name+input+result for the
                  // package-based renderer (@noted/claude-blocks ToolCallPart). Every
                  // non-Task tool_use (Bash/Read/Edit/Write/MultiEdit/Glob/Grep/Web*/
                  // MCP…) renders as a real card with the proper LCS diff / Prism
                  // output, mirroring the SDK tab.
                  const rr = findToolResult();
                  actions.push({
                    tool: '__raw__',
                    rawTool: {
                      // tool_use id is globally unique per call — it is both
                      // the live-result match key and the payload identity
                      // for lazy rehydration of a dehydrated result.
                      toolUseId: block.id,
                      toolName: name,
                      args: input,
                      result: rr ? rr.text : undefined,
                      isError: rr ? rr.isError : undefined,
                      diffHunks: rr ? rr.diffHunks : undefined,
                      backgroundStatus: rr ? rr.backgroundStatus : undefined,
                    },
                  });
                }
              }
            }
            textContent = textParts.join('\n\n');
          }

          if (textContent.trim() || actions.length > 0) {
            entries.push({
              uuid: entry.uuid,
              role: 'assistant',
              timestamp: entry.timestamp || '',
              content: textContent.trim(),
              thinking: thinkingParts.length > 0 ? thinkingParts.join('\n\n---\n\n') : undefined,
              actions: actions.length > 0 ? actions : undefined,
              sessionId: entrySid
            });
          }
        } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          // Look ahead for compact summary content
          let compactSummary = '';
          for (let j = i + 1; j < historyBranch.length; j++) {
            const next = historyBranch[j];
            if (next.isCompactSummary && next.type === 'user') {
              const raw = typeof next.message?.content === 'string'
                ? next.message.content
                : Array.isArray(next.message?.content)
                  ? (next.message.content.find(c => c.type === 'text')?.text || '')
                  : '';
              compactSummary = raw
                .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
                .replace(/\[200~/g, '').replace(/~\]/g, '').trim();
              break;
            }
            if (next.type === 'user' && !next.isSidechain && !next.isMeta) break;
          }
          entries.push({
            uuid: entry.uuid,
            role: 'compact',
            timestamp: entry.timestamp || '',
            content: 'COMPACTED',
            compactSummary: compactSummary || undefined,
            preTokens: entry.compactMetadata?.preTokens || undefined,
            sessionId: entrySid
          });
        }

        // Fork boundary markers (forkBoundaryUuids) are NOT inserted here —
        // session boundary detection (sessionId change check above) already handles fork separators.
        // Adding them here caused duplicate FORK labels due to inherited markers accumulating.
      }

      const latestSessionId = resolveLatestSessionInChain(sessionId, cwd);

      let editableLastPromptStatus = null;
      if (tabId && editablePromptState) {
        try {
          const matched = _applyEditableLastPromptStatus(entries, editablePromptState);
          if (matched) {
            editableLastPromptStatus = {
              uuid: matched.uuid,
              status: matched.deliveryStatus,
              source: matched.deliveryStatusSource || null,
            };
            console.log('[FullHistory:EditableLastPrompt] tab=' + String(tabId).slice(-12)
              + ' session=' + String(sessionId).slice(0, 8)
              + ' uuid=' + String(matched.uuid || '').slice(0, 8)
              + ' source=' + (matched.deliveryStatusSource || '-'));
          }
        } catch (e) {
          console.warn('[FullHistory:EditableLastPrompt] failed tab=' + String(tabId).slice(-12)
            + ' session=' + String(sessionId).slice(0, 8)
            + ' error=' + (e?.message || e));
        }
      }

      const presentedEntries = decorateHistoryPromptPresentations(_projectManager?.db, {
        toolType: 'claude',
        sessionId,
        entries,
      });
      let responseTimingBound = false;
      const timedEntries = decorateHistoryResponseTimings(_projectManager?.db, {
        toolType: 'claude',
        sessionId,
        tabId,
        entries: presentedEntries,
        onBound: () => {
          responseTimingBound = true;
        },
      });
      if (
        responseTimingBound
        && tabId
        && event?.sender
        && (typeof event.sender.isDestroyed !== 'function' || !event.sender.isDestroyed())
      ) {
        event.sender.send('agent-activity:timing-changed', {
          tabId,
          busy: false,
          reason: 'history-response-bound',
        });
      }
      // Pending sidecars can become bound to exact UUIDs while decorating.
      // Return a revision that includes that final metadata state.
      const finalPresentationRevision = _projectManager?.db?.getHistoryPromptPresentationRevision
        ? _projectManager.db.getHistoryPromptPresentationRevision('claude', sessionId)
        : 'none';
      const finalResponseTimingRevision = _projectManager?.db?.getHistoryResponseTimingRevision
        ? _projectManager.db.getHistoryResponseTimingRevision('claude', sessionId, tabId || null)
        : 'none';
      const finalRevisionContext = JSON.stringify({
        base: baseRevisionContext,
        promptPresentationRevision: finalPresentationRevision,
        responseTimingRevision: finalResponseTimingRevision,
      });
      const revision = buildHistoryRevision(
        { toolType: 'claude', sessionId, cwd },
        historySources,
        { context: finalRevisionContext }
      );
      // Heavy tool outputs / thinking leave main as short previews + payload
      // refs; the renderer pulls the full text only on expand
      // (history:get-tool-payload). This keeps the IPC clone and renderer
      // retained-state proportional to what is on screen instead of to
      // transcript size. OPT-IN per call: web/iOS and Timeline consumers of
      // this channel have no rehydration path and keep full payloads until
      // they adopt one — silently handing them previews would be a
      // capability downgrade.
      if (payload.dehydrate === true) {
        const dehydration = dehydrateHistoryEntries({
          toolType: 'claude',
          sessionId,
          entries: timedEntries,
          stash: historyPayloadStash,
          // Claude compact summaries stay inline: they are few, bounded
          // prose, and their extraction depends on branch look-ahead — the
          // stash-miss rebuild recovers payloads from recordMap by exact
          // identity, which covers tool results and thinking only.
          dehydrateCompact: false,
        });
        if (dehydration.dehydrated > 0) {
          console.log('[FullHistory:Dehydrate] session=' + sessionId.slice(0, 8)
            + ' payloads=' + dehydration.dehydrated
            + ' savedKb=' + Math.round(dehydration.savedChars / 1024));
        }
      }
      return {
        success: true,
        unchanged: false,
        entries: timedEntries,
        latestSessionId,
        claudeMemoryBoundaryUuid: _firstOrphanRecoveredFromUuid,
        editableLastPromptStatus,
        revision,
      };
    } catch (error) {
      console.error('[Claude FullHistory] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // ========== TIMELINE NOTES ==========

  ipcMain.handle('timeline:get-notes', async (event, { sessionId }) => {
    try {
      const db = projectManager.db;
      const rows = db.getTimelineNotes(sessionId);
      const notesMap = {};
      const positionsMap = {};
      for (const row of rows) {
        notesMap[row.entry_uuid] = row.content;
        positionsMap[row.entry_uuid] = row.position || 'before';
      }
      return { success: true, notes: notesMap, positions: positionsMap };
    } catch (error) {
      console.error('[TimelineNotes] get-notes error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('timeline:save-note', async (event, { entryUuid, sessionId, tabId, content, position }) => {
    try {
      const db = projectManager.db;
      db.saveTimelineNote(entryUuid, sessionId, tabId, content, position || 'before');
      return { success: true };
    } catch (error) {
      console.error('[TimelineNotes] save-note error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('timeline:delete-note', async (event, { entryUuid, sessionId }) => {
    try {
      const db = projectManager.db;
      db.deleteTimelineNote(entryUuid, sessionId);
      return { success: true };
    } catch (error) {
      console.error('[TimelineNotes] delete-note error:', error);
      return { success: false, error: error.message };
    }
  });

  // ========== REWIND MARKERS ==========

  ipcMain.handle('timeline:get-rewind-markers', async (event, { sessionId }) => {
    try {
      const db = projectManager.db;
      const rows = db.getRewindMarkers(sessionId);
      return { success: true, markers: rows.map(r => r.entry_uuid) };
    } catch (error) {
      console.error('[RewindMarkers] get error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('timeline:delete-fork-marker', async (event, { sourceSessionId, forkSessionId }) => {
    try {
      const db = projectManager.db;
      db.db.prepare('UPDATE fork_markers SET hidden = 1 WHERE source_session_id = ? AND forked_to_session_id = ?')
        .run(sourceSessionId, forkSessionId);
      // Invalidate cache so Timeline picks up hidden=1 without restart.
      db.invalidateForkMarkerCache(sourceSessionId);
      db.invalidateForkMarkerCache(forkSessionId);
      console.log('[ForkMarker] Hidden:', sourceSessionId?.slice(0, 8), '→', forkSessionId?.slice(0, 8));
      return { success: true };
    } catch (error) {
      console.error('[ForkMarker] delete error:', error);
      return { success: false, error: error.message };
    }
  });
}

// Mobile-web Timeline view: same active-branch backtrace as parseTimelineUuids,
// but returns rich objects (preview text, full text, color band, tools list).
// The mobile drawer uses this directly. The 'color' field follows Timeline's
// desktop palette: green=user prompt, purple=compact, blue=note hint (we surface
// the placeholder; notes themselves are stored separately in DB and not joined
// here yet — same as desktop's first-pass render).
function parseTimelineEntries(sourcePath) {
  try {
    const content = fs.readFileSync(sourcePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const recordMap = new Map();
    let lastRecord = null;
    let fileIndex = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.uuid) {
          e._fileIndex = fileIndex++;
          recordMap.set(e.uuid, e);
          lastRecord = e;
        }
      } catch {}
    }
    if (!lastRecord) return [];

    // Backtrace — identical algorithm to parseTimelineUuids minus the recovery
    // edge cases (those handle proxy crashes; mobile timeline showing nothing
    // for an in-flight crashed session is acceptable).
    const branch = [];
    let cur = lastRecord.uuid;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const rec = recordMap.get(cur);
      if (!rec) break;
      branch.unshift(rec);
      cur = rec.logicalParentUuid || rec.parentUuid;
    }

    // Pass 1: collect tool_use_id → result map (tool_result lives in user-type
    // entries — same trick as fact-claude-sdk-tab.md::Tool-call rendering).
    const toolResults = new Map();
    for (const entry of branch) {
      if (entry.type !== 'user') continue;
      const c = entry.message?.content;
      if (!Array.isArray(c)) continue;
      for (const block of c) {
        if (block?.type === 'tool_result' && block.tool_use_id) {
          const txt = typeof block.content === 'string' ? block.content
            : Array.isArray(block.content) ? block.content.map(x => x?.text || '').join('\n') : '';
          toolResults.set(block.tool_use_id, { result: txt, isError: !!block.is_error });
        }
      }
    }

    const compactSummaryText = (entry) => {
      const raw = entry?.message?.content;
      if (typeof raw === 'string') return raw.trim();
      if (Array.isArray(raw)) {
        return raw
          .map((item) => item?.type === 'text' && typeof item.text === 'string' ? item.text : '')
          .filter(Boolean)
          .join('\n')
          .trim();
      }
      return '';
    };
    const findPairedCompactSummary = (boundaryIndex) => {
      for (let i = boundaryIndex + 1; i < Math.min(branch.length, boundaryIndex + 5); i++) {
        const candidate = branch[i];
        if (candidate?.type === 'user' && candidate.isCompactSummary) {
          return compactSummaryText(candidate);
        }
        if (candidate?.type === 'user') break;
      }
      return '';
    };

    const out = [];
    for (let idx = 0; idx < branch.length; idx++) {
      const entry = branch[idx];
      if (entry.isSidechain || entry.type === 'summary') continue;

      if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
        const raw = extractQueuedCommandPromptText(entry.attachment.prompt).trim();
        if (!raw || entry.isMeta) continue;
        if (slashCommandDisplayFromText(raw)) continue;
        out.push({
          uuid: entry.uuid,
          kind: 'user',
          color: '#a6e3a1',
          preview: raw.slice(0, 220),
          full: raw,
          truncated: raw.length > 220,
          ts: entry.timestamp || null,
          tools: [],
        });
      } else if (entry.type === 'user') {
        if (entry.isCompactSummary) continue;
        let raw = entry.message?.content;
        if (Array.isArray(raw)) {
          if (raw.some(i => i.type === 'tool_result')) continue; // tool result, not a prompt
          const tb = raw.find(i => i.type === 'text' && i.text);
          raw = tb?.text || null;
        }
        if (!raw || typeof raw !== 'string') continue;
        if (entry.isMeta) continue;
        // Same noise filter the desktop Timeline uses, plus local-command-stdout
        // and local-command-stderr (slash-command output that the user doesn't
        // think of as a "message").
        if (raw.includes('<command-name>') || raw.includes('<system-reminder>') ||
            raw.includes('<task-notification>') || raw.includes('<local-command-stdout>') ||
            raw.includes('<local-command-stderr>') ||
            raw.startsWith('[Request interrupted')) continue;
        out.push({
          uuid: entry.uuid,
          kind: 'user',
          color: '#a6e3a1',
          preview: raw.slice(0, 220),
          full: raw,
          truncated: raw.length > 220,
          ts: entry.timestamp || null,
          tools: [],
        });
      } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        const summary = entry.summary || findPairedCompactSummary(idx) || 'Conversation compacted';
        out.push({
          uuid: entry.uuid,
          kind: 'compact',
          color: '#cba6f7',
          preview: summary,
          full: summary,
          truncated: false,
          ts: entry.timestamp || null,
          tools: [],
        });
      }
      // Assistant blocks are intentionally NOT emitted — desktop Timeline
      // shows only user-authored entries (prompts, compact boundaries, notes).
      // Assistant replies are visible in the chat scroll itself; doubling them
      // in the drawer would just duplicate the whole conversation.
    }
    return out;
  } catch (e) {
    console.error('[parseTimelineEntries] Error:', e.message);
    return [];
  }
}

function getSessionMaterialization(sessionId, cwd) {
  if (!sessionId) {
    return {
      success: true,
      sessionId: null,
      materialized: false,
      conversationMaterialized: false,
      timelineCount: 0,
      fileFound: false,
      reason: 'no-session-id',
    };
  }
  try {
    const found = findSessionFile(sessionId, cwd);
    if (!found) {
      return {
        success: true,
        sessionId,
        materialized: false,
        conversationMaterialized: false,
        timelineCount: 0,
        fileFound: false,
        reason: 'session-file-not-found',
      };
    }
    const entries = parseTimelineEntries(found.filePath);
    const timelineCount = Array.isArray(entries) ? entries.length : 0;
    let fileSize = 0;
    try { fileSize = fs.statSync(found.filePath).size; } catch {}
    return {
      success: true,
      sessionId,
      materialized: timelineCount > 0,
      conversationMaterialized: timelineCount > 0,
      timelineCount,
      fileFound: true,
      filePath: found.filePath,
      fileSize,
      reason: timelineCount > 0 ? 'timeline-has-entries' : 'timeline-empty',
    };
  } catch (e) {
    return {
      success: false,
      sessionId,
      materialized: false,
      conversationMaterialized: false,
      timelineCount: 0,
      fileFound: false,
      error: e.message,
      reason: 'materialization-check-failed',
    };
  }
}

// Repair dangling parentUuid in a JSONL file by rewriting each broken reference
// to the uuid of the physical predecessor line. Same logic as the offline
// /tmp/jsonl-repair.sh script — but runs in-process before `claude --resume`
// so the upstream Claude CLI sees a clean chain and renders full history.
//
// Why this is needed: Claude CLI never writes its slash-command assistant
// replies or attachment virtual parents to JSONL — the next user-prompt
// references a phantom uuid. CLI backtrace stops at the orphan, history
// truncates to "everything AFTER the orphan", matching exactly what user
// sees in `claude --resume` and history panel before this fix.
async function repairJsonlChainBreaks(sessionId, cwd) {
  try {
    const found = findSessionFile(sessionId, cwd);
    if (!found) return { repaired: 0, reason: 'file-not-found' };
    const filePath = found.filePath;
    // Async read: this function runs in main and is called in bulk by the boot
    // sweep — readFileSync on a 100MB session blocked the loop for the whole
    // I/O too, on top of the unavoidable CPU-bound parse below.
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const lines = raw.split('\n');

    // PARSE every line with real JSON.parse (not regex on raw text).
    // Regex-based scan caught false uuids inside last-prompt content strings
    // (which themselves contain JSON literals like '"uuid":"..."') and made
    // dangling-detection silently miss real cases — hence the user seeing
    // "history truncated" even after a fake-OK audit. Real JSON parsing
    // ignores content fields and only looks at top-level keys.
    const parsed = []; // null or { uuid, parentUuid, raw_d }
    const uuids = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line[0] !== '{') { parsed.push(null); continue; }
      try {
        const d = JSON.parse(line);
        parsed.push(d);
        if (d.uuid) uuids.add(d.uuid);
      } catch {
        parsed.push(null);
      }
    }

    // Find dangling parentUuid refs and compute predecessor for each.
    const fixes = []; // { lineIdx, oldParent, newParent }
    for (let i = 0; i < parsed.length; i++) {
      const d = parsed[i];
      if (!d || !d.parentUuid || uuids.has(d.parentUuid)) continue;
      // search predecessor up to 10 lines back
      let predUuid = null;
      for (let k = i - 1; k >= Math.max(0, i - 10); k--) {
        if (parsed[k] && parsed[k].uuid) { predUuid = parsed[k].uuid; break; }
      }
      if (!predUuid) continue;
      fixes.push({ lineIdx: i, oldParent: d.parentUuid, newParent: predUuid });
    }

    if (fixes.length === 0) return { repaired: 0, reason: 'no-dangling' };

    // Rewrite each affected line by re-serializing the parsed object — avoids
    // ambiguity from string-level replacement (which can hit content fields).
    const newLines = lines.slice();
    for (const { lineIdx, oldParent, newParent } of fixes) {
      const d = parsed[lineIdx];
      const _classified = _classifyOrphanFlavor(d);
      // Verbose forensic log for post-mortem grep: same fields as
      // [JsonlChainDiag:ChainBreak] so a single grep "JsonlChainDiag" or
      // "JsonlAutoRepair" across multi-day logs surfaces every repair with
      // flavor + content sample + timestamps. Without this, boot-time sweep
      // silently heals breaks and post-mortem loses all visibility.
      let contentSample = '';
      try {
        const c = d.message?.content;
        if (typeof c === 'string') contentSample = c.substring(0, 100).replace(/\n/g, ' ');
        else if (Array.isArray(c)) {
          const text = c.find(b => b.type === 'text')?.text;
          contentSample = (text || c.map(b => b.type).join('|')).substring(0, 100);
        }
      } catch {}
      d.parentUuid = newParent;
      newLines[lineIdx] = JSON.stringify(d);
      console.log('[JsonlAutoRepair] session=' + sessionId.substring(0, 8) +
        ' line=' + (lineIdx + 1) +
        ' orphanUuid=' + (d.uuid || '?').substring(0, 8) +
        ' orphanType=' + (d.type || '?') +
        ' flavor=' + _classified.flavor +
        ' orphanTimestamp=' + (d.timestamp || '?') +
        ' missingParent=' + oldParent.substring(0, 8) +
        ' newParent=' + newParent.substring(0, 8) +
        (contentSample ? ' content="' + contentSample + '"' : ''));
    }

    // Backup before write
    const backupPath = filePath + '.autorepair-' + Math.floor(Date.now() / 1000);
    fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8');
    console.log('[JsonlAutoRepair] session=' + sessionId.substring(0, 8) + ' repaired=' + fixes.length + ' backup=' + backupPath);
    // Invalidate cache so next read picks up changes
    _jsonlCache.delete(filePath);
    return { repaired: fixes.length, backupPath };
  } catch (e) {
    console.error('[JsonlAutoRepair] Error for session ' + sessionId + ':', e.message);
    return { repaired: 0, error: e.message };
  }
}

module.exports = { register, findSessionFile, loadJsonlRecords, resolveSessionChain, resolveLatestSessionInChain, parseTimelineUuids, parseTimelineEntries, getSessionMaterialization, deleteEffortEntries: _deleteEffortEntries, trimTrailingEffortEntries: _trimTrailingEffortEntries, trimTrailingStartupSlashEntriesFromFile: _trimTrailingStartupSlashEntriesFromFile, repairJsonlChainBreaks, _api };
