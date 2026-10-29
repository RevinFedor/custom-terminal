'use strict';

// Input is the existing immutable UTF-16 leaf, not a source-sized String.
// A single token register owns numbers, fixed punctuation and leaf references.
// Comments and every token-sized value are written to the existing arena.
// The Unicode predicates are pinned to Babel 7.29.3 (see the adjacent license).
const text = require('./history-paged-text');
const { accumulator } = require('./codex-root-js-text');
const { isIdentifierStart, isIdentifierChar } = require('./codex-root-js-identifiers');
const { probe } = require('./codex-root-js-probe');
const KEYWORDS = new Set(('break case catch continue debugger default do else finally for function if return switch throw try var const while with new this super class extends export import null true false in instanceof typeof void delete').split(' '));
const PUNCT = new Set(('>>>= === !== >>> **= &&= ||= ??= => == != <= >= ++ -- << >> && || ?? ** += -= *= /= %= &= |= ^= <<= >>= ?. ...').split(' '));
const REGEXP_FLAGS = 'dgimsuvy';
const isLine = c => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
const isSpace = c => c !== undefined && /\s/u.test(c);
const isDigit = c => c >= '0' && c <= '9';
const digit = c => c && /[0-9a-f]/i.test(c) ? parseInt(c, 16) : -1;

class PagedJsFallback extends Error {
  constructor(code, offset) {
    // No token, source excerpt, property name, or growing diagnostic graph.
    super('history_js_grammar_fallback'); this.code = code; this.offset = offset;
  }
}
class PagedJsSyntaxError extends SyntaxError {
  constructor(code, offset) {
    // Used only after a grammar proof of the same strict-module rejection.
    // The two existing consumers discard the parser error and keep their old
    // UNKNOWN/null policy. No identifier/source is interpolated into an Error.
    super('history_js_invalid_syntax'); this.code = code; this.offset = offset;
  }
}

class PagedJsLexer {
  constructor(source, arena, comment) {
    this.source = source; this.arena = arena; this.reader = text.reader(source);
    this.pos = 0; this.lastEnd = 0; this.token = null; this.comment = comment;
    this.commentStack = arena.make('array'); this.interpreter = null;
    this.metrics = arena.metrics;
  }
  at(at = this.pos) { return this.reader.at(at); }
  point(at = this.pos) {
    const first = this.at(at)?.charCodeAt(0);
    if (first >= 0xd800 && first <= 0xdbff) {
      const next = this.at(at + 1)?.charCodeAt(0);
      if (next >= 0xdc00 && next <= 0xdfff) return (first - 0xd800) * 1024 + next - 0xdc00 + 0x10000;
    }
    return first;
  }
  fallback(code, at = this.pos) {
    // A malformed lexeme or a missing required delimiter has no alternate
    // production in the pinned default grammar. Never retain token detail.
    throw new PagedJsSyntaxError(code, at);
  }
  // Raw bounded lookahead for contextual declarations. It does not construct
  // a token/comment or mutate lexer state, so comments still finish once.
  lookahead(at, inLine) {
    for (;;) {
      const c = this.at(at);
      if (isSpace(c)) { if (inLine && isLine(c)) return at; at++; continue; }
      if (c !== '/' || !['/', '*'].includes(this.at(at + 1))) return at;
      const begin = at, block = this.at(at + 1) === '*'; at += 2;
      if (!block) { while (at < this.source.length && !isLine(this.at(at))) at++; continue; }
      while (at < this.source.length && !(this.at(at) === '*' && this.at(at + 1) === '/')) {
        if (inLine && isLine(this.at(at))) return begin;
        at++;
      }
      if (at >= this.source.length) return begin;
      at += 2;
    }
  }
  operatorAt(at, word) {
    for (let i = 0; i < word.length; i++) if (this.at(at + i) !== word[i]) return false;
    return true;
  }
  wordAt(at, word) {
    return this.operatorAt(at, word) && !isIdentifierChar(this.point(at + word.length)) && this.at(at + word.length) !== '\\';
  }
  bindingAt(at) {
    return (isIdentifierStart(this.point(at)) || this.at(at) === '\\')
      && !this.wordAt(at, 'in') && !this.wordAt(at, 'instanceof');
  }
  slice(from, to) { return this.source.slice(from, to); }
  append(writer, from, to) {
    for (const part of text.chunks(this.source, from, to)) {
      for (let at = 0; at < part.length; at += 128) writer.write(part.slice(at, at + 128));
    }
  }
  space() {
    const start = this.pos; let comments = null, line = false;
    for (;;) {
      const c = this.at();
      if (isSpace(c)) { if (isLine(c)) line = true; this.pos++; continue; }
      const block = c === '/' && this.at(this.pos + 1) === '*';
      const single = c === '/' && this.at(this.pos + 1) === '/';
      const hashbang = this.pos === 0 && c === '#' && this.at(1) === '!';
      if (!block && !single && !hashbang) break;
      const begin = this.pos; this.pos += 2;
      if (block) {
        while (!(this.at() === '*' && this.at(this.pos + 1) === '/')) {
          if (this.pos >= this.source.length) this.fallback('unterminated-comment', begin);
          if (isLine(this.at())) line = true;
          this.pos++;
        }
        this.pos += 2;
      } else while (this.pos < this.source.length && !isLine(this.at())) this.pos++;
      const node = this.comment(hashbang ? 'InterpreterDirective' : block ? 'CommentBlock' : 'CommentLine',
        begin, this.pos, this.slice(begin + 2, this.pos - (block ? 2 : 0)));
      if (hashbang) this.interpreter = node;
      else { if (!comments) comments = this.arena.make('array'); comments.push(node); }
    }
    if (comments) this.commentStack.push(this.arena.record({ start, end: this.pos, comments,
      leadingNode: null, trailingNode: null, containingNode: null }));
    return line;
  }
  unicode() {
    // Called after a backslash. The raw source is retained independently.
    if (this.at() !== 'u') return null;
    this.pos++;
    const point = this.at() === '{'; if (point) this.pos++;
    let value = 0, count = 0;
    while (digit(this.at()) >= 0 && (point || count < 4)) {
      value = Math.min(0x110000, value * 16 + digit(this.at())); this.pos++; count++;
    }
    if (point) { if (this.at() !== '}' || !count) return null; this.pos++; }
    else if (count !== 4) return null;
    return value <= 0x10ffff ? value : null;
  }
  word(start) {
    let first = true, escaped = false, out = null, from = start;
    while (this.pos < this.source.length) {
      let point = this.point();
      if (this.at() === '\\') {
        if (!out) out = accumulator(this.source);
        this.append(out, from, this.pos); this.pos++; escaped = true;
        point = this.unicode();
        if (point === null || !(first ? isIdentifierStart(point) : isIdentifierChar(point))) this.fallback('identifier-escape', start);
        out.write(String.fromCodePoint(point)); from = this.pos;
      } else {
        if (!(first ? isIdentifierStart(point) : isIdentifierChar(point))) break;
        this.pos += point > 0xffff ? 2 : 1;
      }
      first = false;
    }
    if (first) this.fallback('identifier', start);
    if (out) this.append(out, from, this.pos);
    const value = out ? out.finish() : this.slice(start, this.pos);
    const keyword = typeof value === 'string' && KEYWORDS.has(value);
    // Escaped keywords are legal IdentifierNames in properties and module
    // specifiers. Identifier/binding contexts reject them after disambiguation.
    return { kind: keyword && !escaped ? value : 'name', value, start, end: this.pos, escaped };
  }
  number(start) {
    let radix = 10, fractional = false, separators = false, dot = false;
    if (this.at() === '0' && /[xXbBoO]/.test(this.at(this.pos + 1) || '')) {
      const type = this.at(this.pos + 1).toLowerCase(); radix = type === 'x' ? 16 : type === 'b' ? 2 : 8; this.pos += 2;
    }
    const digits = base => {
      let count = 0, previous = false;
      for (;;) {
        const c = this.at(), d = digit(c);
        if (d >= 0 && d < base) { count++; previous = true; this.pos++; }
        else if (c === '_') {
          if (!previous || digit(this.at(this.pos + 1)) < 0 || digit(this.at(this.pos + 1)) >= base) this.fallback('numeric-separator', start);
          separators = true; previous = false; this.pos++;
        } else break;
      }
      return count;
    };
    if (radix !== 10) { if (!digits(radix)) this.fallback('numeric-radix', start); }
    else {
      const begin = this.pos, integer = digits(10);
      if (integer > 1 && this.at(begin) === '0') this.fallback('strict-leading-zero', start);
      if (this.at() === '.') { dot = fractional = true; this.pos++; if (!digits(10) && !integer) this.fallback('decimal', start); }
      if (!integer && !dot) this.fallback('decimal', start);
      if (this.at() === 'e' || this.at() === 'E') {
        fractional = true; this.pos++;
        if (this.at() === '+' || this.at() === '-') this.pos++;
        if (!digits(10)) this.fallback('numeric-exponent', start);
      }
    }
    const end = this.pos, bigint = this.at() === 'n';
    if (bigint) { if (fractional) this.fallback('fractional-bigint', start); this.pos++; }
    if (isIdentifierStart(this.point()) || this.at() === '\\' || isDigit(this.at())) this.fallback('numeric-suffix', start);
    let value;
    if (separators) {
      const out = accumulator(this.source);
      for (let at = start; at < end; at++) if (this.at(at) !== '_') out.write(this.at(at));
      value = out.finish();
    } else value = this.slice(start, end);
    return { kind: bigint ? 'bigint' : 'number', value: bigint ? value : text.number(value), start, end: this.pos };
  }
  quoted(start, template) {
    // For a template chunk pos points just after ` or the interpolation's }.
    const quote = template ? '`' : this.at(start), begin = template ? this.pos : start + 1;
    this.pos = begin;
    let raw = null, cooked = null, rawFrom = begin, cookedFrom = begin, valid = true;
    const flushCooked = at => {
      if (!valid) return;
      if (!cooked) cooked = accumulator(this.source);
      this.append(cooked, cookedFrom, at);
    };
    while (this.pos < this.source.length) {
      let c = this.at();
      if (c === quote || template && c === '$' && this.at(this.pos + 1) === '{') {
        const end = this.pos, tail = c === quote;
        if (raw) this.append(raw, rawFrom, end);
        if (cooked && valid) this.append(cooked, cookedFrom, end);
        const rawValue = raw ? raw.finish() : this.slice(begin, end);
        const cookedValue = valid ? cooked ? cooked.finish() : rawValue : null;
        this.pos += tail ? 1 : 2;
        return { kind: template ? 'quasi' : 'string', value: cookedValue, raw: rawValue,
          start: template ? begin : start, end: template ? end : this.pos, tail, invalid: !valid };
      }
      if (!template && (c === '\r' || c === '\n')) this.fallback('string-newline', start);
      if (c === '\r') {
        if (!raw) raw = accumulator(this.source);
        this.append(raw, rawFrom, this.pos); raw.write('\n');
        flushCooked(this.pos); if (valid) cooked.write('\n');
        this.pos++; if (this.at() === '\n') this.pos++;
        rawFrom = cookedFrom = this.pos; continue;
      }
      if (c !== '\\') { this.pos++; continue; }
      flushCooked(this.pos); this.pos++;
      c = this.at();
      if (c === undefined) this.fallback('unterminated-literal', start);
      this.pos++;
      let value = c;
      if (isLine(c)) {
        value = '';
        if (c === '\r') {
          if (!raw) raw = accumulator(this.source);
          this.append(raw, rawFrom, this.pos - 1); raw.write('\n');
          if (this.at() === '\n') this.pos++;
          rawFrom = this.pos;
        }
      } else if (c === 'n') value = '\n';
      else if (c === 'r') value = '\r';
      else if (c === 't') value = '\t';
      else if (c === 'b') value = '\b';
      else if (c === 'v') value = '\v';
      else if (c === 'f') value = '\f';
      else if (c === 'x' || c === 'u') {
        let point = null;
        if (c === 'u') { this.pos--; point = this.unicode(); }
        else {
          let n = 0, count = 0;
          while (count < 2 && digit(this.at()) >= 0) { n = n * 16 + digit(this.at()); this.pos++; count++; }
          if (count === 2) point = n;
        }
        if (point === null) { if (!template) this.fallback('string-escape', start); valid = false; }
        else value = String.fromCodePoint(point);
      } else if (isDigit(c)) {
        if (c === '0' && !isDigit(this.at())) value = '\0';
        else { if (!template) this.fallback('strict-octal-escape', start); valid = false; }
      }
      if (valid) cooked.write(value);
      cookedFrom = this.pos;
    }
    this.fallback('unterminated-literal', start);
  }
  regexp(start) {
    this.token = null; this.pos = start + 1;
    let escaped = false, inClass = false;
    while (this.pos < this.source.length) {
      const c = this.at();
      if (isLine(c)) this.fallback('regexp-newline', start);
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '[') inClass = true;
      else if (c === ']' && inClass) inClass = false;
      else if (c === '/' && !inClass) break;
      this.pos++;
    }
    if (this.at() !== '/') this.fallback('unterminated-regexp', start);
    const pattern = this.slice(start + 1, this.pos++); let flags = '';
    while (this.pos < this.source.length) {
      const c = this.at();
      if (REGEXP_FLAGS.includes(c)) {
        if (flags.includes(c) || c === 'u' && flags.includes('v') || c === 'v' && flags.includes('u')) this.fallback('regexp-flags', start);
        flags += c; this.pos++;
      } else if (isIdentifierChar(this.point()) || c === '\\') this.fallback('regexp-flags', start);
      else break;
    }
    this.lastEnd = this.pos;
    return { pattern, flags, end: this.pos };
  }
  peek() {
    if (this.token) return this.token;
    const line = this.space(), start = this.pos, c = this.at(); let token;
    if (c === undefined) token = { kind: 'eof', start, end: start };
    else if (isIdentifierStart(this.point()) || c === '\\') token = this.word(start);
    else if (isDigit(c) || c === '.' && isDigit(this.at(start + 1))) token = this.number(start);
    else if (c === '"' || c === "'") token = this.quoted(start, false);
    else {
      let operator = c;
      for (let count = 4; count >= 2; count--) {
        let value = '';
        for (let i = 0; i < count && this.at(start + i) !== undefined; i++) value += this.at(start + i);
        if (PUNCT.has(value) && !(value === '?.' && isDigit(this.at(start + 2)))) { operator = value; break; }
      }
      if (!'{}()[];:,.?~!+-*/%<>=&|^`#'.includes(c)) this.fallback('unsupported-token', start);
      this.pos += operator.length; token = { kind: operator, start, end: this.pos };
    }
    token.line = line; this.token = token;
    this.metrics.jsTokensRead = (this.metrics.jsTokensRead || 0) + 1;
    let fields = 0;
    for (const key in token) {
      fields++;
      if (typeof token[key] === 'string') this.metrics.maxJsTokenNativeChars = Math.max(this.metrics.maxJsTokenNativeChars || 0, token[key].length);
    }
    this.metrics.maxJsTokenNativeFields = Math.max(this.metrics.maxJsTokenNativeFields || 0, fields);
    probe('token', this.arena, token);
    return token;
  }
  take() { const token = this.peek(); this.token = null; this.lastEnd = token.end; return token; }
  is(kind) { return this.peek().kind === kind; }
  eat(kind) { if (!this.is(kind)) return false; this.take(); return true; }
  expect(kind) { if (!this.is(kind)) this.fallback('expected-token', this.peek().start); return this.take(); }
}

module.exports = { PagedJsLexer, PagedJsFallback, PagedJsSyntaxError, KEYWORDS };
