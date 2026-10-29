import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';

const path = process.env.CODEX_CONTROL_SOURCE || new URL('../components/Workspace/ClaudeControlBar.tsx', import.meta.url);
const source = fs.readFileSync(path, 'utf8');
const tree = ts.createSourceFile('bar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let button;
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'button'
    && node.openingElement.attributes.properties.some(attr => ts.isJsxAttribute(attr)
      && attr.name.getText(tree) === 'data-agent-setting-trigger' && attr.initializer?.text === 'model')) button = node;
  ts.forEachChild(node, visit);
}
visit(tree); assert.ok(button, 'actual model trigger');
const compiled = ts.transpileModule('globalThis.renderModel = () => (' + button.getText(tree) + ');',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;

test('a Main-owned in-flight model selection is a red-hover cancel click', () => {
  let cancels = 0;
  const context = vm.createContext({ React, modelSpinning: true, modelCanCancel: true,
    settingsWriteBusy: true, modelBlocked: true, codexModelMenuDisabled: true, triggerStyle: {},
    triggerRefs: { current: {} }, forceResetBusy: () => { cancels++; }, triggerProps: () => ({}),
    busyCancelHover: false, setBusyCancelHover: value => { context.busyCancelHover = value; },
    modelActiveId: 'gpt-6.1-terra', modelLabel: 'GPT-6.1 Terra', pinnedPopup: null,
    claudeModelProofNeedsAttention: false, ControlBusySpinner: () => null });
  vm.runInContext(compiled, context);
  let element = context.renderModel();
  assert.equal(element.props.disabled, false, 'the in-flight control must actually accept the cancellation click');
  element.props.onMouseEnter(); element = context.renderModel();
  assert.equal(element.props.style.backgroundColor, 'rgba(220,38,38,0.14)');
  assert.equal(React.Children.toArray(element.props.children).find(child => child.type === context.ControlBusySpinner).props.hovered, true);
  element.props.onClick(); assert.equal(cancels, 1);
});
