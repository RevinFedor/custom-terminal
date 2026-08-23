import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'PaneTabStrip.tsx'), 'utf8');

test('opt-in reveal читает committed rect и settle идёт passive-effect без layout-state feedback', () => {
  assert.match(source, /autoReveal = false/);
  assert.match(source, /if \(!autoReveal \|\| !targetTabId \|\| wrap\) return/);
  assert.match(source, /getBoundingClientRect\(\)/);
  assert.match(source, /desiredOverflowKeyRef\.current = key;\s*setOverflow\(\{ left, right, leftIds: next\.hiddenLeftIds, rightIds: next\.hiddenRightIds \}\)/);
  assert.match(source, /paneStripOverflowStateKey\(\{[\s\S]{0,220}hiddenLeftIds: next\.hiddenLeftIds,[\s\S]{0,120}hiddenRightIds: next\.hiddenRightIds/);
  assert.doesNotMatch(source, /useLayoutEffect\([\s\S]{0,120}measure\(\)/,
    'workspace switch must not force strip geometry during the React commit');
  assert.match(source, /const entriesRef = useRef\(entries\)/);
  assert.match(source, /entriesRef\.current = entries/);
  assert.match(source, /const entriesKey = entries\.map/);
  assert.match(source, /useEffect\(\(\) => \{[\s\S]{0,900}pendingRevealRef\.current[\s\S]{0,700}\}, \[autoReveal, overflow, revealChip, wrap\]\)/);
  assert.match(source, /revealSettlePassRef\.current > 4/);
  assert.match(source, /new ResizeObserver\(\(\) => \{\s*measure\(\);\s*\}\)/);
  assert.match(source, /ro\.observe\(el\)/);
  assert.match(source, /querySelectorAll<HTMLElement>\('\[data-strip-item\]'\)\.forEach\(\(chip\) => ro\.observe\(chip\)\)/);
  assert.match(source, /\}, \[entriesKey, kindsKey, measure\]\)/);
  assert.doesNotMatch(source, /ResizeObserver[\s\S]{0,180}revealChip/);
  assert.doesNotMatch(source, /useLayoutEffect\([^\n]*overflow|\[measure,[^\]]*overflow/);
  assert.doesNotMatch(source, /desiredOverflowRef|committedOverflowRef/);
  assert.doesNotMatch(source, /setTimeout\s*\(/);
  assert.doesNotMatch(source, /marginPx/);
  assert.doesNotMatch(source, /viewportWidth:[^\n]*endInsetPx|clientWidth[^\n]*endInsetPx/);
  assert.doesNotMatch(source, /\[kindOfTab, overflow, wrap\]/);
  assert.match(source, /autoRevealShownRef\.current === shownTabId/);
  assert.doesNotMatch(source, /const paneFocused =|\[shownTabId, inStrip, paneFocused/,
    'focus/width changes only measure overflow; they never reset manual scroll');
  assert.match(source, /const focusPaneAfterHeaderClick = \(\) => \{/);
  assert.match(source, /scrollBy\(-1\);\s*focusPaneAfterHeaderClick\(\)/);
  assert.match(source, /scrollBy\(1\);\s*focusPaneAfterHeaderClick\(\)/);
});

test('wrap-mode не запускает reveal и не возвращает overflow badges', () => {
  assert.match(source, /if \(!el \|\| !targetTabId \|\| wrap\) return/);
  assert.match(source, /if \(wrap \|\| !inStrip\) \{[\s\S]*left: \[\], right: \[\], leftIds: \[\], rightIds: \[\][\s\S]*return/);
});

test('красная сумма скрытых ошибок берётся из общего счётчика уведомлений', () => {
  // Рамка чипа и сумма в «×N» обязаны отвечать одним числом: два источника
  // разошлись бы на первом же изменении правил показа уведомлений.
  assert.match(source, /hiddenToastOwnerCounts\(s\.toasts, \[shownTabId\]\)/);
  assert.match(source, /hiddenToastCountForChips\(counts, overflow\.leftIds\)/);
  assert.match(source, /hiddenToastCountForChips\(counts, overflow\.rightIds\)/);
  // Селектор отдаёт ПАРУ ЧИСЕЛ строкой, а не список уведомлений: подписка на
  // массив перерисовывала бы полосу на каждое всплывающее сообщение.
  assert.match(source, /const hiddenErrorsKey = useUIStore\(\(s\) => \{/);
  assert.match(source, /errorCount=\{leftErrors\}/);
  assert.match(source, /errorCount=\{rightErrors\}/);
  assert.match(source, /data-strip-overflow-errors=\{errorCount\}/);
});
