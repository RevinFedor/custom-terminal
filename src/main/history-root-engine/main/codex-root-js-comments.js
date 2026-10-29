'use strict';

// Babel 7.29.3 CommentsParser attachment algorithm, adapted to arena owners.
// The comments, whitespace records and attachment lists never form native
// arrays. Keep the same aliases and visits: both old consumers traverse typed
// comments, so merely dropping comments can change their 30,000-node policy.
// See codex-root-js-babel.LICENSE for the upstream license.
class PagedJsComments {
  constructor(arena, lexer) { this.arena = arena; this.lexer = lexer; }
  attach(node, key, comments) {
    const previous = node[key];
    if (previous === undefined) { node[key] = comments; return; }
    const count = comments.length, length = previous.length;
    for (let i = length - 1; i >= 0; i--) previous[i + count] = previous[i];
    for (let i = 0; i < count; i++) previous[i] = comments[i];
  }
  inner(node, elements, whitespace) {
    let last = null, i = elements.length;
    while (last === null && i > 0) last = elements[--i];
    this.attach(last === null || last.start > whitespace.start ? node : last,
      last === null || last.start > whitespace.start ? 'innerComments' : 'trailingComments', whitespace.comments);
  }
  finalize(whitespace) {
    if (whitespace.leadingNode !== null || whitespace.trailingNode !== null) {
      if (whitespace.leadingNode !== null) this.attach(whitespace.leadingNode, 'trailingComments', whitespace.comments);
      if (whitespace.trailingNode !== null) this.attach(whitespace.trailingNode, 'leadingComments', whitespace.comments);
    } else if (whitespace.containingNode !== null) {
      const node = whitespace.containingNode;
      if (this.lexer.at(whitespace.start - 1) === ',') {
        const type = node.type;
        if (type === 'ObjectExpression' || type === 'ObjectPattern' || type === 'RecordExpression') this.inner(node, node.properties, whitespace);
        else if (type === 'CallExpression' || type === 'NewExpression' || type === 'OptionalCallExpression') this.inner(node, node.arguments, whitespace);
        else if (type === 'FunctionDeclaration' || type === 'FunctionExpression' || type === 'ArrowFunctionExpression'
          || type === 'ObjectMethod' || type === 'ClassMethod' || type === 'ClassPrivateMethod') this.inner(node, node.params, whitespace);
        else if (type === 'ArrayExpression' || type === 'ArrayPattern' || type === 'TupleExpression') this.inner(node, node.elements, whitespace);
        else if (type === 'ExportNamedDeclaration' || type === 'ImportDeclaration') this.inner(node, node.specifiers, whitespace);
        else this.attach(node, 'innerComments', whitespace.comments);
      } else this.attach(node, 'innerComments', whitespace.comments);
    }
  }
  process(node) {
    const stack = this.lexer.commentStack, length = stack.length;
    if (!length) return node;
    let i = length - 1, last = stack[i];
    if (last.start === node.end) { last.leadingNode = node; i--; }
    for (; i >= 0; i--) {
      const whitespace = stack[i], end = whitespace.end;
      if (end > node.start) {
        whitespace.containingNode = node; this.finalize(whitespace); stack.splice(i, 1);
      } else {
        if (end === node.start) whitespace.trailingNode = node;
        break;
      }
    }
    return node;
  }
  finish() {
    const stack = this.lexer.commentStack;
    for (let i = stack.length - 1; i >= 0; i--) this.finalize(stack[i]);
    stack.length = 0;
  }
  reset(node) {
    const stack = this.lexer.commentStack;
    if (stack.length && this.arena.same(stack[stack.length - 1].leadingNode, node)) stack[stack.length - 1].leadingNode = null;
  }
  surround(node, start, end) {
    const stack = this.lexer.commentStack;
    for (let i = stack.length - 1; i >= 0; i--) {
      const whitespace = stack[i];
      if (whitespace.start === end) whitespace.leadingNode = node;
      else if (whitespace.end === start) whitespace.trailingNode = node;
      else if (whitespace.end < start) break;
    }
  }
}

module.exports = { PagedJsComments };
