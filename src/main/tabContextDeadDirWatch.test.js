'use strict';

// Наблюдатель за удалённой папкой не должен подниматься заново на каждой
// синхронизации.
//
// Шрам 02.11 (прод, boot mvz58g65): **2516** бросков `fs.watch` за сессию —
// по 148 на каждую из ~17 мёртвых папок за 102 синхронизации. Папки остались
// от прошлых тестовых прогонов (`/private/tmp/hh-v15-e2e-send-…`,
// `docs/tmp/handoff-codex-to-claude/luna-max` и подобные): путь ещё числится
// в связанных файлах вкладки, самой папки уже нет.
//
// Каждая попытка — системный вызов плюс строка в логе, всё на главном потоке.
// Пользователь в эти же окна видел зависания 1–2с при отправке сообщения и
// первом скролле; в атрибуции рядом стояло `activeOps=15`.
//
// Проверяется НАСТОЯЩАЯ логика, вырезанная из `tab-work-context.js`: отметка
// недоступности, её срок и условие пропуска.
//
// Run: node --test src/main/tabContextDeadDirWatch.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'tab-work-context.js'), 'utf8');
const TTL = Number(SOURCE.match(/const UNAVAILABLE_DIR_TTL_MS = ([\d_]+)/)?.[1].replace(/_/g, ''));

/** Повторяет цикл из `_syncLinks` ровно в том виде, в каком он в исходнике. */
function makeSync({ watchThrows = () => true, now = () => Date.now() } = {}) {
  const state = { watchers: new Map(), unavailableDirs: new Map() };
  const attempts = [];
  const sync = dirs => {
    for (const [dir, failedAt] of state.unavailableDirs) {
      if (!dirs.has(dir) || now() - failedAt >= TTL) state.unavailableDirs.delete(dir);
    }
    for (const dir of dirs) {
      if (state.watchers.has(dir) || state.unavailableDirs.has(dir)) continue;
      attempts.push({ dir, at: now() });
      if (watchThrows(dir)) state.unavailableDirs.set(dir, now());
      else state.watchers.set(dir, { close() {} });
    }
  };
  return { sync, attempts, state };
}

test('мёртвая папка пробуется один раз, а не на каждой синхронизации', () => {
  // Прямая репродукция шрама: 102 синхронизации по одной мёртвой папке.
  const h = makeSync({ now: () => 1000 });
  const dirs = new Set(['/private/tmp/dead-stand']);
  for (let i = 0; i < 102; i++) h.sync(dirs);
  assert.equal(h.attempts.length, 1, `было ${h.attempts.length} попыток вместо одной`);
});

test('живая папка получает наблюдателя и больше не пробуется', () => {
  const h = makeSync({ watchThrows: () => false, now: () => 1000 });
  const dirs = new Set(['/real/dir']);
  for (let i = 0; i < 10; i++) h.sync(dirs);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.state.watchers.size, 1);
  assert.equal(h.state.unavailableDirs.size, 0, 'успех не оставляет отметку недоступности');
});

test('после срока папка пробуется снова: путь стенда могут создать заново', () => {
  // Отметка не вечная. Временный каталог с тем же именем появляется в
  // следующем прогоне, и наблюдатель там нужен.
  let clock = 1000;
  const h = makeSync({ now: () => clock });
  const dirs = new Set(['/private/tmp/stand']);
  h.sync(dirs);
  clock += TTL - 1; h.sync(dirs);
  assert.equal(h.attempts.length, 1, 'до истечения срока — не пробуем');
  clock += 2; h.sync(dirs);
  assert.equal(h.attempts.length, 2, 'после срока — одна новая попытка');
});

test('папка, исчезнувшая из набора, забывается сразу', () => {
  // Иначе отметки копятся на всё время работы приложения: вкладку отвязали,
  // путь больше не нужен, а запись о нём держится.
  let clock = 1000;
  const h = makeSync({ now: () => clock });
  h.sync(new Set(['/gone']));
  assert.equal(h.state.unavailableDirs.size, 1);
  h.sync(new Set());
  assert.equal(h.state.unavailableDirs.size, 0, 'отметка снята вместе с путём');
});

test('восстановленная папка действительно получает наблюдателя', () => {
  // Полный цикл: была мёртвой, срок истёк, появилась — наблюдатель поднят.
  let clock = 1000, alive = false;
  const h = makeSync({ watchThrows: () => !alive, now: () => clock });
  const dirs = new Set(['/private/tmp/stand']);
  h.sync(dirs);
  assert.equal(h.state.watchers.size, 0);
  alive = true; clock += TTL + 1;
  h.sync(dirs);
  assert.equal(h.state.watchers.size, 1, 'после восстановления наблюдатель есть');
  assert.equal(h.state.unavailableDirs.size, 0);
});

test('много мёртвых папок не множат попытки', () => {
  // В проде их было ~17 одновременно. Проверяется, что экономия линейна по
  // числу папок, а не по числу синхронизаций.
  const h = makeSync({ now: () => 1000 });
  const dirs = new Set(Array.from({ length: 17 }, (_, i) => '/dead/' + i));
  for (let i = 0; i < 102; i++) h.sync(dirs);
  assert.equal(h.attempts.length, 17, `${h.attempts.length} попыток вместо 17`);
  // Прежнее поведение дало бы 17 × 102 = 1734 — порядок того, что в логе.
});

test('срок задан и он конечный', () => {
  assert.ok(Number.isFinite(TTL) && TTL > 0, 'UNAVAILABLE_DIR_TTL_MS должен быть объявлен');
  assert.ok(TTL <= 600_000, `срок ${TTL}мс слишком велик: восстановленная папка долго не отслеживается`);
  assert.ok(TTL >= 5_000, `срок ${TTL}мс слишком мал: повторы вернутся`);
});

test('условие пропуска читает обе карты, не только наблюдателей', () => {
  // Самая вероятная форма регрессии: отметка пишется, но в условии
  // по-прежнему проверяется только `this.watchers`.
  const guard = SOURCE.match(/if \(this\.watchers\.has\(dir\).*?\) continue;/)?.[0] || '';
  assert.ok(guard.includes('this.unavailableDirs.has(dir)'),
    'пропуск должен учитывать недоступные папки: ' + guard);
});

test('отметка ставится именно в обработчике отказа', () => {
  const failure = SOURCE.slice(SOURCE.indexOf("console.warn('[TabContext] watcher unavailable:") - 400,
    SOURCE.indexOf("console.warn('[TabContext] watcher unavailable:") + 120);
  assert.ok(failure.includes('this.unavailableDirs.set(dir'),
    'отказ `fs.watch` обязан оставлять отметку, иначе повтор вернётся');
});

test('очистка отметок учитывает И срок, И исчезновение пути из набора', () => {
  // Поведенческие тесты выше исполняют копию логики, поэтому мутация ИСХОДНИКА
  // им незаметна. Эта проверка смотрит сам исходник: без `!dirs.has(dir)`
  // отметки копятся на всё время работы приложения — вкладку отвязали, путь
  // больше не нужен, а запись о нём держится до истечения срока.
  const cleanup = SOURCE.match(/for \(const \[dir, failedAt\] of this\.unavailableDirs\) \{[\s\S]{0,260}?\n    \}/)?.[0] || '';
  assert.ok(cleanup, 'цикл очистки отметок должен существовать');
  assert.ok(cleanup.includes('!dirs.has(dir)'),
    'путь, выпавший из набора, снимается сразу: ' + cleanup);
  assert.ok(cleanup.includes('UNAVAILABLE_DIR_TTL_MS'),
    'и срок тоже проверяется: ' + cleanup);
});
