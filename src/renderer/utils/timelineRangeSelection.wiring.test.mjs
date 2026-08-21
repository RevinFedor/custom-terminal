import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const timelinePath = fileURLToPath(new URL('../components/Workspace/Timeline.tsx', import.meta.url));
const source = fs.readFileSync(timelinePath, 'utf8');

test('single-entry menu splits Select and Copy without duplicating range state', () => {
  const splitStart = source.indexOf('data-testid="timeline-range-selection-split"');
  const splitEnd = source.indexOf('<div className="border-t border-white/10 my-1" />', splitStart);
  const split = source.slice(splitStart, splitEnd);

  assert.ok(splitStart >= 0 && splitEnd > splitStart, 'split control is present');
  assert.match(split, /data-testid="timeline-range-selection-start"/);
  assert.match(split, /style=\{\{ flex: '4 1 0%'/);
  assert.match(split, /startRangeSelection\(contextMenu\.entry\)/);
  assert.match(split, />\s*Выбрать\s*<\/button>/);
  assert.match(split, /style=\{\{ flex: '1 1 0%'/);
  assert.match(split, /handleCopySingleEntry\(contextMenu\.entry\)/);
  assert.match(split, /<Copy size=\{12\} \/>/);
});

test('an active range consumes the second click before Timeline navigation', () => {
  const selectionBranchStart = source.indexOf('if (selectionStartIdRef.current) {');
  const navigationStart = source.indexOf('const index = entries.findIndex', selectionBranchStart);
  const selectionBranch = source.slice(selectionBranchStart, navigationStart);

  assert.ok(selectionBranchStart >= 0, 'existing range-selection state machine is present');
  assert.ok(navigationStart > selectionBranchStart, 'navigation follows the selection branch');
  assert.match(selectionBranch, /e\?\.preventDefault\(\);/);
  assert.match(selectionBranch, /e\?\.stopPropagation\(\);/);
  assert.match(selectionBranch, /setRangeActionMenu\(\{/);
  assert.match(selectionBranch, /return;/);
  assert.match(source, /if \(readOnly && !selectionStartIdRef\.current\)/,
    'read-only navigation yields to an already active range selection');
});

test('пометка правого клика живёт ровно столько, сколько открытое меню', () => {
  // Точка красится в момент правого клика, чтобы было видно, про какую запись
  // меню. Закрылось меню — красить нечего: пометку снимает ОДИН переход
  // «было открыто → закрылось», а не каждое из мест закрытия по отдельности
  // (их дюжина: уход курсора, клик мимо, любое выполненное действие).
  const at = source.indexOf('const contextMenuWasOpenRef');
  assert.ok(at >= 0, 'переход открыто→закрыто отслеживается');
  const block = source.slice(at, at + 400);
  assert.match(block, /if \(contextMenuWasOpenRef\.current && !contextMenu\) setContextSelectedEntryId\(null\);/);
  assert.match(block, /contextMenuWasOpenRef\.current = !!contextMenu;/);
  assert.match(block, /\}, \[contextMenu\]\);/);

  // Ставится пометка по-прежнему в правом клике и по-прежнему ДО выхода для
  // read-only: там меню не открывается, и видимая цель — единственный ответ
  // жеста.
  const rc = source.indexOf('const handleRightClick =');
  const rcBlock = source.slice(rc, source.indexOf('setContextMenu({ x: 0, y, entry, anchorY });', rc));
  const mark = rcBlock.indexOf('setContextSelectedEntryId(entry.uuid)');
  const bail = rcBlock.indexOf('if (readOnly) return;');
  assert.ok(mark >= 0 && bail > mark, 'пометка ставится до выхода для read-only');
});
