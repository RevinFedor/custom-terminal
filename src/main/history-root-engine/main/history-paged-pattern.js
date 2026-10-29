'use strict';

// Fixed production patterns over UTF-16 pages. The compiled program depends
// only on a small, developer-owned pattern. Captures are ranges; backtracking
// frames are paged. This is not a general public RegExp replacement.
const text = require('./history-paged-text');
const cache = new Map();
const unsupported = () => { throw new TypeError('history_pattern_unsupported'); };

function compile(expression) {
  const key = expression.source + '/' + expression.flags;
  if (cache.has(key)) return cache.get(key);
  if (/[uyd]/.test(expression.flags) || expression.source.length > 512) unsupported();
  const source = expression.source, flags = expression.flags.replace(/[gm]/g, '');
  let at = 0, groups = 0;
  const character = spelling => ({ op: 'char', test: new RegExp('^(?:' + spelling + ')$', flags) });
  function sequence() {
    const nodes = [];
    while (at < source.length && source[at] !== ')' && source[at] !== '|') {
      let node, c = source[at++];
      if (c === '(') {
        let kind = 'capture', id;
        if (source[at] === '?') {
          at++; const prefix = source[at++];
          kind = prefix === ':' ? 'group' : prefix === '=' ? 'look' : prefix === '!' ? 'negative' : unsupported();
        }
        if (kind === 'capture') id = ++groups;
        const body = alternatives();
        if (source[at++] !== ')') unsupported();
        node = { op: kind, body, id };
      } else if (c === '[') {
        const start = at - 1;
        if (source[at] === '^') at++;
        while (at < source.length && source[at] !== ']') { if (source[at++] === '\\') at++; }
        if (source[at++] !== ']') unsupported();
        node = character(source.slice(start, at));
      } else if (c === '\\') {
        c = source[at++];
        if (c === 'b' || c === 'B') node = { op: 'boundary', negative: c === 'B' };
        else if (/[1-9]/.test(c)) node = { op: 'backref', id: Number(c) };
        else {
          let spelling = '\\' + c;
          if (c === 'u' || c === 'x') { const count = c === 'u' ? 4 : 2; spelling += source.slice(at, at + count); at += count; }
          node = character(spelling);
        }
      } else if (c === '^' || c === '$') node = { op: c === '^' ? 'start' : 'end' };
      else if (c === '*' || c === '+' || c === '?' || c === '{') unsupported();
      else node = character(c === '.' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      let min, max;
      if (source[at] === '*' || source[at] === '+' || source[at] === '?') {
        c = source[at++]; min = c === '+' ? 1 : 0; max = c === '?' ? 1 : Infinity;
      } else if (source[at] === '{') {
        const bound = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(at));
        if (!bound) unsupported();
        at += bound[0].length; min = Number(bound[1]);
        max = bound[2] === undefined ? min : bound[2] === '' ? Infinity : Number(bound[2]);
        if (min > 32 || max !== Infinity && max > 32) unsupported();
      }
      if (min !== undefined) {
        const lazy = source[at] === '?'; if (lazy) at++;
        node = { op: 'repeat', body: node, min, max, lazy };
      }
      nodes.push(node);
    }
    return nodes;
  }
  function alternatives() {
    const branches = [sequence()];
    while (source[at] === '|') { at++; branches.push(sequence()); }
    return branches.length === 1 ? branches[0] : [{ op: 'alternative', branches }];
  }
  const tree = alternatives();
  if (at !== source.length || groups > 8) unsupported();
  const code = [];
  const emit = op => (code.push(op), code.length - 1);
  function width(nodes) {
    return nodes.reduce((sum, node) => sum + (node.op === 'char' ? 1
      : node.op === 'capture' || node.op === 'group' ? width(node.body)
      : node.op === 'alternative' ? Math.min(...node.branches.map(width))
      : node.op === 'repeat' ? node.min * width([node.body]) : 0), 0);
  }
  function captureSlots(node, slots = []) {
    if (node.op === 'capture') slots.push(node.id * 2, node.id * 2 + 1);
    if (Array.isArray(node.body)) for (const child of node.body) captureSlots(child, slots);
    else if (node.body) captureSlots(node.body, slots);
    if (node.branches) for (const branch of node.branches) for (const child of branch) captureSlots(child, slots);
    return slots;
  }
  function generate(nodes) {
    for (const node of nodes) {
      if (node.op === 'alternative') {
        const exits = [];
        node.branches.forEach((branch, i) => {
          if (i === node.branches.length - 1) { generate(branch); return; }
          const split = emit({ op: 'split', a: code.length + 1, b: null });
          generate(branch); exits.push(emit({ op: 'jump', to: null })); code[split].b = code.length;
        });
        for (const exit of exits) code[exit].to = code.length;
      } else if (node.op === 'capture') {
        emit({ op: 'save', slot: node.id * 2 }); generate(node.body); emit({ op: 'save', slot: node.id * 2 + 1 });
      } else if (node.op === 'group') generate(node.body);
      else if (node.op === 'look' || node.op === 'negative') {
        const look = emit({ op: node.op, body: code.length + 1, next: null });
        generate(node.body); emit({ op: 'done' }); code[look].next = code.length;
      } else if (node.op === 'repeat' && node.body.op === 'char') emit({ ...node, max: node.max === Infinity ? null : node.max });
      else if (node.op === 'repeat') {
        // An empty repeating atom needs ECMAScript's additional progress
        // machinery. None of the fixed production patterns uses one.
        if (node.max === Infinity && width([node.body]) === 0) unsupported();
        const slots = captureSlots(node.body);
        const iteration = () => { if (slots.length) emit({ op: 'clear', slots }); generate([node.body]); };
        for (let i = 0; i < node.min; i++) iteration();
        if (node.max === Infinity) {
          const split = emit({ op: 'split', a: null, b: null }), body = code.length;
          iteration(); emit({ op: 'jump', to: split });
          code[split].a = node.lazy ? code.length : body; code[split].b = node.lazy ? body : code.length;
        } else for (let i = node.min; i < node.max; i++) {
          const split = emit({ op: 'split', a: null, b: null }), body = code.length;
          iteration(); code[split].a = node.lazy ? code.length : body; code[split].b = node.lazy ? body : code.length;
        }
      } else emit(node);
    }
  }
  generate(tree); emit({ op: 'done' });
  const program = { code, groups, multiline: expression.multiline, ignoreCase: expression.ignoreCase };
  while (cache.size >= 32) cache.delete(cache.keys().next().value);
  cache.set(key, program); return program;
}

function execute(program, value, from = 0) {
  const arena = text.info(value)?.arena;
  if (!arena) throw new TypeError('history_pattern_paged_text_required');
  const scan = text.reader(value), { code } = program, metrics = arena.metrics;
  const isWord = char => /[A-Za-z0-9_]/.test(char || '');
  const isLine = char => /[\n\r\u2028\u2029]/.test(char || '');
  const canonical = c => { const upper = c.toUpperCase(); return upper.length !== 1 || c.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128 ? c : upper; };
  let steps = 0, writes = 0;
  function run(startPc, start, captures) {
    let pc = startPc, pos = start, caps = captures, top = null;
    const push = frame => {
      let parent = 0;
      if (top) { parent = arena.store.put(top, [top.parent]); writes++; }
      top = { ...frame, parent };
    };
    const retry = () => {
      if (!top) return false;
      const frame = top;
      pc = frame.pc; pos = frame.pos; caps = frame.caps.slice();
      if (frame.range && frame.pos !== frame.end) frame.pos += frame.delta;
      else top = frame.parent ? arena.store.json(frame.parent) : null;
      return true;
    };
    for (;;) {
      steps++;
      const op = code[pc], char = scan.at(pos);
      let valid = true;
      if (op.op === 'done') return { pos, caps };
      if (op.op === 'char') { valid = char !== undefined && op.test.test(char); if (valid) { pos++; pc++; } }
      else if (op.op === 'save') { caps[op.slot] = pos; pc++; }
      else if (op.op === 'clear') { for (const slot of op.slots) caps[slot] = -1; pc++; }
      else if (op.op === 'jump') pc = op.to;
      else if (op.op === 'split') { push({ pc: op.b, pos, caps: caps.slice() }); pc = op.a; }
      else if (op.op === 'start') { valid = pos === 0 || program.multiline && isLine(scan.at(pos - 1)); if (valid) pc++; }
      else if (op.op === 'end') { valid = pos === value.length || program.multiline && isLine(char); if (valid) pc++; }
      else if (op.op === 'boundary') { valid = (isWord(scan.at(pos - 1)) !== isWord(char)) !== op.negative; if (valid) pc++; }
      else if (op.op === 'backref') {
        const begin = caps[op.id * 2], end = caps[op.id * 2 + 1];
        if (begin >= 0 && end >= begin) for (let i = begin; i < end; i++) {
          const a = scan.at(i), b = scan.at(pos + i - begin);
          if (b === undefined || (program.ignoreCase ? canonical(a) !== canonical(b) : a !== b)) { valid = false; break; }
        }
        if (valid) { if (begin >= 0 && end >= begin) pos += end - begin; pc++; }
      } else if (op.op === 'repeat') {
        const begin = pos, maximum = op.max === null ? value.length : Math.min(value.length, pos + op.max);
        while (pos < maximum && op.body.test.test(scan.at(pos))) pos++;
        const least = begin + op.min, most = pos;
        valid = most >= least;
        if (valid) {
          pc++;
          if (most > least) push({ pc, pos: op.lazy ? least + 1 : most - 1, end: op.lazy ? most : least,
            delta: op.lazy ? 1 : -1, range: true, caps: caps.slice() });
          pos = op.lazy ? least : most;
        }
      } else if (op.op === 'look' || op.op === 'negative') {
        const result = run(op.body, pos, caps.slice());
        valid = !!result === (op.op === 'look');
        if (valid) { if (result) caps = result.caps; pc = op.next; }
      } else unsupported();
      if (!valid && !retry()) return null;
    }
  }
  try {
    for (let start = Math.max(0, from); start <= value.length; start++) {
      const caps = new Array((program.groups + 1) * 2).fill(-1); caps[0] = start;
      const found = run(0, start, caps);
      if (found) {
        found.caps[1] = found.pos;
        const result = [];
        for (let i = 0; i <= program.groups; i++) {
          const begin = found.caps[i * 2], end = found.caps[i * 2 + 1];
          result.push(begin < 0 || end < begin ? undefined : value.slice(begin, end));
        }
        result.index = start; result.end = found.pos; return result;
      }
      if (code[0].op === 'start' && !program.multiline) break;
    }
    return null;
  } finally {
    metrics.patternSteps = (metrics.patternSteps || 0) + steps;
    metrics.patternFrameWrites = (metrics.patternFrameWrites || 0) + writes;
    metrics.maxPatternCaptureSlots = Math.max(metrics.maxPatternCaptureSlots || 0, (program.groups + 1) * 2);
  }
}

function exec(expression, value, from = 0) {
  if (!text.isPagedText(value)) {
    const re = new RegExp(expression.source, expression.flags.replace(/g/g, '') + 'g');
    re.lastIndex = from; const result = re.exec(value);
    if (result) result.end = re.lastIndex;
    return result;
  }
  return execute(compile(expression), value, from);
}
function test(expression, value) { return !!exec(expression, value); }
function* matches(expression, value) {
  let at = 0, match;
  while (at <= value.length && (match = exec(expression, value, at))) {
    yield match; at = match.end > match.index ? match.end : match.end + 1;
  }
}
module.exports = { exec, test, matches, compile };
