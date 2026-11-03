// Слежение за папками живёт во вспомогательном процессе: зависшая системная
// служба слежения не должна останавливать главный поток.
//
// Шрам 03.11 12:08–12:21: служба слежения macOS (fseventsd) застряла на
// медленном внешнем диске и 12.5 минуты не отвечала никому. Главный поток
// Noted закрыл слежение за папкой (`fs.watch(...).close()`), libuv стал ждать
// ответа службы без срока — окно «не отвечает» 4 минуты, перезапуск не помог.
//
// Настоящую службу тест не вешает (это задело бы всю систему). Вместо неё
// замораживается сам исполнитель — SIGSTOP. Для главного процесса это то же
// самое: исполнитель не отвечает. Проверяется ровно пользовательский результат:
// главный поток при этом свободен, а после разморозки слежение продолжается.
//
// Run: node --test src/main/dirWatchHost.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const dirWatch = require('./dir-watch');
const { DirWatchHost, HostedDirWatcher, nodeSpawn, routeWatch } = dirWatch;

const MAIN_DIR = __dirname;

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dirwatch-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeHost(t, extra = {}) {
  const lines = [];
  const log = {
    log: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line),
  };
  const spawned = [];
  const host = new DirWatchHost({
    spawn: () => { const child = nodeSpawn(); spawned.push(child); return child; },
    log,
    ...extra,
  });
  t.after(() => host.shutdown());
  return { host, lines, spawned };
}

function until(predicate, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('timeout: ' + label)); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

// Событие о файле в папке. FSEvents иногда сначала отдаёт событие о самой
// папке — ждём именно нужное имя.
function nextEventFor(watcher, name, write) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { done = true; reject(new Error('no event for ' + name)); }, 8000);
    watcher.on('change', function onChange(eventType, filename) {
      if (filename && String(filename).endsWith(name)) {
        done = true;
        clearTimeout(timer);
        watcher.removeListener('change', onChange);
        resolve({ eventType, filename });
      }
    });
    // Подписка у исполнителя асинхронна: пишем, пока событие не придёт.
    let n = 0;
    const poke = () => {
      if (done) return;
      write(n++);
      if (n < 40) setTimeout(poke, 150);
    };
    setTimeout(poke, 50);
  });
}

test('событие о новом файле приходит через исполнитель', { skip: process.platform !== 'darwin' }, async t => {
  const dir = tempDir(t);
  const { host } = makeHost(t);
  const watcher = host.watch(dir, false);
  assert.ok(watcher instanceof HostedDirWatcher);
  const event = await nextEventFor(watcher, 'a.txt', n => fs.writeFileSync(path.join(dir, 'a.txt'), String(n)));
  assert.match(String(event.filename), /a\.txt$/);
  assert.ok(['rename', 'change'].includes(event.eventType));
  watcher.close();
});

test('рекурсивное слежение отдаёт путь вложенного файла', { skip: process.platform !== 'darwin' }, async t => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'sub'));
  const { host } = makeHost(t);
  const watcher = host.watch(dir, true);
  const event = await nextEventFor(watcher, 'deep.txt',
    n => fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), String(n)));
  assert.equal(String(event.filename), path.join('sub', 'deep.txt'));
  watcher.close();
});

test("close: событий больше нет, 'close' приходит один раз, повтор безопасен", { skip: process.platform !== 'darwin' }, async t => {
  const dir = tempDir(t);
  const { host } = makeHost(t);
  const watcher = host.watch(dir, false);
  await nextEventFor(watcher, 'b.txt', n => fs.writeFileSync(path.join(dir, 'b.txt'), String(n)));
  let closes = 0;
  let after = 0;
  watcher.on('close', () => closes++);
  watcher.on('change', () => after++);
  watcher.close();
  watcher.close();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'b.txt'), 'x' + i);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(closes, 1, "'close' ровно один раз, как у fs.FSWatcher");
  assert.equal(after, 0, 'после close() слушатель не вызывается');
  assert.equal(host.state().watches, 0);
});

test('ЗАМОРОЖЕННЫЙ исполнитель не останавливает главный поток', { skip: process.platform !== 'darwin' }, async t => {
  // Прямая репродукция 03.11: служба не отвечает, а главный процесс
  // продолжает открывать и закрывать слежение за папками.
  const dir = tempDir(t);
  const { host, lines, spawned } = makeHost(t, { notRespondingMs: 300 });
  const first = host.watch(dir, false);
  await nextEventFor(first, 'warm.txt', n => fs.writeFileSync(path.join(dir, 'warm.txt'), String(n)));

  const child = spawned[0];
  process.kill(child.pid, 'SIGSTOP');
  t.after(() => { try { process.kill(child.pid, 'SIGCONT'); } catch {} });

  // 300 открытий и закрытий подряд. При прямом fs.watch первое же close()
  // ждало бы службу без срока.
  let slowest = 0;
  const started = performance.now();
  for (let i = 0; i < 300; i++) {
    const at = performance.now();
    const watcher = host.watch(dir, i % 2 === 0);
    watcher.close();
    slowest = Math.max(slowest, performance.now() - at);
  }
  first.close();
  const total = performance.now() - started;
  assert.ok(slowest < 20, 'одна операция главного потока заняла ' + slowest.toFixed(1) + ' мс');
  assert.ok(total < 500, '300 операций заняли ' + total.toFixed(0) + ' мс');

  // Цикл событий главного процесса жив: таймер срабатывает вовремя.
  const lagStart = performance.now();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(performance.now() - lagStart < 250, 'цикл событий главного процесса не должен стоять');

  // Диагностика объясняет, что ждёт именно исполнитель.
  await until(() => lines.some(line => line.includes('[DirWatchHost] not-responding')), 'not-responding log');
  assert.ok(host.state().pendingOps > 0, 'операции ждут исполнителя, а не главный поток');

  // Служба «ожила»: очередь выполняется по порядку, слежение работает снова.
  process.kill(child.pid, 'SIGCONT');
  await until(() => lines.some(line => line.includes('[DirWatchHost] responding-again')), 'responding-again log');
  await until(() => host.state().pendingOps === 0, 'pending drained');
  // Разбор очереди после разморозки — не новый эпизод: старые операции в ней
  // законно «старые», но исполнитель уже отвечает. Один эпизод — по строке.
  const count = tag => lines.filter(line => line.includes('[DirWatchHost] ' + tag)).length;
  assert.equal(count('not-responding'), 1, 'одна строка «не отвечает» на эпизод');
  assert.equal(count('responding-again'), 1, 'одна строка «снова отвечает» на эпизод');
  const again = host.watch(dir, false);
  await nextEventFor(again, 'after.txt', n => fs.writeFileSync(path.join(dir, 'after.txt'), String(n)));
  again.close();
});

test('падение исполнителя: слежение восстанавливается само', { skip: process.platform !== 'darwin' }, async t => {
  const dir = tempDir(t);
  const { host, spawned } = makeHost(t);
  const watcher = host.watch(dir, false);
  await nextEventFor(watcher, 'c.txt', n => fs.writeFileSync(path.join(dir, 'c.txt'), String(n)));
  process.kill(spawned[0].pid, 'SIGKILL');
  await until(() => spawned.length === 2 && host.state().generation === 2, 'respawn');
  // Тот же объект слежения продолжает получать события: вызывающий не знает
  // о перезапуске.
  const event = await nextEventFor(watcher, 'd.txt', n => fs.writeFileSync(path.join(dir, 'd.txt'), String(n)));
  assert.match(String(event.filename), /d\.txt$/);
  watcher.close();
});

test('исполнитель падает подряд: слежение возвращается в главный процесс, а не пропадает', { skip: process.platform !== 'darwin' }, async t => {
  const dir = tempDir(t);
  const { host, lines, spawned } = makeHost(t);
  const watcher = host.watch(dir, false);
  for (let i = 0; i < dirWatch.CRASH_LIMIT; i++) {
    await until(() => spawned[i], 'child ' + i);
    process.kill(spawned[i].pid, 'SIGKILL');
    await until(() => host.state().mode === (i + 1 < dirWatch.CRASH_LIMIT ? 'host' : 'direct-fallback')
      && (i + 1 >= dirWatch.CRASH_LIMIT || spawned.length === i + 2), 'state after crash ' + i);
  }
  assert.equal(host.state().mode, 'direct-fallback');
  assert.ok(lines.some(line => line.includes('direct-fallback reason=crash-loop')));
  const event = await nextEventFor(watcher, 'e.txt', n => fs.writeFileSync(path.join(dir, 'e.txt'), String(n)));
  assert.match(String(event.filename), /e\.txt$/);
  watcher.close();
});

test("отказ исполнителя приходит событием 'error' с кодом", { skip: process.platform !== 'darwin' }, async t => {
  const dir = tempDir(t);
  const { host } = makeHost(t);
  const missing = path.join(dir, 'missing');
  const watcher = host.watch(missing, false);
  const error = await new Promise(resolve => watcher.on('error', resolve));
  assert.equal(error.code, 'ENOENT');
  assert.equal(error.syscall, 'watch');
  assert.equal(error.path, missing);
  assert.equal(host.state().watches, 0, 'неудачное слежение не удерживается');
});

test('маршрут: папка — через исполнитель, файл — прямой fs.watch, нет пути — синхронный отказ', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, '1');
  const calls = [];
  const fakeHost = { watch: (target, recursive) => { calls.push({ target, recursive }); return { kind: 'hosted' }; } };

  assert.deepEqual(routeWatch(() => fakeHost, dir, { recursive: true }, () => {}), { kind: 'hosted' });
  assert.deepEqual(calls, [{ target: dir, recursive: true }]);
  assert.deepEqual(routeWatch(() => fakeHost, dir, () => {}), { kind: 'hosted' }, 'вызов без опций');
  assert.equal(calls[1].recursive, false);

  const direct = routeWatch(() => fakeHost, file, { persistent: false }, () => {});
  assert.equal(direct.constructor.name, 'FSWatcher', 'слежение за файлом не уходит в исполнитель');
  direct.close();
  assert.equal(calls.length, 2);

  assert.throws(() => routeWatch(() => fakeHost, path.join(dir, 'nope'), {}, () => {}), error =>
    error.code === 'ENOENT' && error.syscall === 'watch' && /watch '/.test(error.message),
  'отказ того же вида и в тот же момент, что у fs.watch');
  assert.equal(calls.length, 2);
});

test('вне Electron watch() — это обычный fs.watch', t => {
  const dir = tempDir(t);
  const watcher = dirWatch.watch(dir, { persistent: false }, () => {});
  assert.equal(watcher.constructor.name, 'FSWatcher');
  watcher.close();
  assert.equal(dirWatch.watchWith(fs), dirWatch.watch, 'настоящий fs — через общий маршрут');
  const fake = { watch: (...args) => ({ fake: args.length }) };
  assert.deepEqual(dirWatch.watchWith(fake)('x', {}, () => {}), { fake: 3 }, 'подмена из теста — как есть');
});

// ---- Структурная защита -------------------------------------------------------
// Новое `fs.watch(папка)` в главном процессе снова привязало бы окно к службе.
// Прямой fs.watch разрешён только для отдельных ФАЙЛОВ (kqueue) — их список ниже.

const DIRECT_FILE_WATCHES = {
  'main.js': [
    "fs.watch(filePath, { persistent: false }, onChange)",
    "fs.watch(\n      preparation.filePath,",
    "fs.watch(target.filePath, () => {",
    "fs.watch(filePath, () => scanCodexTurnAppend(",
    "fs.watch(sessionFilePath, { persistent: false },",
    "fs.watch(w.filePath, { persistent: false }, () => {",
  ],
  'web-server.js': ["fs.watch(filePath, () => {"],
  'session-transcript-service.js': ["fs.watch(state.filePath, { persistent: false },"],
};

const MAIN_MODULES = [
  'main.js', 'web-server.js', 'tab-work-context.js', 'claude-bridge-transcript-recheck.js',
  'claude-prompt-audit.js', 'prompt-catalog-preparation.js', 'session-transcript-service.js',
  'ipc/git.js', 'ipc/semantic-index-status.js', 'ipc/claude-md-mirror.js',
];

test('в главном процессе нет прямого слежения за папками', () => {
  for (const relative of MAIN_MODULES) {
    const source = fs.readFileSync(path.join(MAIN_DIR, relative), 'utf8');
    const allowed = DIRECT_FILE_WATCHES[path.basename(relative)] || [];
    let index = -1;
    while ((index = source.indexOf('fs.watch(', index + 1)) !== -1) {
      const before = source.slice(Math.max(0, index - 12), index);
      if (/dirWatch\.$|Impl\.$|[A-Za-z_]$/.test(before)) continue; // dirWatch.watch / fsImpl.watch / myfs.watch
      const site = source.slice(index, index + 60);
      assert.ok(allowed.some(prefix => site.startsWith(prefix)),
        relative + ': прямой fs.watch вне списка файловых — ' + JSON.stringify(site.split('\n')[0]));
    }
  }
});

test('модули с подменяемым fs ведут настоящий fs через dirWatch', () => {
  for (const relative of ['claude-bridge-transcript-recheck.js', 'claude-prompt-audit.js', 'prompt-catalog-preparation.js']) {
    const source = fs.readFileSync(path.join(MAIN_DIR, relative), 'utf8');
    assert.ok(source.includes('watchWith('), relative + ': слежение должно идти через dirWatch.watchWith');
    assert.ok(!/(fsImpl|fileSystem|service\.fs)\.watch\(/.test(source), relative + ': прямой вызов подменяемого fs.watch');
  }
});
