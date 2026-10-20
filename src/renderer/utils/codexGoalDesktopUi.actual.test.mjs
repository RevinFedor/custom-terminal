import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(process.env.NOTED_GOAL_UI_SOURCE
  || new URL('../components/Workspace/AgentLifecycleActions.tsx', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs' }).code,
  { module, exports: module.exports, require });
const Actions = module.exports.default;
const lifecycle = (goalActions = {}) => ({ tabId: 'T', kind: 'info', title: 'CODEX GOAL',
  description: 'Goal ждёт выбора', spinner: false, goalActions: {
    operationId: 'op', availableActions: ['resume', 'leave-paused'], ...goalActions,
  } });
const buttons = props => React.Children.toArray(Actions(props).props.children).flatMap(child =>
  child?.type === 'button' ? [child] : child?.props?.children ? React.Children.toArray(child.props.children) : [])
  .filter(child => child?.type === 'button');
const event = () => ({ preventDefault() {}, stopPropagation() {} });

test('actual Goal UI renders compact explicit choices and invokes the actual click callbacks', () => {
  const calls = [];
  const summary = lifecycle({ onChoose: action => calls.push(action) });
  const html = renderToStaticMarkup(React.createElement(Actions, { lifecycle: summary }));
  assert.match(html, /Resume Goal/);
  assert.match(html, /Leave paused/);
  assert.doesNotMatch(html, /width:100%|flex-grow:1/);
  const choices = buttons({ lifecycle: summary }).filter(button => button.props['data-codex-goal-action']);
  assert.equal(choices.length, 2);
  for (const button of choices) button.props.onClick(event());
  assert.deepEqual(calls, ['resume', 'leave-paused']);
});

test('no availableActions means disabled choices, including programmatic stale click; X only dismisses', () => {
  const calls = [];
  const summary = { ...lifecycle({ availableActions: [], onChoose: action => calls.push(action) }),
    onDismiss: () => calls.push('hide') };
  const rendered = buttons({ lifecycle: summary });
  const choices = rendered.filter(button => button.props['data-codex-goal-action']);
  assert.equal(choices.length, 2);
  for (const button of choices) {
    assert.equal(button.props.disabled, true);
    button.props.onClick(event());
  }
  rendered.find(button => 'data-agent-lifecycle-dismiss' in button.props).props.onClick(event());
  assert.deepEqual(calls, ['hide']);
});

test('Check status invokes only a read callback, never either choice', () => {
  const calls = [];
  const summary = lifecycle({ availableActions: [], onChoose: action => calls.push(action), onRefresh: () => calls.push('read') });
  const readButton = buttons({ lifecycle: summary }).find(button => 'data-codex-goal-read' in button.props);
  assert.ok(readButton, 'Unknown Goal exposes a read-only status control');
  readButton.props.onClick(event());
  assert.deepEqual(calls, ['read']);
});
