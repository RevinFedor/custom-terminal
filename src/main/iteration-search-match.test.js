'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSnippet,
  countLines,
  findQueryOffsets,
  queryWords,
} = require('./iteration-search-match');

test('поиск буквальный и регистронезависимый, находит ВСЕ вхождения', () => {
  const offsets = findQueryOffsets('Кэш, потом кэш, и ещё КЭШ', 'кэш');
  assert.equal(offsets.length, 3);
  // Смещения в ИСХОДНОМ тексте, не в приведённом к нижнему регистру: renderer
  // режет по ним оригинал, и сдвиг на один символ подсветил бы соседнюю букву.
  assert.deepEqual(offsets[0], { start: 0, end: 3 });
  assert.deepEqual(offsets[2], { start: 22, end: 25 });
});

test('запасной режим требует ВСЕ слова, а не любое', () => {
  // Одно слово из двух — это не «почти нашли», это шум, которого при точном
  // поиске не было бы вовсе.
  assert.equal(findQueryOffsets('только про кэш', 'кэш таймлайн', 'words').length, 0);
  assert.equal(findQueryOffsets('кэш и таймлайн рядом', 'кэш таймлайн', 'words').length, 2);
});

test('короткие слова запроса отбрасываются: по одной букве ищется весь архив', () => {
  assert.deepEqual(queryWords('я и кэш'), ['кэш']);
});

test('окно берётся вокруг ПЕРВОГО совпадения, а не от начала промпта', () => {
  // Длинные промпты часто начинаются одинаково: окно от начала во всех
  // результатах выглядело бы одним и тем же текстом без искомого.
  const head = 'преамбула '.repeat(60);
  const text = head + 'ИСКОМОЕ дальше хвост';
  const offsets = findQueryOffsets(text, 'искомое');
  const snippet = buildSnippet(text, offsets);
  assert.ok(snippet.from > 0, 'окно должно быть сдвинуто к совпадению');
  assert.ok(snippet.text.toLowerCase().includes('искомое'));
  assert.equal(snippet.headTrimmed, true);
  // Совпадение пересчитано в координаты ОКНА, иначе подсветка уехала бы.
  assert.equal(
    snippet.text.slice(snippet.offsets[0].start, snippet.offsets[0].end).toLowerCase(),
    'искомое',
  );
});

test('в окно попадают только целиком поместившиеся совпадения', () => {
  // Половина подсветки на краю окна читается как ошибка разметки, а не как
  // «дальше есть ещё».
  const text = 'кэш' + 'x'.repeat(500) + 'кэш';
  const offsets = findQueryOffsets(text, 'кэш');
  const snippet = buildSnippet(text, offsets);
  assert.equal(offsets.length, 2);
  assert.equal(snippet.offsets.length, 1);
  assert.equal(snippet.tailTrimmed, true);
});

test('свёрнутый кусок — ровно ТРИ строки: совпадение и по одной вокруг', () => {
  // Не «сколько влезет»: у кусков разной высоты список перестаёт читаться как
  // список — глаз не находит, где кончается один результат и начинается
  // следующий. Соседние строки нужны, потому что промпт — это разговор: одна
  // строка без окружения часто не говорит ничего.
  const text = ['первая', 'вторая с КЭШем', 'третья', 'четвёртая'].join('\n');
  const snippet = buildSnippet(text, findQueryOffsets(text, 'кэш'));
  assert.deepEqual(snippet.text.split('\n'), ['первая', 'вторая с КЭШем', 'третья']);
  assert.equal(snippet.tailTrimmed, true);
});

test('у краёв промпта строк меньше трёх — добирать их неоткуда', () => {
  const text = ['КЭШ в первой', 'вторая'].join('\n');
  const snippet = buildSnippet(text, findQueryOffsets(text, 'кэш'));
  assert.equal(snippet.text.split('\n').length, 2);
  assert.equal(snippet.headTrimmed, false);
});

test('строка длиной в абзац режется по символам, а не растёт на три экрана', () => {
  const text = 'x'.repeat(600) + 'КЭШ' + 'y'.repeat(600);
  const snippet = buildSnippet(text, findQueryOffsets(text, 'кэш'));
  assert.ok(snippet.text.length <= 320, 'кусок не длиннее потолка');
  assert.equal(snippet.offsets.length, 1, 'совпадение всё равно попало в окно');
});

test('счётчик строк считает строки промпта, а не длину', () => {
  assert.equal(countLines('одна\nдве\nтри'), 3);
  assert.equal(countLines(''), 0);
});
