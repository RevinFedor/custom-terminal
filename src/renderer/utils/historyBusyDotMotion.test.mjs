import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '../..');
const panel = fs.readFileSync(
  path.join(repoRoot, 'renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

/**
 * Точка, бегущая по периметру кнопки терминала, — индикатор «идёт работа».
 *
 * Инцидент 2026-08-18: у пользователя включена системная настройка «Уменьшать
 * движение», а в стилях панели точка под неё ГАСИЛАСЬ и подменялась неподвижным
 * кружком. Кнопка выглядела одинаково в работе и в покое — сигнал пропадал
 * целиком («он просто на одном месте, никакой анимации нет»).
 *
 * Настройка просит убрать ИЗБЫТОЧНОЕ движение, а не единственный индикатор
 * состояния. Поэтому здесь проверяется ровно граница: декоративное движение
 * гасить можно, движение-сигнал — нельзя.
 */

const reduceMotionBlock = () => {
  const start = panel.indexOf('@media (prefers-reduced-motion: reduce) {');
  assert.ok(start >= 0, 'блок reduced-motion должен существовать');
  // Блок заканчивается на строке с одиночной закрывающей скобкой без отступа.
  const end = panel.indexOf('\n}\n', start);
  assert.ok(end > start);
  return panel.slice(start, end);
};

test('индикатор занятости не замирает под «Уменьшать движение»', () => {
  const block = reduceMotionBlock();
  assert.doesNotMatch(
    block,
    /hp-terminal-perimeter-loader-dot/,
    'движущаяся точка не имеет права гаситься: её движение и есть сигнал',
  );
  assert.doesNotMatch(
    block,
    /hp-terminal-perimeter-loader-static/,
    'подмена неподвижным кружком делает работу неотличимой от покоя',
  );
});

test('неподвижной подмены не осталось нигде', () => {
  // Мёртвая ветка вернула бы баг при первой же правке стилей.
  assert.doesNotMatch(panel, /hp-terminal-perimeter-loader-static/);
});

test('декоративное движение под настройкой по-прежнему гасится', () => {
  // Правило не «игнорировать настройку», а «различать сигнал и украшение».
  const block = reduceMotionBlock();
  assert.match(block, /\.hp-owner-transition-spin \{\s*\n\s*animation: none;/);
});

test('сама точка и её движение на месте', () => {
  assert.match(panel, /className="hp-terminal-perimeter-loader-dot"/);
  assert.match(panel, /offset-path: path\("M10 3 H16/);
  assert.match(panel, /animation: hp-terminal-perimeter-travel 1\.45s linear infinite/);
  assert.match(panel, /@keyframes hp-terminal-perimeter-travel/);
});

test('у точки есть видимое состояние покоя', () => {
  // Замерено в Chromium: если анимация по любой причине не идёт, точка на
  // траектории из стилей остаётся в НАЧАЛЕ пути — на видном месте у верхнего
  // края иконки. Прежний способ (движение атрибутом SVG) оставлял бы её в самом
  // углу системы координат, где её фактически не видно: «занят» тогда пропадает
  // целиком, а не просто перестаёт двигаться.
  //
  // Отсюда запрет на собственные координаты у точки: они сложились бы со
  // смещением по траектории и увели бы её с пути.
  const start = panel.indexOf('className="hp-terminal-perimeter-loader-dot"');
  const dot = panel.slice(start, panel.indexOf('/>', start));
  assert.ok(dot.length > 0);
  assert.doesNotMatch(dot, /\bcx=/, 'координаты точки задаёт траектория, а не разметка');
  assert.doesNotMatch(dot, /\bcy=/, 'координаты точки задаёт траектория, а не разметка');
  assert.doesNotMatch(panel, /<animateMotion/, 'движение атрибутом SVG не имеет состояния покоя');
});
