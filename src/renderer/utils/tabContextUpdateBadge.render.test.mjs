import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RefreshCw } from 'lucide-react';
import { transformSync } from 'esbuild';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../components/Workspace/TabSignals.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('TabSignals.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['tabFastBadgeOutsidePx', 'TabContextUpdateBadge', 'TabTopLeftSignals'];
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(declarations.length, names.length);
function render(gap, active) {
  const context = vm.createContext({ React, RefreshCw,
    useUIStore: select => select({ tabGeometry: { gap } }),
    WORK_CONTEXT_COLOR: 'var(--work-context-accent)', CONTEXT_BADGE_BAR_OVERLAP_PX: 2,
    TAB_FAST_BADGE_SIZE_PX: 11, TAB_FAST_BADGE_OUTSIDE_RATIO: 0.3,
  });
  vm.runInContext(transformSync(declarations.map(node => node.getText(ast).replace(/^export /, '')).join('\n'),
    { loader: 'tsx', format: 'cjs' }).code + '\nthis.Badge = TabContextUpdateBadge;', context);
  return renderToStaticMarkup(React.createElement(context.Badge, { active }));
}

test('context marker is static, purple and bottom-left; no pending update means no badge', () => {
  const html = render(4, true);
  assert.match(html, /left:-2px/);
  assert.match(html, /bottom:-2px/);
  assert.match(html, /var\(--work-context-accent\)/);
  assert.match(html, /data-tab-context-update-marker/);
  assert.doesNotMatch(html, /animation|animate-spin/);
  assert.equal(render(4, false), '');
});

test('tight card spacing keeps the marker out of the next card', () => {
  assert.match(render(0, true), /bottom:1px/);
  assert.match(render(2, true), /bottom:-1px/);
  assert.match(render(16, true), /bottom:-2px/);
});

test('usage and Fast keep their upper lane; both card surfaces reserve the lower slot', () => {
  const top = declarations.find(node => node.name.text === 'TabTopLeftSignals').getText(ast);
  assert.doesNotMatch(top, /RefreshCw|hasContextUpdate|workContext/);
  for (const name of ['TabBar', 'PaneTabChip']) {
    const host = fs.readFileSync(new URL(`../components/Workspace/${name}.tsx`, import.meta.url), 'utf8');
    assert.match(host, /<TabContextUpdateBadge active=\{hasContextUpdate\}/);
    assert.match(host, /TAB_CONTEXT_UPDATE_INSET_PX/);
    assert.match(host, /useTabWorkContext\(tab(?:\.id|Id)\)\.pendingCount > 0/);
  }
});
