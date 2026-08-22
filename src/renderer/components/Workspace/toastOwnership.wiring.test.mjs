// Уведомление принадлежит ВКЛАДКЕ, а не окну приложения.
//
// Правило держит `utils/toastPlacement.mjs` (и его модельные тесты); здесь —
// проводка: что в углу приложения остались только общие сообщения, что про
// невидимую ошибку говорит чип, и что рамка чипа и красная сумма в счётчике
// скрытых считаются ОДНИМ числом.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..', '..');
const toast = fs.readFileSync(path.join(rendererRoot, 'components/UI/Toast.tsx'), 'utf8');
const chip = fs.readFileSync(path.join(here, 'PaneTabChip.tsx'), 'utf8');
const strip = fs.readFileSync(path.join(here, 'PaneTabStrip.tsx'), 'utf8');
const area = fs.readFileSync(path.join(here, 'TerminalArea.tsx'), 'utf8');

test('в углу приложения — только уведомления БЕЗ вкладки', () => {
  // Раньше сюда падало и уведомление невидимой вкладки: считалось, что потерять
  // сообщение хуже, чем показать не на месте. Оказалось наоборот — плашка про
  // невидимую работу вставала поверх окна, к которому не относится.
  assert.match(toast, /const visibleToasts = toasts\.filter\(\(t\) => isToastVisible\(t, visibleTabIds\) && !t\.tabId\)/);
  assert.doesNotMatch(toast, /const windowToasts/);
});

test('уведомление видимой вкладки живёт в якоре ЕЁ окна', () => {
  assert.match(toast, /resolveToastHostTabId\(t, visibleTabIds\) === tabId/);
  assert.match(toast, /data-toast-anchor-tab-id="\$\{tabId\}"/);
  // Якорь ставит TerminalArea рядом с каждой поверхностью вкладки, ниже шапки
  // этого окна — измеренной, а не предсказанной (в переносе шапка выше).
  assert.match(area, /data-toast-anchor-tab-id=\{tab\.id\}/);
  assert.match(area, /TAB_SURFACE_HEADER_HEIGHT_VAR/);
});

test('про ошибку невидимой вкладки говорит её ЧИП', () => {
  assert.match(chip, /const hiddenErrorCount = useUIStore\(\(s\) => \(/);
  // Селектор возвращает ЧИСЛО: подписка на список уведомлений перерисовывала бы
  // каждый чип на любое всплывающее сообщение приложения.
  assert.match(chip, /shown \? 0 : s\.toasts\.reduce\(/);
  assert.match(chip, /toast\.tabId === tabId && isErrorToast\(toast\)/);
  // Рамка, а не значок: в узком чипе значок спорил бы за место с меткой статуса
  // и полосой квадратов задач.
  assert.match(chip, /border: hiddenErrorCount > 0\s*\?\s*'1px solid #f87171'/);
});

test('красная сумма в счётчике ×N считается тем же числом, что рамка', () => {
  assert.match(strip, /hiddenToastOwnerCounts\(s\.toasts, \[shownTabId\]\)/);
  assert.match(strip, /hiddenToastCountForChips\(counts, overflow\.leftIds\)/);
  assert.match(strip, /hiddenToastCountForChips\(counts, overflow\.rightIds\)/);
  assert.match(strip, /data-strip-overflow-errors=\{errorCount\}/);
  // Отдельной коробкой, а не внутри столбика видов: «сколько там вкладок» и
  // «сколько там сломалось» — разные новости.
  assert.match(strip, /background: '#dc2626'/);
});
