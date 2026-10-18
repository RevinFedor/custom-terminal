'use strict';

const fs = require('node:fs');

// true retains a scalar; an object schema selects keys; ITEMS selects array
// elements. PRESENCE keeps the JSON type/nullness, DEFER keeps an exact byte
// range marked by RANGE. { [DEFER]: selectedSchema } also keeps a small
// object/array projection in .value without retaining scalar bodies.
// No application-specific schema lives in this module.
const DEFER = Symbol('read selected value later');
const PRESENCE = Symbol('preserve JSON type, omit body');
const ITEMS = Symbol('array items');
const RANGE = Symbol('physical JSON value');

const CHUNK_BYTES = 1024 * 1024;
const TOKEN_FRAGMENT_BATCH = 1024;
// readJsonlRange trims ECMAScript whitespace at the physical line boundary
// before JSON.parse. Inside a JSON value only JSON whitespace is legal.
const EDGE_WHITESPACE = ['\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003',
  '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028',
  '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'].map(text => Buffer.from(text).toString('latin1'));
const yieldToMain = () => new Promise(resolve => setImmediate(resolve));
const range = (from, to) => ({ [RANGE]: true, from, to });

// A validating JSON projection, not a search for a type substring. Key order,
// escapes, duplicate keys and malformed ignored values have JSON.parse
// semantics. Large ignored strings/subtrees never become JS strings/objects.
// Latin1 here is a byte-preserving transport; retained JSON strings are decoded
// from UTF-8 only when complete, including a code point split across reads.
function createJsonProjection(rootSchema) {
  const stack = [];
  let maxTokenBytes = 0, maxChunkBytes = 0, maxBufferedBytes = 0, chunkBytes = 0;
  let token = null, value, complete = false, invalid = false, seen = false, edgePrefix = '';
  const locatedProjection = schema => schema && typeof schema === 'object' && Object.hasOwn(schema, DEFER);
  const keyLimitFor = schema => {
    let limit = 1024;
    if (schema && typeof schema === 'object') for (const key of Object.keys(schema)) {
      limit = Math.max(limit, key.length * 6 + 2); // longest legal escaped encoding
    }
    return limit;
  };
  const wanted = () => {
    const parent = stack.at(-1);
    if (!parent) return rootSchema;
    if (parent.kind === 'array') return parent.schema?.[ITEMS];
    return parent.key !== null && Object.hasOwn(parent.schema || {}, parent.key)
      ? parent.schema[parent.key] : undefined;
  };
  const put = (result, schema, from, to) => {
    if (schema === DEFER) result = range(from, to);
    else if (locatedProjection(schema)) result = { ...range(from, to), value: result };
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
    // Only keys longer than every possible selected key can be discarded.
    // This is not a size limit on selected names or searchable values.
    if (token.key && token.length > token.keyLimit) {
      token.capture = false; token.parts = []; token.blocks = undefined; return;
    }
    token.parts.push(text);
    // Escapes and tiny writes can produce one fragment per encoded byte. Keep
    // the complete token in blocks, without retaining millions of references
    // or repeatedly joining its entire growing prefix.
    if (token.parts.length >= TOKEN_FRAGMENT_BATCH) {
      (token.blocks ||= []).push(token.parts.join(''));
      token.parts = [];
    }
    maxTokenBytes = Math.max(maxTokenBytes, token.length);
    maxBufferedBytes = Math.max(maxBufferedBytes, chunkBytes + token.length);
  };
  const tokenText = () => {
    if (!token.blocks) return token.parts.join('');
    if (token.parts.length) token.blocks.push(token.parts.join(''));
    return token.blocks.join('');
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
        ? JSON.parse(Buffer.from(tokenText(), 'latin1').toString('utf8')) : null;
      parent.state = 'colon';
    } else {
      let result;
      if (token.kind === 'atom') {
        if (token.word ? token.wordIndex !== token.word.length
          : !['zero', 'int', 'fraction', 'exponent'].includes(token.numberState)) throw Error('atom');
        if (token.capture) result = JSON.parse(tokenText());
        else if (token.schema === PRESENCE) result = token.word === 'null' ? null : 0;
      } else if (token.capture) {
        result = JSON.parse(Buffer.from(tokenText(), 'latin1').toString('utf8'));
      } else if (token.schema === PRESENCE) result = '';
      put(result, token.schema, token.from, end);
    }
    token = null;
  };
  const write = (source, offset) => {
    chunkBytes = source.length;
    maxChunkBytes = Math.max(maxChunkBytes, chunkBytes);
    maxBufferedBytes = Math.max(maxBufferedBytes, chunkBytes + (token?.capture ? token.length : 0));
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
            keyLimit: parent?.keyLimit,
            capture: key || (schema !== undefined && schema !== DEFER && schema !== PRESENCE && !locatedProjection(schema)),
            parts: [], length: 0 };
          append('"'); index++; continue;
        }
        if (char === '{' || char === '[') {
          const selected = locatedProjection(schema) ? schema[DEFER] : schema;
          stack.push({ kind: char === '{' ? 'object' : 'array', state: 'empty',
            originalSchema: schema, schema: typeof selected === 'object' ? selected : undefined,
            keyLimit: char === '{' ? keyLimitFor(schema) : 0,
            from: offset + index, value: schema === undefined || schema === DEFER
              ? undefined : char === '{' ? {} : [] });
          index++; continue;
        }
        if (!'-0123456789tfn'.includes(char)) throw Error('value');
        token = { kind: 'atom', schema, from: offset + index,
          capture: schema !== undefined && schema !== DEFER && schema !== PRESENCE && !locatedProjection(schema), parts: [], length: 0 };
      }
    } catch { invalid = true; }
  };
  const finish = end => {
    try { if (token?.kind === 'atom') finishToken(end); } catch { invalid = true; }
    return { value, valid: !invalid && complete && !token && !edgePrefix && stack.length === 0,
      empty: !invalid && !seen && !token && !edgePrefix };
  };
  // Encoded token + current write input only; excludes selected decoded values
  // and container/depth state. Ignored bodies never contribute token storage.
  return { write, finish, stats: () => ({ maxTokenBytes, maxChunkBytes, maxBufferedBytes }) };
}

async function readProjectedValue(filePath, loc, schema, options = {}) {
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

// startByte/endByte are inclusive, like readJsonlRange. Visitor locators have
// an exclusive toByte and include the physical newline and edge whitespace.
// Only newline-committed records are visited; a partial tail is a byte locator,
// never a retained giant buffer. Resume keeps its existing small-line fast path.
async function readProjectedJsonlRange(filePath, startByte, endByte, options = {}) {
  let offset = startByte, start = startByte, line = options.startLine ?? options.lineCount ?? 0;
  let parsed = 0, errors = 0, parser = createJsonProjection(options.schema);
  const metrics = options.metrics;
  if (metrics) Object.assign(metrics, { bytes: 0, chunks: 0, maxRecordBytes: 0,
    maxTokenBytes: 0, maxChunkBytes: 0, maxBufferedBytes: 0 });
  const measure = (readChunkBytes = 0) => {
    if (!metrics) return;
    const stats = parser.stats();
    for (const key of ['maxTokenBytes', 'maxChunkBytes', 'maxBufferedBytes']) {
      metrics[key] = Math.max(metrics[key], stats[key]);
    }
    // The filesystem buffer can contain many lines, each a smaller write.
    metrics.maxChunkBytes = Math.max(metrics.maxChunkBytes, readChunkBytes);
    metrics.maxBufferedBytes = Math.max(metrics.maxBufferedBytes, readChunkBytes + stats.maxTokenBytes);
  };
  if (endByte >= startByte) for await (const bytes of fs.createReadStream(filePath, {
    start: startByte, end: endByte,
    highWaterMark: Math.max(1, Number(options.highWaterMark) || CHUNK_BYTES),
  })) {
    options.onChunk?.(bytes, offset);
    options.onBytes?.(bytes.length);
    let cursor = 0;
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(10, cursor);
      const end = newline < 0 ? bytes.length : newline;
      parser.write(bytes.subarray(cursor, end).toString('latin1'), offset + cursor);
      measure(bytes.length);
      if (newline < 0) break;
      const result = parser.finish(offset + end);
      if (metrics) metrics.maxRecordBytes = Math.max(metrics.maxRecordBytes, offset + end - start);
      if (result.valid) {
        parsed++;
        const record = { ...result.value, __line: line, __byteOffset: start };
        await options.onRecord?.(record, { filePath, fromByte: start, toByte: offset + end + 1, startLine: line });
      } else if (!result.empty) errors++;
      line++; start = offset + end + 1; cursor = end + 1;
      parser = createJsonProjection(options.schema);
    }
    offset += bytes.length;
    if (metrics) { metrics.bytes += bytes.length; metrics.chunks++; }
    options.onProgress?.(offset - startByte);
    await yieldToMain();
  }
  measure();
  return { parsed, errors, lineCount: line, partialBytes: offset - start,
    partial: { filePath, fromByte: start, toByte: offset, startLine: line } };
}

module.exports = { DEFER, PRESENCE, ITEMS, RANGE, createJsonProjection,
  readProjectedValue, readProjectedJsonlRange };

