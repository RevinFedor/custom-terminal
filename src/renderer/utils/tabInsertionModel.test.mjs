import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  resolveSiblingInsertionIndex,
  resolveTabInsertionIndex,
  visualSubtreeIds,
} from './tabInsertionModel.mjs';

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

// ── «Ещё одну ЗДЕСЬ»: сосед после всего поддерева ─────────────────────────

test('новая вкладка встаёт ПОСЛЕ карточки текущей и всего, что внутри неё', () => {
  // parent держит child, child держит grandchild — в списке они идут подряд.
  const tabIds = ['first', 'parent', 'child', 'grandchild', 'tail'];
  const parentOf = { child: 'parent', grandchild: 'child' };
  assert.equal(resolveSiblingInsertionIndex({ tabIds, referenceTabId: 'parent', parentOf }), 4);
  // Обычная вставка «сразу после» разорвала бы карточку родителя пополам.
  assert.equal(resolveTabInsertionIndex({ tabIds, referenceTabId: 'parent' }), 2);
});

test('вкладка без детей ведёт себя как обычная вставка после себя', () => {
  const tabIds = ['a', 'b', 'c'];
  assert.equal(resolveSiblingInsertionIndex({ tabIds, referenceTabId: 'b', parentOf: {} }), 2);
});

test('потомок, лежащий дальше по списку, всё равно учитывается', () => {
  // Порядок в сторе может разойтись с деревом: считаем по фактическим позициям.
  const tabIds = ['parent', 'other', 'child'];
  assert.equal(
    resolveSiblingInsertionIndex({ tabIds, referenceTabId: 'parent', parentOf: { child: 'parent' } }),
    3,
  );
});

test('нет ссылки или её уже закрыли — в конец', () => {
  const tabIds = ['a', 'b'];
  assert.equal(resolveSiblingInsertionIndex({ tabIds, parentOf: {} }), 2);
  assert.equal(resolveSiblingInsertionIndex({ tabIds, referenceTabId: 'gone', parentOf: {} }), 2);
});

test('циклическая ссылка на себя не зацикливает обход', () => {
  const subtree = visualSubtreeIds({ a: 'a', b: 'a' }, 'a');
  assert.deepEqual([...subtree].sort(), ['a', 'b']);
});
