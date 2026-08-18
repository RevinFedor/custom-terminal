// Одно правило, три места: элемент не меняет свой размер и своё место из-за
// того, что изменилось его СОДЕРЖИМОЕ или соседнее окно.
//
// Симптомы у всех трёх были разные, а причина одна — размер считался по тому,
// что показывают ПРЯМО СЕЙЧАС:
//
//   • карточка вкладки подпрыгивала на время переименования: поле ввода больше
//     подписи, которую оно заменяет, а высоту карточки задаёт содержимое;
//   • кнопка расхода памяти дёргала весь правый край тулбара: «980 МБ» и
//     «1.02 ГБ» — разной ширины, а число обновляется само;
//   • полоска Run after уезжала влево на ширину бокового окна при каждом ⌘].
//
// Лечится одинаково: место резервируется заранее — по самому длинному варианту,
// по коробке заменяемой подписи, либо просто не отдаётся под чужое окно.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => fs.readFileSync(path.join(here, ...parts), 'utf8');

const tabBar = read('TabBar.tsx');
const resourceButton = read('ResourceUsageButton.tsx');
const terminal = read('Terminal.tsx');
const overlay = read('PromptQueueOverlay.tsx');

test('поле переименования занимает ту же коробку, что подпись вкладки', () => {
  // Раньше у поля были свои 13px шрифта, свои вертикальные отступы (py-0.5) и
  // рамка В ПОТОКЕ — вместе это делало карточку выше на время правки, и весь
  // список под ней сдвигался.
  //
  // `font: inherit` забирает и размер, и межстрочный интервал целиком; рамка
  // рисуется тенью, а тень не занимает места в раскладке.
  const inputs = tabBar.match(/className="bg-\[#333\][^"]*"/g) || [];
  assert.equal(inputs.length, 2, 'полей переименования два: вкладка и группа');
  for (const cls of inputs) {
    assert.ok(!/py-/.test(cls), 'вертикальных отступов у поля быть не должно: ' + cls);
    assert.ok(!/border /.test(cls), 'рамка в потоке меняет высоту: ' + cls);
  }
  const withInheritedFont = tabBar.match(/font: 'inherit',\s*\n\s*padding: '0 4px',\s*\n\s*border: 'none',\s*\n\s*boxShadow: 'inset 0 0 0 1px var\(--color-accent\)'/g) || [];
  assert.equal(withInheritedFont.length, 2, 'обе правки — по одному правилу');
});

test('кнопка расхода памяти держит ширину самого длинного числа', () => {
  // Значение меняется само, каждые несколько секунд. Если ширину задаёт текущее
  // значение, всё, что стоит справа, ездит без участия пользователя.
  // Мерка — по самой длинной подписи, какая ЗДЕСЬ бывает, и не шире: лишний
  // запас не виден сам по себе, виден только промежуток, который он оставляет
  // между значком и числом.
  assert.match(resourceButton, /RESOURCE_CHIP_VALUE_WIDTH_CH = '6\.6ch'/);
  assert.match(resourceButton, /minWidth: RESOURCE_CHIP_VALUE_WIDTH_CH/);
  // `ch` меряется цифрой шрифта, а одинаковой ширины цифры даёт tabular-nums:
  // без него мерка врала бы на пропорциональных цифрах.
  assert.match(resourceButton, /fontVariantNumeric: 'tabular-nums'/);
  // Число прижато вправо: разряды не должны прыгать при смене длины.
  assert.match(resourceButton, /justifyContent: 'flex-end'/);
});

test('Run after больше не отходит от бокового окна, но отходит от Timeline', () => {
  // Боковое окно закрывается одной клавишей и у полоски есть свёрнутый вид —
  // отступать ей не от чего. Timeline же не окно, а колонка: поверх неё полоску
  // было бы просто не видно, поэтому этот отступ остаётся.
  assert.match(terminal, /const promptQueueRightInset = resolveTimelineInset\(sharedInsetArgs\);/);
  // Кнопки, привязанные к самому терминалу, считают по-прежнему полный отступ —
  // они в другой коробке, и её правый край боковое окно реально закрывает.
  assert.match(terminal, /const terminalArrowRightInset = resolveCenterRightInset\(\{/);
});

test('у полоски Run after нет внутренних отступов — место занимают кнопки', () => {
  const rail = overlay.slice(overlay.indexOf('className="pq-collapsed-rail"'));
  const head = rail.slice(0, rail.indexOf('>'));
  assert.match(head, /padding: 0,/);
  assert.ok(!/padding: '3px 5px'/.test(head), 'старые отступы рейла удалены');
  // Кнопки выросли ровно на освободившееся: полоска той же высоты, но теперь
  // это кнопки, а не воздух вокруг них.
  assert.match(overlay, /\.pq-rail-button \{[\s\S]{0,400}?height: 26px;/);
});
