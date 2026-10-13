import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = fs.readFileSync(new URL('./SettingsModal.tsx', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
const sections = new Map();
function walk(node, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, ancestors); return; }
  if (node.type === 'JSXElement') {
    const attr = node.openingElement.attributes.find(attr => attr.name?.name === 'data-settings-section');
    if (attr?.value?.value) sections.set(attr.value.value, { node, ancestors });
  }
  for (const [key, value] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) walk(value, [...ancestors, node]);
  }
}
walk(ast);
const part = node => source.slice(node.start, node.end);

function renderPolicies(overrides = {}) {
  const section = sections.get('model-behavior');
  assert.ok(section, 'the always-visible settings section exists');
  const calls = [];
  const context = {
    module: { exports: {} }, React, modelSettingsExpanded: false,
    defaultCodexModel: 'gpt-6-astra', defaultCodexEffort: 'max',
    defaultCodexEfforts: ['low', 'max'], selectedDefaultCodexModel: { id: 'gpt-6-astra' },
    codexModelsForSettings: [{ id: 'gpt-6-astra', label: 'Astra' }],
    codexEffortOptions: [], codexResumePausedGoal: true, codexUsageExhaustionPolicy: 'continue',
    vrFieldStyle: {}, compactEffortLabel: value => value, effortLabel: (_options, value) => value,
    setSettingsDefaultCodexModel: value => calls.push(['model', value]),
    setDefaultCodexEffort: value => calls.push(['effort', value]),
    setCodexResumePausedGoal: value => calls.push(['goal', value]),
    setCodexUsageExhaustionPolicy: value => calls.push(['usage', value]),
    ...overrides,
  };
  const compiled = transformSync('module.exports = (' + part(section.node) + ');', {
    loader: 'tsx', format: 'cjs', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
  }).code;
  vm.runInNewContext(compiled, context);
  const tree = context.module.exports;
  const controls = new Map();
  function visit(element) {
    if (!React.isValidElement(element)) return;
    if (element.type === 'select') controls.set(element.props['data-testid'], element.props);
    React.Children.forEach(element.props.children, visit);
  }
  visit(tree);
  return { tree, controls, calls, html: renderToStaticMarkup(tree) };
}

test('the catalog keeps its collapse, while model policies are the next unconditional section', () => {
  const catalog = sections.get('model-settings');
  const behavior = sections.get('model-behavior');
  assert.ok(catalog && behavior);
  assert.match(part(catalog.node), /Настройки model\/f/);
  assert.match(part(catalog.node), /data-settings-models-toggle/);
  assert.match(part(catalog.node), /modelSettingsExpanded &&/);
  assert.ok(behavior.node.start > catalog.node.end);
  assert.equal(catalog.ancestors.at(-1), behavior.ancestors.at(-1), 'both sections share their layout owner');
  for (const ancestor of behavior.ancestors) {
    if (ancestor.type === 'LogicalExpression') assert.doesNotMatch(part(ancestor.left), /modelSettingsExpanded/);
    if (ancestor.type === 'ConditionalExpression') assert.doesNotMatch(part(ancestor.test), /modelSettingsExpanded/);
  }
  assert.doesNotMatch(part(behavior.node), /modelSettingsExpanded|aria-expanded|onClick=/);
  assert.doesNotMatch(part(catalog.node), /codex-resume-goal-policy|codex-usage-exhaustion-policy|codex-default-model/);
});

test('all three settings remain rendered when the catalog is collapsed or expanded', () => {
  for (const modelSettingsExpanded of [false, true]) {
    const { tree, controls, html } = renderPolicies({ modelSettingsExpanded });
    assert.equal(tree.props.style.order, -1, 'the section follows the catalog before other System sections');
    assert.equal(controls.size, 4, 'default model/effort and two independent policies');
    for (const text of ['Настройки моделей', 'По умолчанию', 'При восстановлении сессии', 'Когда исчерпан лимит Codex']) {
      assert.ok(html.includes(text));
    }
    assert.equal(controls.get('codex-resume-goal-policy').value, 'resume');
    assert.equal(controls.get('codex-usage-exhaustion-policy').value, 'continue');
  }
});

test('moved controls preserve saved values and call the same setters without mount writes', () => {
  const { controls, calls } = renderPolicies({ codexResumePausedGoal: false, codexUsageExhaustionPolicy: 'stop-all' });
  assert.deepEqual(calls, []);
  assert.equal(controls.get('codex-resume-goal-policy').value, 'paused');
  assert.equal(controls.get('codex-usage-exhaustion-policy').value, 'stop-all');
  for (const [id, value] of [
    ['codex-default-model', 'gpt-6-sol'], ['codex-default-effort', 'low'],
    ['codex-resume-goal-policy', 'resume'], ['codex-resume-goal-policy', 'paused'],
    ['codex-usage-exhaustion-policy', 'continue'], ['codex-usage-exhaustion-policy', 'stop-all'],
  ]) controls.get(id).onChange({ currentTarget: { value } });
  assert.deepEqual(calls, [
    ['model', 'gpt-6-sol'], ['effort', 'low'], ['goal', true], ['goal', false],
    ['usage', 'continue'], ['usage', 'stop-all'],
  ]);
});

test('no default model keeps effort disabled and the existing empty-value normalization', () => {
  const { controls, calls } = renderPolicies({ defaultCodexModel: 'none', defaultCodexEffort: 'none', selectedDefaultCodexModel: null });
  assert.equal(controls.get('codex-default-model').value, '');
  assert.equal(controls.get('codex-default-effort').value, '');
  assert.equal(controls.get('codex-default-effort').disabled, true);
  controls.get('codex-default-model').onChange({ currentTarget: { value: '' } });
  controls.get('codex-default-effort').onChange({ currentTarget: { value: '' } });
  assert.deepEqual(calls, [['model', ''], ['effort', 'none']]);
});
