'use strict';

// A resumable grammar, not a native AST followed by an arena import. One
// native register record executes at a time; suspended productions are linked
// immutable pages. AST/list/scope/comment/parenthesis identities are allocated
// directly in the SAME reducer arena. Unsupported productions explicitly fall
// back to the old parser; this module does not change either consumer's UNKNOWN
// policy or claim that that compatibility interval is bounded.
const text = require('./history-paged-text');
const { PagedJsLexer, PagedJsFallback, PagedJsSyntaxError, KEYWORDS } = require('./codex-root-js-lexer');
const { PagedJsComments } = require('./codex-root-js-comments');
const { probe } = require('./codex-root-js-probe');
const extended = require('./codex-root-js-extended');
const STRICT = new Set(('implements interface let package private protected public static yield enum await').split(' '));
const UNARY = new Set(['!', '~', '+', '-', 'typeof', 'void', 'delete', 'await', '++', '--']);
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '|=', '^=', '&=', '&&=', '||=', '??=']);
const PRECEDENCE = Object.freeze({ ',': 1, '?': 3, '||': 4, '??': 4, '&&': 5, '|': 6, '^': 7, '&': 8,
  '==': 9, '!=': 9, '===': 9, '!==': 9, '<': 10, '>': 10, '<=': 10, '>=': 10, in: 10, instanceof: 10,
  '<<': 11, '>>': 11, '>>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13, '**': 14 });

// Fixed strict-module grammar and early-error guards. Required-identifier,
// atom, statement and delimiter guards run only after their complete default
// productions have been dispatched. Future unknown codes keep compatibility;
// an invalid internal opcode is an infrastructure error, never a syntax result.
const PROVEN_SYNTAX = new Set((
  'identifier-context binding-pattern semicolon function-body expression-production ' +
  'statement-production object-method-or-pattern method-parameters ' +
  'accessor-parameters arrow-cover assignment-pattern async-arrow-precedence async-declaration-name await-context bare-super ' +
  'binding-property class-arguments class-constructor class-field class-name const-initializer delete-private ' +
  'duplicate-import-attribute duplicate-label escaped-declaration escaped-operator export-declaration export-from export-source ' +
  'for-assignment for-await-classic for-await-context for-binding for-head for-initializer for-of-async ' +
  'function-name group-arrow-precedence import-arguments import-as import-attribute-value import-from import-meta ' +
  'jump-context member-binding module-top-level new-target-context newline-throw non-simple-strict-directive nullish-mixing ' +
  'object-rest object-rest-binding optional-chain-context optional-tag parameter-await-yield parenthesized-expression parenthesized-pattern ' +
  'pattern-method pattern-operator pattern-target private-brand-context private-brand-in private-constructor private-context ' +
  'private-name-space resource-await-context resource-bare-case resource-export resource-for-in resource-pattern rest-comma ' +
  'rest-default rest-last rest-parameter-last return-context shorthand-name single-body-declaration static-prototype ' +
  'strict-assignment strict-binding strict-delete strict-function-name strict-identifier string-export-local string-import-alias ' +
  'super-call-context super-context super-private switch-clause try-handler unary-exponent undeclared-private ' +
  'untagged-invalid-escape unterminated-body yield-precedence '
).trim().split(' '));

class PagedJsGrammar {
  constructor(source, arena) {
    this.source = source; this.arena = arena; this.store = arena.store; this.metrics = arena.metrics;
    this.lexer = new PagedJsLexer(source, arena, (type, start, end, value) => this.node(type, start, end, { value }, false));
    this.comments = new PagedJsComments(arena, this.lexer);
    this.parens = arena.make('map'); this.raw = arena.make('map');
    this.escaped = arena.make('set'); this.restCommas = arena.make('set');
    // Cover errors belong to the object owner until expression/pattern
    // disambiguation is complete. Converting that owner clears no other error.
    this.coverChecks = arena.make('array');
    this.scope = this.newScope(null, 'program'); this.context = 0;
    this.classContext = null; this.labels = arena.make('array');
    this.moduleState = arena.record({ names: arena.make('set'), refs: arena.make('array') });
    this.frame = { op: 'body', pc: 0, parent: 0, start: 0, close: 'eof', program: true, directives: true };
    this.depth = 1; this.result = undefined; this.done = false;
  }
  node(type, start, end, fields, finish = true) {
    // Babel advances its lookahead before finishNode/processComment.
    if (finish) this.lexer.peek();
    // A fixed node header plus arena/leaf references, never native children.
    // One owner-index commit instead of one per header/field source object.
    const record = { type, start, end };
    for (const key in fields) record[key] = fields[key];
    const node = this.arena.record(record);
    this.metrics.jsPagedAstNodes = (this.metrics.jsPagedAstNodes || 0) + 1;
    probe('node', this.arena, node);
    if (finish) this.comments.process(node);
    return node;
  }
  fail(code, at = this.lexer.peek().start) {
    if (PROVEN_SYNTAX.has(code)) throw new PagedJsSyntaxError(code, at);
    throw new PagedJsFallback(code, at);
  }
  rejectBinding(code, at) { throw new PagedJsSyntaxError(code, at); }
  name(token, liberal = false) {
    if (token.kind !== 'name' && !(liberal && KEYWORDS.has(token.kind))) this.fail('identifier-context', token.start);
    if (!liberal && typeof token.value === 'string' && (STRICT.has(token.value) || KEYWORDS.has(token.value))) this.fail('strict-identifier', token.start);
    if (!liberal && this.context & 32 && token.value === 'arguments') this.fail('class-arguments', token.start);
    const node = this.node('Identifier', token.start, token.end, { name: token.value });
    if (token.escaped) this.escaped.add(this.arena.owner(node));
    return node;
  }
  property() {
    const token = this.lexer.take();
    if (token.kind === 'string' || token.kind === 'number' || token.kind === 'bigint') return this.literal(token);
    return this.name(token, true);
  }
  literal(token) {
    const kind = token.kind, type = kind === 'number' ? 'NumericLiteral' : kind === 'bigint' ? 'BigIntLiteral' : 'StringLiteral';
    const node = this.node(type, token.start, token.end, { value: token.value });
    if (kind === 'string') this.raw.set(this.arena.owner(node), token.raw);
    return node;
  }
  start(node) { return this.parens.get(this.arena.owner(node))?.start ?? node.start; }
  end(node) { return this.parens.get(this.arena.owner(node))?.end ?? node.end; }
  parenthesized(node) { return this.parens.has(this.arena.owner(node)); }
  target(node) {
    if (node.type !== 'Identifier' && node.type !== 'MemberExpression') this.fail('assignment-pattern', node.start);
    if (node.type === 'Identifier' && (node.name === 'eval' || node.name === 'arguments')) this.fail('strict-assignment', node.start);
  }
  semi() {
    if (this.lexer.eat(';')) return this.lexer.lastEnd;
    const next = this.lexer.peek();
    if (next.kind !== 'eof' && next.kind !== '}' && !next.line) this.fail('semicolon', next.start);
    return this.lexer.lastEnd;
  }
  // Only fixed six-field fragments are serialized. Parent pages are edges,
  // never a native ancestry array. A failed/released parse leaves unreachable
  // pages for the store's existing collection, not rooted continuation owners.
  saveFrame() {
    let page = 0, fields = [], edges = [];
    const flush = () => {
      if (!fields.length) return;
      if (page) edges.push(page);
      page = this.store.put({ kind: 'js-frame', next: page, fields }, edges);
      this.metrics.jsGrammarFrameWrites = (this.metrics.jsGrammarFrameWrites || 0) + 1;
      fields = []; edges = [];
    };
    for (const key in this.frame) {
      const value = this.frame[key];
      // Grammar opcodes/punctuation are fixed short strings. Keeping those
      // inline in a <=6-field scratch page avoids repeated SQL leaf writes;
      // history-sized strings still use the existing immutable leaf contract.
      const ref = typeof value === 'string' && value.length <= 32 ? { type: 'js-frame-text', value } : this.arena.encode(value);
      fields.push([key, ref]);
      if (ref.type === 'page') edges.push(ref.id);
      if (fields.length === 6) flush();
    }
    flush(); return page;
  }
  clearFrame() { for (const key in this.frame) delete this.frame[key]; }
  call(op, values, resume) {
    // These productions carry the surrounding [In] parameter. A cover group
    // retains it for a possible arrow body, while its items explicitly use
    // +In. Other productions introduce their own expression context (lists,
    // object/class keys, templates, bindings inside patterns, block bodies).
    if (this.frame.noIn && ['expr','variable','binding','group','yield'].includes(op) && !Object.hasOwn(values, 'noIn')) values.noIn = true;
    this.frame.pc = resume;
    const parent = this.saveFrame(); this.clearFrame();
    this.frame.op = op; this.frame.pc = 0; this.frame.parent = parent;
    for (const key in values) this.frame[key] = values[key];
    this.depth++;
  }
  ret(value) {
    let page = this.frame.parent;
    this.clearFrame(); this.depth--;
    if (!page) { this.result = value; this.done = true; return; }
    while (page) {
      const record = this.store.json(page);
      if (!record || record.kind !== 'js-frame' || !Array.isArray(record.fields)
        || record.fields.length > 6 || !Number.isSafeInteger(record.next) || record.next < 0) {
        throw Object.assign(new Error('history_js_frame_corrupt'), { code: 'history_js_frame_corrupt' });
      }
      for (const [key, ref] of record.fields) this.frame[key] = ref.type === 'js-frame-text' ? ref.value : this.arena.decode(ref);
      page = record.next;
    }
    this.frame.value = value;
  }
  newScope(parent, kind) { return this.arena.record({ parent, kind, names: this.arena.make('map') }); }
  declare(node, kind) {
    if (node.type !== 'Identifier') this.fail('binding-pattern', node.start);
    const name = node.name;
    if (name === 'eval' || name === 'arguments' || typeof name === 'string' && (STRICT.has(name) || KEYWORDS.has(name))) this.fail('strict-binding', node.start);
    let scope = this.scope;
    if (kind === 'param') {
      if (scope.names.has(name)) this.rejectBinding('duplicate-parameter', node.start);
      scope.names.set(name, 8); return;
    }
    const lexical = kind === 'const' || kind === 'let' || kind === 'using' || kind === 'await using'
      || kind === 'class' || kind === 'function' && scope.kind !== 'function';
    if (lexical) {
      if (scope.names.has(name)) this.rejectBinding('duplicate-lexical', node.start);
      scope.names.set(name, 2); return;
    }
    for (;;) {
      const existing = scope.names.get(name) || 0;
      if (existing & 2) this.rejectBinding('var-lexical-conflict', node.start);
      scope.names.set(name, existing | 1);
      if (scope.kind === 'program' || scope.kind === 'function') break;
      scope = scope.parent;
    }
  }
  arrow(params, start, async, resume) {
    for (const param of params) extended.pattern(this, param, true);
    this.lexer.expect('=>');
    // A concise body inherits [In] from the arrow's enclosing assignment
    // expression, not from the +In expressions used to parse its cover head.
    // A braced body starts a fresh statement context in the body production.
    this.call('function-body', { params, start, async, arrow: true, id: null, noIn: !!this.frame.noIn }, resume);
  }
  run() {
    while (!this.done) {
      const f = this.frame, l = this.lexer;
      let count = 0;
      for (const key in f) count++;
      this.metrics.maxJsGrammarRegisterFields = Math.max(this.metrics.maxJsGrammarRegisterFields || 0, count);
      this.metrics.maxJsGrammarDepthOnDisk = Math.max(this.metrics.maxJsGrammarDepthOnDisk || 0, this.depth);
      this.metrics.maxJsCommentQueueOnDisk = Math.max(this.metrics.maxJsCommentQueueOnDisk || 0, l.commentStack.length);
      this.metrics.jsGrammarSteps = (this.metrics.jsGrammarSteps || 0) + 1;
      probe('register', this.arena, f);
      switch (f.op) {
        case 'body': {
          if (f.pc === 0) {
            f.body = this.arena.make('array'); f.dirs = this.arena.make('array');
            if (!f.program) {
              l.expect('{');
              if (!f.functionBody) { f.oldScope = this.scope; this.scope = this.newScope(this.scope, 'block'); }
            }
            f.pc = 1;
          }
          if (f.pc === 2) {
            const statement = f.value; delete f.value;
            if (f.directives && statement.type === 'ExpressionStatement' && statement.expression.type === 'StringLiteral'
              && !this.parenthesized(statement.expression)) {
              const literal = statement.expression;
              // Babel converts the completed statement/literal nodes in place.
              // Keeping the owners also preserves comment attachment aliases.
              literal.type = 'DirectiveLiteral'; literal.value = this.raw.get(this.arena.owner(literal));
              statement.type = 'Directive'; statement.value = literal; delete statement.expression;
              f.dirs.push(statement);
            } else { f.directives = false; f.body.push(statement); }
            f.pc = 1;
          }
          if (l.is(f.close)) {
            let end;
            if (f.program) end = this.source.length;
            else end = l.take().end;
            const node = f.program ? this.node('Program', 0, end, { sourceType: 'module', interpreter: l.interpreter, body: f.body, directives: f.dirs })
              : f.staticBlock ? this.node('StaticBlock', f.start, end, { body: f.body })
              : this.node('BlockStatement', f.start, end, { body: f.body, directives: f.dirs });
            if (f.oldScope) this.scope = f.oldScope;
            if (f.program) { extended.finishCover(this); extended.finishModule(this); this.comments.finish(); }
            this.ret(node); break;
          }
          if (l.is('eof')) this.fail('unterminated-body');
          this.call('statement', { topLevel: !!f.program }, 2); break;
        }
        case 'statement': {
          if (f.pc === 1) { this.ret(f.value); break; }
          if (f.pc === 2) {
            if (f.value.type === 'Identifier' && l.is(':')) {
              l.take(); this.call('label', { start: f.start, label: f.value }, 1); break;
            }
            extended.settleLabels(this, false);
            if (f.value.type === 'FunctionExpression' && f.value.async && !this.parenthesized(f.value) && f.value.start === f.start) {
              if (!f.value.id) this.fail('async-declaration-name', f.start);
              this.declare(f.value.id, 'function'); f.value.type = 'FunctionDeclaration'; this.ret(f.value); break;
            }
            const node = this.node('ExpressionStatement', f.start, this.semi(), { expression: f.value }); this.ret(node); break;
          }
          if (f.pc === 3) { const node = this.node('ReturnStatement', f.start, this.semi(), { argument: f.value }); this.ret(node); break; }
          const token = l.peek(); f.start = token.start;
          if (token.kind !== 'name') extended.settleLabels(this, ['for','while','do'].includes(token.kind));
          if (token.kind === ';') { l.take(); this.ret(this.node('EmptyStatement', token.start, token.end, {})); break; }
          if (token.kind === '{') { this.call('body', { start: token.start, close: '}', directives: false }, 1); break; }
          if (token.kind === 'const' || token.kind === 'var' || token.kind === 'name' && token.value === 'let') {
            if (token.escaped) this.fail('escaped-declaration', token.start);
            l.take(); this.call('variable', { start: token.start, kind: token.value || token.kind }, 1); break;
          }
          const resource = extended.resourceKind(this, token, false);
          if (resource) {
            extended.consumeResource(this, resource);
            this.call('variable', { start: token.start, kind: resource }, 1); break;
          }
          if (token.kind === 'function') { l.take(); this.call('function', { start: token.start, declaration: true, async: false }, 1); break; }
          if (token.kind === 'class') { l.take(); this.call('class', { start: token.start, declaration: true }, 1); break; }
          if (extended.statement(this, token)) break;
          if (token.kind === 'return') {
            if (!(this.context & 1)) this.fail('return-context', token.start);
            l.take(); const next = l.peek();
            if (next.line || next.kind === ';' || next.kind === '}' || next.kind === 'eof') {
              this.ret(this.node('ReturnStatement', token.start, this.semi(), { argument: null })); break;
            }
            this.call('expr', { min: 1 }, 3); break;
          }
          if (token.kind === 'for') { l.take(); this.call('for', { start: token.start }, 1); break; }
          if (token.kind !== 'name' && KEYWORDS.has(token.kind) && !['this','super','import','new','null','true','false','typeof','void','delete'].includes(token.kind)) this.fail('statement-production', token.start);
          this.call('expr', { min: 1 }, 2); break;
        }
        case 'variable': {
          if (f.pc === 0) { f.list = this.arena.make('array'); f.pc = 1; }
          if (f.pc === 1) {
            this.call('binding', { defaults: false }, 3); break;
          }
          if (f.pc === 3) {
            f.id = f.value; delete f.value; extended.declarePattern(this, f.id, f.kind);
            if ((f.kind === 'using' || f.kind === 'await using') && f.id.type !== 'Identifier') this.fail('resource-pattern', f.id.start);
            if (l.eat('=')) { this.call('expr', { min: 2 }, 2); break; }
            if ((f.kind === 'const' || f.kind === 'using' || f.kind === 'await using' || f.id.type !== 'Identifier') && !f.forHead) this.fail('const-initializer', f.id.start);
            f.value = null; f.pc = 2;
          }
          if (f.pc === 2) {
            f.list.push(this.node('VariableDeclarator', f.id.start, f.value ? this.end(f.value) : f.id.end, { id: f.id, init: f.value }));
            delete f.value; delete f.id;
            if (l.eat(',')) { f.pc = 1; break; }
            const end = f.forHead ? l.lastEnd : this.semi();
            this.ret(this.node('VariableDeclaration', f.start, end, { declarations: f.list, kind: f.kind })); break;
          }
          break;
        }
        case 'function': {
          if (f.pc === 3) { this.ret(f.value); break; }
          if (f.pc === 0) {
            f.generator = l.eat('*');
            f.id = l.is('name') ? this.name(l.take()) : null;
            if (f.declaration) { if (!f.id && !f.anonymous) this.fail('function-name'); if (f.id) this.declare(f.id, 'function'); }
            f.oldContext = this.context;
            this.context = (f.async ? 3 : 1) | (f.generator ? 4 : 0) | 64;
            l.expect('('); this.call('params', {}, 1); break;
          }
          this.context = f.oldContext;
          this.call('function-body', { start: f.start, id: f.id, params: f.value, async: f.async, generator: f.generator, declaration: f.declaration }, 3);
          break;
        }
        case 'function-body': {
          if (f.pc === 0) {
            f.oldScope = this.scope; f.oldContext = this.context;
            f.oldLabels = this.labels; this.labels = this.arena.make('array');
            this.scope = this.newScope(this.scope, 'function');
            this.context = (f.async ? 3 : 1) | (f.generator ? 4 : 0) | (f.arrow ? f.oldContext & 120 : 64);
            if (f.id && !f.declaration && (f.id.name === 'eval' || f.id.name === 'arguments')) this.fail('strict-function-name', f.id.start);
            for (const param of f.params) extended.declarePattern(this, param, 'param');
            if (l.is('{')) this.call('body', { start: l.peek().start, close: '}', directives: true, functionBody: true }, 1);
            else if (f.arrow) this.call('expr', { min: 2 }, 1);
            else this.fail('function-body');
            break;
          }
          this.scope = f.oldScope; this.context = f.oldContext; this.labels = f.oldLabels;
          extended.checkParameters(this, f.params, f.value);
          this.ret(this.node(f.arrow ? 'ArrowFunctionExpression' : f.declaration ? 'FunctionDeclaration' : 'FunctionExpression', f.start, this.end(f.value),
            { id: f.id, generator: !!f.generator, async: !!f.async, params: f.params, body: f.value })); break;
        }
        default: if (!extended.step(this)) this.expressionStep();
      }
    }
    return this.result;
  }

  expressionStep() {
    const f = this.frame, l = this.lexer;
    // Expression productions below share the same one-register driver.
    switch (f.op) {
      case 'expr': {
        if (f.pc === 0 && f.pcResume) { delete f.pcResume; f.pc = 2; }
        if (f.pc === 1) { f.left = f.value; delete f.value; f.pc = 2; }
        if (f.pc === 3) {
          const argument = f.value; delete f.value;
          if (f.operator === 'delete' && argument.type === 'Identifier') this.fail('strict-delete', argument.start);
          if (f.operator === 'delete' && argument.property?.type === 'PrivateName') this.fail('delete-private', argument.start);
          const update = f.operator === '++' || f.operator === '--'; if (update) this.target(argument);
          f.left = this.node(f.operator === 'await' ? 'AwaitExpression' : update ? 'UpdateExpression' : 'UnaryExpression', f.start, this.end(argument),
            f.operator === 'await' ? { argument } : { operator: f.operator, prefix: true, argument });
          delete f.operator; f.pc = 2;
        }
        if (f.pc === 4) {
          const property = f.value; delete f.value; const end = l.expect(']').end;
          f.left = extended.member(this, f.left, property, true, end, !!f.optional); delete f.optional; f.pc = 2;
        }
        if (f.pc === 5) {
          const args = f.value; delete f.value;
          f.left = extended.callNode(this, f.left, args, l.lastEnd, !!f.optional); delete f.optional; f.pc = 2;
        }
        if (f.pc === 6) {
          const right = f.value; delete f.value;
          const op = f.operator, assignment = ASSIGN.has(op), logical = op === '||' || op === '&&' || op === '??';
          if (logical) {
            for (const node of [f.left, right]) if (!this.parenthesized(node) && node.type === 'LogicalExpression'
              && (op === '??' && node.operator !== '??' || op !== '??' && node.operator === '??')) this.fail('nullish-mixing', node.start);
          }
          f.left = this.node(assignment ? 'AssignmentExpression' : logical ? 'LogicalExpression' : 'BinaryExpression', this.start(f.left), this.end(right),
            { operator: op, left: f.left, right }); delete f.operator; f.pc = 2;
        }
        if (f.pc === 7) {
          f.sequence.push(f.value); delete f.value;
          if (l.eat(',')) { this.call('expr', { min: 2 }, 7); return; }
          f.left = this.node('SequenceExpression', this.start(f.sequence[0]), this.end(f.sequence[f.sequence.length - 1]), { expressions: f.sequence });
          delete f.sequence; f.pc = 2;
        }
        if (f.pc === 8) { f.consequent = f.value; delete f.value; l.expect(':'); this.call('expr', { min: 2 }, 9); return; }
        if (f.pc === 9) {
          f.left = this.node('ConditionalExpression', this.start(f.left), this.end(f.value), { test: f.left, consequent: f.consequent, alternate: f.value });
          delete f.value; delete f.consequent; f.pc = 2;
        }
        if (f.pc === 10) { f.left = this.node('ArrayExpression', f.start, l.lastEnd, { elements: f.value }); delete f.value; f.pc = 2; }
        if (f.pc === 11) { f.left = this.node('TaggedTemplateExpression', this.start(f.left), f.value.end, { tag: f.left, quasi: f.value }); delete f.value; f.pc = 2; }
        if (f.pc === 0) {
          const token = l.peek(), op = token.kind === 'name' ? token.value : token.kind; f.start = token.start;
          if (token.kind === 'name' && token.value === 'yield' && !token.escaped && (this.context & 4)) {
            if (f.min > 2) this.fail('yield-precedence', token.start);
            l.take(); this.call('yield', { start: token.start }, 1); return;
          }
          if (UNARY.has(op)) {
            // new's callee and a class heritage are LeftHandSideExpression,
            // not UnaryExpression. Parenthesized operands enter group instead.
            if (f.min >= 17) this.rejectBinding('lhs-unary', token.start);
            if (token.escaped) this.fail('escaped-operator', token.start);
            if (op === 'await' && this.context && !(this.context & 2)) this.fail('await-context', token.start);
            l.take(); f.operator = op; this.call('expr', { min: 15 }, 3); return;
          }
          if (token.kind === 'number' || token.kind === 'bigint' || token.kind === 'string') { l.take(); f.left = this.literal(token); f.pc = 2; }
          else if (token.kind === 'null' || token.kind === 'true' || token.kind === 'false' || token.kind === 'this') {
            l.take(); f.left = this.node(token.kind === 'this' ? 'ThisExpression' : token.kind === 'null' ? 'NullLiteral' : 'BooleanLiteral', token.start, token.end,
              token.kind === 'true' || token.kind === 'false' ? { value: token.kind === 'true' } : {}); f.pc = 2;
          } else if (token.kind === '/' || token.kind === '/=') {
            const regex = l.regexp(token.start); f.left = this.node('RegExpLiteral', token.start, regex.end, { pattern: regex.pattern, flags: regex.flags }); f.pc = 2;
          } else if (token.kind === '(') { l.take(); this.call('group', { start: token.start, allowArrow: f.min <= 2 }, 1); return; }
          else if (token.kind === '[') { l.take(); this.call('list', { close: ']', array: true }, 10); return; }
          else if (token.kind === '{') { l.take(); this.call('object', { start: token.start }, 1); return; }
          else if (token.kind === '`') { l.take(); this.call('template', { start: token.start, tagged: false }, 1); return; }
          else if (token.kind === 'function') { l.take(); this.call('function', { start: token.start, async: false }, 1); return; }
          else if (token.kind === 'class') { l.take(); this.call('class', { start: token.start, declaration: false }, 1); return; }
          else if (token.kind === 'import') { l.take(); this.call('import-expression', { start: token.start, end: token.end }, 1); return; }
          else if (token.kind === 'super') {
            if (!(this.context & 8)) this.fail('super-context', token.start);
            l.take(); f.left = this.node('Super', token.start, token.end, {}); f.pc = 2;
          }
          else if (token.kind === '#') {
            if (f.min > 10 || f.noIn) this.fail('private-brand-context', token.start);
            f.left = extended.privateName(this, true);
            if (!l.is('in')) this.fail('private-brand-in', token.start); f.pc = 2;
          }
          else if (token.kind === 'new') { l.take(); this.call('new', { start: token.start }, 1); return; }
          else if (token.kind === 'name') {
            l.take(); const id = this.name(token), next = l.peek();
            if (token.value === 'async' && !token.escaped && !next.line) {
              if (next.kind === 'function') { this.comments.reset(id); l.take(); this.call('function', { start: token.start, async: true }, 1); return; }
              if (next.kind === 'name' && !(f.noIn && next.value === 'of'
                && !l.operatorAt(l.lookahead(next.end, false), '=>'))) {
                if (f.min > 2) this.fail('async-arrow-precedence', token.start);
                const params = this.arena.make('array'); params.push(this.name(l.take()));
                this.arrow(params, token.start, true, 1); return;
              }
              if (next.kind === '(' && !f.noCall) { l.take(); this.call('group', { start: next.start, asyncStart: token.start, asyncCallee: id, allowArrow: f.min <= 2 }, 1); return; }
            }
            f.left = id; f.pc = 2;
          } else this.fail('expression-production', token.start);
        }
        if (f.pc !== 2) return;
        const token = l.peek(), op = token.kind;
        // These are completed assignment/expression productions, not atoms
        // on which another call/member/operator may be attached. In
        // particular a braced arrow body and a line-terminated bare yield
        // must return to their caller before it decides delimiters or ASI.
        // Parentheses explicitly re-enter the primary-expression grammar;
        // an enclosing Expression can still collect comma-separated items.
        if (['ArrowFunctionExpression','YieldExpression','AssignmentExpression','ConditionalExpression','SequenceExpression'].includes(f.left.type)
          && !this.parenthesized(f.left) && !(op === ',' && f.min === 1)) { this.ret(f.left); return; }
        if (op === '=>') {
          if (f.min > 2 || token.line || f.left.type !== 'Identifier' || this.parenthesized(f.left)) this.fail('arrow-cover', token.start);
          const params = this.arena.make('array'); params.push(f.left); this.arrow(params, f.left.start, false, 1); return;
        }
        if (op === '?.' && f.min <= 17) {
          if (f.noCall || f.left.type === 'Super') this.fail('optional-chain-context', token.start);
          l.take();
          if (l.eat('[')) { f.optional = true; this.call('expr', { min: 1, noIn: false }, 4); return; }
          if (l.eat('(')) { f.optional = true; this.call('list', { close: ')' }, 5); return; }
          const property = l.is('#') ? extended.privateName(this, true) : this.name(l.take(), true);
          f.left = extended.member(this, f.left, property, false, property.end, true); return;
        }
        if (op === '.' && f.min <= 17) {
          l.take(); const property = l.is('#') ? extended.privateName(this, true) : this.name(l.take(), true);
          f.left = extended.member(this, f.left, property, false, property.end, false); return;
        }
        if (op === '[' && f.min <= 17) { l.take(); this.call('expr', { min: 1, noIn: false }, 4); return; }
        if (op === '(' && f.min <= 17 && !f.noCall) { l.take(); this.call('list', { close: ')' }, 5); return; }
        if (op === '`' && f.min <= 17) { if (extended.chain(this, f.left)) this.fail('optional-tag', token.start); l.take(); this.call('template', { start: token.start, tagged: true }, 11); return; }
        if ((op === '++' || op === '--') && !token.line && f.min <= 16) {
          this.target(f.left); l.take(); f.left = this.node('UpdateExpression', this.start(f.left), token.end, { operator: op, prefix: false, argument: f.left }); return;
        }
        const precedence = op === 'in' && f.noIn ? 0 : ASSIGN.has(op) ? 2 : PRECEDENCE[op];
        if (!precedence || precedence < f.min) {
          if (f.left.type === 'Super' && !(f.noCall && op === '(' && this.context & 16)) this.fail('bare-super', f.left.start);
          this.ret(f.left); return;
        }
        l.take();
        if (op === ',') { f.sequence = this.arena.make('array'); f.sequence.push(f.left); this.call('expr', { min: 2 }, 7); return; }
        if (op === '?') { this.call('expr', { min: 2, noIn: false }, 8); return; }
        if (ASSIGN.has(op)) { if (op === '=') extended.pattern(this, f.left, false); else this.target(f.left); }
        if (op === '**' && !this.parenthesized(f.left) && (f.left.type === 'UnaryExpression' || f.left.type === 'AwaitExpression')) this.fail('unary-exponent', token.start);
        f.operator = op;
        this.call('expr', { min: precedence + (ASSIGN.has(op) || op === '**' ? 0 : 1) }, 6); return;
      }
      case 'group': {
        if (f.pc === 0) { f.items = this.arena.make('array'); f.pc = 1; }
        if (f.pc === 2 || f.pc === 4) {
          const value = f.pc === 4 ? this.node('SpreadElement', f.spread, this.end(f.value), { argument: f.value }) : f.value;
          f.items.push(value); delete f.value;
          if (!l.is(')')) {
            l.expect(','); f.trailing = l.is(')');
            if (value.type === 'SpreadElement') this.restCommas.add(this.arena.owner(value));
          }
          f.pc = 1;
        }
        if (f.pc === 3) { this.ret(f.value); return; }
        if (l.eat(')')) {
          const end = l.lastEnd;
          if (l.is('=>') && !l.peek().line) {
            if (!f.allowArrow) this.fail('group-arrow-precedence', f.start);
            this.arrow(f.items, f.asyncStart ?? f.start, f.asyncStart !== undefined, 3); return;
          }
          if (f.asyncCallee) {
            this.ret(this.node('CallExpression', f.asyncStart, end, { callee: f.asyncCallee, arguments: f.items })); return;
          }
          if (!f.items.length || f.trailing || f.items.some(item => item.type === 'SpreadElement')) this.fail('parenthesized-expression', f.start);
          const node = f.items.length === 1 ? f.items[0] : this.node('SequenceExpression', this.start(f.items[0]), this.end(f.items[f.items.length - 1]), { expressions: f.items });
          this.parens.set(this.arena.owner(node), this.arena.record({ start: f.start, end })); this.comments.surround(node, f.start, end); this.ret(node); return;
        }
        if (l.is('...')) { f.spread = l.take().start; this.call('expr', { min: 2, noIn: false }, 4); return; }
        this.call('expr', { min: 2, noIn: false }, 2); return;
      }
      case 'list': {
        if (f.pc === 0) { f.items = this.arena.make('array'); f.pc = 1; }
        if (f.pc === 2 || f.pc === 3) {
          const value = f.pc === 3 ? this.node('SpreadElement', f.spread, this.end(f.value), { argument: f.value }) : f.value;
          f.items.push(value); delete f.value;
          if (!l.is(f.close)) {
            l.expect(',');
            if (value.type === 'SpreadElement') this.restCommas.add(this.arena.owner(value));
          }
          f.pc = 1;
        }
        if (l.eat(f.close)) { this.ret(f.items); return; }
        if (f.array && l.eat(',')) { f.items.push(null); return; }
        if (l.is('...')) { f.spread = l.take().start; this.call('expr', { min: 2 }, 3); return; }
        this.call('expr', { min: 2 }, 2); return;
      }
      case 'object': {
        if (f.pc === 0) { f.items = this.arena.make('array'); f.proto = 0; f.pc = 1; }
        if (f.pc === 2) { f.key = f.value; delete f.value; l.expect(']'); f.pc = 3; }
        if (f.pc === 4) {
          const property = this.node('ObjectProperty', f.propertyStart, this.end(f.value), { method: false, key: f.key, computed: f.computed, shorthand: false, value: f.value });
          f.items.push(property); delete f.value; delete f.key; f.pc = 5;
        }
        if (f.pc === 6) { f.items.push(this.node('SpreadElement', f.propertyStart, this.end(f.value), { argument: f.value })); delete f.value; f.pc = 5; }
        if (f.pc === 7) { f.items.push(f.value); delete f.value; delete f.key; f.pc = 5; }
        if (f.pc === 8) {
          const left = this.arena.assign(f.key); left.range = undefined;
          const value = this.node('AssignmentPattern', left.start, this.end(f.value), { left, right: f.value });
          f.items.push(this.node('ObjectProperty', f.propertyStart, value.end,
            { method: false, key: f.key, computed: false, shorthand: true, value }));
          f.proto |= 4; delete f.value; delete f.key; f.pc = 5;
        }
        if (f.pc === 5) {
          if (!l.is('}')) {
            l.expect(','); const last = f.items[f.items.length - 1];
            if (last.type === 'SpreadElement') this.restCommas.add(this.arena.owner(last));
          }
          f.pc = 1;
        }
        if (f.pc === 1) {
          if (l.eat('}')) {
            const node = this.node('ObjectExpression', f.start, l.lastEnd, { properties: f.items });
            if (f.proto & 6) this.coverChecks.push(this.arena.record({ node, flags: f.proto }));
            this.ret(node); return;
          }
          f.propertyStart = l.peek().start;
          if (l.eat('...')) { this.call('expr', { min: 2 }, 6); return; }
          f.generator = l.eat('*'); f.computed = l.eat('[');
          if (f.computed) { this.call('expr', { min: 2 }, 2); return; }
          f.key = this.property(); f.pc = 3;
        }
        if (f.pc === 3) {
          if (extended.objectMethod(this)) return;
          if (l.eat(':')) {
            const key = f.key.type === 'Identifier' ? f.key.name : f.key.value;
            if (!f.computed && text.equal(key, '__proto__')) { if (f.proto & 1) f.proto |= 2; f.proto |= 1; }
            this.call('expr', { min: 2 }, 4); return;
          }
          if (!f.computed && f.key.type === 'Identifier' && (l.is(',') || l.is('}') || l.is('='))) {
            const name = f.key.name;
            if (typeof name === 'string' && (KEYWORDS.has(name) || STRICT.has(name))) this.fail('shorthand-name', f.key.start);
            if (l.eat('=')) { this.call('expr', { min: 2 }, 8); return; }
            const value = this.arena.assign(f.key); value.range = undefined;
            f.items.push(this.node('ObjectProperty', f.propertyStart, f.key.end, { method: false, key: f.key, computed: false, shorthand: true, value }));
            delete f.key; f.pc = 5; return;
          }
          this.fail('object-method-or-pattern', f.propertyStart);
        }
        return;
      }
      case 'template': {
        if (f.pc === 0) { f.quasis = this.arena.make('array'); f.expressions = this.arena.make('array'); f.pc = 1; }
        if (f.pc === 2) { f.expressions.push(f.value); delete f.value; l.expect('}'); f.pc = 1; }
        const quasi = l.quoted(f.start, true);
        if (quasi.invalid && !f.tagged) this.fail('untagged-invalid-escape', quasi.start);
        l.lastEnd = l.pos;
        const node = this.node('TemplateElement', quasi.start, l.lastEnd,
          { value: this.arena.record({ raw: quasi.raw, cooked: quasi.value }), tail: quasi.tail });
        node.end = quasi.end; f.quasis.push(node);
        if (quasi.tail) { this.ret(this.node('TemplateLiteral', f.start, l.lastEnd, { expressions: f.expressions, quasis: f.quasis })); return; }
        this.call('expr', { min: 1 }, 2); return;
      }
      case 'new': {
        if (f.pc === 0) {
          if (l.eat('.')) {
            const token = l.take();
            if (token.kind !== 'name' || token.value !== 'target' || token.escaped || !(this.context & 96)) this.fail('new-target-context', f.start);
            const meta = this.node('Identifier', f.start, f.start + 3, { name: 'new' });
            this.ret(this.node('MetaProperty', f.start, token.end, { meta, property: this.name(token) })); return;
          }
          if (l.is('import') && l.at(l.lookahead(l.peek().end, false)) === '(') this.rejectBinding('new-import', f.start);
          this.call('expr', { min: 17, noCall: true }, 1); return;
        }
        if (f.pc === 1) {
          f.callee = f.value; delete f.value;
          if (l.eat('(')) { this.call('list', { close: ')' }, 2); return; }
          f.value = this.arena.make('array'); f.pc = 2;
        }
        this.ret(this.node('NewExpression', f.start, l.lastEnd, { callee: f.callee, arguments: f.value })); return;
      }
      default: throw Object.assign(new Error('history_js_production'), { code: 'history_js_production' });
    }
  }
}

function parsePagedJsProgram(source, arena) { return new PagedJsGrammar(source, arena).run(); }
module.exports = { parsePagedJsProgram, PagedJsGrammar };
