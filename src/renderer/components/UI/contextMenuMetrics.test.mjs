import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONTEXT_MENU_BLOCK_DIVIDER_STYLE,
  CONTEXT_MENU_COMPACT_ROW_STYLE,
  CONTEXT_MENU_ICON_SLOT_STYLE,
  CONTEXT_MENU_METRICS,
  CONTEXT_MENU_METRICS_HOOK,
  CONTEXT_MENU_PANEL_STYLE,
  CONTEXT_MENU_ROW_STYLE,
  WINDOW_PICKER_METRICS,
  contextMenuEstimatedHeight,
  windowPickerNaturalHeight,
  windowPickerNaturalWidth,
} from './contextMenuMetrics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(here, '..', '..');
const readRenderer = (relativePath) => fs.readFileSync(path.join(renderer, relativePath), 'utf8');

const app = readRenderer('App.tsx');
const tabBar = readRenderer('components/Workspace/TabBar.tsx');
const spaceStrip = readRenderer('components/Workspace/SpaceStrip.tsx');
const runAfterPicker = readRenderer('components/Workspace/RunAfterTabPicker.tsx');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker after: ${start}`);
  return source.slice(from, to);
}

test('dense context-menu geometry has one exact metrics contract', () => {
  assert.deepEqual(CONTEXT_MENU_METRICS, {
    rowHeight: 28,
    compactRowHeight: 26,
    xPadding: 8,
    iconSlot: 16,
    gap: 6,
    radius: 7,
    dividerWidth: 1,
    dividerColor: '#3a3a3a',
    minWidth: 168,
    maxWidth: 280,
    viewportInset: 8,
  });
  assert.equal(CONTEXT_MENU_METRICS_HOOK, 'compact-v1');
  assert.deepEqual(CONTEXT_MENU_ROW_STYLE, {
    boxSizing: 'border-box',
    height: 28,
    minHeight: 28,
    padding: '0 8px',
    columnGap: 6,
    whiteSpace: 'nowrap',
  });
  assert.equal(CONTEXT_MENU_COMPACT_ROW_STYLE.height, 26);
  assert.equal(CONTEXT_MENU_COMPACT_ROW_STYLE.padding, '0 8px');
  assert.equal(CONTEXT_MENU_COMPACT_ROW_STYLE.whiteSpace, 'nowrap');
  assert.equal(CONTEXT_MENU_ICON_SLOT_STYLE.flex, '0 0 16px');
  assert.equal(CONTEXT_MENU_PANEL_STYLE.minWidth, 168);
  assert.equal(CONTEXT_MENU_PANEL_STYLE.maxWidth, 'min(280px, calc(100vw - 16px))');
  assert.equal(CONTEXT_MENU_PANEL_STYLE.borderRadius, 7);
  assert.ok(!Object.hasOwn(CONTEXT_MENU_PANEL_STYLE, 'width'), 'panel width must stay content-driven');
  assert.deepEqual(CONTEXT_MENU_BLOCK_DIVIDER_STYLE, {
    borderTop: '1px solid #3a3a3a',
    borderBottom: '1px solid #3a3a3a',
  });
  assert.equal(contextMenuEstimatedHeight({ rows: 3 }), 86);
  assert.equal(contextMenuEstimatedHeight({ rows: 2, compactRows: 1, dividers: 1 }), 85);
});

test('window picker is row-compact for small layouts and grows into a bounded scroll map', () => {
  assert.deepEqual(WINDOW_PICKER_METRICS, {
    cellHeight: 26,
    gap: 4,
    mapMinWidth: 160,
    columnMinWidth: 70,
    panelMaxWidth: 240,
    viewportMaxHeight: 176,
  });
  // The former fixed map was 104px even for one row. A 26px card is the
  // requested roughly four-times denser common case.
  assert.equal(windowPickerNaturalHeight(1), 26);
  assert.equal(windowPickerNaturalHeight(2), 56);
  assert.equal(windowPickerNaturalHeight(4), 116);
  assert.equal(windowPickerNaturalWidth(1), 160);
  assert.equal(windowPickerNaturalWidth(2), 160);
  assert.equal(windowPickerNaturalWidth(3), 218);
  assert.equal(windowPickerNaturalHeight(Number.NaN), 26);
});

test('tab, project and workflow menus consume the shared metrics and expose hooks', () => {
  for (const [name, source] of [
    ['TabBar', tabBar],
    ['App', app],
    ['SpaceStrip', spaceStrip],
  ]) {
    assert.match(source, /contextMenuMetrics\.mjs/, `${name} bypasses the shared geometry module`);
    assert.match(source, /data-context-menu-metrics=\{CONTEXT_MENU_METRICS_HOOK\}/,
      `${name} does not expose its metrics version`);
    assert.match(source, /CONTEXT_MENU_PANEL_STYLE/, `${name} has local panel geometry`);
    assert.match(source, /CONTEXT_MENU_ROW_STYLE/, `${name} has local row geometry`);
  }

  const projectMenu = between(app, '{/* Project Context Menu */}', 'export default App;');
  assert.match(projectMenu, /data-project-context-menu/);
  assert.match(projectMenu, /data-project-context-pair="close-stop"/);
  assert.match(projectMenu, /data-project-context-action="close"/);
  assert.match(projectMenu, /data-project-context-action="stop"/);
  assert.doesNotMatch(projectMenu, /\bpy-(?:1\.5|2)\b|justify-end|min-w-\[140px\]|51px/);

  const workflowMenu = between(spaceStrip, 'data-workflow-context-menu={id}', 'document.body');
  assert.match(workflowMenu, /data-workflow-context-action="rename"/);
  assert.match(workflowMenu, /data-workflow-context-action="settings"/);
  assert.match(workflowMenu, /data-workflow-context-action="delete"/);
  assert.doesNotMatch(workflowMenu, /width:\s*168|height:\s*28|padding:\s*'0 9px'|\bpy-1\.5\b|51px/);

  const tabMenu = between(tabBar, '{/* Context Menu - styled like terminal context menu */}', '{/* Group context menu */}');
  assert.match(tabMenu, /data-tab-context-menu/);
  assert.match(tabMenu, /data-tab-context-action="add"/);
  assert.match(tabMenu, /data-tab-context-action="rename"/);
  assert.match(tabMenu, /data-tab-context-action="move-to-project"/);
  assert.doesNotMatch(tabMenu, /w-\[240px\]|\bpy-1\.5\b|h-\[51px\]|51px/);
});

test('fork cluster is one compact nowrap flex row', () => {
  const fork = between(tabBar, 'data-tab-fork-split', '{/* Scripts - submenu */}');
  assert.match(fork, /className="flex items-stretch w-full"/);
  assert.match(fork, /style=\{CONTEXT_MENU_BLOCK_DIVIDER_STYLE\}/);
  assert.equal((fork.match(/data-context-menu-row="compact"/g) || []).length, 3);
  assert.equal((fork.match(/style=\{CONTEXT_MENU_COMPACT_ROW_STYLE\}/g) || []).length, 3);
  assert.match(fork, /flex-\[1\.6_1_0%\]/);
  assert.match(fork, /flex-\[0\.7_1_0%\]/);
  assert.match(fork, />Compact Fork</);
  assert.match(fork, />Fork</);
  assert.match(fork, />SDK</);
  assert.doesNotMatch(fork, /grid-cols|whitespace-normal|<br\s*\/?\s*>|\bpy-1\.5\b|51px/);
  assert.equal(CONTEXT_MENU_COMPACT_ROW_STYLE.whiteSpace, 'nowrap');
});

test('embedded Restart after context row uses the same ordinary-row measure', () => {
  const trigger = between(runAfterPicker, 'const renderContextRowTrigger', 'return (');
  assert.match(trigger, /data-context-menu-row="ordinary"/);
  assert.match(trigger, /\.\.\.CONTEXT_MENU_ROW_STYLE/);
  assert.doesNotMatch(trigger, /padding:\s*'6px 12px'|gap:\s*10/);
});
