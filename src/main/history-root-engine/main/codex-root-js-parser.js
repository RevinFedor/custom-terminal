'use strict';

// The paged grammar creates nodes/continuations before native AST allocation.
// Its explicitly unsupported productions retain the measured v10 compatibility
// path below. This is still INCOMPLETE for general admitted JavaScript.
// A preserving lexical island in front of the EXISTING Babel grammar. Long
// comment/string/template leaves never enter Babel. Source coordinates and
// decoded leaves are restored into the arena, and the analysis sees paged AST
// owners. General JavaScript that cannot fit this bounded island still uses
// the measured original compatibility parser. That remaining source/native-AST
// boundary is OPEN; this module must not set producerBounded to true.
const { parse } = require('@babel/parser'); // bootstrap, never lazy in a read
const text = require('./history-paged-text');
const { accumulator } = require('./codex-root-js-text');
const { parsePagedJsProgram } = require('./codex-root-js-grammar');
const { PagedJsFallback, PagedJsSyntaxError } = require('./codex-root-js-lexer');
const { probe } = require('./codex-root-js-probe');
const OPTIONS = Object.freeze({ sourceType: 'module', allowAwaitOutsideFunction: true });
const ISLAND_CHARS = 1024;

// A failed backing operation is not a JavaScript syntax/eligibility result.
// Inspect only the fixed error code, never Babel's lazy message/stack/detail.
// Consumers apply this rule only to rooted input; native DTO behavior stays
// unchanged. Other historical parse/analysis rejections retain UNKNOWN/null.
function isRootJsStorageError(error) {
  const code = error?.code;
  return typeof code === 'string' && (/^(?:history_|HISTORY_|SQLITE_)/.test(code)
    || ['ENOSPC','EIO','EROFS','EMFILE','ENFILE','ENOMEM','EBADF','ECANCELED','ABORT_ERR'].includes(code));
}
function isRootJsSyntaxError(error) {
  // Only parser syntax failures carry the existing UNKNOWN/null meaning.
  // Other exceptions (including programming/integrity errors without a code)
  // must reach the transaction boundary with their original identity.
  return error instanceof PagedJsSyntaxError
    || error instanceof SyntaxError && error.code === 'BABEL_PARSER_SYNTAX_ERROR';
}

function literal(source, start, r) {
  const quote = r.at(start), template = quote === '`';
  const cooked = accumulator(source), raw = accumulator(source);
  let at = start + 1, valid = true;
  const hex = c => c && /^[0-9a-f]$/i.test(c);
  while (at < source.length) {
    let c = r.at(at++);
    if (c === quote) return { start, end: at, quote,
      cooked: valid ? cooked.finish() : null, raw: raw.finish() };
    if (template && c === '$' && r.at(at) === '{') return null; // original grammar fallback, never UNKNOWN
    if (c === '\r') {
      if (!template) return null;
      if (r.at(at) === '\n') at++;
      raw.write('\n'); cooked.write('\n'); continue;
    }
    if (c === '\n' && !template) return null;
    raw.write(c);
    if (c !== '\\') { cooked.write(c); continue; }
    if (at >= source.length) return null;
    c = r.at(at++);
    if (c === '\r') { if (r.at(at) === '\n') at++; raw.write('\n'); continue; }
    raw.write(c);
    if (c === '\n' || c === '\u2028' || c === '\u2029') continue;
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', v: '\v', f: '\f' };
    if (Object.hasOwn(simple, c)) { cooked.write(simple[c]); continue; }
    if (c === 'x' || c === 'u') {
      let point = false, digits = c === 'x' ? 2 : 4, n = 0, count = 0;
      if (c === 'u' && r.at(at) === '{') { raw.write(r.at(at++)); point = true; digits = Infinity; }
      while (count < digits && hex(r.at(at))) {
        const h = r.at(at++); raw.write(h); count++;
        n = Math.min(0x110000, n * 16 + parseInt(h, 16));
      }
      let ok = point ? count > 0 && r.at(at) === '}' && n <= 0x10ffff : count === digits;
      if (point && r.at(at) === '}') raw.write(r.at(at++));
      if (!ok) { if (!template) return null; valid = false; }
      else cooked.write(String.fromCodePoint(n));
      continue;
    }
    if (c >= '0' && c <= '9') {
      if (c === '0' && !(r.at(at) >= '0' && r.at(at) <= '9')) cooked.write('\0');
      else { if (!template) return null; valid = false; }
      continue;
    }
    cooked.write(c);
  }
  return null;
}

function lowerLeaves(source, arena) {
  const offsets = arena.make('array'), leaves = arena.make('map'), r = text.reader(source);
  let lowered = '', at = 0;
  const emit = (piece, start, end) => {
    if (lowered.length + piece.length > ISLAND_CHARS) return false;
    const base = lowered.length;
    for (let i = 0; i < piece.length; i++) offsets[base + i] = Math.min(end, start + i);
    offsets[base + piece.length] = end;
    lowered += piece; return true;
  };
  while (at < source.length) {
    const start = at, c = r.at(at);
    if (c === '"' || c === "'" || c === '`') {
      const leaf = literal(source, at, r);
      if (!leaf) return null;
      at = leaf.end;
      if (at - start <= text.SMALL_CHARS) { if (!emit(text.small(source.slice(start, at)), start, at)) return null; continue; }
      const pos = lowered.length;
      const replacement = c === '`' ? leaf.cooked === null ? '`\\8`' : '`x`' : c + c;
      if (!emit(replacement, start, at)) return null;
      const row = arena.assign({ start, end: at, quote: c, cooked: leaf.cooked, raw: leaf.raw });
      leaves.set(pos, row);
      if (c === '`') {
        // TemplateElement is the interior range, not the tagged expression.
        offsets[pos + 1] = start + 1;
        offsets[pos + replacement.length - 1] = at - 1;
        leaves.set(pos + 1, row);
      }
      continue;
    }
    if (c === '/') {
      if (r.at(at + 1) !== '/' && r.at(at + 1) !== '*') return null;
      const block = r.at(at + 1) === '*';
      at += 2;
      if (block) { const end = source.indexOf('*/', at); if (end < 0) return null; at = end + 2; }
      else while (at < source.length && !/[\n\r\u2028\u2029]/u.test(r.at(at))) at++;
      if (at - start <= text.SMALL_CHARS) { if (!emit(text.small(source.slice(start, at)), start, at)) return null; continue; }
      const pos = lowered.length;
      let newline = false;
      if (block) for (const part of text.chunks(source, start + 2, at - 2)) if (/[\n\r\u2028\u2029]/u.test(part)) { newline = true; break; }
      if (!emit(block ? newline ? '/*\nx*/' : '/*x*/' : '//x', start, at)) return null;
      leaves.set(pos, arena.assign({ start, end: at, comment: true,
        value: source.slice(start + 2, block ? at - 2 : at) }));
      continue;
    }
    if (!emit(c, at, at + 1)) return null;
    at++;
  }
  offsets[lowered.length] = source.length;
  arena.metrics.maxJsIslandSourceChars = Math.max(arena.metrics.maxJsIslandSourceChars || 0, lowered.length);
  return { source: lowered, offsets, leaves };
}

// Node identity is independent of the arena's three-handle convenience cache.
// The original native AST of a bounded island is measured explicitly. General
// compatibility parses retain their real width/depth maxima too; they are not
// reclassified as bounded just because the resulting analysis is on pages.
function nativeFieldsNext(value, ordinal) {
  if (Array.isArray(value)) {
    while (ordinal < value.length && !(ordinal in value)) ordinal++;
    return ordinal < value.length ? { key: String(ordinal), next: ordinal + 1 } : null;
  }
  let index = 0;
  for (const key in value) if (Object.hasOwn(value, key)) {
    if (index++ === ordinal) return { key, next: index };
  }
  return null;
}
function measureNativeAst(program, arena) {
  const SEEN = Symbol('owned-ast-audit'), PARENT = Symbol('owned-ast-audit-parent'), NEXT = Symbol('owned-ast-audit-next');
  let value = program, depth = 0, objects = 0, nodes = 0;
  const enter = (item, parent) => {
    item[SEEN] = true; item[PARENT] = parent; item[NEXT] = 0; objects++;
    if (typeof item.type === 'string') nodes++;
    if (Array.isArray(item)) arena.metrics.maxJsNativeAstArray = Math.max(arena.metrics.maxJsNativeAstArray || 0, item.length);
  };
  enter(value, null);
  while (value) {
    arena.metrics.maxJsAstDepth = Math.max(arena.metrics.maxJsAstDepth || 0, depth);
    const next = nativeFieldsNext(value, value[NEXT]);
    if (!next) { value = value[PARENT]; depth--; continue; }
    value[NEXT] = next.next; const child = value[next.key];
    if (typeof child === 'string') arena.metrics.maxJsNativeAstLeafChars = Math.max(arena.metrics.maxJsNativeAstLeafChars || 0, child.length);
    if (child && typeof child === 'object' && !child[SEEN]) { enter(child, value); value = child; depth++; }
  }
  arena.metrics.maxJsNativeAstObjects = Math.max(arena.metrics.maxJsNativeAstObjects || 0, objects);
  arena.metrics.maxJsNativeAstNodes = Math.max(arena.metrics.maxJsNativeAstNodes || 0, nodes);
  // This audits the actual reachable native post-parse graph, including loc/
  // extra/comment aliases. It is not a claim about Babel's transient allocator.
}
function ownAst(program, arena, lowered) {
  measureNativeAst(program, arena);
  // Thread our privately owned Babel nodes while copying them. No recursion,
  // native traversal stack or native identity Map: logical identities live on
  // the nodes until this private native graph becomes unreachable. This does
  // NOT remove that native graph; the general parser boundary remains OPEN.
  const OWNER = Symbol('owned-ast-owner'), PARENT = Symbol('owned-ast-parent'), NEXT = Symbol('owned-ast-next');
  const enter = (item, parent) => {
    const out = arena.make(Array.isArray(item) ? 'array' : 'object');
    item[OWNER] = arena.owner(out); item[PARENT] = parent; item[NEXT] = 0;
    if (Array.isArray(item)) out.length = item.length;
    return out;
  };
  const result = enter(program, null); let value = program;
  while (value) {
    const next = nativeFieldsNext(value, value[NEXT]);
    if (!next) { value = value[PARENT]; continue; }
    value[NEXT] = next.next;
    const key = next.key;
    // These fields have no typed semantic children and do not participate in
    // either existing eligibility analysis. Lexical start/end are retained.
    if (key === 'loc' || key === 'extra') continue;
    let child = value[key];
    const leaf = lowered && Number.isInteger(value.start) ? lowered.leaves.get(value.start) : null;
    if (lowered && (key === 'start' || key === 'end') && Number.isInteger(child)) child = lowered.offsets[child];
    if (key === 'value' && leaf) {
      if (leaf.comment) child = leaf.value;
      else if (value.type === 'StringLiteral') child = leaf.cooked;
      else if (value.type === 'DirectiveLiteral') child = leaf.raw;
      else if (value.type === 'TemplateElement') child = arena.assign({ raw: leaf.raw, cooked: leaf.cooked });
    }
    if (!child || typeof child !== 'object' || text.isPagedText(child)
      || require('./history-projection-arena').projectionArenaOf(child)) arena.set(value[OWNER], key, child);
    else if (child[OWNER] !== undefined) arena.set(value[OWNER], key, arena.handle(child[OWNER]));
    else { arena.set(value[OWNER], key, enter(child, value)); value = child; }
  }
  return result;
}

function compatibilityProgram(source, arena) {
  try { return parse(source, OPTIONS).program; }
  catch (error) {
    // Babel 7.29.3 installs a LAZY message getter. Never call it (or read stack)
    // just to measure an error: that would manufacture a new source-sized
    // String that neither old consumer requests. Inspect existing data only.
    const message = Object.getOwnPropertyDescriptor(error, 'message');
    const chars = typeof message?.value === 'string' ? message.value.length : 0;
    const lazyMessage = typeof message?.get === 'function';
    const details = Object.getOwnPropertyDescriptor(error, 'details')?.value;
    let detailChars = 0, detailFields = 0, detailArrayLength = 0;
    if (details && typeof details === 'object') for (const key in details) if (Object.hasOwn(details, key)) {
      detailFields++;
      const value = Object.getOwnPropertyDescriptor(details, key)?.value;
      if (typeof value === 'string') detailChars = Math.max(detailChars, value.length);
      if (Array.isArray(value)) detailArrayLength = Math.max(detailArrayLength, value.length);
    }
    arena.metrics.jsNativeParseErrors = (arena.metrics.jsNativeParseErrors || 0) + 1;
    arena.metrics.maxJsNativeErrorChars = Math.max(arena.metrics.maxJsNativeErrorChars || 0, chars);
    arena.metrics.jsLazyNativeErrors = (arena.metrics.jsLazyNativeErrors || 0) + Number(lazyMessage);
    arena.metrics.maxJsNativeErrorDetailChars = Math.max(arena.metrics.maxJsNativeErrorDetailChars || 0, detailChars);
    arena.metrics.maxJsNativeErrorDetailFields = Math.max(arena.metrics.maxJsNativeErrorDetailFields || 0, detailFields);
    arena.metrics.maxJsNativeErrorDetailArray = Math.max(arena.metrics.maxJsNativeErrorDetailArray || 0, detailArrayLength);
    probe('compatibility-error', arena, { chars, lazyMessage, detailChars, detailFields, detailArrayLength });
    throw error;
  }
}

function parseRootJsProgram(source, reason) {
  const arena = text.info(source)?.arena;
  if (!arena) return parse(source, OPTIONS).program;
  arena.requireStep();
  arena.metrics.jsPagedParseAttempts = (arena.metrics.jsPagedParseAttempts || 0) + 1;
  probe('begin', arena, source);
  try {
    const program = parsePagedJsProgram(source, arena);
    arena.metrics.jsPagedParses = (arena.metrics.jsPagedParses || 0) + 1;
    probe('complete', arena, program);
    return program;
  } catch (error) {
    if (error instanceof PagedJsSyntaxError) {
      arena.metrics.jsPagedSyntaxErrors = (arena.metrics.jsPagedSyntaxErrors || 0) + 1;
      arena.metrics.maxJsSyntaxErrorMessageChars = Math.max(arena.metrics.maxJsSyntaxErrorMessageChars || 0, error.message.length);
      probe('reject', arena, { code: error.code, offset: error.offset, chars: error.message.length });
      throw error;
    }
    if (!(error instanceof PagedJsFallback)) throw error;
    arena.metrics.jsPagedFallbacks = (arena.metrics.jsPagedFallbacks || 0) + 1;
    arena.metrics.lastJsPagedFallback = error.code;
    probe('fallback', arena, { code: error.code, offset: error.offset });
  }
  const lowered = lowerLeaves(source, arena);
  if (lowered) {
    arena.metrics.jsIslandParses = (arena.metrics.jsIslandParses || 0) + 1;
    return ownAst(compatibilityProgram(lowered.source, arena), arena, lowered);
  }
  arena.metrics.jsCompatibilityParses = (arena.metrics.jsCompatibilityParses || 0) + 1;
  const plain = text.materialize(source, reason);
  arena.metrics.maxJsCompatibilitySourceChars = Math.max(arena.metrics.maxJsCompatibilitySourceChars || 0, plain.length);
  return ownAst(compatibilityProgram(plain, arena), arena, null);
}
module.exports = { parseRootJsProgram, isRootJsStorageError, isRootJsSyntaxError, ISLAND_CHARS };
