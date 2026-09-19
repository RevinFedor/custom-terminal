'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { createCodexSourceSettingsReducer } = require('./codex-source-settings');
const { codexUserMessageAuditText, codexUserMessagePresentationText,
  isCodexEnvironmentContextUserText, isCodexProjectInstructionsUserText } = require('./codex-prompt-audit');

const DEFER = Symbol('read only if this is a user carrier');
const PRESENCE = Symbol('preserve JSON type, omit body');
const ITEMS = Symbol('array items');
const RANGE = Symbol('physical JSON value');
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
// readJsonlRange trims ECMAScript whitespace at the physical line boundary
// before JSON.parse. Inside a JSON value only JSON whitespace is legal.
const EDGE_WHITESPACE = ['\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003',
  '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028',
  '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'].map(text => Buffer.from(text).toString('latin1'));
const yieldToMain = () => new Promise(resolve => setImmediate(resolve));
const statKey = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const range = (from, to) => ({ [RANGE]: true, from, to });

// A validating JSON projection, not a search for a type substring. Key order,
// escapes, duplicate keys and malformed ignored values have JSON.parse
// semantics. Large ignored strings/subtrees never become JS strings/objects.
// Latin1 here is a byte-preserving transport; retained JSON strings are decoded
// from UTF-8 only when complete, including a code point split across reads.
function createJsonProjection(rootSchema = SCHEMA) {
  const stack = [];
  let token = null, value, complete = false, invalid = false, seen = false, edgePrefix = '';
  const wanted = () => {
    const parent = stack.at(-1);
    if (!parent) return rootSchema;
    if (parent.kind === 'array') return parent.schema?.[ITEMS];
    return parent.key !== null && Object.hasOwn(parent.schema || {}, parent.key)
      ? parent.schema[parent.key] : undefined;
  };
  const put = (result, schema, from, to) => {
    if (schema === DEFER) result = range(from, to);
    const parent = stack.at(-1);
    if (!parent) { value = result; complete = true; return; }
    if (schema !== undefined) {
      if (parent.kind === 'array') parent.value.push(result);
      else Object.defineProperty(parent.value, parent.key, {
        value: result, enumerable: true, configurable: true, writable: true,
      });
    }
    parent.state = 'comma';
  };
  const append = text => {
    if (!token.capture) return;
    token.length += text.length;
    // No selected schema key can have an encoding this long. Unknown keys
    // must not make an ignored giant object consume giant memory either.
    if (token.key && token.length > 1024) { token.capture = false; token.parts = []; return; }
    token.parts.push(text);
  };
  const atomPiece = text => {
    // Validate discarded numbers/literals without buffering them. A legal
    // number can itself be hundreds of MB (JSON.parse accepts Infinity).
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (token.word) {
        if (token.word[token.wordIndex++] !== char) throw Error('literal');
        index++; continue;
      }
      const state = token.numberState || 'start';
      if (state === 'start' && 'tfn'.includes(char)) {
        token.word = char === 't' ? 'true' : char === 'f' ? 'false' : 'null';
        token.wordIndex = 0; continue;
      }
      if (['int', 'fraction', 'exponent'].includes(state) && char >= '0' && char <= '9') {
        const digits = /[0-9]+/y;
        digits.lastIndex = index;
        digits.exec(text); index = digits.lastIndex; continue;
      }
      if ((state === 'start' || state === 'sign') && char >= '0' && char <= '9') {
        token.numberState = char === '0' ? 'zero' : 'int';
      } else if (state === 'start' && char === '-') token.numberState = 'sign';
      else if ((state === 'zero' || state === 'int') && char === '.') token.numberState = 'dot';
      else if (state === 'dot' && char >= '0' && char <= '9') token.numberState = 'fraction';
      else if (['zero', 'int', 'fraction'].includes(state) && /[eE]/.test(char)) token.numberState = 'e';
      else if (state === 'e' && (char === '+' || char === '-')) token.numberState = 'exponent-sign';
      else if ((state === 'e' || state === 'exponent-sign') && char >= '0' && char <= '9') token.numberState = 'exponent';
      else throw Error('number');
      index++;
    }
    append(text);
  };
  const finishToken = end => {
    if (token.key) {
      const parent = stack.at(-1);
      parent.key = token.capture
        ? JSON.parse(Buffer.from(token.parts.join(''), 'latin1').toString('utf8')) : null;
      parent.state = 'colon';
    } else {
      let result;
      if (token.kind === 'atom') {
        if (token.word ? token.wordIndex !== token.word.length
          : !['zero', 'int', 'fraction', 'exponent'].includes(token.numberState)) throw Error('atom');
        if (token.capture) result = JSON.parse(token.parts.join(''));
        else if (token.schema === PRESENCE) result = token.word === 'null' ? null : 0;
      } else if (token.capture) {
        result = JSON.parse(Buffer.from(token.parts.join(''), 'latin1').toString('utf8'));
      } else if (token.schema === PRESENCE) result = '';
      put(result, token.schema, token.from, end);
    }
    token = null;
  };
  const write = (source, offset) => {
    if (invalid) return;
    try {
      let index = 0;
      while (index < source.length) {
        if (token?.kind === 'string') {
          const start = index;
          if (token.unicode) {
            if (!/[0-9a-fA-F]/.test(source[index])) throw Error('unicode');
            token.unicode--; index++; append(source.slice(start, index)); continue;
          }
          if (token.escape) {
            const char = source[index++];
            if (!'"\\/bfnrtu'.includes(char)) throw Error('escape');
            token.escape = false;
            if (char === 'u') token.unicode = 4;
            append(char); continue;
          }
          const special = /["\\\x00-\x1f]/g;
          special.lastIndex = index;
          const next = special.exec(source);
          index = next ? next.index + 1 : source.length;
          append(source.slice(start, index));
          if (!next) continue;
          const char = next[0];
          if (char === '"') finishToken(offset + index);
          else if (char === '\\') token.escape = true;
          else throw Error('control');
          continue;
        }
        if (token?.kind === 'atom') {
          const end = source.slice(index).search(/[\s,\[\]{}:"\x80-\xff]/);
          const stop = end < 0 ? source.length : index + end;
          atomPiece(source.slice(index, stop));
          index = stop;
          if (end < 0) continue;
          finishToken(offset + index);
          continue;
        }
        const char = source[index];
        if (!stack.length && (edgePrefix || char.charCodeAt(0) >= 128)) {
          edgePrefix += char; index++;
          if (EDGE_WHITESPACE.includes(edgePrefix)) edgePrefix = '';
          else if (!EDGE_WHITESPACE.some(text => text.startsWith(edgePrefix))) throw Error('edge whitespace');
          continue;
        }
        if (!stack.length && (char === '\v' || char === '\f')) { index++; continue; }
        if (char === ' ' || char === '\t' || char === '\r' || char === '\n') { index++; continue; }
        seen = true;
        const parent = stack.at(-1);
        if (!parent && complete) throw Error('trailing');
        if (parent?.state === 'colon') {
          if (char !== ':') throw Error('colon');
          parent.state = 'value'; index++; continue;
        }
        if (parent?.state === 'comma') {
          if (char === ',') { parent.state = parent.kind === 'object' ? 'key' : 'value'; index++; continue; }
          if (char !== (parent.kind === 'object' ? '}' : ']')) throw Error('comma');
        }
        if (char === '}' || char === ']') {
          if (!parent || char !== (parent.kind === 'object' ? '}' : ']')
            || !['empty', 'comma'].includes(parent.state)) throw Error('end');
          stack.pop(); index++;
          put(parent.value, parent.originalSchema, parent.from, offset + index);
          continue;
        }
        const key = parent?.kind === 'object' && ['empty', 'key'].includes(parent.state);
        if (key && char !== '"') throw Error('key');
        const schema = key ? true : wanted();
        if (char === '"') {
          token = { kind: 'string', key, schema, from: offset + index,
            capture: key || (schema !== undefined && schema !== DEFER && schema !== PRESENCE),
            parts: [], length: 0 };
          append('"'); index++; continue;
        }
        if (char === '{' || char === '[') {
          stack.push({ kind: char === '{' ? 'object' : 'array', state: 'empty',
            originalSchema: schema, schema: typeof schema === 'object' ? schema : undefined,
            from: offset + index, value: schema === undefined || schema === DEFER
              ? undefined : char === '{' ? {} : [] });
          index++; continue;
        }
        if (!'-0123456789tfn'.includes(char)) throw Error('value');
        token = { kind: 'atom', schema, from: offset + index,
          capture: schema !== undefined && schema !== DEFER && schema !== PRESENCE, parts: [], length: 0 };
      }
    } catch { invalid = true; }
  };
  const finish = end => {
    try { if (token?.kind === 'atom') finishToken(end); } catch { invalid = true; }
    return { value, valid: !invalid && complete && !token && !edgePrefix && stack.length === 0,
      empty: !invalid && !seen && !token && !edgePrefix };
  };
  return { write, finish };
}

async function readProjectedValue(filePath, loc, schema, options) {
  const parser = createJsonProjection(schema);
  let offset = loc.from;
  for await (const bytes of fs.createReadStream(filePath, {
    start: loc.from, end: loc.to - 1, highWaterMark: options.highWaterMark || CHUNK_BYTES,
  })) {
    parser.write(bytes.toString('latin1'), offset);
    offset += bytes.length;
    options.onBytes?.(bytes.length);
    await yieldToMain();
  }
  const result = parser.finish(offset);
  if (!result.valid) throw Error('codex-resume-source-changed');
  return result.value;
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

  async function scan(filePath, stat, sessionId, options) {
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
          if (old.toByte - old.fromByte <= SMALL_SOURCE_BYTES) {
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
    if (stat.size <= SMALL_SOURCE_BYTES && !options.forceProjection) {
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
  function load(sessionId, cwd, options = {}) {
    const key = JSON.stringify([sessionId, cwd || '', options.sessionsDir || '']);
    const previous = flights.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => loadInner(sessionId, cwd, options));
    flights.set(key, next);
    next.finally(() => { if (flights.get(key) === next) flights.delete(key); }).catch(() => {});
    return next;
  }
  return { load, stats: () => ({ ...stats, views: views.size }), clear: () => views.clear() };
}

module.exports = { createCodexResumeSourceReader, createJsonProjection };
