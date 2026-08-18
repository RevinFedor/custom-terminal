'use strict';

// ОДИН matcher на весь поиск по промптам.
//
// У поиска три вопроса, и это должен быть один ответ:
//   1. подходит ли этот промпт вообще;
//   2. какой кусок показать в свёрнутой строке;
//   3. что подсветить — и в свёрнутом куске, и в раскрытом промпте целиком.
//
// Если на них отвечают разные функции, они расходятся в первый же особый
// случай: промпт «подошёл» по одному правилу, а подсветить по другому нечего —
// строка выглядит как ложное срабатывание, хотя нашли верно. Поэтому смещения
// совпадений считает ровно этот модуль, и renderer их только рисует: у него
// своего matcher'а нет вообще.
//
// Поиск буквальный и регистронезависимый — «просто ищите наиболее точное
// слово». Умного ранжирования здесь нет намеренно: у буквального поиска и не
// может быть сигнала релевантности, кроме числа совпадений, а притворяться, что
// он есть, значит переставлять строки по причине, которую нельзя объяснить.

/** Потолок символов у свёрнутого куска. Строк всегда три (см. buildSnippet),
 *  но одна строка бывает длиной в абзац — тогда режем её по символам. */
const SNIPPET_CHARS = 320;
/** Сколько символов оставить ПЕРЕД совпадением, когда строку пришлось резать:
 *  совпадение должно быть видно сразу, но и без начала фразы читается плохо. */
const SNIPPET_LEAD = 90;

function normalize(value) {
  return String(value == null ? '' : value).toLocaleLowerCase();
}

/** Слова запроса — для запасного режима «все слова, но не подряд». */
function queryWords(query) {
  return Array.from(new Set(
    normalize(query)
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
  ));
}

function findLiteralOffsets(haystack, needle) {
  const offsets = [];
  if (!needle) return offsets;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    offsets.push({ start: at, end: at + needle.length });
    at = haystack.indexOf(needle, at + needle.length);
  }
  return offsets;
}

/**
 * Найти совпадения в одном тексте.
 *
 * `mode` задаётся СНАРУЖИ и один на весь поиск, а не решается для каждого
 * промпта отдельно. Иначе список смешал бы точные совпадения с приблизительными
 * без всякой пометки, и подпись «показаны промпты со всеми словами» была бы
 * враньём про половину строк.
 *
 * @param {string} text
 * @param {string} query
 * @param {'phrase'|'words'} mode
 * @returns {Array<{start:number,end:number}>} смещения В ИСХОДНОМ тексте
 */
function findQueryOffsets(text, query, mode = 'phrase') {
  const source = String(text == null ? '' : text);
  const haystack = normalize(source);
  const phrase = normalize(query).trim();
  if (!haystack || !phrase) return [];
  if (mode !== 'words') return findLiteralOffsets(haystack, phrase);

  const words = queryWords(phrase);
  if (words.length === 0) return [];
  // Запасной режим требует ВСЕ слова: промпт с одним словом из трёх — это не
  // «почти нашли», это шум, которого при точном поиске не было бы.
  const perWord = words.map((word) => findLiteralOffsets(haystack, word));
  if (perWord.some((hits) => hits.length === 0)) return [];
  return perWord
    .flat()
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

/** Начало строки, в которой лежит символ `index`. */
function lineStartAt(source, index) {
  return source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
}

/** Конец строки (позиция её `\n` или конец текста). */
function lineEndAt(source, index) {
  const at = source.indexOf('\n', index);
  return at === -1 ? source.length : at;
}

/**
 * Кусок промпта вокруг первого совпадения + смещения ВНУТРИ этого куска.
 *
 * Три строки: строка с совпадением, одна над ней и одна под ней. Не «столько
 * символов, сколько влезет»: у куска переменной высоты каждая строка списка
 * своего роста, и список перестаёт читаться как список — глаз не находит, где
 * кончается один результат и начинается следующий. Соседние строки нужны,
 * потому что промпт — это разговор: одна строка без окружения часто не говорит
 * ничего.
 *
 * Окно берётся от совпадения, а не от начала промпта: длинные промпты часто
 * начинаются одинаковой преамбулой, и три строки от их начала во всех
 * результатах выглядели бы одним и тем же текстом без искомого.
 *
 * Одна строка бывает длиной в абзац — тогда она режется по символам вокруг
 * совпадения, иначе «три строки» превратятся в три экрана переноса.
 *
 * @returns {{text:string, from:number, offsets:Array<{start:number,end:number}>,
 *            headTrimmed:boolean, tailTrimmed:boolean}}
 */
function buildSnippet(text, offsets, limit = SNIPPET_CHARS) {
  const source = String(text == null ? '' : text);
  const hit = offsets && offsets.length > 0 ? offsets[0] : { start: 0, end: 0 };
  const hitLineStart = lineStartAt(source, hit.start);
  const hitLineEnd = lineEndAt(source, hit.start);

  // Соседние строки: по одной с каждой стороны, если они есть.
  let from = hitLineStart > 0 ? lineStartAt(source, hitLineStart - 1) : 0;
  let to = hitLineEnd < source.length ? lineEndAt(source, hitLineEnd + 1) : source.length;

  if (to - from > limit) {
    // Не влезли: держимся за совпадение, а не за границы строк.
    from = Math.max(from, hit.start - SNIPPET_LEAD);
    to = Math.min(to, from + limit);
    if (hit.end > to) {
      // Совпадение длиннее окна — сдвигаем окно так, чтобы оно осталось видно.
      to = Math.min(source.length, hit.end + 40);
      from = Math.max(0, to - limit);
    }
    // Не резать слово пополам: ищем ближайший пробел справа, но только рядом —
    // на тексте без пробелов сдвиг ушёл бы далеко от совпадения.
    if (from > 0 && from < hit.start) {
      const space = source.indexOf(' ', from);
      if (space !== -1 && space - from <= 40 && space < hit.start) from = space + 1;
    }
  }

  const sliced = source.slice(from, to);
  return {
    text: sliced,
    from,
    // Только те совпадения, что попали в окно ЦЕЛИКОМ: половина подсветки на
    // краю читается как ошибка разметки.
    offsets: (offsets || [])
      .filter((one) => one.start >= from && one.end <= to)
      .map((one) => ({ start: one.start - from, end: one.end - from })),
    headTrimmed: from > 0,
    tailTrimmed: to < source.length,
  };
}

/** Строк в промпте — для подписи «Раскрыть полностью (N строк)». */
function countLines(text) {
  const source = String(text == null ? '' : text);
  if (!source) return 0;
  return source.split('\n').length;
}

module.exports = {
  SNIPPET_CHARS,
  buildSnippet,
  countLines,
  findQueryOffsets,
  queryWords,
};
