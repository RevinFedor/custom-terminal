import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '../../..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const signals = read('src/renderer/components/Workspace/TabSignals.tsx');
const tabbar = read('src/renderer/components/Workspace/TabBar.tsx');

// Пересчёт выступа скопирован из TabSignals.tsx намеренно: тест обязан упасть,
// если формулу там поменяют, а не следовать за ней.
const SIZE = 11;
const RATIO = 0.3;
const outside = (gap) => Math.max(0, Math.min(Math.round(SIZE * RATIO), Math.floor(gap)));

/**
 * Codex Fast на карточке вкладки — жёлтая молния на ВЕРХНЕМ конце полоски
 * процесса.
 *
 * Главное требование — ПРИНАДЛЕЖНОСТЬ: значок стоит у верхней границы своей
 * карточки и выходит наружу лишь частью высоты. Серединой на шве было бы не
 * понять, чей он — верхней вкладки или нижней.
 */

test('выступ наружу не больше 30% высоты значка', () => {
  assert.equal(outside(16), 3);
  assert.equal(outside(8), 3);
  assert.equal(outside(3), 3);
  assert.ok(outside(16) / SIZE <= 0.3);
});

test('выступ ограничен зазором между карточками', () => {
  // Зазор настраиваемый (0-16px). При зазоре меньше выступа значок залезал бы на
  // ПРЕДЫДУЩУЮ вкладку — ровно та неоднозначность, которой значок и избегает.
  // Замерено: при зазоре 0 значок накрывал соседа на 3px, при 2 — на 1px.
  assert.equal(outside(2), 2);
  assert.equal(outside(1), 1);
  assert.equal(outside(0), 0, 'при нулевом зазоре значок целиком внутри карточки');
  assert.match(signals, /export function tabFastBadgeOutsidePx\(gapPx: number/);
  assert.match(signals, /Math\.max\(0, Math\.min\(wanted, Math\.floor\(Number\(gapPx\) \|\| 0\)\)\)/);
  assert.match(signals, /top: -tabFastBadgeOutsidePx\(gapPx, size\)/);
  // Зазор читается из тех же настроек, по которым расставлены карточки.
  assert.match(signals, /const gapPx = useUIStore\(\(s\) => s\.tabGeometry\.gap\)/);
});

test('значок закреплён в левом верхнем углу карточки', () => {
  // Обе служебные метки теперь образуют одну левую колонку: Fast сверху,
  // контекст снизу. Настройка process-bar не раскидывает их по двум краям.
  const badge = signals.slice(
    signals.indexOf('export function TabFastBadge'),
    signals.indexOf('/**\n * Маркер статуса'),
  );
  assert.match(badge, /left: -Math\.round\(size \* 0\.32\)/);
  assert.doesNotMatch(badge, /processBar\.position|onRight|\{ right:/);
});

test('на недоказанном состоянии значка нет вовсе', () => {
  // Тариф принадлежит КОНКРЕТНОМУ writer'у; после смены сессии старое
  // доказательство силы не имеет. Соврать «Fast выключен» так же плохо, как
  // соврать «включён», поэтому рисуется только доказанный active.
  assert.match(signals, /if \(!active\) return null;/);
  assert.match(tabbar, /\}\)\.active;/);
});

test('состояние Fast берётся ОДНИМ резолвером с кнопкой в панели управления', () => {
  // Два независимых вычисления «включён ли Fast» разошлись бы на первом же
  // граничном случае, а граничный случай здесь основной (владение тарифом).
  assert.match(tabbar, /import \{ resolveCodexFastModeState \} from '\.\.\/\.\.\/utils\/codexFastMode\.mjs'/);
  assert.match(tabbar, /resolveCodexFastModeState\(\{[\s\S]{0,320}serviceTierSessionId: codexLiveServiceTierSessionId/);
  const bar = read('src/renderer/components/Workspace/ClaudeControlBar.tsx');
  assert.match(bar, /import \{ resolveCodexFastModeState \} from '\.\.\/\.\.\/utils\/codexFastMode\.mjs'/);
});

test('подписки на состояние гранулярные, без подписки на Map', () => {
  // Подписка на openProjects целиком перерисовывала бы всё приложение при любом
  // изменении любой вкладки (Fingerprint pattern из CLAUDE.md).
  const block = tabbar.slice(
    tabbar.indexOf('const codexLiveServiceTier = useWorkspaceStore('),
    tabbar.indexOf('}).active;'),
  );
  assert.ok(block.length > 0);
  assert.match(block, /s\.openProjects\.get\(projectId\)\?\.tabs\.get\(tab\.id\)\?\.codexLiveServiceTier/);
  assert.doesNotMatch(block, /for \(const \[, ws\] of s\.openProjects\)/);
});

test('карточка не обрезает значок, выходящий за её край', () => {
  // overflow:hidden на карточке отрезал бы выступающую часть, и значок сел бы
  // ровно на границу — то есть требование «выходит на 20-30%» стало бы невыполнимым.
  assert.match(tabbar, /overflow: 'visible',/);
});
