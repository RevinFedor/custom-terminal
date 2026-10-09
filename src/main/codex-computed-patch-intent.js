'use strict';

const path = require('node:path');
const MAX_SOURCE_CHARS = 512 * 1024;
let parse;

function sourceFromCall(payload) {
  if (!['function_call', 'custom_tool_call'].includes(payload?.type)
    || payload.name !== 'exec' || (payload.namespace && payload.namespace !== 'functions')) return null;
  if (typeof payload.input === 'string') return payload.input;
  if (typeof payload.arguments !== 'string') return null;
  try { return JSON.parse(payload.arguments)?.input || null; } catch { return payload.arguments; }
}

function assignedNames(node, names = new Set()) {
  if (!node || typeof node !== 'object') return names;
  if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') names.add(node.left.name);
  if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression'
    && node.left.object.type === 'Identifier') names.add(node.left.object.name);
  if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') names.add(node.argument.name);
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'exit') names.add('exit');
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => assignedNames(child, names));
    else if (value && typeof value === 'object') assignedNames(value, names);
  }
  return names;
}

function stringValue(node, bindings, assigned, seen = new Set()) {
  if (!node || seen.size > 8) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'Identifier') {
    if (assigned.has(node.name) || seen.has(node.name)) return null;
    return stringValue(bindings.get(node.name), bindings, assigned, new Set([...seen, node.name]));
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = stringValue(node.left, bindings, assigned, seen);
    const right = stringValue(node.right, bindings, assigned, seen);
    return left !== null && right !== null ? left + right : null;
  }
  if (node.type === 'TemplateLiteral') {
    let value = '';
    for (let index = 0; index < node.quasis.length; index++) {
      if (node.quasis[index].value.cooked === null) return null;
      value += node.quasis[index].value.cooked;
      if (index < node.expressions.length) {
        const part = stringValue(node.expressions[index], bindings, assigned, seen);
        if (part === null) return null;
        value += part;
      }
    }
    return value;
  }
  return null;
}

// Resolve only a literal header. The computed patch body is never evaluated;
// the existing file-transition owner proves the physical write separately.
function patchHeader(node, bindings, assigned, seen = new Set()) {
  if (!node || seen.size > 8) return { text: '', computed: false };
  if (node.type === 'Identifier') {
    if (assigned.has(node.name) || seen.has(node.name)) return { text: '', computed: false };
    return patchHeader(bindings.get(node.name), bindings, assigned, new Set([...seen, node.name]));
  }
  if (node.type === 'TemplateLiteral') {
    let text = '';
    for (let index = 0; index < node.quasis.length; index++) {
      text += node.quasis[index].value.cooked ?? '';
      if (index < node.expressions.length) {
        const part = stringValue(node.expressions[index], bindings, assigned, seen);
        if (part === null) break;
        text += part;
      }
    }
    return { text, computed: node.expressions.length > 0 };
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = patchHeader(node.left, bindings, assigned, seen);
    const literal = stringValue(node.left, bindings, assigned, seen);
    if (literal === null) return { ...left, computed: true };
    const right = patchHeader(node.right, bindings, assigned, seen);
    return { text: literal + right.text, computed: left.computed || right.computed || stringValue(node.right, bindings, assigned, seen) === null };
  }
  return { text: stringValue(node, bindings, assigned, seen) || '', computed: false };
}

function awaitedPatch(expression) {
  let node = expression;
  if (node?.type === 'CallExpression' && node.callee.type === 'Identifier'
    && ['text', 'notify'].includes(node.callee.name) && node.arguments.length === 1) node = node.arguments[0];
  if (node?.type !== 'AwaitExpression') return null;
  node = node.argument;
  return node?.type === 'CallExpression' && node.callee.type === 'MemberExpression'
    && node.callee.computed === false && node.callee.object.type === 'Identifier' && node.callee.object.name === 'tools'
    && node.callee.property.name === 'apply_patch' && node.arguments.length === 1 ? node : null;
}

function computedPatchWriteIntents(payload) {
  const source = sourceFromCall(payload);
  if (typeof source !== 'string' || source.length > MAX_SOURCE_CHARS || !source.includes('apply_patch')) return [];
  let program;
  try {
    parse ||= require('@babel/parser').parse;
    program = parse(source, { sourceType: 'module', allowAwaitOutsideFunction: true }).program;
  } catch { return []; }
  try { return computedPatchIntentsForProgram(program); } catch { return []; }
}

function computedPatchIntentsForProgram(program) {
  const assigned = assignedNames(program);
  const bindings = new Map(), intents = [];
  if (['tools', 'text', 'notify', 'globalThis', 'exit'].some(name => assigned.has(name))) return [];
  if (program.body.some(statement => ['FunctionDeclaration', 'ClassDeclaration'].includes(statement.type)
    && ['tools', 'text', 'notify'].includes(statement.id?.name))) return [];
  if (program.body.some(statement => statement.type === 'VariableDeclaration'
    && statement.declarations.some(item => item.id.type !== 'Identifier' || ['tools', 'text', 'notify'].includes(item.id.name)))) return [];
  for (const statement of program.body) {
    const expressions = statement.type === 'ExpressionStatement' ? [statement.expression]
      : statement.type === 'VariableDeclaration' ? statement.declarations.map(item => item.init) : [];
    for (const expression of expressions) {
      const call = awaitedPatch(expression);
      if (!call) continue;
      const head = patchHeader(call.arguments[0], bindings, assigned);
      if (!head.computed) continue;
      const match = /^\s*\*\*\* Begin Patch\r?\n\*\*\* Update File: ([^\r\n]+)\r?\n/.exec(head.text);
      const target = match?.[1]?.trim();
      if (!target || !path.isAbsolute(target) || /[\x00-\x1f$]/.test(target) || head.text.includes('*** Move to:')) continue;
      intents.push({ filePath: path.normalize(target), index: call.start });
    }
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
      for (const item of statement.declarations) if (item.id.type === 'Identifier') bindings.set(item.id.name, item.init);
    }
  }
  return intents;
}

function executionOutput(value, depth = 0) {
  if (depth > 4) return value;
  if (typeof value === 'string') {
    try { return executionOutput(JSON.parse(value), depth + 1); } catch { return value; }
  }
  return value;
}

function executionTextParts(value) {
  if (typeof value === 'string') return [value];
  const blocks = Array.isArray(value) ? value : value?.content;
  if (Array.isArray(blocks)) return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text);
  return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
}

function computedPatchResultYielded(payload) {
  return executionTextParts(executionOutput(payload?.output))
    .some(text => /^\s*Script running with cell ID \d+\s*$/m.test(text));
}

function computedPatchResultFailed(payload) {
  if (payload?.is_error === true) return true;
  const output = executionOutput(payload?.output);
  if (output?.isError === true || output?.error != null) return true;
  return executionTextParts(output).some(text => /^\s*(?:Script error:|Script failed|Error:)/.test(text));
}

module.exports = { computedPatchWriteIntents, computedPatchResultFailed, computedPatchResultYielded };
