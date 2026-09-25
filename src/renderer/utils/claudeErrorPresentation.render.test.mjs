import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const React = require('react');
const icons = require('lucide-react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = fs.readFileSync(new URL('../components/Workspace/AgentLifecycleActions.tsx', import.meta.url), 'utf8');
const module = { exports: {} };
new Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)(
  name => name === 'react' ? React : name === 'lucide-react' ? icons : assert.fail(name), module, module.exports);
const Actions = module.exports.default;

test('actual lifecycle actions are icon-only, transparent, aligned and preserve composer focus', () => {
  let retries = 0, dismissed = 0, prevented = 0, stopped = 0;
  const lifecycle = { kind: 'error', onRetry: () => retries++, onDismiss: () => dismissed++ };
  const buttons = React.Children.toArray(Actions({ lifecycle }).props.children);
  assert.equal(buttons.length, 2);
  const event = { preventDefault: () => prevented++, stopPropagation: () => stopped++ };
  for (const button of buttons) {
    assert.equal(button.props.style.background, 'transparent');
    assert.equal(button.props.style.width, 16);
    assert.equal(button.props.style.height, 16);
    assert.equal(button.props.style.alignItems, 'center');
    assert.equal(button.props.style.lineHeight, 0);
    assert.ok(button.props.title && button.props['aria-label']);
    assert.notEqual(typeof button.props.children, 'string');
    button.props.onMouseDown(event);
  }
  assert.equal(prevented, 2);
  buttons[0].props.onClick(event);
  buttons[0].props.onClick(event);
  assert.equal(retries, 2, 'each click calls the existing retry owner; no extra submission');
  buttons[1].props.onClick(event);
  assert.equal(retries, 2);
  assert.equal(dismissed, 1);
  assert.equal(stopped, 3);
  const html = renderToStaticMarkup(React.createElement(Actions, { lifecycle }));
  assert.doesNotMatch(html, />RETRY|>Retry|>×/);
  assert.equal(Actions({ lifecycle: null }), null);
  assert.equal(Actions({ lifecycle: { kind: 'starting' } }), null);
});

test('actual History error row uses service chrome and escaped complete provider reason', () => {
  const file = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('HistoryPanel.tsx', file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'HistoryInterruptedRow') expression = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(expression);
  const compiled = transformSync('const row = ' + expression, { loader: 'tsx', format: 'cjs' }).code;
  const Row = new Function('React', 'ConversationMessage', 'SlidersHorizontal', compiled + '\nreturn row;')(
    React, props => React.createElement('section', { 'data-uuid': props.entryUuid }, props.children), icons.SlidersHorizontal);
  const entry = { uuid: 'error-a', role: 'provider-error', content: 'API error: 403 <denied> · model not changed' };
  const html = renderToStaticMarkup(React.createElement(Row, { entry }));
  assert.match(html, /hp-history-provider-error/);
  assert.match(html, /403 &lt;denied&gt; · model not changed/);
  assert.doesNotMatch(html, /cb-user-bubble|<denied>/);
  assert.match(file, /\.hp-history-provider-error \{ color: #b87946; \}/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(Row, { entry: { ...entry, role: 'interrupted' } })), /hp-history-provider-error/);
});

test('an intentionally compact error does not fall back to a ready-to-send tooltip', () => {
  const file = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('HistoryPanel.tsx', file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'terminalStatusDescription') expression = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const project = new Function('unifiedTransientStatus', 'activeLifecycle', 'basicStatusDescription', 'status', 'return ' + expression);
  assert.equal(project(null, { description: '' }, { active: 'Ready to send' }, 'active'), '');
  assert.equal(project(null, null, { active: 'Ready to send' }, 'active'), 'Ready to send');
});
