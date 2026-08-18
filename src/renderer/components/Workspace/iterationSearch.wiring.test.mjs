import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Гвозди для поиска по промптам в переключателе. Проверяют не «код существует»,
// а решения, которые легко откатить назад одной «оптимизацией».

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..', '..');
const overlay = fs.readFileSync(path.join(here, 'TabSwitcherOverlay.tsx'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');

test('промпты читаются ТЕМ ЖЕ парсером, что Timeline и History', () => {
  // Свой парсер разошёлся бы с ними по uuid, и переход «к найденному промпту»
  // приводил бы не туда — либо молча никуда.
  const at = main.indexOf('async function searchOpenTabPrompts');
  assert.ok(at > 0, 'searchOpenTabPrompts должен существовать в main');
  const body = main.slice(at, main.indexOf('ipcMain.handle(\'iteration-search:open-tabs\'', at));
  assert.match(body, /_loadSessionTurns\(/);
  assert.match(body, /_extractTurnPromptText\(/);
  assert.doesNotMatch(body, /JSON\.parse\(/, 'парсинг JSONL здесь заводить нельзя');
});

test('номер хода считается по ВСЕМ промптам вкладки, а не по найденным', () => {
  // Иначе «#7» меняется от запроса к запросу и перестаёт быть адресом.
  const at = main.indexOf('async function searchOpenTabPrompts');
  const body = main.slice(at, main.indexOf('ipcMain.handle(\'iteration-search:open-tabs\'', at));
  const inc = body.indexOf('iterationIndex += 1');
  const filter = body.indexOf('findQueryOffsets(');
  assert.ok(inc > 0 && filter > 0, 'обе точки должны быть в теле');
  assert.ok(inc < filter, 'счётчик увеличивается ДО отбора по совпадению');
});

test('renderer не ищет сам — только рисует смещения от main', () => {
  // Два matcher'а разойдутся в первом же особом случае: промпт «подошёл» по
  // одному правилу, а подсветить по другому нечего — верное совпадение
  // выглядит ложным.
  assert.match(overlay, /splitByOffsets/);
  assert.doesNotMatch(overlay, /\.toLowerCase\(\)\.indexOf\(/);
  assert.doesNotMatch(overlay, /hit\.fullText\.indexOf\(/);
});

test('поиск идёт по ОТКРЫТЫМ вкладкам: у результата есть куда вести', () => {
  // Закрытую вкладку пришлось бы сначала восстанавливать — это уже не переход,
  // а действие, и оно не должно происходить от Enter в списке результатов.
  assert.match(overlay, /collectIterationTargets\(/);
  assert.match(overlay, /'iteration-search:open-tabs'/);
  assert.doesNotMatch(overlay, /restoreTabHistoryEntry/);
});

test('переход прокручивает переписку тем же механизмом, что Timeline', () => {
  assert.match(overlay, /setHistoryPanelOpen\(target\.tabId, true\)/);
  assert.match(overlay, /setHistoryScrollToUuid\(target\.entryUuid\)/);
});

test('запрос отложен: каждый заход читает файлы сессий всех вкладок', () => {
  assert.match(overlay, /window\.setTimeout\(async \(\) => \{/);
  // И помечен своим запросом: ответ приходит, когда строка уже другая.
  assert.match(overlay, /setIterationAnsweredQuery\(text\)/);
});

test('результаты приходят ПОТОКОМ: вкладка разобрана — вкладка показана', () => {
  // Десять секунд пустого экрана и «первый ответ через полсекунды» — это разные
  // продукты. Ждать общего конца незачем: порядок групп задаёт свежесть вкладок,
  // она известна заранее, и поздняя вкладка не может переставить показанное.
  assert.match(main, /const emit = typeof options\.onTab === 'function'/);
  assert.match(main, /sender\.send\('iteration-search:chunk'/);
  assert.match(overlay, /ipcRenderer\.on\('iteration-search:chunk', onChunk\)/);
  assert.match(overlay, /mergeIterationChunk\(base, chunk, targetOrderRef\.current\)/);
  // Опоздавший кусок прошлого поиска отбрасывается по НОМЕРУ запроса, а не по
  // тому, отписался ли уже слушатель.
  assert.match(overlay, /chunk\.requestId !== requestId/);
});

test('второй проход ЗАМЕНЯЕТ показанное, а не дополняет его', () => {
  // Смешать точные совпадения с приблизительными в одном списке — соврать про
  // половину строк. Замена делается один раз, дальше куски дополняют.
  assert.match(main, /replaces,/);
  assert.match(overlay, /chunk\.replaces && !replacedRef\.current \? \[\] : prev/);
});

test('наведение НЕ прокручивает список: строка под курсором уже на экране', () => {
  // Список уехал — курсор оказался над другой строкой — она выделилась — список
  // уехал снова. Это и читается как «раскрыл, скроллю вниз, а меня возвращает».
  assert.match(overlay, /selectionByKeyboardRef/);
  assert.match(overlay, /if \(el && selectionByKeyboardRef\.current\) el\.scrollIntoView/);
  assert.match(overlay, /onPointerEnter=\{\(\) => \{ if \(!mouseBlockedRef\.current\) selectByMouse\(index\); \}\}/);
});

test('состояние поиска переживает закрытие панели', () => {
  // Набрать запрос, дождаться обхода, раскрыть, проскроллить — это работа.
  // Панель закрывают по десять раз за сеанс (сходить во вкладку и вернуться);
  // выбрасывать работу на каждом закрытии значит отучить от поиска вовсе.
  assert.match(overlay, /const iterationMemory: IterationMemory = \{/);
  assert.match(overlay, /iterationMemory\.selectedUuid = selected\?\.kind === 'iteration'/);
  assert.match(overlay, /iterationMemory\.scrollTop = listRef\.current\?\.scrollTop/);
  // Повторный вход не гоняет тот же обход заново.
  assert.match(overlay, /signature === iterationMemory\.answeredSignature/);
});

test('счётчик — номер выделенного из всех найденных, и он один на всё', () => {
  assert.match(overlay, /iterationHitPosition\(rows, selectedIndex\)/);
  assert.match(overlay, /\{iterationHitPos \|\| '–'\}\/\{iterationHitCount\}/);
});

test('лоадер и счётчик живут НА рамке, а не строкой в списке', () => {
  // Строкой они стоили бы места дважды: занимали ряд и сдвигали весь список при
  // каждом появлении — а появляются на каждый запрос.
  assert.match(overlay, /data-switcher-iteration-frame-note/);
  assert.match(overlay, /position: 'absolute'[\s\S]{0,400}?transform: 'translate\(0, -50%\)'/);
  assert.match(overlay, /background: PANEL_BG/);
});

test('номер промпта показывается со знаменателем: «#7/214»', () => {
  // Номер без знаменателя ничего не говорит: седьмой из десяти и седьмой из
  // трёхсот — разный масштаб.
  assert.match(overlay, /#\{hit\.iterationIndex \+ 1\}\/\{hit\.totalIterations \|\| '\?'\}/);
  assert.match(main, /const totalIterations = iterationIndex \+ 1;/);
});

test('режим совпадения показывается: «по словам» — это другой ответ', () => {
  // Строки в нём не содержат введённой фразы, и без подписи это читается как
  // сломанный поиск. Подпись — на рамке, вместе с лоадером и счётчиком: место
  // одно, и важнейшее вытесняет остальное.
  assert.match(overlay, /iterationMatchMode === 'words'/);
  assert.match(overlay, /Точной фразы нет/);
});

test('пустых состояний пять, и они говорят разное', () => {
  for (const phrase of [
    'Ищу по промптам…',
    'Введите слово из промпта',
    'Выберите хотя бы один проект',
    'Ничего не нашлось',
  ]) {
    assert.ok(overlay.includes(phrase), 'нет состояния: ' + phrase);
  }
  assert.match(overlay, /iterationError\s*\n?\s*\?\s*iterationError/);
});

test('раскрытие помнится по uuid промпта, а не по номеру строки', () => {
  // Список перестраивается на каждый ответ; по индексу раскрытие «прыгнуло» бы
  // на соседний промпт.
  assert.match(overlay, /expandedHits\.has\(hit\.entryUuid\)/);
  assert.match(overlay, /setExpandedHits\(new Set\(\)\)/);
});
