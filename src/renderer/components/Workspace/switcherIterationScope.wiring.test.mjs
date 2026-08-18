// Переключатель режима поиска внутри поля ввода переключателя вкладок.
//
// В поле ввода два разных вопроса, а не один с фильтром:
//   «Вкладки»  — как называется вкладка (мгновенно, локально);
//   «Итерации» — что в этих вкладках писали (буквальный поиск по промптам).
//
// Правила ниже — про то, что легко сломать позже, и что каждый раз ломается
// одинаково: спрятанная стоимость поиска, устаревший ответ, показанный молча,
// и второй matcher тех же данных.
//
// Историческая правка (2026-08-18): первая версия этого режима искала СМЫСЛОВЫМ
// поиском по ЗАКРЫТЫМ вкладкам, переиспользуя индекс домашней страницы. Это
// отвечало на другой вопрос: «о чём был разговор» вместо «где я это писал», и у
// результата не было куда вести — закрытую вкладку сначала надо восстановить.
// Тесты ниже прибивают текущее поведение, чтобы возврат к прежнему был явным.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..', '..');
const switcher = fs.readFileSync(path.join(here, 'TabSwitcherOverlay.tsx'), 'utf8');
const model = fs.readFileSync(path.join(repo, 'src/renderer/utils/tabSwitcherModel.mjs'), 'utf8');

test('поиск буквальный и по ОТКРЫТЫМ вкладкам, а не смысловой по архиву', () => {
  // Смысловой поиск в проекте уже есть — на домашней странице. Он отвечает на
  // «о чём был разговор», стоит внешнего вызова на каждую букву и ведёт в
  // закрытые вкладки, которые сначала надо восстанавливать.
  assert.match(switcher, /ipcRenderer\.invoke\('iteration-search:open-tabs'/);
  assert.doesNotMatch(switcher, /tab-iteration-search:semantic/);
  assert.doesNotMatch(switcher, /minScore/);
});

test('какие проекты спрашивать — выбор человека, и пустой выбор значит «нигде»', () => {
  // Подмена пустого набора на «везде» меняла бы объём ответа сама собой, без
  // действия человека, и вернуть прежний он бы не смог.
  assert.match(switcher, /collectIterationTargets\(\{/);
  assert.match(switcher, /projectFilter: iterationProjects/);
  assert.match(switcher, /iterationProjects\.size === 0\s*\n?\s*\?\s*'Выберите хотя бы один проект'/);
  // Умолчание ставится ОДИН раз за всё время — при первом входе в режим. Дальше
  // набор принадлежит человеку и переживает закрытие вместе с памятью поиска.
  assert.match(switcher, /if \(iterationMemory\.projects\) return;/);
  assert.match(switcher, /iterationMemory\.projects = initial;/);
});

test('поиск отложен и помечен своим запросом', () => {
  // Каждый заход читает и разбирает файлы сессий всех выбранных вкладок. Поиск
  // на каждую букву превратил бы одно слово в шесть таких обходов.
  assert.match(switcher, /setTimeout\(async \(\) => \{[\s\S]{0,4000}?\}, 220\)/);
  assert.match(switcher, /window\.clearTimeout\(timer\)/);
  // Ответ приходит, когда строка уже другая: без метки список показывал бы
  // ответ на позавчерашний вопрос и молчал бы об этом. Подпись — на рамке.
  assert.match(switcher, /setIterationAnsweredQuery\(text\)/);
  assert.match(switcher, /ниже — ответ на «\$\{iterationAnsweredQuery\}»/);
  // Отменённый заход не пишет результат поверх нового.
  assert.match(switcher, /if \(cancelled\) return;/);
});

test('пустой экран называет ПРИЧИНУ, а не одно «ничего не найдено»', () => {
  // Пять разных фактов: идёт поиск, допишите запрос, негде искать, ошибка,
  // ничего нет. Одна строка на все заставила бы гадать — ждать,
  // переформулировать или включить проект.
  assert.match(switcher, /Ищу по промптам…/);
  assert.match(switcher, /Введите слово из промпта/);
  assert.match(switcher, /Выберите хотя бы один проект/);
  assert.match(switcher, /iterationError\s*\n?\s*\?\s*iterationError/);
  assert.match(switcher, /Ничего не нашлось/);
});

test('по умолчанию всегда поиск по вкладкам, режим не запоминается', () => {
  // Переключатель чаще всего открывают, чтобы просто перейти на вкладку.
  // Застать его в режиме, который читает файлы сессий, дороже одного клика.
  const open = switcher.slice(
    switcher.indexOf('const openSearch = useCallback('),
    switcher.indexOf('const openCtrl = useCallback('),
  );
  assert.match(open, /setScope\('tabs'\)/);
  // Строка ввода пустая: открытие «по вкладкам» — это почти всегда «перейти
  // куда-то», и чужой текст в поле дал бы отфильтрованный список.
  assert.match(open, /setQuery\(''\)/);
  // А вот РЕЗУЛЬТАТЫ переживают закрытие — см. `iterationMemory`. Стирается
  // только незавершённый поход за ответом.
  const close = switcher.slice(
    switcher.indexOf('const close = useCallback('),
    switcher.indexOf('const openIterationHit = useCallback('),
  );
  assert.doesNotMatch(close, /setIterationHits\(\[\]\)/);
  assert.match(close, /setIterationLoading\(false\)/);
});

test('переключение режима не уводит фокус из поля ввода', () => {
  // Человек печатает. Уехавший на кнопку курсор — это потерянный темп и
  // «куда делся мой ввод». То же и у выбора проектов, и у стрелок.
  assert.match(switcher, /onMouseDown=\{\(e\) => \{[\s\S]{0,500}?e\.preventDefault\(\);[\s\S]{0,200}?setScope\(option\.value\);[\s\S]{0,120}?inputRef\.current\?\.focus\(\)/);
  assert.match(switcher, /toggleIterationProject\(chip\.projectId\);[\s\S]{0,120}?inputRef\.current\?\.focus\(\)/);
  // Плюс клавиша: тот же жест без мыши, набранная строка сохраняется — её же
  // обычно и надо переспросить у другого поиска.
  assert.match(switcher, /if \(e\.key === 'Tab' && !e\.metaKey && !e\.ctrlKey && !e\.altKey\) \{[\s\S]{0,300}?setScope\(\(prev\) => \(prev === 'tabs' \? 'iterations' : 'tabs'\)\)/);
});

test('строки-промпты живут в ОБЩЕМ списке и выбираются как вкладки', () => {
  // Два списка со своими индексами разошлись бы на первом же шаге стрелкой.
  assert.match(model, /if \(row\.kind === 'iteration'\) \{ out\.push\(i\); return; \}/);
  assert.match(switcher, /if \(row\.kind === 'iteration'\) \{\s*\n\s*openIterationHit\(row\.hit\);/);
  // Заголовок вкладки — разделитель, как заголовок проекта: не выбирается.
  assert.doesNotMatch(model, /row\.kind === 'iteration-tab'/);
});

test('переход открывает вкладку, переписку и прокручивает на этот промпт', () => {
  const open = switcher.slice(
    switcher.indexOf('const openIterationHit = useCallback('),
    switcher.indexOf('const commitRow = useCallback('),
  );
  // Вкладка открыта по построению — искали только по открытым, восстанавливать
  // нечего. Восстановление здесь было бы уже не переходом, а действием.
  assert.doesNotMatch(open, /restoreTabHistoryEntry/);
  // Переписка — единственная поверхность, где промпт вообще виден.
  assert.match(open, /setHistoryPanelOpen\(target\.tabId, true\)/);
  // Прокрутка идёт тем же механизмом, что переход из Timeline: второй путь к
  // тому же месту разошёлся бы с ним.
  assert.match(open, /setHistoryScrollToUuid\(target\.entryUuid\)/);
});

test('стрелки в поле двигают ТУ ЖЕ выделенную строку, что и клавиши', () => {
  // Второй «текущий результат» развёл бы Enter и стрелку вниз по разным местам.
  assert.match(switcher, /data-switcher-iteration-step/);
  assert.match(switcher, /selectByKeyboard\(\(prev\) => stepIndex\(rowsRef\.current, prev, step\.dir\)\)/);
});
