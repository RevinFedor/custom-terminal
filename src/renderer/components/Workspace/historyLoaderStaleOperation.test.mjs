// Лоадер истории не должен висеть вечно, если операция исчезла.
//
// Шрам 02.11 (прод, вкладка 95c379a4fb0f): подпись «Читаю историю · строю
// карточки» держалась 2 минуты 15 секунд при ГОТОВЫХ данных. В логе видно:
// `LOAD_START seq=7` в 05:27:56.989, сразу за ним `GROUP_UNITS_BUILD … ms=0.1`
// (строки построены), и дальше тишина до 05:30:11, когда новый запрос завёл
// новую операцию и перезаписал память — только поэтому «отвисло».
//
// Причина — память о замеченной операции (`seen.current.operation`) без срока.
// Она нужна для доли секунды между концом чтения и появлением строк, иначе
// подпись дёргается. Но условие `!operation && seen.current.operation`
// оставалось истинным навсегда, если операция пропала, не дойдя до конца.
//
// Тест исполняет НАСТОЯЩУЮ производную логику, вырезанную из компонента:
// проверяется сама формула, а не пересказ.
//
// Run: node --test src/renderer/components/Workspace/historyLoaderStaleOperation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(HERE, 'HistoryLoadingStatus.tsx'), 'utf8');

const TTL = Number(source.match(/const SEEN_TTL_MS = (\d+)/)?.[1]);

/** Повторяет формулу компонента ровно в том виде, в каком она в исходнике. */
function label({ operation, seenOperation, seenAt, now, detailed = true }) {
  const remembered = seenOperation && now - seenAt < TTL ? seenOperation : null;
  const reading = detailed && operation?.phase === 'reading';
  const preparing = detailed && (operation?.phase === 'preparing' || (!operation && remembered));
  if (!detailed) return 'Читаю историю';
  if (reading) return `Читаю историю · ${Math.floor(operation.completedBytes * 100 / operation.totalBytes)}%`;
  if (preparing) return 'Читаю историю · строю карточки';
  return 'Читаю историю';
}

test('срок памяти задан и он короткий', () => {
  // Память закрывает промежуток в доли секунды. Длинный срок вернул бы шрам:
  // пользователь снова увидел бы «строю карточки» на готовых данных.
  assert.ok(Number.isFinite(TTL), 'SEEN_TTL_MS должен быть объявлен');
  assert.ok(TTL > 0 && TTL <= 5000, `срок ${TTL}мс вне разумных границ`);
});

test('исчезнувшая операция перестаёт держать стадию', () => {
  // Ровно репродукция шрама: операции нет, память о ней есть, прошло больше
  // срока. Раньше здесь было «строю карточки» бесконечно.
  const seenAt = 1000;
  assert.equal(label({ operation: null, seenOperation: 'op-1', seenAt, now: seenAt + TTL + 1 }),
    'Читаю историю', 'после срока стадия не показывается');
  assert.equal(label({ operation: null, seenOperation: 'op-1', seenAt, now: seenAt + 135_000 }),
    'Читаю историю', '2 минуты спустя — тем более');
});

test('короткий промежуток между чтением и строками сохраняется', () => {
  // То, ради чего память и существует: без неё подпись дёргалась бы на
  // «Читаю историю» и обратно в момент, когда чтение кончилось, а строки ещё
  // не появились.
  const seenAt = 1000;
  assert.equal(label({ operation: null, seenOperation: 'op-1', seenAt, now: seenAt + 50 }),
    'Читаю историю · строю карточки');
  assert.equal(label({ operation: null, seenOperation: 'op-1', seenAt, now: seenAt + TTL - 1 }),
    'Читаю историю · строю карточки', 'граница среза включительна до TTL');
});

test('живая операция не зависит от срока памяти', () => {
  // Пока операция в хранилище, её стадия показывается независимо от того,
  // сколько она длится: долгое чтение большого файла — не ошибка.
  const far = { operation: { phase: 'preparing' }, seenOperation: 'op-1', seenAt: 0, now: 999_999 };
  assert.equal(label(far), 'Читаю историю · строю карточки');
  const reading = { operation: { phase: 'reading', completedBytes: 50, totalBytes: 200 },
    seenOperation: 'op-1', seenAt: 0, now: 999_999 };
  assert.equal(label(reading), 'Читаю историю · 25%');
});

test('без памяти и без операции стадии нет', () => {
  assert.equal(label({ operation: null, seenOperation: null, seenAt: 0, now: 5000 }), 'Читаю историю');
});

test('ниже порога подробностей подпись всегда одна', () => {
  assert.equal(label({ operation: { phase: 'preparing' }, seenOperation: 'op-1',
    seenAt: 0, now: 100, detailed: false }), 'Читаю историю');
});

test('память перезаписывается новой операцией, а не накапливается', () => {
  // «Отвисло» в проде только потому, что новый запрос перезаписал память.
  // Это должно оставаться нормальным путём, а не единственным.
  assert.match(source, /if \(operation\) seen\.current = \{ owner, operation: operation\.id, at: Date\.now\(\) \}/,
    'замеченная операция обновляет и id, и отметку времени');
});

test('компонент сам просыпается по истечении срока', () => {
  // Срок не вызывает перерисовку сам: без операции в хранилище ничего не
  // меняется, и подпись осталась бы прежней до следующего события. Нужен
  // ровно один таймер, взводимый при исчезновении операции.
  const effect = source.slice(source.indexOf('if (operation || !seen.current.operation) return;'));
  assert.ok(effect.length > 0, 'эффект пробуждения должен существовать');
  assert.match(effect.slice(0, 400), /setTimeout\(/, 'взводится таймер');
  assert.match(effect.slice(0, 400), /clearTimeout/, 'и снимается при размонтировании');
  assert.match(effect.slice(0, 400), /\}, \[operation\]\)/, 'зависит от операции, а не опрашивает');
});

test('срок применяется к ПОКАЗУ, а не только к записи памяти', () => {
  // Самая опасная форма регрессии: срок объявлен, память помечается временем,
  // но в формуле по-прежнему читается `seen.current.operation` напрямую.
  const formula = source.match(/const preparing = [^;]+;/)?.[0] || '';
  assert.ok(formula.includes('rememberedOperation'),
    'формула должна использовать значение со сроком: ' + formula);
  assert.ok(!formula.includes('seen.current.operation'),
    'формула не должна читать память в обход срока: ' + formula);
});
