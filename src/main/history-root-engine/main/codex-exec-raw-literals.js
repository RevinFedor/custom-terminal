'use strict';
const rootText = require('./history-paged-text');
const rootOps = require('./history-root-operations');
const { parseRootJsProgram, isRootJsStorageError, isRootJsSyntaxError } = require('./codex-root-js-parser');

const UNKNOWN = Symbol('unknown-literal');
const MAX_SOURCE_CHARS = 512 * 1024;

function awaitedToolCall(expression) {
  let node = expression;
  if (node?.type === 'CallExpression' && node.callee.type === 'Identifier'
    && ['text', 'notify'].includes(node.callee.name) && node.arguments.length === 1) node = node.arguments[0];
  if (node?.type !== 'AwaitExpression') return null;
  node = node.argument;
  return node?.type === 'CallExpression' && node.callee.type === 'MemberExpression'
    && !node.callee.computed && node.callee.object.name === 'tools' && node.arguments.length === 1 ? node : null;
}

function literalValue(node, depth = 0) {
  if (!node || depth > 24) return UNKNOWN;
  if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(node.type)) return node.value;
  if (node.type === 'NullLiteral') return null;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') {
    return -node.argument.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? UNKNOWN;
  if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'MemberExpression'
    && !node.tag.computed && node.tag.object.name === 'String' && node.tag.property.name === 'raw'
    && node.quasi.expressions.length === 0) return node.quasi.quasis[0].value.raw;
  if (node.type === 'ArrayExpression') {
    const values = rootOps.arrayFor(node);
    for (const child of node.elements) {
      const item = literalValue(child, depth + 1);
      if (item === UNKNOWN) return UNKNOWN;
      values.push(item);
    }
    return values;
  }
  if (node.type !== 'ObjectExpression') return UNKNOWN;
  const arena = rootOps.arenaOf(node);
  const value = arena ? arena.make('object') : {};
  for (const property of node.properties) {
    if (property.type !== 'ObjectProperty' || property.computed || property.shorthand) return UNKNOWN;
    const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
    const item = literalValue(property.value, depth + 1);
    if (!rootText.isText(key) || rootText.equal(key, '__proto__') || item === UNKNOWN) return UNKNOWN;
    if (arena) arena.set(arena.owner(value), key, item);
    else Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return value;
}

// The old literal reader stays the fast path. Parse once, lazily, only for an
// unresolved String.raw argument; never execute the source or interpolate it.
function createCodexRawLiteralResolver(source) {
  const arena = rootOps.arenaOf(source), ops = rootOps.operations(arena);
  const same = (a, b) => arena ? arena.same(a, b) : a === b;
  const own = value => arena ? arena.assign(value) : value;
  let calls;
  function indexCalls() {
    calls = arena ? arena.make('map') : new Map();
    if (source.length > MAX_SOURCE_CHARS) return;
    try {
      const program = parseRootJsProgram(source, 'exec-raw-literal-Babel-source');
      for (const statement of program.body) {
        const expressions = statement.type === 'ExpressionStatement' ? [statement.expression]
          : statement.type === 'VariableDeclaration' ? statement.declarations.map(item => item.init) : [];
        for (const expression of expressions) {
          const call = awaitedToolCall(expression);
          if (call) calls.set(call.start, call.arguments[0]);
        }
      }
      const pending = ops.array(); pending.push(own({ node: program }));
      let count = 0;
      while (pending.length) {
        if (++count > 30000) { calls.clear(); return; }
        const { node, parent, grandparent } = pending.pop();
        if (['AssignmentExpression', 'UpdateExpression', 'NewExpression'].includes(node.type)) { calls.clear(); return; }
        if (node.type === 'Identifier' && node.name === 'tools'
          && !(parent?.type === 'MemberExpression' && same(parent.object, node) && !parent.computed
            && grandparent?.type === 'CallExpression' && same(grandparent.callee, parent))) { calls.clear(); return; }
        if (node.type === 'CallExpression') {
          const tool = node.callee.type === 'MemberExpression' && node.callee.object.name === 'tools' && !node.callee.computed;
          const output = node.callee.type === 'Identifier' && ['text', 'notify'].includes(node.callee.name);
          if (!tool && !output) { calls.clear(); return; }
        }
        if (node.type === 'Identifier' && ['String', 'globalThis', 'global', 'eval', 'Function'].includes(node.name)) {
          const intrinsicTag = node.name === 'String' && parent?.type === 'MemberExpression'
            && same(parent.object, node) && !parent.computed && parent.property.name === 'raw'
            && grandparent?.type === 'TaggedTemplateExpression' && same(grandparent.tag, parent);
          if (!intrinsicTag) { calls.clear(); return; }
        }
        for (const [, child] of rootOps.entries(node)) {
          if (Array.isArray(child)) {
            for (const item of child) if (item && typeof item.type === 'string') pending.push(own({ node: item, parent: node, grandparent: parent }));
          } else if (child && typeof child.type === 'string') pending.push(own({ node: child, parent: node, grandparent: parent }));
        }
        if (arena) arena.metrics.maxJsAnalysisStackOnDisk = Math.max(arena.metrics.maxJsAnalysisStackOnDisk || 0, pending.length);
      }
    } catch (error) {
      if (arena && (isRootJsStorageError(error) || !isRootJsSyntaxError(error))) throw error;
      calls.clear();
    }
  }
  return call => {
    if (!rawMarker(call.argumentsText || '')) return null;
    if (!calls) indexCalls();
    const value = literalValue(calls.get(call.start));
    return value === UNKNOWN ? null : value;
  };
}

function rawMarker(value) {
  if (!rootText.isPagedText(value)) return /\bString\s*\.\s*raw\s*`/.test(value);
  const r = rootText.reader(value);
  for (let at = value.indexOf('String'); at >= 0; at = value.indexOf('String', at + 1)) {
    if (/[A-Za-z0-9_]/.test(r.at(at - 1) || '')) continue;
    let end = at + 6; while (/\s/.test(r.at(end) || '')) end++;
    if (r.at(end++) !== '.') continue;
    while (/\s/.test(r.at(end) || '')) end++;
    if (!value.startsWith('raw', end)) continue; end += 3;
    while (/\s/.test(r.at(end) || '')) end++;
    if (r.at(end) === '`') return true;
  }
  return false;
}
module.exports = { createCodexRawLiteralResolver };
