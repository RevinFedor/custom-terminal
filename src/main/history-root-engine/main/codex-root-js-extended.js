'use strict';

// Additional productions use the SAME paged continuation driver and arena as
// the original grammar. No native AST importer, recursive production calls or
// source-sized diagnostic is introduced here. Failure still delegates to the
// existing Babel compatibility path; that path remains explicitly unbounded.
const text = require('./history-paged-text');
const ops = require('./history-root-operations');

const chain = (g, node) => !g.parenthesized(node)
  && (node.type === 'OptionalMemberExpression' || node.type === 'OptionalCallExpression');
function member(g, object, property, computed, end, optional) {
  if (object.type === 'Super' && property.type === 'PrivateName') g.fail('super-private', property.start);
  const fields = { object, computed, property };
  const chained = optional || chain(g, object);
  if (chained) fields.optional = optional;
  return g.node(chained ? 'OptionalMemberExpression' : 'MemberExpression', g.start(object), end, fields);
}
function privateName(g, use) {
  const start = g.lexer.expect('#').start, token = g.lexer.take();
  if (token.start !== start + 1) g.fail('private-name-space', start);
  const id = g.name(token, true), node = g.node('PrivateName', start, id.end, { id });
  if (use) {
    if (!g.classContext) g.fail('private-context', start);
    g.classContext.uses.push(node);
  }
  return node;
}
function classKey(g) { return g.lexer.is('#') ? privateName(g, false) : g.property(); }
function declarePrivate(g, key, kind, isStatic) {
  if (key.type !== 'PrivateName') return;
  const name = key.id.name;
  if (text.equal(name, 'constructor')) g.fail('private-constructor', key.start);
  const bits = kind === 'get' ? 2 : kind === 'set' ? 4 : 1;
  const prior = g.classContext.names.get(name) || 0;
  if (prior && (prior & 1 || bits & 1 || prior & bits || !!(prior & 8) !== !!isStatic)) g.rejectBinding('duplicate-private', key.start);
  g.classContext.names.set(name, prior | bits | (isStatic ? 8 : 0));
}
function callNode(g, callee, args, end, optional) {
  if (callee.type === 'Super' && !(g.context & 16)) g.fail('super-call-context', callee.start);
  const chained = optional || chain(g, callee), fields = { callee };
  if (chained) fields.optional = optional;
  fields.arguments = args;
  return g.node(chained ? 'OptionalCallExpression' : 'CallExpression', g.start(callee), end, fields);
}
function contextual(g, value) {
  const token = g.lexer.peek();
  if (token.kind !== 'name' || token.value !== value || token.escaped) return false;
  g.lexer.take(); return true;
}
function moduleName(g, requireUnicode = true) {
  const token = g.lexer.peek();
  if (token.kind !== 'string') return g.name(g.lexer.take(), true);
  const node = g.literal(g.lexer.take());
  if (requireUnicode) {
    // ModuleExportName requires well-formed Unicode; ordinary string values
    // (including import-attribute keys) retain lone UTF-16 code units.
    let high = false;
    for (const part of text.chunks(node.value)) for (let i = 0; i < part.length; i++) {
      const c = part.charCodeAt(i), low = c >= 0xdc00 && c <= 0xdfff;
      if (high !== low) g.rejectBinding('module-name-surrogate', node.start);
      high = c >= 0xd800 && c <= 0xdbff;
    }
    if (high) g.rejectBinding('module-name-surrogate', node.start);
  }
  return node;
}
function exported(g, node) {
  const name = node.type === 'Identifier' ? node.name : node.value;
  if (g.moduleState.names.has(name)) g.rejectBinding('duplicate-export', node.start);
  g.moduleState.names.add(name);
}
function finishModule(g) {
  for (const node of g.moduleState.refs) if (!g.scope.names.has(node.name)) g.rejectBinding('undefined-export', node.start);
}
function finishCover(g) {
  for (const check of g.coverChecks) if (check.node.type === 'ObjectExpression') {
    g.rejectBinding(check.flags & 4 ? 'cover-initialized-name' : 'duplicate-proto', check.node.start);
  }
}
function settleLabels(g, loop) {
  for (let i = g.labels.length - 1; i >= 0; i--) {
    const row = g.labels[i]; if (!row.pending) break;
    row.loop = loop; row.pending = false;
  }
}
function resourceKind(g, token, forHead) {
  if (token.kind !== 'name' || token.escaped) return null;
  const l = g.lexer;
  let at = l.lookahead(token.end, true);
  if (token.value === 'await') {
    if (!l.wordAt(at, 'using')) return null;
    at = l.lookahead(at + 5, true);
    return l.bindingAt(at) ? 'await using' : null;
  }
  if (token.value !== 'using') return null;
  if (forHead && l.wordAt(at, 'of') && !['=', ':', ';'].includes(l.at(l.lookahead(at + 2, false)))) return null;
  return l.bindingAt(at) || !forHead && l.at(at) === '{' ? 'using' : null;
}
function consumeResource(g, kind) {
  if (g.scope.kind === 'switch') g.fail('resource-bare-case');
  if (kind === 'await using') {
    if (g.context && !(g.context & 2)) g.fail('resource-await-context');
    g.lexer.take();
  }
  g.lexer.take();
}
function exportDeclaration(g, declaration) {
  if (declaration.id) exported(g, declaration.id);
  if (declaration.type !== 'VariableDeclaration') return;
  const pending = g.arena.make('array'); for (const d of declaration.declarations) pending.push(d.id);
  while (pending.length) {
    const node = pending.pop(); if (!node) continue;
    if (node.type === 'Identifier') exported(g, node);
    else if (node.type === 'AssignmentPattern') pending.push(node.left);
    else if (node.type === 'RestElement') pending.push(node.argument);
    else if (node.type === 'ArrayPattern') for (const item of node.elements) pending.push(item);
    else if (node.type === 'ObjectPattern') for (const item of node.properties) pending.push(item.type === 'RestElement' ? item : item.value);
  }
}

// Cover conversion and binding validation walk one paged item at a time. A
// leaf is never coerced to a JS property key (including under hash collision).
function pattern(g, root, binding) {
  const pending = g.arena.make('array'); pending.push(root);
  while (pending.length) {
    const node = pending.pop(); if (!node) continue;
    // Parenthesized Identifier/Member assignment targets were already
    // accepted by V11. Binding patterns (including arrow parameters) still
    // reject them, as do parenthesized array/object patterns.
    if (g.parenthesized(node) && (binding || !['Identifier','MemberExpression'].includes(node.type))) g.fail('parenthesized-pattern', node.start);
    switch (node.type) {
      case 'Identifier': g.target(node); break;
      case 'MemberExpression': if (binding) g.fail('member-binding', node.start); break;
      case 'ArrayExpression': case 'ArrayPattern': {
        node.type = 'ArrayPattern';
        for (let i = 0; i < node.elements.length; i++) {
          const item = node.elements[i];
          if (item && (item.type === 'SpreadElement' || item.type === 'RestElement') && i !== node.elements.length - 1) g.fail('rest-last', item.start);
          pending.push(item);
        }
        break;
      }
      case 'ObjectExpression': case 'ObjectPattern': {
        node.type = 'ObjectPattern';
        for (let i = 0; i < node.properties.length; i++) {
          const prop = node.properties[i];
          if (prop.type === 'ObjectProperty') pending.push(prop.value);
          else if (prop.type === 'SpreadElement' || prop.type === 'RestElement') {
            if (i !== node.properties.length - 1 || binding && prop.argument.type !== 'Identifier'
              || !binding && !['Identifier', 'MemberExpression'].includes(prop.argument.type)) g.fail('object-rest', prop.start);
            pending.push(prop);
          } else g.fail('pattern-method', prop.start);
        }
        break;
      }
      case 'AssignmentExpression':
        if (node.operator !== '=') g.fail('pattern-operator', node.start);
        node.type = 'AssignmentPattern'; delete node.operator;
        pending.push(node.left); break;
      case 'AssignmentPattern': pending.push(node.left); break;
      case 'SpreadElement': case 'RestElement':
        if (g.restCommas.has(g.arena.owner(node))) g.fail('rest-comma', node.start);
        node.type = 'RestElement';
        if (node.argument.type === 'AssignmentExpression' || node.argument.type === 'AssignmentPattern') g.fail('rest-default', node.start);
        pending.push(node.argument); break;
      default: g.fail('pattern-target', node.start);
    }
  }
}
function declarePattern(g, root, kind) {
  const pending = g.arena.make('array'); pending.push(root);
  while (pending.length) {
    const node = pending.pop(); if (!node) continue;
    if (node.type === 'Identifier') g.declare(node, kind);
    else if (node.type === 'AssignmentPattern') pending.push(node.left);
    else if (node.type === 'RestElement') pending.push(node.argument);
    else if (node.type === 'ArrayPattern') for (const item of node.elements) pending.push(item);
    else if (node.type === 'ObjectPattern') for (const item of node.properties) pending.push(item.type === 'RestElement' ? item : item.value);
    else g.fail('binding-pattern', node.start);
  }
}
function checkParameters(g, params, body) {
  if (params.some(p => p.type !== 'Identifier') && body.type === 'BlockStatement') {
    for (const directive of body.directives) if (text.equal(directive.value.value, 'use strict')) g.fail('non-simple-strict-directive', directive.start);
  }
  const pending = g.arena.make('array'); for (const param of params) pending.push(param);
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'AwaitExpression' || node.type === 'YieldExpression') g.fail('parameter-await-yield', node.start);
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') continue;
    if (node.type === 'ObjectMethod' || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') {
      // A method body/parameter list has its own function context, but its
      // computed key is evaluated in the enclosing parameter context.
      if (node.computed) pending.push(node.key);
      continue;
    }
    for (const [, child] of ops.entries(node)) {
      if (Array.isArray(child)) for (const item of child) { if (item?.type) pending.push(item); }
      else if (child?.type) pending.push(child);
    }
  }
}
function statement(g, token) {
  const l = g.lexer;
  if (token.kind === 'export') {
    if (!g.frame.topLevel) g.fail('module-top-level', token.start);
    l.take(); g.call('export', { start: token.start }, 1); return true;
  }
  if (token.kind === 'import') {
    // The lexical lookahead is a fixed register saved on pages, not a second
    // source string. Dynamic import/import.meta stay in expression grammar.
    l.take(); const next = l.peek();
    if (next.kind === '(' || next.kind === '.') {
      g.call('import-statement', { start: token.start, end: token.end }, 1); return true;
    }
    if (!g.frame.topLevel) g.fail('module-top-level', token.start);
    g.call('import', { start: token.start }, 1); return true;
  }
  if (['if','while','do','try','switch'].includes(token.kind)) {
    l.take(); g.call(token.kind, { start: token.start }, 1); return true;
  }
  if (token.kind === 'throw') { l.take(); g.call('throw', { start: token.start }, 1); return true; }
  if (token.kind === 'debugger') {
    l.take(); g.ret(g.node('DebuggerStatement', token.start, g.semi(), {})); return true;
  }
  if (token.kind === 'break' || token.kind === 'continue') {
    l.take(); const next = l.peek();
    const label = !next.line && next.kind === 'name' ? g.name(l.take()) : null;
    let found = false;
    for (let i = g.labels.length - 1; i >= 0; i--) {
      const row = g.labels[i];
      if (label ? text.equal(row.name, label.name) && (token.kind === 'break' || row.loop)
        : row.loop || token.kind === 'break' && row.switch) { found = true; break; }
    }
    if (!found) g.fail('jump-context', token.start);
    g.ret(g.node(token.kind === 'break' ? 'BreakStatement' : 'ContinueStatement', token.start, g.semi(), { label })); return true;
  }
  return false;
}
function singleBody(g, node) {
  if (node.type === 'VariableDeclaration' && node.kind !== 'var' || node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') g.fail('single-body-declaration', node.start);
}
function methodSpec(g, start, key, computed, generator, async, kind, isClass, isStatic) {
  return g.arena.record({ start, key, computed, generator, async, kind, isClass, static: isStatic });
}
function objectMethod(g) {
  const f = g.frame, l = g.lexer;
  if (f.methodComputed) { delete f.methodComputed; }
  if (!f.methodKind && !f.computed && !f.generator && f.key.type === 'Identifier' && !g.escaped.has(g.arena.owner(f.key))
    && (f.key.name === 'get' || f.key.name === 'set' || f.key.name === 'async')
    && !['(',':',',','}','='].includes(l.peek().kind) && !(f.key.name === 'async' && l.peek().line)) {
    f.methodKind = f.key.name; g.comments.reset(f.key);
    f.generator = f.methodKind === 'async' && l.eat('*');
    f.computed = l.eat('[');
    if (f.computed) { f.methodComputed = true; g.call('expr', { min: 2 }, 2); return true; }
    f.key = g.property();
  }
  if (l.is('(')) {
    l.take(); const kind = f.methodKind === 'get' || f.methodKind === 'set' ? f.methodKind : 'method';
    const spec = methodSpec(g, f.propertyStart, f.key, f.computed, !!f.generator, f.methodKind === 'async', kind, false, false);
    delete f.methodKind; delete f.generator;
    g.call('method', { spec }, 7); return true;
  }
  if (f.methodKind || f.generator) g.fail('method-parameters', f.propertyStart);
  return false;
}

function step(g) {
  const f = g.frame, l = g.lexer, a = g.arena;
  switch (f.op) {
    case 'binding': {
      if (f.pc === 0) {
        const token = l.peek();
        if (token.kind === '[') { l.take(); g.call('binding-array', { start: token.start }, 1); return true; }
        if (token.kind === '{') { l.take(); g.call('binding-object', { start: token.start }, 1); return true; }
        f.value = g.name(l.take()); f.pc = 1;
      }
      if (f.pc === 1) {
        if (f.defaults && l.eat('=')) { f.left = f.value; delete f.value; g.call('expr', { min: 2 }, 2); return true; }
        g.ret(f.value); return true;
      }
      g.ret(g.node('AssignmentPattern', f.left.start, g.end(f.value), { left: f.left, right: f.value })); return true;
    }
    case 'binding-array': {
      if (f.pc === 0) { f.items = a.make('array'); f.pc = 1; }
      if (f.pc === 2 || f.pc === 3) {
        f.items.push(f.pc === 3 ? g.node('RestElement', f.rest, f.value.end, { argument: f.value }) : f.value);
        delete f.value;
        if (f.pc === 3 && !l.is(']')) g.fail('rest-last');
        if (!l.is(']')) l.expect(','); f.pc = 1;
      }
      if (l.eat(']')) { g.ret(g.node('ArrayPattern', f.start, l.lastEnd, { elements: f.items })); return true; }
      if (l.eat(',')) { f.items.push(null); return true; }
      if (l.is('...')) { f.rest = l.take().start; g.call('binding', { defaults: false }, 3); return true; }
      g.call('binding', { defaults: true }, 2); return true;
    }
    case 'binding-object': {
      if (f.pc === 0) { f.items = a.make('array'); f.pc = 1; }
      if (f.pc === 2) { f.key = f.value; delete f.value; l.expect(']'); f.pc = 3; }
      if (f.pc === 4 || f.pc === 5) {
        const value = f.pc === 5 ? g.node('AssignmentPattern', f.left.start, g.end(f.value), { left: f.left, right: f.value }) : f.value;
        f.items.push(g.node('ObjectProperty', f.at, value.end, { key: f.key, computed: f.computed, method: false, shorthand: !!f.shorthand, value }));
        delete f.value; delete f.left; delete f.key; f.pc = 6;
      }
      if (f.pc === 7) {
        if (f.value.type !== 'Identifier') g.fail('object-rest-binding', f.value.start);
        f.items.push(g.node('RestElement', f.at, f.value.end, { argument: f.value })); delete f.value;
        if (!l.is('}')) g.fail('rest-last'); f.pc = 6;
      }
      if (f.pc === 6) { if (!l.is('}')) l.expect(','); f.pc = 1; }
      if (f.pc === 1) {
        if (l.eat('}')) { g.ret(g.node('ObjectPattern', f.start, l.lastEnd, { properties: f.items })); return true; }
        f.at = l.peek().start; f.shorthand = false;
        if (l.eat('...')) { g.call('binding', { defaults: false }, 7); return true; }
        f.computed = l.eat('[');
        if (f.computed) { g.call('expr', { min: 2 }, 2); return true; }
        f.key = g.property(); f.pc = 3;
      }
      if (l.eat(':')) { g.call('binding', { defaults: true }, 4); return true; }
      if (f.computed || f.key.type !== 'Identifier') g.fail('binding-property', f.at);
      f.shorthand = true; f.value = a.assign(f.key); f.value.range = undefined;
      if (l.eat('=')) { f.left = f.value; delete f.value; g.call('expr', { min: 2 }, 5); return true; }
      f.pc = 4; return true;
    }
    case 'params': {
      if (f.pc === 0) { f.items = a.make('array'); f.pc = 1; }
      if (f.pc === 2 || f.pc === 3) {
        f.items.push(f.pc === 3 ? g.node('RestElement', f.rest, f.value.end, { argument: f.value }) : f.value); delete f.value;
        if (f.pc === 3 && !l.is(')')) g.fail('rest-parameter-last');
        if (!l.is(')')) l.expect(','); f.pc = 1;
      }
      if (l.eat(')')) { g.ret(f.items); return true; }
      if (l.is('...')) { f.rest = l.take().start; g.call('binding', { defaults: false }, 3); return true; }
      g.call('binding', { defaults: true }, 2); return true;
    }
    case 'yield': {
      if (f.pc === 0) {
        const next = l.peek(); f.delegate = !next.line && l.eat('*');
        if (!f.delegate && (next.line || [';',')',']','}',',',':','eof'].includes(next.kind))) {
          g.ret(g.node('YieldExpression', f.start, l.lastEnd, { delegate: false, argument: null })); return true;
        }
        g.call('expr', { min: 2 }, 1); return true;
      }
      g.ret(g.node('YieldExpression', f.start, g.end(f.value), { delegate: f.delegate, argument: f.value })); return true;
    }
    case 'class': {
      if (f.pc === 0) {
        f.id = l.is('name') ? g.name(l.take()) : null;
        if (f.declaration) { if (!f.id && !f.anonymous) g.fail('class-name'); if (f.id) g.declare(f.id, 'class'); }
        f.oldScope = g.scope; g.scope = g.newScope(g.scope, 'class');
        if (f.id) g.declare(f.id, 'class');
        if (l.eat('extends')) { g.call('expr', { min: 17 }, 1); return true; }
        f.value = null; f.pc = 1;
      }
      if (f.pc === 1) {
        f.superClass = f.value; delete f.value;
        f.bodyStart = l.expect('{').start; f.items = a.make('array');
        f.oldClass = g.classContext; g.classContext = a.record({ parent: f.oldClass, derived: !!f.superClass,
          constructorSeen: false, names: a.make('map'), uses: a.make('array') }); f.pc = 2;
      }
      if (f.pc === 3) { f.items.push(f.value); delete f.value; f.pc = 2; }
      if (l.eat('}')) {
        for (const used of g.classContext.uses) if (!g.classContext.names.has(used.id.name)) {
          if (f.oldClass) f.oldClass.uses.push(used); else g.fail('undeclared-private', used.start);
        }
        const body = g.node('ClassBody', f.bodyStart, l.lastEnd, { body: f.items });
        g.scope = f.oldScope; g.classContext = f.oldClass;
        g.ret(g.node(f.declaration ? 'ClassDeclaration' : 'ClassExpression', f.start, body.end, { id: f.id, superClass: f.superClass, body })); return true;
      }
      if (l.eat(';')) return true;
      g.call('class-member', {}, 3); return true;
    }
    case 'class-member': {
      if (f.pc === 0) {
        f.start = l.peek().start; f.static = false; f.async = false; f.kind = 'method';
        f.generator = l.eat('*'); f.computed = l.eat('[');
        if (f.computed) { g.call('expr', { min: 2 }, 1); return true; }
        f.key = classKey(g); f.pc = 2;
      }
      if (f.pc === 1) { f.key = f.value; delete f.value; l.expect(']'); f.pc = 2; }
      if (f.pc === 2) {
        if (!f.computed && !f.generator && !f.static && f.key.type === 'Identifier' && !g.escaped.has(a.owner(f.key)) && f.key.name === 'static'
          && !['(', '=', ';', '}'].includes(l.peek().kind)) {
          f.static = true; g.comments.reset(f.key);
          if (l.is('{')) {
            f.oldScope = g.scope; f.oldContext = g.context; f.oldLabels = g.labels;
            g.scope = g.newScope(g.scope, 'function'); g.context = 8 | 32; g.labels = a.make('array');
            // Finish the actual owner once: an intermediate BlockStatement
            // would consume comments before the StaticBlock could own them.
            g.call('body', { start: f.start, close: '}', directives: false, functionBody: true, staticBlock: true }, 6); return true;
          }
          f.generator = l.eat('*'); f.computed = l.eat('[');
          if (f.computed) { g.call('expr', { min: 2 }, 1); return true; }
          f.key = classKey(g);
        }
        if (!f.computed && !f.generator && !f.async && f.kind === 'method' && f.key.type === 'Identifier' && !g.escaped.has(a.owner(f.key))
          && ['async','get','set'].includes(f.key.name) && !['(', '=', ';', '}'].includes(l.peek().kind)
          && !(f.key.name === 'async' && l.peek().line)) {
          const modifier = f.key.name; g.comments.reset(f.key);
          f.async = modifier === 'async'; f.kind = f.async ? 'method' : modifier;
          f.generator = f.async && l.eat('*'); f.computed = l.eat('[');
          if (f.computed) { g.call('expr', { min: 2 }, 1); return true; }
          f.key = classKey(g);
        }
        const key = f.key.type === 'Identifier' ? f.key.name : f.key.value;
        if (f.static && !f.computed && text.equal(key, 'prototype')) g.fail('static-prototype', f.key.start);
        if (l.eat('(')) {
          declarePrivate(g, f.key, f.kind, f.static);
          if (!f.static && !f.computed && text.equal(key, 'constructor')) {
            if (f.async || f.generator || f.kind !== 'method' || g.classContext.constructorSeen) g.fail('class-constructor', f.start);
            g.classContext.constructorSeen = true; f.kind = 'constructor';
          }
          g.call('method', { spec: methodSpec(g, f.start, f.key, f.computed, f.generator, f.async, f.kind, true, f.static) }, 3); return true;
        }
        if (f.generator || f.async || f.kind !== 'method' || !f.computed && text.equal(key, 'constructor')) g.fail('class-field', f.start);
        declarePrivate(g, f.key, 'field', f.static);
        if (l.eat('=')) {
          f.oldContext = g.context; g.context = 8 | 32;
          g.call('expr', { min: 2 }, 4); return true;
        }
        f.value = null; f.pc = 5;
      }
      if (f.pc === 3) { g.ret(f.value); return true; }
      if (f.pc === 4) { g.context = f.oldContext; delete f.oldContext; f.pc = 5; }
      if (f.pc === 5) {
        const fields = { static: f.static, key: f.key };
        if (f.key.type !== 'PrivateName') fields.computed = f.computed;
        fields.value = f.value;
        g.ret(g.node(f.key.type === 'PrivateName' ? 'ClassPrivateProperty' : 'ClassProperty', f.start, g.semi(), fields)); return true;
      }
      if (f.pc === 6) {
        g.scope = f.oldScope; g.context = f.oldContext; g.labels = f.oldLabels;
        g.ret(f.value); return true;
      }
      return true;
    }
    case 'method': {
      if (f.pc === 0) {
        f.oldScope = g.scope; f.oldContext = g.context; f.oldLabels = g.labels;
        g.scope = g.newScope(g.scope, 'function'); g.labels = a.make('array');
        g.context = 1 | (f.spec.async ? 2 : 0) | (f.spec.generator ? 4 : 0) | 8 | 64
          | (f.spec.kind === 'constructor' && g.classContext?.derived ? 16 : 0);
        g.call('params', {}, 1); return true;
      }
      if (f.pc === 1) {
        f.params = f.value; delete f.value;
        if (f.spec.kind === 'get' && f.params.length || f.spec.kind === 'set' && (f.params.length !== 1 || f.params[0].type === 'RestElement')) g.fail('accessor-parameters', f.spec.start);
        for (const param of f.params) declarePattern(g, param, 'param');
        g.call('body', { start: l.peek().start, close: '}', directives: true, functionBody: true }, 2); return true;
      }
      checkParameters(g, f.params, f.value);
      const spec = f.spec, fields = { key: spec.key, computed: spec.computed, kind: spec.kind, id: null,
        generator: !!spec.generator, async: !!spec.async, params: f.params, body: f.value };
      if (spec.isClass) fields.static = spec.static; else fields.method = spec.kind === 'method';
      if (spec.key.type === 'PrivateName' && !spec.async && spec.kind === 'method') delete fields.computed;
      g.scope = f.oldScope; g.context = f.oldContext; g.labels = f.oldLabels;
      g.ret(g.node(spec.isClass ? spec.key.type === 'PrivateName' ? 'ClassPrivateMethod' : 'ClassMethod' : 'ObjectMethod', spec.start, f.value.end, fields)); return true;
    }
    case 'if': {
      if (f.pc === 0) { l.expect('('); g.call('expr', { min: 1 }, 1); return true; }
      if (f.pc === 1) { f.test = f.value; delete f.value; l.expect(')'); g.call('statement', {}, 2); return true; }
      if (f.pc === 2) {
        singleBody(g, f.value); f.consequent = f.value; delete f.value;
        if (l.eat('else')) { g.call('statement', {}, 3); return true; }
        f.value = null; f.pc = 3;
      }
      if (f.value) singleBody(g, f.value);
      g.ret(g.node('IfStatement', f.start, f.value ? f.value.end : f.consequent.end, { test: f.test, consequent: f.consequent, alternate: f.value })); return true;
    }
    case 'while': {
      if (f.pc === 0) { l.expect('('); g.call('expr', { min: 1 }, 1); return true; }
      if (f.pc === 1) {
        f.test = f.value; delete f.value; l.expect(')');
        g.labels.push(a.record({ name: null, loop: true })); g.call('statement', {}, 2); return true;
      }
      singleBody(g, f.value); g.labels.pop();
      g.ret(g.node('WhileStatement', f.start, f.value.end, { test: f.test, body: f.value })); return true;
    }
    case 'do': {
      if (f.pc === 0) { g.labels.push(a.record({ name: null, loop: true })); g.call('statement', {}, 1); return true; }
      if (f.pc === 1) {
        singleBody(g, f.value); g.labels.pop(); f.body = f.value; delete f.value;
        l.expect('while'); l.expect('('); g.call('expr', { min: 1 }, 2); return true;
      }
      l.expect(')'); l.eat(';'); g.ret(g.node('DoWhileStatement', f.start, l.lastEnd, { body: f.body, test: f.value })); return true;
    }
    case 'label': {
      if (f.pc === 0) {
        for (const row of g.labels) if (text.equal(row.name, f.label.name)) g.fail('duplicate-label', f.start);
        g.labels.push(a.record({ name: f.label.name, loop: false, pending: true }));
        g.call('statement', {}, 1); return true;
      }
      singleBody(g, f.value); g.labels.pop();
      g.ret(g.node('LabeledStatement', f.start, f.value.end, { label: f.label, body: f.value })); return true;
    }
    case 'throw': {
      if (f.pc === 0) { if (l.peek().line) g.fail('newline-throw', f.start); g.call('expr', { min: 1 }, 1); return true; }
      g.ret(g.node('ThrowStatement', f.start, g.semi(), { argument: f.value })); return true;
    }
    case 'try': {
      if (f.pc === 0) { g.call('body', { start: l.peek().start, close: '}', directives: false }, 1); return true; }
      if (f.pc === 1) {
        f.block = f.value; delete f.value; f.handler = null;
        if (l.is('catch')) { f.catchStart = l.take().start; g.call('catch', { start: f.catchStart }, 2); return true; }
        f.pc = 2;
      }
      if (f.pc === 2) {
        if (f.value) { f.handler = f.value; delete f.value; }
        if (l.eat('finally')) { g.call('body', { start: l.peek().start, close: '}', directives: false }, 3); return true; }
        if (!f.handler) g.fail('try-handler', f.start); f.value = null; f.pc = 3;
      }
      g.ret(g.node('TryStatement', f.start, f.value ? f.value.end : f.handler.end,
        { block: f.block, handler: f.handler, finalizer: f.value })); return true;
    }
    case 'catch': {
      if (f.pc === 0) {
        f.oldScope = g.scope; g.scope = g.newScope(g.scope, 'catch');
        if (l.eat('(')) { g.call('binding', { defaults: false }, 1); return true; }
        f.value = null; f.pc = 1;
      }
      if (f.pc === 1) {
        f.param = f.value; delete f.value;
        if (f.param) { l.expect(')'); declarePattern(g, f.param, f.param.type === 'Identifier' ? 'param' : 'let'); }
        g.call('body', { start: l.peek().start, close: '}', directives: false, functionBody: true }, 2); return true;
      }
      g.scope = f.oldScope;
      g.ret(g.node('CatchClause', f.start, f.value.end, { param: f.param, body: f.value })); return true;
    }
    case 'switch': {
      if (f.pc === 0) { l.expect('('); g.call('expr', { min: 1 }, 1); return true; }
      if (f.pc === 1) {
        f.discriminant = f.value; delete f.value; l.expect(')'); l.expect('{');
        f.cases = a.make('array'); f.defaultSeen = false; f.oldScope = g.scope;
        g.scope = g.newScope(g.scope, 'switch'); g.labels.push(a.record({ name: null, switch: true })); f.pc = 2;
      }
      if (f.pc === 3) { f.test = f.value; delete f.value; l.expect(':'); f.body = a.make('array'); f.pc = 4; }
      if (f.pc === 5) { f.body.push(f.value); delete f.value; f.pc = 4; }
      if (f.pc === 4) {
        if (['case','default','}'].includes(l.peek().kind)) {
          f.cases.push(g.node('SwitchCase', f.caseStart, l.lastEnd, { consequent: f.body, test: f.test }));
          delete f.body; delete f.test; f.pc = 2;
        } else { g.call('statement', {}, 5); return true; }
      }
      if (l.eat('}')) {
        g.scope = f.oldScope; g.labels.pop();
        g.ret(g.node('SwitchStatement', f.start, l.lastEnd, { discriminant: f.discriminant, cases: f.cases })); return true;
      }
      const token = l.take(); f.caseStart = token.start;
      if (token.kind === 'case') { g.call('expr', { min: 1 }, 3); return true; }
      if (token.kind !== 'default' || f.defaultSeen) g.fail('switch-clause', token.start);
      f.defaultSeen = true; f.value = null; f.pc = 3; return true;
    }
    case 'for': {
      if (f.pc === 0) {
        f.await = l.peek().kind === 'name' && l.peek().value === 'await';
        if (f.await) { if (l.take().escaped || g.context && !(g.context & 2)) g.fail('for-await-context'); }
        l.expect('('); f.oldScope = g.scope; g.scope = g.newScope(g.scope, 'block');
        const token = l.peek();
        const resource = resourceKind(g, token, true);
        if (token.kind === ';') { f.value = null; f.pc = 1; }
        else if (resource || token.kind === 'const' || token.kind === 'var' || token.kind === 'name' && token.value === 'let') {
          if (resource) consumeResource(g, resource); else l.take();
          if (token.escaped) g.fail('escaped-declaration', token.start);
          g.call('variable', { start: token.start, kind: resource || token.value || token.kind, forHead: true, noIn: true }, 1); return true;
        } else { g.call('expr', { min: 1, noIn: true }, 1); return true; }
      }
      if (f.pc === 1) {
        f.init = f.value; delete f.value;
        const next = l.peek(), of = next.kind === 'name' && next.value === 'of';
        if (of || next.kind === 'in') {
          l.take(); if (of && next.escaped || f.await && !of || !f.init) g.fail('for-head', next.start);
          if (f.init.type === 'VariableDeclaration') {
            if (f.init.declarations.length !== 1 || f.init.declarations[0].init) g.fail('for-binding', f.init.start);
            if (!of && (f.init.kind === 'using' || f.init.kind === 'await using')) g.fail('resource-for-in', f.init.start);
          } else {
            if (of && !f.await && f.init.type === 'Identifier' && f.init.name === 'async'
              && !g.parenthesized(f.init) && !g.escaped.has(a.owner(f.init))) g.fail('for-of-async', f.init.start);
            if (f.init.type === 'AssignmentExpression') g.fail('for-assignment', f.init.start);
            pattern(g, f.init, false);
          }
          f.kind = of ? 'ForOfStatement' : 'ForInStatement';
          g.call('expr', { min: of ? 2 : 1 }, 2); return true;
        }
        if (f.await) g.fail('for-await-classic', next.start);
        if (f.init?.type === 'VariableDeclaration') for (const item of f.init.declarations) {
          if (!item.init && (['const','using','await using'].includes(f.init.kind) || item.id.type !== 'Identifier')) g.fail('for-initializer', item.start);
        }
        l.expect(';'); f.kind = 'ForStatement';
        if (!l.is(';')) { g.call('expr', { min: 1 }, 3); return true; }
        f.value = null; f.pc = 3;
      }
      if (f.pc === 2) { f.right = f.value; delete f.value; f.pc = 5; }
      if (f.pc === 3) {
        f.test = f.value; delete f.value; l.expect(';');
        if (!l.is(')')) { g.call('expr', { min: 1 }, 4); return true; }
        f.value = null; f.pc = 4;
      }
      if (f.pc === 4) { f.update = f.value; delete f.value; f.pc = 5; }
      if (f.pc === 5) {
        l.expect(')'); g.labels.push(a.record({ name: null, loop: true })); g.call('statement', {}, 6); return true;
      }
      singleBody(g, f.value); g.scope = f.oldScope; g.labels.pop();
      const fields = f.kind === 'ForStatement' ? { init: f.init, test: f.test, update: f.update, body: f.value }
        : { left: f.init, right: f.right, body: f.value };
      if (f.kind === 'ForOfStatement') fields.await = f.await;
      g.ret(g.node(f.kind, f.start, f.value.end, fields)); return true;
    }
    case 'import-expression': {
      if (f.pc === 0) {
        if (l.eat('.')) {
          const token = l.take(), property = g.name(token);
          if (token.escaped || !text.equal(property.name, 'meta')) g.fail('import-meta', property.start);
          const meta = g.node('Identifier', f.start, f.end, { name: 'import' });
          g.ret(g.node('MetaProperty', f.start, property.end, { meta, property })); return true;
        }
        l.expect('('); g.call('list', { close: ')' }, 1); return true;
      }
      if (f.value.length < 1 || f.value.length > 2 || f.value.some(x => x.type === 'SpreadElement')) g.fail('import-arguments', f.start);
      const callee = g.node('Import', f.start, f.end, {});
      g.ret(g.node('CallExpression', f.start, l.lastEnd, { callee, arguments: f.value })); return true;
    }
    case 'import-statement': {
      if (f.pc === 0) { g.call('import-expression', { start: f.start, end: f.end }, 1); return true; }
      // Continue through the ordinary operator driver (import('x').then etc).
      if (f.pc === 1) { g.call('expr', { pcResume: true, left: f.value, min: 1 }, 2); return true; }
      g.ret(g.node('ExpressionStatement', f.start, g.semi(), { expression: f.value })); return true;
    }
    case 'attributes': {
      if (f.pc === 0) {
        f.items = a.make('array'); f.names = a.make('set');
        if (!l.eat('with')) { g.ret(f.items); return true; }
        l.expect('{'); f.pc = 1;
      }
      if (l.eat('}')) { g.ret(f.items); return true; }
      const key = moduleName(g, false), name = key.type === 'Identifier' ? key.name : key.value;
      if (f.names.has(name)) g.fail('duplicate-import-attribute', key.start); f.names.add(name);
      l.expect(':'); if (!l.is('string')) g.fail('import-attribute-value'); const value = g.literal(l.take());
      f.items.push(g.node('ImportAttribute', key.start, value.end, { key, value }));
      if (!l.is('}')) l.expect(','); return true;
    }
    case 'import': {
      if (f.pc === 0) {
        f.items = a.make('array');
        if (l.is('string')) { f.source = g.literal(l.take()); g.call('attributes', {}, 3); return true; }
        if (l.is('name')) {
          const local = g.name(l.take()); g.declare(local, 'let');
          f.items.push(g.node('ImportDefaultSpecifier', local.start, local.end, { local }));
          if (!l.eat(',')) { f.pc = 2; } else f.pc = 1;
        } else f.pc = 1;
      }
      if (f.pc === 1) {
        if (l.is('*')) {
          const start = l.take().start;
          if (!contextual(g, 'as')) g.fail('import-as');
          const local = g.name(l.take()); g.declare(local, 'let');
          f.items.push(g.node('ImportNamespaceSpecifier', start, local.end, { local })); f.pc = 2;
        } else { l.expect('{'); f.pc = 4; }
      }
      if (f.pc === 4) {
        if (l.eat('}')) f.pc = 2;
        else {
          const imported = moduleName(g); let local;
          if (contextual(g, 'as')) local = g.name(l.take());
          else { if (imported.type !== 'Identifier') g.fail('string-import-alias', imported.start); local = a.assign(imported); local.range = undefined; }
          g.declare(local, 'let'); f.items.push(g.node('ImportSpecifier', imported.start, local.end, { imported, local }));
          if (!l.is('}')) l.expect(','); return true;
        }
      }
      if (f.pc === 2) {
        if (!contextual(g, 'from') || !l.is('string')) g.fail('import-from');
        f.source = g.literal(l.take()); g.call('attributes', {}, 3); return true;
      }
      g.ret(g.node('ImportDeclaration', f.start, g.semi(), { specifiers: f.items, source: f.source, attributes: f.value })); return true;
    }
    case 'export': {
      if (f.pc === 0) {
        f.items = a.make('array');
        if (l.eat('default')) {
          exported(g, { type: 'Identifier', name: 'default', start: f.start });
          f.default = true;
          if (l.is('function')) { const start = l.take().start; g.call('function', { start, declaration: true, anonymous: true, async: false }, 1); return true; }
          if (l.is('class')) { const start = l.take().start; g.call('class', { start, declaration: true, anonymous: true }, 1); return true; }
          g.call('expr', { min: 2 }, 2); return true;
        }
        if (l.is('*')) {
          const start = l.take().start; f.all = true;
          if (contextual(g, 'as')) {
            const name = moduleName(g); exported(g, name); f.all = false; f.namespace = true;
            f.items.push(g.node('ExportNamespaceSpecifier', start, name.end, { exported: name }));
          }
          f.pc = 4;
        } else if (l.eat('{')) { f.pc = 3; }
        else { g.call('statement', {}, 1); return true; }
      }
      if (f.pc === 1 || f.pc === 2) {
        let declaration = f.value, end = declaration.end;
        if (f.default) {
          if (f.pc === 2 && declaration.type === 'FunctionExpression' && declaration.async && !g.parenthesized(declaration)) {
            declaration.type = 'FunctionDeclaration'; if (declaration.id) g.declare(declaration.id, 'function');
          } else if (f.pc === 2) end = g.semi();
          g.ret(g.node('ExportDefaultDeclaration', f.start, end, { declaration })); return true;
        }
        if (!['VariableDeclaration','FunctionDeclaration','ClassDeclaration'].includes(declaration.type)) g.fail('export-declaration', declaration.start);
        if (declaration.kind === 'using' || declaration.kind === 'await using') g.fail('resource-export', declaration.start);
        exportDeclaration(g, declaration);
        g.ret(g.node('ExportNamedDeclaration', f.start, end, { specifiers: f.items, source: null, attributes: a.make('array'), declaration })); return true;
      }
      if (f.pc === 3) {
        if (l.eat('}')) { f.pc = 4; }
        else {
          const local = moduleName(g); let name;
          if (contextual(g, 'as')) name = moduleName(g); else { name = a.assign(local); name.range = undefined; }
          exported(g, name); f.items.push(g.node('ExportSpecifier', local.start, name.end, { local, exported: name }));
          if (!l.is('}')) l.expect(','); return true;
        }
      }
      if (f.pc === 4) {
        if (contextual(g, 'from')) {
          if (!l.is('string')) g.fail('export-source'); f.source = g.literal(l.take());
          g.call('attributes', {}, 5); return true;
        }
        if (f.all || f.namespace) g.fail('export-from');
        f.source = null; f.value = a.make('array');
        for (const spec of f.items) {
          if (spec.local.type !== 'Identifier') g.fail('string-export-local', spec.local.start);
          g.moduleState.refs.push(spec.local);
        }
        f.pc = 5;
      }
      const fields = f.all ? { source: f.source, attributes: f.value }
        : { specifiers: f.items, source: f.source, attributes: f.value };
      if (!f.all && !f.namespace) fields.declaration = null;
      g.ret(g.node(f.all ? 'ExportAllDeclaration' : 'ExportNamedDeclaration', f.start, g.semi(), fields)); return true;
    }
    default: return false;
  }
}
module.exports = { chain, member, callNode, privateName, finishModule, finishCover, settleLabels, resourceKind, consumeResource,
  pattern, declarePattern, checkParameters, statement, objectMethod, step };
