import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const terminalArea = readFileSync(join(here, 'TerminalArea.tsx'), 'utf8');
const chrome = readFileSync(join(here, 'SplitPaneChrome.tsx'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test('vacant pane stays a real pointer-focus target', () => {
  const vacant = between(
    terminalArea,
    'splitPanes.forEach((pane, paneIndex) => {\n      if (!isEmptyPane(pane)) return;',
    '\n    for (const tabId of tabLayerNodeCacheRef.current.keys())',
  );
  assert.match(vacant, /data-terminal-pane-wrapper="empty"/);
  assert.match(vacant, /data-pane-event-index=\{paneIndex\}/);
  assert.match(vacant, /data-split-pane-index=\{paneIndex\}/);
  assert.match(vacant, /data-split-pane-hover-frame/);
  assert.match(vacant, /transition: 'none'/);
  assert.match(vacant, /<SplitPaneFocusFrame focused=\{focusedPane\}/);
});

test('vacant pane uses the canonical window navbar instead of a reduced copy', () => {
  const vacant = between(
    terminalArea,
    'splitPanes.forEach((pane, paneIndex) => {\n      if (!isEmptyPane(pane)) return;',
    '\n    for (const tabId of tabLayerNodeCacheRef.current.keys())',
  );
  assert.match(vacant, /<SplitPaneAttachRow[\s\S]*?tabId=""[\s\S]*?vacant/);
  // Двойной клик по свободному месту шапки — ОДИН жест на все окна: он
  // открывает место со страницей выбора (NWT-1). Прямой запуск терминала
  // стоял здесь prop'ом и выигрывал у общего обработчика полосы, поэтому в
  // пустом окне тот же жест молча поднимал shell.
  assert.match(vacant, /onCreateTab=\{\(\) => useWorkspaceStore\.getState\(\)\.openWindowTabChooser\(paneIndex\)\}/);
  assert.doesNotMatch(vacant, /onCreateTab=\{\(\) => launchIntoEmptyPane\(/,
    'создание МЕСТА не подменяется прямым запуском терминала');
  // `×` закрывает окно целиком, вместе со всеми его местами.
  assert.match(vacant, /onCloseVacantPane=\{\(\) => useWorkspaceStore\.getState\(\)\.closeWindowPane\(paneIndex\)\}/);
  // Явный «Терминал» полосы запуска остаётся отдельной кнопкой.
  assert.match(vacant, /onLaunch=\{\(action\) => \{ void launchIntoEmptyPane\(paneIndex, action\); \}\}/);
  assert.doesNotMatch(vacant, /<PaneTabStrip/,
    'TerminalArea must not grow a second, reduced pane-navbar implementation');
});

test('canonical navbar renders vacancy without a tab and keeps strip menu/create/close capabilities', () => {
  const attach = between(
    chrome,
    'export function SplitPaneAttachRow({',
    '\n/** Above every surface a pane can host',
  );
  assert.match(attach, /if \(!tabExists && !vacant\) return null/);
  assert.match(attach, /shownTabId=\{vacant \? '' : tabId\}/);
  assert.match(attach, /onCreateTab=\{onCreateTab \|\| createTabInThisWindow\}/);
  assert.match(attach, /data-vacant-pane-parked-count=\{vacant \? entries\.length : undefined\}/);
  assert.match(attach, /data-vacant-pane-label/);
  assert.match(attach, /data-vacant-pane-close/);
  assert.match(attach, /data-split-strip-menu-button/,
    'the same ellipsis/settings owner must remain present');
  assert.match(attach, /\{!vacant && <div[\s\S]*?data-split-strip-menu-item="timeline"/,
    'tab-owned Timeline action must not pretend an empty pane has a tab');
});
