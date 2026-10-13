import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';

const source = fs.readFileSync(new URL('./SettingsModal.tsx', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
const functions = ['LineNumbersToggle', 'SessionStatusesEditor'].map(name => {
  const node = ast.program.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node); return source.slice(node.start, node.end);
}).join('\n');

test('task title visibility uses the actual shared sound switch; its setter and other status settings stay separate', () => {
  for (const showTitles of [true, false]) {
    const writes = [];
    const state = { sessionStatuses: [], taskStatuses: [], statusMarker: { sizePx: 8 },
      taskStatusMarker: { sizePx: 8, showTitles }, setTaskStatusMarker: patch => writes.push(patch) };
    const context = { React, module: { exports: {} }, Tooltip: props => props.children,
      StatusColumnEditor: () => null, useUIStore: selector => selector(state) };
    vm.runInNewContext(transformSync(functions + '\nmodule.exports = {LineNumbersToggle,SessionStatusesEditor};', {
      loader: 'tsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', format: 'cjs',
    }).code, context);
    const { LineNumbersToggle, SessionStatusesEditor } = context.module.exports;
    const columns = SessionStatusesEditor().props.children;
    const extra = columns[1].props.extraControl.props.children;
    assert.equal(extra.type, LineNumbersToggle, 'same implementation as System sound, not a copied toggle');
    const tree = LineNumbersToggle(extra.props), switchElement = tree.props.children[0];
    assert.equal(switchElement.type, 'button'); assert.equal(switchElement.props.role, 'switch');
    assert.equal(switchElement.props['aria-checked'], showTitles);
    assert.match(switchElement.props.className, /w-8 h-4 rounded-full/);
    assert.equal(switchElement.props.style.border, 0);
    const html = renderToStaticMarkup(tree);
    assert.match(html, /Показывать названия задач/); assert.doesNotMatch(html, /type="checkbox"/);
    assert.deepEqual(writes, []); switchElement.props.onClick();
    assert.equal(writes.length, 1); assert.equal(writes[0].showTitles, !showTitles);
    assert.deepEqual(Object.keys(writes[0]), ['showTitles']);
  }
});
