import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTEXT_USAGE_COLORS,
  contextUsageColor,
  contextUsageDisplayValue,
} from './contextUsageMeter.mjs';

const repoRoot = path.join(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const bar = read('renderer/components/Workspace/ClaudeControlBar.tsx');
const signals = read('renderer/components/Workspace/TabSignals.tsx');
const tabbar = read('renderer/components/Workspace/TabBar.tsx');
// Чип вкладки в шапке окна живёт в своём файле (выделен из SplitPaneChrome).
const pane = read('renderer/components/Workspace/PaneTabChip.tsx');

/**
 * Заполнение контекста показывается в трёх местах: панель управления, карточка
 * вкладки в боковом списке и чип вкладки в шапке панели сплита. Решение о цвете
 * и формате — ОДНО на всех: иначе одно и то же число показывалось бы в панели
 * ещё зелёным, а на карточке уже жёлтым, и верить перестали бы обоим.
 */

test('пороги цвета заданы один раз и применяются одинаково', () => {
  assert.equal(contextUsageColor(0), CONTEXT_USAGE_COLORS.ok);
  assert.equal(contextUsageColor(50), CONTEXT_USAGE_COLORS.ok, 'ровно на пороге ещё спокойный');
  assert.equal(contextUsageColor(50.1), CONTEXT_USAGE_COLORS.warn);
  assert.equal(contextUsageColor(80), CONTEXT_USAGE_COLORS.warn, 'ровно на пороге ещё янтарный');
  assert.equal(contextUsageColor(80.1), CONTEXT_USAGE_COLORS.danger);
  // Мусор не красит в тревожный цвет: неизвестное — не то же, что плохое.
  assert.equal(contextUsageColor(null), CONTEXT_USAGE_COLORS.ok);
  assert.equal(contextUsageColor('abc'), CONTEXT_USAGE_COLORS.ok);
});

test('нет измерения — нет числа, а не ноль', () => {
  // Ноль означал бы «контекст пуст». Настоящий смысл — «данных ещё нет».
  assert.equal(contextUsageDisplayValue(null), null);
  assert.equal(contextUsageDisplayValue(0), null);
  assert.equal(contextUsageDisplayValue(-5), null);
  assert.equal(contextUsageDisplayValue(undefined), null);
  assert.equal(contextUsageDisplayValue(NaN), null);
});

test('значение всегда целое и не длиннее трёх знаков', () => {
  // Число приходит извне; четырёхзначное вылезло бы за правый край карточки.
  assert.equal(contextUsageDisplayValue(19.4), 19);
  assert.equal(contextUsageDisplayValue(19.6), 20);
  assert.equal(contextUsageDisplayValue(100), 100);
  assert.equal(contextUsageDisplayValue(1000), 999);
  assert.equal(String(contextUsageDisplayValue(99999)).length, 3);
});

test('все три поверхности берут цвет из общего модуля, а не считают свой', () => {
  assert.match(bar, /import \{ contextUsageColor \} from '\.\.\/\.\.\/utils\/contextUsageMeter\.mjs'/);
  assert.match(bar, /const meterColor = contextUsageColor\(contextPct\)/);
  // Прежняя тройная тернарка в панели не должна вернуться.
  assert.doesNotMatch(bar, /contextPct > 80 \? '#ef4444'/);
  assert.match(signals, /import \{ contextUsageColor, contextUsageDisplayValue \}/);
  assert.match(signals, /color: contextUsageColor\(pct\)/);
});

test('число 8px, без знака процента, прижато к левому краю', () => {
  // Знак процента в углу карточки смысла не добавляет, а места занимает как
  // цифра — при 100 это разница между «влезло» и «вылезло».
  // 8px, а не 10: на 10 число спорило по весу с именем вкладки и читалось как
  // часть строки, а не как отметка на краю (юзер, 2026-08-18).
  assert.match(signals, /export const TAB_CONTEXT_BADGE_FONT_PX = 8;/);
  assert.match(signals, /fontSize: TAB_CONTEXT_BADGE_FONT_PX/);
  const badge = signals.slice(
    signals.indexOf('export function TabContextUsageBadge'),
    signals.indexOf('export function useTabActivitySignals'),
  );
  assert.ok(badge.length > 0);
  // Знака процента нет в САМОМ числе. В подсказке при наведении он остаётся —
  // там место не расходуется, а «19» без единицы измерения понятно не всем.
  // Строка рендера — отдельно стоящая `{value}`. Проверка привязана к позиции,
  // а не к отсутствию `%` во всём компоненте: `%` законно есть в подсказке
  // (`${value}%`), и запрет по всему тексту падал именно на ней.
  assert.match(badge, /^\s*\{value\}$/m);
  assert.doesNotMatch(badge, /^\s*\{value\}%/m);
  assert.match(badge, /title=\{`Использовано \$\{value\}% контекстного окна`\}/);
  // Моноширинные цифры: иначе число дёргается при каждом изменении.
  assert.match(badge, /fontVariantNumeric: 'tabular-nums'/);
  // line-height: 1 — иначе строка свисает на ~40% кегля и уезжает на соседа.
  assert.match(badge, /lineHeight: 1,/);
});

test('под числом плашка ровно по его границам, без лишнего места', () => {
  // Просьба пользователя: число должно быть чётко видно, но размеры блока —
  // не увеличиваться, «никаких лишних отступов».
  //
  // Замерено в Chromium: плашка совпадает с шириной строчного бокса числа
  // (лишнее по ширине 0px), а краска цифр лежит внутри неё с запасом 1.25px
  // сверху и снизу — ничего не срезано. Карточка при этом не растёт вовсе:
  // элемент вынут из потока, поэтому на её размеры он не влияет в принципе,
  // при любом значении.
  const badge = signals.slice(
    signals.indexOf('export function TabContextUsageBadge'),
    signals.indexOf('export function useTabActivitySignals'),
  );
  assert.match(badge, /backgroundColor: TAB_CONTEXT_BADGE_BG/);
  // Фон взят у панели управления, а не подобран заново: одна роль — один цвет.
  assert.match(signals, /export const TAB_CONTEXT_BADGE_BG = '#161616';/);
  const bar = read('renderer/components/Workspace/ClaudeControlBar.tsx');
  assert.match(bar, /backgroundColor: '#161616',/,
    'плашка обязана повторять фон панели управления — иначе два разных серых');

  // Своих отступов у плашки нет: они раздвинули бы её за границы числа.
  assert.doesNotMatch(badge, /\bpadding\b/);
  // И элемент обязан оставаться вынутым из потока, иначе он начнёт занимать место.
  assert.match(badge, /position: 'absolute'/);

  // Плашка заменила свечение вокруг глифа: поверх цветной полоски оно
  // размывалось и контраста не давало.
  assert.doesNotMatch(badge, /textShadow/);
});

test('число живёт в левом нижнем углу и ложится на левую process-bar', () => {
  // Обе метки принадлежат левому краю карточки: молния — его верхнему концу,
  // число — нижнему. Когда process-bar тоже слева, число ложится на неё;
  // когда полоска справа, число всё равно остаётся в выбранной левой колонке.
  const badge = signals.slice(
    signals.indexOf('export function TabContextUsageBadge'),
    signals.indexOf('export function useTabActivitySignals'),
  );
  assert.match(badge, /left: leftInset/);
  assert.match(badge, /const leftInset = -CONTEXT_BADGE_BAR_OVERLAP_PX;/);
  assert.doesNotMatch(badge, /processBar\.position/);
  // Смещение считается ОТ ширины полоски, а не подобрано на глаз: изменится
  // полоска — поедет и число, без второй правки в другом месте.
  assert.match(
    signals,
    /export const CONTEXT_BADGE_BAR_OVERLAP_PX = TAB_PROCESS_BAR_W_PX - 1;/,
  );
  // Число рисуется ПОВЕРХ полоски, иначе она перечеркнула бы последнюю цифру.
  assert.match(badge, /zIndex = 7/);
  // Выступ вниз ограничен зазором — тем же правилом, что у молнии.
  assert.match(badge, /bottom: -tabFastBadgeOutsidePx\(gapPx, TAB_CONTEXT_BADGE_FONT_PX\)/);
});

test('стартовое значение читается из базы, а не ждёт события', () => {
  // События несут только ИЗМЕНЕНИЯ: у вкладки, чей ход прошёл раньше или чей
  // процесс закрыт, число не появилось бы никогда.
  const hook = signals.slice(
    signals.indexOf('export function useTabContextUsage'),
    signals.indexOf('export function TabContextUsageBadge'),
  );
  assert.ok(hook.length > 0);
  assert.match(hook, /ipcRenderer\.invoke\('tab:get-context-pct', \{ tabId \}\)/);
  // Все три канала: Claude, Codex и SDK — иначе у части вкладок угол пустой.
  assert.match(hook, /ipcRenderer\.on\('claude:bridge-update', onClaudeBridge\)/);
  assert.match(hook, /ipcRenderer\.on\('codex:context-update', onCodexContext\)/);
  assert.match(hook, /window\.addEventListener\('sdk-context-update', onWindowEvent\)/);
});

test('кадр чужой сессии не может проставить число на карточку', () => {
  // Claude НИКОГДА не удаляет свои bridge-файлы, и при повторном использовании
  // PID кадр давно мёртвой сессии приходит с ЭТИМ tabId
  // (fix-bridge-stale-takeover.md). Совпадения по вкладке недостаточно.
  //
  // Панель управления такие кадры отбрасывала всегда, а карточка принимала
  // любой — и на одну вкладку в двух местах показывались РАЗНЫЕ числа, причём
  // неверное на более заметном. Проверка обязана быть той же, что в панели.
  const hook = signals.slice(
    signals.indexOf('export function useTabContextUsage'),
    signals.indexOf('export function TabContextUsageBadge'),
  );
  assert.ok(hook.length > 0);
  assert.match(signals, /import \{ isStaleAgainstPending \} from '\.\.\/\.\.\/utils\/pendingResume'/);
  // 1) идёт resume — кадр другой сессии не принимается;
  assert.match(hook, /isStaleAgainstPending\(tabId, frameSessionId\)/);
  // 2) вкладка уже привязана к сессии — кадр, называющий другую, не принимается.
  assert.match(
    hook,
    /frameSessionId !== boundClaudeSessionId\) return;/,
  );
  // Привязка читается гранулярным селектором, без подписки на Map.
  assert.doesNotMatch(hook, /useWorkspaceStore\(\(s\) => s\.openProjects\)/);

  assert.match(bar, /isStaleAgainstPending\(tabId, data\.sessionId\)/,
    'панель управления обязана держать ту же проверку — иначе поверхности разойдутся снова');
});

test('обе метки живут ТОЛЬКО на карточке в боковом списке', () => {
  // Боковой список — обзор: там читают состояние всех вкладок сразу, и обе
  // метки отвечают на вопрос, который там и задают.
  assert.match(tabbar, /<TabFastBadge active=\{codexFastActive\} \/>/, 'TabBar: молния');
  assert.match(tabbar, /<TabContextUsageBadge pct=\{tabContextPct\} \/>/, 'TabBar: контекст');
  assert.match(tabbar, /resolveCodexFastModeState\(\{/, 'TabBar: резолвер тарифа');

  // На чипе в шапке окна их нет (юзер, 2026-08-18). Шапка говорит про ОДНО
  // окно, и в полосе из нескольких чипов те же метки превращались бы в рябь
  // вокруг имён; плюс они свисают за нижнюю кромку, где идёт строка пути.
  assert.doesNotMatch(pane, /TabFastBadge/, 'PaneTabChip: молнии быть не должно');
  assert.doesNotMatch(pane, /TabContextUsageBadge/, 'PaneTabChip: числа быть не должно');
});
