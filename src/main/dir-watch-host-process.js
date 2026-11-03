'use strict';

// Вспомогательный процесс слежения за ПАПКАМИ. Зачем он нужен и что именно
// изолирует — в `dir-watch.js`. Здесь только исполнитель: держит настоящие
// `fs.watch`, пересылает события и сам ждёт системную службу при закрытии.
//
// Если служба слежения macOS (fseventsd) зависнет, `close()` здесь встанет без
// срока — и это нормально: встанет ТОЛЬКО этот процесс. Сообщения главного
// процесса подождут в канале и выполнятся по порядку, когда служба оживёт.
//
// Работает и как Electron utilityProcess (`process.parentPort`), и как обычный
// дочерний процесс Node (`process.send`) — второе нужно тестам.

const fs = require('node:fs');

function channel() {
  if (process.parentPort) {
    return {
      on: handler => process.parentPort.on('message', event => handler(event?.data)),
      post: message => process.parentPort.postMessage(message),
    };
  }
  if (typeof process.send === 'function') {
    // Родитель-тест ушёл — уходим и мы, а не висим сиротой.
    process.on('disconnect', () => process.exit(0));
    return {
      on: handler => process.on('message', handler),
      post: message => { try { process.send(message); } catch {} },
    };
  }
  throw new Error('dir-watch host needs a parent channel');
}

const port = channel();
const watchers = new Map();

// События копятся в пределах одного оборота цикла и уходят одним сообщением:
// рекурсивное слежение за репозиторием во время сборки даёт тысячи событий, и
// по сообщению на каждое было бы дороже для главного процесса, чем было раньше.
let batch = [];
let flushQueued = false;
function flush() {
  flushQueued = false;
  if (!batch.length) return;
  const events = batch;
  batch = [];
  port.post({ t: 'ev', events });
}
function queueEvent(id, eventType, filename) {
  batch.push([id, eventType, filename == null ? null : String(filename)]);
  if (!flushQueued) { flushQueued = true; setImmediate(flush); }
}

function startWatch({ id, target, recursive }) {
  const startedAt = Date.now();
  let watcher;
  try {
    watcher = fs.watch(target, { recursive: !!recursive, persistent: true },
      (eventType, filename) => queueEvent(id, eventType, filename));
  } catch (error) {
    port.post({ t: 'err', id, op: 'watch', code: error?.code || null, message: String(error?.message || error) });
    return;
  }
  watcher.on('error', error => {
    if (watchers.get(id) !== watcher) return;
    watchers.delete(id);
    try { watcher.close(); } catch {}
    // Уже пришедшие события должны дойти раньше ошибки, как у прямого fs.watch.
    flush();
    port.post({ t: 'err', id, op: 'event', code: error?.code || null, message: String(error?.message || error) });
  });
  watchers.set(id, watcher);
  port.post({ t: 'ack', op: 'watch', id, ms: Date.now() - startedAt });
}

function stopWatch({ id }) {
  const watcher = watchers.get(id);
  watchers.delete(id);
  const startedAt = Date.now();
  // Именно здесь при зависшей службе стоял главный поток Noted 03.11.
  if (watcher) { try { watcher.close(); } catch {} }
  port.post({ t: 'ack', op: 'close', id, ms: Date.now() - startedAt });
}

port.on(message => {
  if (!message || typeof message !== 'object') return;
  if (message.t === 'watch') startWatch(message);
  else if (message.t === 'close') stopWatch(message);
});

port.post({ t: 'ready', pid: process.pid });
