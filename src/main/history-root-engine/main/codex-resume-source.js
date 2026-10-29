'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { createCodexSourceSettingsReducer } = require('./codex-source-settings');
const { readCodexResumeLaunchWindow } = require('./codex-resume-launch-source');
const { codexUserMessageAuditText, codexUserMessagePresentationText,
  isCodexEnvironmentContextUserText, isCodexProjectInstructionsUserText } = require('./codex-prompt-audit');

const { DEFER, PRESENCE, ITEMS, RANGE, readProjectedValue,
  createJsonProjection: createProjection } = require('./codex-json-projection');
const SETTINGS = { model: true, effort: true, reasoning_effort: true, model_reasoning_effort: true };
const USER_FIELDS = ['message', 'text', 'content', 'images', 'local_images'];
const SCHEMA = {
  type: true, timestamp: true, time: true, created_at: true,
  payload: {
    type: true, name: true, role: true, started_at: true, ...SETTINGS, thread_settings: SETTINGS,
    id: true, session_id: true, cwd: true, timestamp: true,
    forked_from_id: true, forked_from_ordinal_exclusive: true,
    history_mode: true,
    // The Resume launch planner tests only nullness. This compact metadata
    // is never a Fork lineage or empty-read proof: those keep their own exact
    // source readers in main, including the separate standalone-empty check.
    history_base: PRESENCE,
    num_turns: true, turns: true,
    ...Object.fromEntries(USER_FIELDS.map(key => [key, DEFER])),
  },
};
const CONTENT = { [ITEMS]: {
  type: true, text: true, value: true, message: true,
  // Audit needs to know that an image URL is a string, never its base64.
  image_url: PRESENCE, imageUrl: PRESENCE,
} };
const CHUNK_BYTES = 1024 * 1024;
const SMALL_SOURCE_BYTES = 256 * 1024;
const yieldToMain = () => new Promise(resolve => setImmediate(resolve));
const statKey = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

// Preserve the existing Resume schema and public parser entry point.
function createJsonProjection(rootSchema = SCHEMA) {
  return createProjection(rootSchema);
}

async function hydrateUser(filePath, record, options) {
  const payload = record.payload;
  for (const key of USER_FIELDS) {
    const loc = payload?.[key];
    if (!loc?.[RANGE]) continue;
    const schema = key === 'content' ? CONTENT
      : key === 'images' || key === 'local_images' ? { [ITEMS]: true } : true;
    payload[key] = await readProjectedValue(filePath, loc, schema, options);
  }
}

async function scanResumeJsonl(filePath, size, onRecord, options = {}) {
  let offset = 0, start = 0, line = 0, parsed = 0, errors = 0;
  let parser = options.forceProjection ? createJsonProjection() : null;
  let pieces = [], lineBytes = 0, lastYield = performance.now();
  const feed = (bytes, at) => {
    lineBytes += bytes.length;
    if (parser) { parser.write(bytes.toString('latin1'), at); return; }
    pieces.push(bytes);
    if (lineBytes <= 32 * 1024) return;
    parser = createJsonProjection();
    let cursor = start;
    for (const piece of pieces) { parser.write(piece.toString('latin1'), cursor); cursor += piece.length; }
    pieces = [];
  };
  if (size > 0) for await (const bytes of fs.createReadStream(filePath, {
    start: 0, end: size - 1, highWaterMark: options.highWaterMark || CHUNK_BYTES,
  })) {
    options.onBytes?.(bytes.length);
    let cursor = 0;
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(10, cursor);
      const end = newline < 0 ? bytes.length : newline;
      feed(bytes.subarray(cursor, end), offset + cursor);
      if (newline < 0) break;
      let result;
      if (parser) result = parser.finish(offset + end);
      else {
        // Match readJsonlRange's bounded ordinary-line path. Keeping at most
        // 32 KiB avoids reopening a file for each small user text/image path,
        // and lets native JSON.parse handle the overwhelmingly common case.
        const text = Buffer.concat(pieces, lineBytes).toString('utf8').trim();
        try { result = text ? { value: JSON.parse(text), valid: true } : { empty: true }; }
        catch { result = { valid: false }; }
      }
      if (result.valid) {
        parsed++;
        const record = { ...result.value, __line: line, __byteOffset: start };
        await onRecord(record, { filePath, fromByte: start, toByte: offset + end + 1, startLine: line });
      } else if (!result.empty) errors++;
      line++; start = offset + end + 1;
      parser = options.forceProjection ? createJsonProjection() : null;
      pieces = []; lineBytes = 0; cursor = end + 1;
      if (line % 64 === 0 && performance.now() - lastYield >= 8) {
        await yieldToMain(); lastYield = performance.now();
      }
    }
    offset += bytes.length;
    // Bound main-thread work even when the next chunk is already buffered.
    await yieldToMain(); lastYield = performance.now();
  }
  return { parsed, errors, lineCount: line, partialBytes: offset - start };
}

function createCodexResumeSourceReader({ findSessionFile, readJsonlRange,
  createTimelineProjector, activity, maxViews = 24, log = console } = {}) {
  const views = new Map(), flights = new Map();
  const stats = { reads: 0, bytesRead: 0, cacheHits: 0 };

  async function scan(filePath, stat, sessionId, options, preparedRecords = null) {
    const settings = createCodexSourceSettingsReducer(sessionId);
    let timeline = createTimelineProjector(sessionId);
    let sourceMetadata = null, metadataSeen = false, userRecords = 0;
    const locators = new WeakMap(), texts = new Set();
    const onBytes = bytes => { stats.bytesRead += bytes; };
    const readOptions = { ...options, onBytes };
    const consume = async (record, loc) => {
      settings.feed(record);
      if (!metadataSeen && record.type === 'session_meta') {
        metadataSeen = true; sourceMetadata = record.payload || null;
      }
      const payload = record.payload;
      const user = record.type === 'event_msg' && payload?.type === 'user_message'
        || record.type === 'response_item' && payload?.type === 'message' && payload.role === 'user';
      if (user) {
        await hydrateUser(filePath, record, readOptions);
        const text = codexUserMessageAuditText(record);
        if (text !== null && !isCodexEnvironmentContextUserText(text)
          && !isCodexProjectInstructionsUserText(text)) userRecords++;
      }
      // Preserve meta/fork and compact-companion bookkeeping too. Only the
      // presentation bodies are omitted; the canonical reducer still owns all
      // service boundaries and rollback turn coordinates.
      if (record.type === 'response_item' && !user) return;
      const thinPayload = record.type === 'session_meta' ? {
        id: payload?.id, session_id: payload?.session_id, timestamp: payload?.timestamp,
        forked_from_id: payload?.forked_from_id,
      } : {
        type: payload?.type, name: payload?.name, started_at: payload?.started_at,
        model: payload?.model, effort: payload?.effort, num_turns: payload?.num_turns, turns: payload?.turns,
      };
      timeline.feed(user ? record : { ...record, payload: thinPayload });
      const state = timeline.exportState();
      if (user && state.currentUser?.sourceLine === record.__line) {
        locators.set(state.currentUser, loc); texts.add(state.currentUser);
      }
      if (payload?.type === 'thread_rolled_back' && state.currentUser && !texts.has(state.currentUser)) {
        // Rollback can make an old prompt the canonical alias again. Reload
        // only that carrier using the shared byte-range reader for small rows;
        // the projected reader also handles a giant image-bearing carrier.
        const old = locators.get(state.currentUser);
        if (old) {
          let restored;
          if (old.preparedRecord) restored = old.preparedRecord;
          else if (old.toByte - old.fromByte <= SMALL_SOURCE_BYTES) {
            const read = await readJsonlRange(filePath, old.fromByte, old.toByte - 1, { lineCount: old.startLine });
            onBytes(old.toByte - old.fromByte); restored = read.records[0];
          } else {
            restored = await readProjectedValue(filePath, { from: old.fromByte, to: old.toByte }, SCHEMA, readOptions);
            await hydrateUser(filePath, restored, readOptions);
          }
          state.currentUser.content = codexUserMessagePresentationText(restored);
          state.currentTurnCanonicalUserText = state.currentUser.isGoalContinuation ? null : state.currentUser.content;
          texts.add(state.currentUser);
          timeline = createTimelineProjector(sessionId, state);
        }
      }
      const needed = new Set([state.currentUser, state.currentTurnCanonicalUserEntry,
        ...state.pendingResponseUsers.map(item => item.entry)]);
      for (const entry of texts) if (!needed.has(entry)) { delete entry.content; texts.delete(entry); }
    };
    // The shared incremental reader remains the small-file fast path. It
    // streams callbacks and never builds a raw records cache for Resume.
    let scanResult;
    if (preparedRecords) {
      // The exclusive COW writer already produced exact physical records.
      // Reuse THIS reducer; no second settings/materialization codec or file
      // scan, and never retain the raw array in the small Resume views cache.
      let lastYield = performance.now();
      for (let index = 0; index < preparedRecords.length; index++) {
        const record = preparedRecords[index];
        await consume(record, { preparedRecord: record, filePath,
          fromByte: record.__byteOffset, toByte: preparedRecords[index + 1]?.__byteOffset ?? stat.size,
          startLine: record.__line });
        if (index % 64 === 63 && performance.now() - lastYield >= 8) {
          await yieldToMain();lastYield = performance.now();
        }
      }
      scanResult = { parsed: preparedRecords.length, errors: 0, partialBytes: 0 };
    } else if (stat.size <= SMALL_SOURCE_BYTES && !options.forceProjection) {
      const result = await readJsonlRange(filePath, 0, stat.size - 1, {
        collectRecords: false, onRecord: consume, onChunk: bytes => onBytes(bytes.length),
        ...(options.highWaterMark ? { highWaterMark: options.highWaterMark } : {}),
      });
      scanResult = { ...result, partialBytes: result.leftoverBuffer.length };
    } else scanResult = await scanResumeJsonl(filePath, stat.size, consume, readOptions);
    const userTurns = timeline.peekEntries().filter(entry => entry.type === 'user').length;
    const exactSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
    const sourceMaterialization = !sourceMetadata?.id || (exactSessionId && sourceMetadata.id !== exactSessionId)
      ? { materialized: false, metadataOnly: false, userRecords: 0, reason: 'session-meta-missing-or-mismatched' }
      : { materialized: userTurns > 0, metadataOnly: userTurns === 0, userRecords, userTurns,
        reason: userTurns > 0 ? 'user-history-present' : 'session-meta-only' };
    return { sourceSettingsProof: settings.finalize(), sourceMetadata, sourceMaterialization,
      parsedRecords: scanResult.parsed, parseErrors: scanResult.errors, partialBytes: scanResult.partialBytes };
  }

  async function loadInner(sessionId, cwd, options) {
    const key = JSON.stringify([sessionId, cwd || '', options.sessionsDir || '']);
    const started = performance.now(), bytesBefore = stats.bytesRead;
    let finish = null;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const found = await findSessionFile(sessionId, cwd, options);
        if (!found?.filePath) { views.delete(key); return { success: false, error: 'Codex session file not found' }; }
        const filePath = found.filePath, stat = await fs.promises.stat(filePath);
        const version = filePath + ':' + statKey(stat), cached = views.get(key);
        if (cached?.version === version) {
          stats.cacheHits++; views.delete(key); views.set(key, cached);
          return structuredClone({ ...cached.result, mode: 'unchanged' });
        }
        // A growth-only test cannot distinguish append from rewrite+growth.
        // Keep only exact-version results; any changed file is streamed anew.
        views.delete(key);
        // A retry can see a formerly small file grow past the activity limit;
        // its first no-op lease must not suppress that newly known heavy work.
        finish?.();
        finish = activity?.begin({ kind: 'resume', sessionId, tabId: options.tabId, bytes: stat.size }) || (() => {});
        stats.reads++;
        const proof = await scan(filePath, stat, sessionId, options);
        const latest = await findSessionFile(sessionId, cwd, options);
        const after = await fs.promises.stat(filePath);
        if (statKey(stat) !== statKey(after) || latest?.filePath !== filePath) continue;
        const result = { success: true, filePath, ...proof, mode: 'rebuild', sourceSnapshot: {
          filePath, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
          fileIdentity: stat.dev + ':' + stat.ino, sessionId, linkKind: 'end',
        } };
        views.set(key, { version, result });
        while (views.size > maxViews) views.delete(views.keys().next().value);
        log.log?.('[CodexResumeSource] session=' + String(sessionId).slice(0, 8)
          + ' bytes=' + (stats.bytesRead - bytesBefore) + ' records=' + proof.parsedRecords
          + ' ms=' + (performance.now() - started).toFixed(1));
        return structuredClone(result);
      }
      return { success: false, error: 'codex-resume-source-changed-during-read' };
    } catch (error) {
      views.delete(key);
      return { success: false, error: error?.message || String(error) };
    } finally { finish?.(); }
  }
  async function loadForLaunch(sessionId, cwd, options) {
    const key = JSON.stringify([sessionId, cwd || '', options.sessionsDir || '']);
    const started = performance.now();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const found = await findSessionFile(sessionId, cwd, options);
        if (!found?.filePath) return await loadInner(sessionId, cwd, options);
        const filePath = found.filePath, stat = await fs.promises.stat(filePath);
        if (views.get(key)?.version === filePath + ':' + statKey(stat) || stat.size <= SMALL_SOURCE_BYTES) {
          return await loadInner(sessionId, cwd, options);
        }
        views.delete(key);
        stats.reads++;
        const proof = await readCodexResumeLaunchWindow(filePath, stat, sessionId, {
          createTimelineProjector, onBytes: bytes => { stats.bytesRead += bytes; },
        });
        const latest = await findSessionFile(sessionId, cwd, options);
        if (statKey(await fs.promises.stat(filePath)) !== statKey(stat) || latest?.filePath !== filePath
          || proof.reason === 'source-changed') continue;
        if (!proof.matched) {
          log.log?.('[CodexResumeSource] launch-fallback session=' + String(sessionId).slice(0, 8)
            + ' reason=' + proof.reason + ' windowBytes=' + proof.bytesRead);
          return await loadInner(sessionId, cwd, options);
        }
        const { matched, bytesRead, ...fields } = proof;
        log.log?.('[CodexResumeSource] launch-window session=' + String(sessionId).slice(0, 8)
          + ' bytes=' + bytesRead + ' sourceBytes=' + stat.size
          + ' counts=unknown ms=' + (performance.now() - started).toFixed(1));
        return { success: true, filePath, ...fields, mode: 'launch-window', sourceSnapshot: {
          filePath, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
          fileIdentity: stat.dev + ':' + stat.ino, sessionId, linkKind: 'end',
        } };
      }
      return { success: false, error: 'codex-resume-source-changed-during-read' };
    } catch (error) {
      views.delete(key);
      return { success: false, error: error?.message || String(error) };
    }
  }
  function load(sessionId, cwd, options = {}) {
    const key = JSON.stringify([sessionId, cwd || '', options.sessionsDir || '']);
    const previous = flights.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => options.purpose === 'launch'
      ? loadForLaunch(sessionId, cwd, options) : loadInner(sessionId, cwd, options));
    flights.set(key, next);
    next.finally(() => { if (flights.get(key) === next) flights.delete(key); }).catch(() => {});
    return next;
  }
  // Internal cache admission, called only with the committed exclusive writer's
  // records/stat lease. It grants neither writer identity nor input readiness.
  async function seedPrepared(sessionId, cwd, { filePath, stat, records } = {}) {
    const key = JSON.stringify([sessionId, cwd || '', '']);
    const previous = flights.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (!filePath || !stat || !Array.isArray(records) || !records.length
        || records[0]?.type !== 'session_meta' || records[0]?.payload?.id !== sessionId
        || cwd && records[0].payload.cwd !== cwd
        || records[0].__byteOffset !== 0
        || records.some((record, index) => record.__line !== index || !Number.isSafeInteger(record.__byteOffset)
          || record.__byteOffset < 0 || record.__byteOffset >= stat.size
          || index > 0 && record.__byteOffset <= records[index - 1].__byteOffset)) return false;
      const current = await findSessionFile(sessionId, cwd, {});
      if (current?.filePath !== filePath || statKey(await fs.promises.stat(filePath)) !== statKey(stat)) return false;
      const proof = await scan(filePath, stat, sessionId, {}, records);
      const after = await fs.promises.stat(filePath);
      if (statKey(after) !== statKey(stat) || (await findSessionFile(sessionId, cwd, {}))?.filePath !== filePath) return false;
      const result = { success: true, filePath, ...proof, mode: 'prepared', sourceSnapshot: {
        filePath, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
        fileIdentity: stat.dev + ':' + stat.ino, sessionId, linkKind: 'end',
      } };
      views.delete(key);views.set(key, { version: filePath + ':' + statKey(stat), result });
      while (views.size > maxViews) views.delete(views.keys().next().value);
      log.log?.('[CodexResumeSource] prepared session=' + String(sessionId).slice(0, 8)
        + ' records=' + records.length + ' readBytes=0');
      return true;
    });
    flights.set(key, next);
    next.finally(() => { if (flights.get(key) === next) flights.delete(key); }).catch(() => {});
    return next;
  }
  return { load, seedPrepared, stats: () => ({ ...stats, views: views.size }), clear: () => views.clear() };
}

module.exports = { createCodexResumeSourceReader, createJsonProjection };
