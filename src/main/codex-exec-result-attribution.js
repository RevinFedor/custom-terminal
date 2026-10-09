'use strict';

const MAX_SOURCE_CHARS = 512 * 1024;
const HELPERS = new Set(['as_settled', 'stream_settled']);
let parse;
const unknown = () => ({ kind: 'settled', bindings: null });
const unwrapAwait = node => node?.type === 'AwaitExpression' ? node.argument : node;

// A settlement index names the helper's INPUT array/Map, not the lexical order
// of tools.* in the JS. Prove that small source relation without executing JS.
// Old code without these helpers keeps its existing result projection.
function inspectCodexSettledEmission(source, nestedCalls) {
  if (typeof source !== 'string' || !/\b(?:as_settled|stream_settled)\b/.test(source)) return null;
  if (source.length > MAX_SOURCE_CHARS) return unknown();
  let program;
  try {
    parse ||= require('@babel/parser').parse;
    program = parse(source, { sourceType: 'module', allowAwaitOutsideFunction: true }).program;
  } catch { return unknown(); }
  const helperCalls = [];
  const allCalls = [];
  let helperReference = false;
  let mutates = false;
  const stack = [{ node: program, parent: null }];
  let visited = 0;
  while (stack.length) {
    if (++visited > 30000) return unknown();
    const { node, parent } = stack.pop();
    if (['AssignmentExpression', 'UpdateExpression'].includes(node.type)
      || node.type === 'UnaryExpression' && node.operator === 'delete'
      || node.type === 'NewExpression' && (node.callee.type !== 'Identifier' || node.callee.name !== 'Map')) mutates = true;
    if (node.type === 'Identifier' && HELPERS.has(node.name)) {
      const propertyName = parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed && !parent.shorthand
        || parent?.type === 'MemberExpression' && parent.property === node && !parent.computed;
      if (!propertyName) helperReference = true;
    }
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'globalThis'
      && HELPERS.has(node.computed ? node.property.value : node.property.name)) helperReference = true;
    if (node.type === 'CallExpression') allCalls.push(node);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && HELPERS.has(node.callee.name)) helperCalls.push(node);
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child.type === 'string') stack.push({ node: child, parent: node });
      }
    }
  }
  if (!helperCalls.length) return helperReference ? unknown() : null; // not quoted examples/comments
  if (helperCalls.length !== 1) return unknown();
  const helper = helperCalls[0];
  const constants = new Map();
  const nestedByStart = new Map((nestedCalls || []).map((call, index) => [call.start, { call, index }]));
  const outputCalls = new Set();
  let emission = false;
  let invalid = false;

  const isTextCall = (node, argument) => {
    const valid = node?.type === 'CallExpression'
      && node.callee.type === 'Identifier' && node.callee.name === 'text'
      && node.arguments.length === 1 && node.arguments[0]?.type === 'Identifier'
      && node.arguments[0].name === argument;
    if (valid) outputCalls.add(node);
    return valid;
  };
  const emitsEnvelope = callback => {
    if (callback?.type === 'Identifier') return callback.name === 'text';
    if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type)
      || callback.params.length !== 1 || callback.params[0].type !== 'Identifier') return false;
    const parameter = callback.params[0].name;
    if (['text', 'Map', 'tools', ...HELPERS].includes(parameter)) return false;
    let body = callback.body;
    if (body.type === 'BlockStatement') {
      if (body.body.length !== 1) return false;
      body = body.body[0];
      body = body.type === 'ExpressionStatement' ? body.expression
        : body.type === 'ReturnStatement' ? body.argument : null;
    }
    return isTextCall(unwrapAwait(body), parameter);
  };

  for (const statement of program.body) {
    if (statement.type === 'EmptyStatement') continue;
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== 'Identifier' || !declaration.init) { invalid = true; break; }
        const name = declaration.id.name;
        if (constants.has(name) || ['text', 'tools', 'Map', ...HELPERS].includes(name)) { invalid = true; break; }
        constants.set(name, declaration.init);
      }
      continue;
    }
    if (statement.type === 'ExpressionStatement' && unwrapAwait(statement.expression) === helper
      && helper.callee.name === 'stream_settled' && helper.arguments.length === 2) {
      emission = emitsEnvelope(helper.arguments[1]);
      continue;
    }
    if (statement.type === 'ForOfStatement' && statement.await && statement.right === helper
      && helper.callee.name === 'as_settled' && helper.arguments.length === 1
      && statement.left.type === 'VariableDeclaration' && statement.left.kind === 'const'
      && statement.left.declarations.length === 1 && statement.left.declarations[0].id.type === 'Identifier') {
      const name = statement.left.declarations[0].id.name;
      const body = statement.body.type === 'BlockStatement' ? statement.body.body : [statement.body];
      emission = !['text', 'tools', 'Map', ...HELPERS].includes(name)
        && body.length === 1 && body[0].type === 'ExpressionStatement'
        && isTextCall(unwrapAwait(body[0].expression), name);
      continue;
    }
    invalid = true; // extra output, mutation, branching or shadowed helper
  }
  if (invalid || mutates || !emission || allCalls.some(call => call !== helper
    && !outputCalls.has(call) && nestedByStart.get(call.start)?.call.end !== call.end)) return unknown();
  const resolve = (node, seen = new Set()) => {
    node = unwrapAwait(node);
    if (node?.type !== 'Identifier') return node;
    if (seen.has(node.name) || !constants.has(node.name)) return null;
    return resolve(constants.get(node.name), new Set([...seen, node.name]));
  };
  const toolIndex = node => {
    const call = resolve(node);
    const match = nestedByStart.get(call?.start);
    return call?.type === 'CallExpression' && match?.call.end === call.end ? match.index : null;
  };
  const input = resolve(helper.arguments[0]);
  let bindings;
  if (input?.type === 'ArrayExpression') {
    bindings = input.elements.map((element, index) => ({ key: index, callIndex: toolIndex(element) }));
  } else if (input?.type === 'NewExpression' && input.callee.type === 'Identifier'
    && input.callee.name === 'Map' && input.arguments.length === 1) {
    const entries = resolve(input.arguments[0]);
    if (entries?.type !== 'ArrayExpression') return unknown();
    bindings = entries.elements.map(entry => {
      if (entry?.type !== 'ArrayExpression' || entry.elements.length !== 2) return null;
      const key = resolve(entry.elements[0]);
      return ['StringLiteral', 'NumericLiteral'].includes(key?.type)
        ? { key: key.value, callIndex: toolIndex(entry.elements[1]) } : null;
    });
  } else return unknown();
  if (!bindings.length || bindings.some(binding => !binding || binding.callIndex === null)
    || bindings.length !== nestedCalls.length
    || new Set(bindings.map(binding => binding.callIndex)).size !== nestedCalls.length
    || new Set(bindings.map(binding => JSON.stringify(binding.key))).size !== bindings.length) return unknown();
  return { kind: 'settled', bindings };
}

function matchCodexSettledResults(plan, parts, { allowPartial = false } = {}) {
  if (!plan?.bindings || (allowPartial ? parts.length > plan.bindings.length : parts.length !== plan.bindings.length)) return null;
  const bindings = new Map(plan.bindings.map(binding => [JSON.stringify(binding.key), binding.callIndex]));
  const found = new Map();
  for (const part of parts) {
    let result;
    try { result = JSON.parse(part); } catch { return null; }
    if (!result || Array.isArray(result) || !Object.hasOwn(result, 'index')
      || !['fulfilled', 'rejected'].includes(result.status)) return null;
    const field = result.status === 'fulfilled' ? 'value' : 'reason';
    if (Object.keys(result).some(key => !['index', 'status', field].includes(key))) return null;
    const key = JSON.stringify(result.index);
    if (!bindings.has(key) || found.has(bindings.get(key))) return null;
    // Undefined values/rejection reasons are omitted by the runtime JSON printer.
    found.set(bindings.get(key), { value: result[field], isError: result.status === 'rejected' });
  }
  return allowPartial || found.size === bindings.size ? found : null;
}

module.exports = { inspectCodexSettledEmission, matchCodexSettledResults };
