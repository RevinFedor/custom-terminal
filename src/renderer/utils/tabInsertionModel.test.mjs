import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveTabInsertionIndex } from './tabInsertionModel.mjs';

test('Terminal MCP child appends after every manually ordered tab', () => {
  assert.equal(resolveTabInsertionIndex({
    tabIds: ['manual-first', 'parent', 'manual-tail'],
    appendToEnd: true,
    referenceTabId: 'parent',
  }), 3);
});

test('ordinary adjacent creation still inserts after its reference tab', () => {
  assert.equal(resolveTabInsertionIndex({
    tabIds: ['first', 'current', 'tail'],
    referenceTabId: 'current',
  }), 2);
});

test('group anchor placement and missing references preserve existing fallbacks', () => {
  assert.equal(resolveTabInsertionIndex({
    tabIds: ['first', 'anchor', 'tail'],
    groupAnchorTabId: 'anchor',
  }), 1);
  assert.equal(resolveTabInsertionIndex({
    tabIds: ['first', 'tail'],
    referenceTabId: 'closed-tab',
  }), 2);
});

test('Project API agent-tab bridge requests tail placement without dropping visual parentage', () => {
  const appPath = fileURLToPath(new URL('../App.tsx', import.meta.url));
  const source = readFileSync(appPath, 'utf8');
  const branchStart = source.indexOf("if (action === 'createAgentTab')");
  const branchEnd = source.indexOf("if (action === 'startAgentTab')", branchStart);
  const branch = source.slice(branchStart, branchEnd > branchStart ? branchEnd : undefined);

  assert.ok(branchStart >= 0, 'createAgentTab bridge branch must exist');
  assert.match(branch, /appendToEnd:\s*true/);
  assert.match(branch, /visualParentTabId:\s*requestedVisualParentId/);
  assert.match(branch, /state\.createTabAfterCurrent\(projectId, explicitName, cwd, createOptions\)/);
});
