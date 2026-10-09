'use strict';

const UNKNOWN = Symbol('unknown-literal');
const MAX_SOURCE_CHARS = 512 * 1024;
let parse;

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
    const values = node.elements.map(item => literalValue(item, depth + 1));
    return values.includes(UNKNOWN) ? UNKNOWN : values;
  }
  if (node.type !== 'ObjectExpression') return UNKNOWN;
  const value = {};
  for (const property of node.properties) {
    if (property.type !== 'ObjectProperty' || property.computed || property.shorthand) return UNKNOWN;
    const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
    const item = literalValue(property.value, depth + 1);
    if (typeof key !== 'string' || key === '__proto__' || item === UNKNOWN) return UNKNOWN;
    Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return value;
}

// The old literal reader stays the fast path. Parse once, lazily, only for an
// unresolved String.raw argument; never execute the source or interpolate it.
function createCodexRawLiteralResolver(source) {
  let calls;
  function indexCalls() {
    calls = new Map();
    if (source.length > MAX_SOURCE_CHARS) return;
    try {
      parse ||= require('@babel/parser').parse;
      const program = parse(source, { sourceType: 'module', allowAwaitOutsideFunction: true }).program;
      for (const statement of program.body) {
        const expressions = statement.type === 'ExpressionStatement' ? [statement.expression]
          : statement.type === 'VariableDeclaration' ? statement.declarations.map(item => item.init) : [];
        for (const expression of expressions) {
          const call = awaitedToolCall(expression);
          if (call) calls.set(call.start, call.arguments[0]);
        }
      }
      const pending = [{ node: program }];
      let count = 0;
      while (pending.length) {
        if (++count > 30000) { calls.clear(); return; }
        const { node, parent, grandparent } = pending.pop();
        if (['AssignmentExpression', 'UpdateExpression', 'NewExpression'].includes(node.type)) { calls.clear(); return; }
        if (node.type === 'Identifier' && node.name === 'tools'
          && !(parent?.type === 'MemberExpression' && parent.object === node && !parent.computed
            && grandparent?.type === 'CallExpression' && grandparent.callee === parent)) { calls.clear(); return; }
        if (node.type === 'CallExpression') {
          const tool = node.callee.type === 'MemberExpression' && node.callee.object.name === 'tools' && !node.callee.computed;
          const output = node.callee.type === 'Identifier' && ['text', 'notify'].includes(node.callee.name);
          if (!tool && !output) { calls.clear(); return; }
        }
        if (node.type === 'Identifier' && ['String', 'globalThis', 'global', 'eval', 'Function'].includes(node.name)) {
          const intrinsicTag = node.name === 'String' && parent?.type === 'MemberExpression'
            && parent.object === node && !parent.computed && parent.property.name === 'raw'
            && grandparent?.type === 'TaggedTemplateExpression' && grandparent.tag === parent;
          if (!intrinsicTag) { calls.clear(); return; }
        }
        for (const child of Object.values(node)) {
          for (const item of Array.isArray(child) ? child : [child]) {
            if (item && typeof item.type === 'string') pending.push({ node: item, parent: node, grandparent: parent });
          }
        }
      }
    } catch { calls.clear(); }
  }
  return call => {
    if (!/\bString\s*\.\s*raw\s*`/.test(call.argumentsText || '')) return null;
    if (!calls) indexCalls();
    const value = literalValue(calls.get(call.start));
    return value === UNKNOWN ? null : value;
  };
}

module.exports = { createCodexRawLiteralResolver };
