'use strict';

/**
 * Слежение за ПАПКАМИ — во вспомогательном процессе, а не в главном.
 *
 * Шрам 03.11 12:08–12:21 (Бангкок). Внешний диск digma512 отвечал по 40 с на
 * чтение папки, и системная служба слежения macOS (fseventsd) застряла на нём:
 * 12.5 минуты она не отвечала НИ ОДНОЙ программе, в том числе про основной
 * диск. На macOS `fs.watch(папка)` идёт через эту службу, а `close()` в libuv
 * ждёт её ответа без срока прямо в вызывающем потоке. Главный поток Noted
 * перестал следить за папкой и встал на 4 минуты («не отвечает»); перезапуск
 * и переустановка не помогли, пока служба стояла. Отчёт macOS:
 * `uv_fs_event_stop → semaphore_wait`, поток FSEvents — в
 * `FSEventStreamStop → f2d_unregister_rpc`, «waiting for fseventsd».
 *
 * Здесь главный процесс только посылает сообщения «следи» и «перестань».
 * Ответа службы ждёт вспомогательный процесс. Если служба застрянет, встанет
 * только он: окно, ввод и История работают, уведомления об изменениях придут,
 * когда служба оживёт, — сообщения ждут в канале и выполнятся по порядку.
 *
 * Почему процесс, а не поток: при выходе Node дожидается своих потоков, и
 * зависший в службе поток не дал бы приложению закрыться. Процесс просто
 * завершается.
 *
 * Интерфейс — как у `fs.watch`: тот же вызов, объект с close/on/ref/unref,
 * событие 'close' после close(), синхронный отказ для несуществующей папки.
 * Слежение за отдельным ФАЙЛОМ идёт через kqueue, службу не задевает и
 * остаётся прямым `fs.watch`. Вне macOS и вне Electron (тесты) — тоже прямой.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const HOST_ENTRY = path.join(__dirname, 'dir-watch-host-process.js');

// Сколько исполнитель может не отвечать, прежде чем это попадёт в лог. Это
// только диагностика: ничего не ждёт этот срок и ничего не делается по нему.
const NOT_RESPONDING_MS = 5000;
// Операция дольше этого — признак медленной службы, пишется в лог.
const SLOW_OP_MS = 250;
// Защита от бесконечного перезапуска: столько падений за окно — и слежение
// возвращается в главный процесс, чтобы возможность не пропала совсем.
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 60_000;

class HostedDirWatcher extends EventEmitter {
  constructor(host, id) {
    super();
    this._host = host;
    this._id = id;
    this._closed = false;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._host._closeEntry(this._id);
    // Как у fs.FSWatcher: 'close' приходит на следующем тике.
    process.nextTick(() => this.emit('close'));
  }

  // У процесса-исполнителя свой цикл; удерживать или отпускать главный цикл
  // нечем. Методы есть, потому что вызывающие их зовут.
  ref() { return this; }
  unref() { return this; }

  _deliver(eventType, filename) {
    if (!this._closed) this.emit('change', eventType, filename);
  }

  _fail(error) {
    if (this._closed) return;
    // Как у fs.FSWatcher: после ошибки слежение снято, 'close' не приходит.
    this._closed = true;
    if (this.listenerCount('error') > 0) this.emit('error', error);
    else console.warn('[DirWatchHost] watcher error without handler code=' + (error?.code || 'unknown')
      + ' path=' + (error?.path || '?'));
  }
}

class DirWatchHost {
  constructor({
    spawn,
    canSpawnNow = () => true,
    whenReady = () => Promise.resolve(),
    log = console,
    now = Date.now,
    notRespondingMs = NOT_RESPONDING_MS,
  } = {}) {
    if (typeof spawn !== 'function') throw new Error('DirWatchHost needs spawn()');
    this.notRespondingMs = notRespondingMs;
    this.spawn = spawn;
    this.canSpawnNow = canSpawnNow;
    this.whenReady = whenReady;
    this.log = log;
    this.now = now;
    this.entries = new Map();
    this.nextId = 0;
    this.child = null;
    this.generation = 0;
    this.waitingReady = false;
    this.direct = false;
    this.stopping = false;
    this.crashes = [];
    this.pending = new Map();
    this.notResponding = null;
    this.lastHeardAt = 0;
    this.timer = null;
    this.stats = { eventsDelivered: 0, respawns: 0, slowOps: 0, maxCloseMs: 0, maxWatchMs: 0 };
  }

  watch(target, recursive, listener) {
    const id = ++this.nextId;
    const wrapper = new HostedDirWatcher(this, id);
    if (typeof listener === 'function') wrapper.on('change', listener);
    const entry = { id, target, recursive: !!recursive, wrapper, generation: 0, direct: null };
    this.entries.set(id, entry);
    if (this.direct) this._attachDirect(entry);
    else if (this.child) this._sendWatch(entry);
    else this._ensureChild();
    return wrapper;
  }

  state() {
    const oldest = this._oldestPending();
    return {
      mode: this.direct ? 'direct-fallback' : (this.child ? 'host' : 'starting'),
      pid: this.child?.pid ?? null,
      generation: this.generation,
      watches: this.entries.size,
      pendingOps: this.pending.size,
      oldestPendingMs: oldest ? this.now() - oldest.sentAt : 0,
      notResponding: !!this.notResponding,
      ...this.stats,
    };
  }

  shutdown() {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const child = this.child;
    this.child = null;
    if (child) { try { child.kill(); } catch {} }
  }

  _ensureChild() {
    if (this.child || this.direct || this.stopping || this.waitingReady) return;
    if (!this.canSpawnNow()) {
      // Electron не создаёт вспомогательные процессы до готовности приложения.
      // Запросы до этого момента просто лежат в entries и уйдут при старте.
      this.waitingReady = true;
      Promise.resolve(this.whenReady()).then(() => {
        this.waitingReady = false;
        this._ensureChild();
      }, () => { this.waitingReady = false; this._enterDirect('ready-failed'); });
      return;
    }
    let child;
    const startedAt = this.now();
    try { child = this.spawn(); }
    catch (error) {
      this.log.warn?.('[DirWatchHost] spawn failed: ' + (error?.message || error));
      this._enterDirect('spawn-failed');
      return;
    }
    const generation = ++this.generation;
    this.child = child;
    child.onMessage(message => this._onMessage(generation, message, startedAt));
    child.onExit((code, signal) => this._onExit(generation, code, signal));
    for (const entry of this.entries.values()) this._sendWatch(entry);
  }

  _sendWatch(entry) {
    entry.generation = this.generation;
    this._track('watch', entry);
    this._post({ t: 'watch', id: entry.id, target: entry.target, recursive: entry.recursive });
  }

  _closeEntry(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.pending.delete('watch:' + id);
    if (entry.direct) {
      // Только в аварийном режиме: исполнитель недоступен, слежение в главном.
      try { entry.direct.close(); } catch {}
      return;
    }
    if (this.child && entry.generation === this.generation) {
      this._track('close', entry);
      this._post({ t: 'close', id });
    }
  }

  _post(message) {
    try { this.child?.post(message); }
    catch (error) {
      // Канал закрыт: процесс умирает, 'exit' придёт и всё перерегистрирует.
      this.log.warn?.('[DirWatchHost] post failed op=' + message.t + ': ' + (error?.message || error));
    }
  }

  _track(op, entry) {
    this.pending.set(op + ':' + entry.id, { op, id: entry.id, target: entry.target, sentAt: this.now(), generation: this.generation });
    this._armTimer();
  }

  _oldestPending() {
    let oldest = null;
    for (const item of this.pending.values()) if (!oldest || item.sentAt < oldest.sentAt) oldest = item;
    return oldest;
  }

  // Молчание исполнителя считается с ПОСЛЕДНЕГО его сообщения, а не от
  // возраста старейшей операции: после разморозки он разбирает очередь, старые
  // операции в ней законно «старые», но исполнитель уже отвечает. Иначе лог
  // чередовал бы «не отвечает» / «снова отвечает» на каждом ответе.
  _silenceSince() {
    const oldest = this._oldestPending();
    return oldest ? Math.max(oldest.sentAt, this.lastHeardAt) : null;
  }

  _armTimer() {
    if (this.timer || this.notResponding || this.stopping) return;
    const since = this._silenceSince();
    if (since === null) return;
    const wait = Math.max(0, this.notRespondingMs - (this.now() - since));
    this.timer = setTimeout(() => { this.timer = null; this._checkResponding(); }, wait);
    this.timer.unref?.();
  }

  _checkResponding() {
    const since = this._silenceSince();
    if (since === null) return;
    const silentMs = this.now() - since;
    if (silentMs < this.notRespondingMs) { this._armTimer(); return; }
    const oldest = this._oldestPending();
    this.notResponding = { since };
    // Один раз за эпизод. Главный поток при этом свободен: ждёт исполнитель.
    this.log.warn?.('[DirWatchHost] not-responding silentMs=' + silentMs + ' pending=' + this.pending.size
      + ' op=' + oldest.op + ' path=' + oldest.target + ' pid=' + (this.child?.pid ?? '?')
      + ' — main thread is free; folder events resume when the system watch service answers');
  }

  _onMessage(generation, message, startedAt) {
    if (generation !== this.generation || !message || typeof message !== 'object') return;
    this.lastHeardAt = this.now();
    if (message.t === 'ev') {
      for (const [id, eventType, filename] of message.events || []) {
        const entry = this.entries.get(id);
        if (!entry || entry.generation !== generation) continue;
        this.stats.eventsDelivered++;
        try { entry.wrapper._deliver(eventType, filename); }
        catch (error) {
          // Исключение слушателя не должно отнимать события у соседних папок
          // из той же пачки; видимость сохраняем, как у прямого fs.watch.
          this.log.error?.('[DirWatchHost] listener threw path=' + entry.target + ': ' + (error?.message || error));
          queueMicrotask(() => { throw error; });
        }
      }
      return;
    }
    if (message.t === 'ack') {
      const key = message.op + ':' + message.id;
      const item = this.pending.get(key);
      this.pending.delete(key);
      const ms = Number(message.ms) || 0;
      if (message.op === 'close' && ms > this.stats.maxCloseMs) this.stats.maxCloseMs = ms;
      if (message.op === 'watch' && ms > this.stats.maxWatchMs) this.stats.maxWatchMs = ms;
      if (ms >= SLOW_OP_MS) {
        this.stats.slowOps++;
        this.log.warn?.('[DirWatchHost] slow-' + message.op + ' ms=' + ms + ' path=' + (item?.target || '?')
          + ' (system watch service; main thread was not blocked)');
      }
      this._afterAck();
      return;
    }
    if (message.t === 'err') {
      this.pending.delete('watch:' + message.id);
      const entry = this.entries.get(message.id);
      if (entry && entry.generation === generation) {
        this.entries.delete(message.id);
        const error = Object.assign(new Error(message.message || 'watch failed'), {
          code: message.code || undefined, syscall: 'watch', path: entry.target, filename: entry.target,
        });
        entry.wrapper._fail(error);
      }
      this._afterAck();
      return;
    }
    if (message.t === 'ready') {
      this.log.log?.('[DirWatchHost] ready pid=' + message.pid + ' generation=' + generation
        + ' startMs=' + (this.now() - startedAt) + ' watches=' + this.entries.size);
    }
  }

  _afterAck() {
    // Исполнитель однопоточный и выполняет сообщения по порядку: любой ответ
    // значит, что его цикл снова идёт, даже если за ним уже стоят новые.
    if (this.notResponding) {
      this.log.log?.('[DirWatchHost] responding-again stalledMs=' + (this.now() - this.notResponding.since)
        + ' pending=' + this.pending.size);
      this.notResponding = null;
    }
    if (!this.pending.size && this.timer) { clearTimeout(this.timer); this.timer = null; }
    else this._armTimer();
  }

  _onExit(generation, code, signal) {
    if (generation !== this.generation) return;
    this.child = null;
    for (const key of [...this.pending.keys()]) if (this.pending.get(key).generation === generation) this.pending.delete(key);
    if (this.notResponding) this.notResponding = null;
    if (this.stopping) return;
    const at = this.now();
    this.crashes = this.crashes.filter(time => at - time < CRASH_WINDOW_MS);
    this.crashes.push(at);
    this.log.warn?.('[DirWatchHost] exited code=' + code + ' signal=' + (signal || 'none')
      + ' watches=' + this.entries.size + ' crashesInWindow=' + this.crashes.length);
    if (this.crashes.length >= CRASH_LIMIT) { this._enterDirect('crash-loop'); return; }
    this.stats.respawns++;
    this._ensureChild();
  }

  _enterDirect(reason) {
    if (this.direct) return;
    this.direct = true;
    const child = this.child;
    this.child = null;
    if (child) { try { child.kill(); } catch {} }
    this.pending.clear();
    this.log.error?.('[DirWatchHost] direct-fallback reason=' + reason + ' watches=' + this.entries.size
      + ' — folder watching returns to the main process; a hung system watch service can freeze it again');
    for (const entry of [...this.entries.values()]) this._attachDirect(entry);
  }

  _attachDirect(entry) {
    try {
      entry.direct = fs.watch(entry.target, { recursive: entry.recursive },
        (eventType, filename) => { this.stats.eventsDelivered++; entry.wrapper._deliver(eventType, filename); });
      entry.direct.on('error', error => {
        if (this.entries.get(entry.id) !== entry) return;
        this.entries.delete(entry.id);
        try { entry.direct.close(); } catch {}
        entry.wrapper._fail(error);
      });
    } catch (error) {
      this.entries.delete(entry.id);
      process.nextTick(() => entry.wrapper._fail(error));
    }
  }
}

// ---- Связка с Electron -------------------------------------------------------

function electronSpawn() {
  const { utilityProcess } = require('electron');
  const child = utilityProcess.fork(HOST_ENTRY, [], {
    serviceName: 'Noted Folder Watch',
    stdio: 'inherit',
    env: { ...process.env, NOTED_DIR_WATCH_HOST_PROCESS: '1' },
  });
  return {
    get pid() { return child.pid; },
    post: message => child.postMessage(message),
    onMessage: handler => child.on('message', handler),
    onExit: handler => child.on('exit', code => handler(code, null)),
    kill: () => child.kill(),
  };
}

/** Дочерний процесс Node с тем же исполнителем — для тестов. */
function nodeSpawn({ execPath = process.execPath } = {}) {
  const { fork } = require('node:child_process');
  const child = fork(HOST_ENTRY, [], { execPath, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return {
    get pid() { return child.pid; },
    post: message => { if (child.connected) child.send(message); },
    onMessage: handler => child.on('message', handler),
    onExit: handler => child.on('exit', (code, signal) => handler(code, signal)),
    kill: signal => child.kill(signal),
    process: child,
  };
}

function hostAvailable() {
  if (process.platform !== 'darwin') return false;           // FSEvents есть только здесь
  if (process.env.NOTED_DIR_WATCH_HOST === '0') return false; // аварийный выключатель
  if (process.type !== 'browser') return false;               // только главный процесс Electron
  try { return typeof require('electron').utilityProcess?.fork === 'function'; }
  catch { return false; }
}

let sharedHost = null;
function host() {
  if (sharedHost) return sharedHost;
  const electron = require('electron');
  sharedHost = new DirWatchHost({
    spawn: electronSpawn,
    canSpawnNow: () => electron.app.isReady(),
    whenReady: () => electron.app.whenReady(),
  });
  electron.app.once('will-quit', () => sharedHost?.shutdown());
  return sharedHost;
}

// Отказ того же вида, что у fs.watch: синхронный, с syscall 'watch'.
function asWatchError(error, target) {
  const message = String(error?.message || error).replace(/, (stat|access) '/, ", watch '");
  return Object.assign(new Error(message), {
    errno: error?.errno, code: error?.code, syscall: 'watch', path: target, filename: target,
  });
}

/**
 * Маршрут одного вызова: папка — через исполнитель, остальное — прямой fs.watch.
 * Отдельно от `watch`, чтобы тест проверил маршрут без Electron.
 */
function routeWatch(getHost, target, options, listener) {
  if (typeof options === 'function') { listener = options; options = undefined; }
  let stat;
  try {
    stat = fs.statSync(target);
    // Прямой fs.watch открывает папку на чтение; та же проверка даёт тот же
    // синхронный отказ, а не запоздалую ошибку из другого процесса.
    if (stat.isDirectory()) fs.accessSync(target, fs.constants.R_OK);
  } catch (error) {
    throw asWatchError(error, target);
  }
  if (!stat.isDirectory()) return fs.watch(target, options, listener);
  const recursive = !!(options && typeof options === 'object' && options.recursive);
  return getHost().watch(target, recursive, listener);
}

/**
 * Замена `fs.watch` с тем же вызовом. Папки на macOS в Electron — через
 * исполнитель; всё остальное — прямой `fs.watch`.
 */
function watch(target, options, listener) {
  if (typeof target !== 'string' || !hostAvailable() || sharedHost?.direct) {
    return fs.watch(target, options, listener);
  }
  return routeWatch(host, target, options, listener);
}

/**
 * Для модулей с подменяемым fs: настоящий fs — через `watch`, подмена из
 * теста — как есть.
 */
function watchWith(fsImpl) {
  if (!fsImpl || fsImpl === fs) return watch;
  return (...args) => fsImpl.watch(...args);
}

function dirWatchState() {
  return sharedHost ? sharedHost.state() : { mode: hostAvailable() ? 'idle' : 'direct', watches: 0 };
}

module.exports = {
  watch,
  watchWith,
  dirWatchState,
  DirWatchHost,
  HostedDirWatcher,
  routeWatch,
  nodeSpawn,
  HOST_ENTRY,
  NOT_RESPONDING_MS,
  CRASH_LIMIT,
};
