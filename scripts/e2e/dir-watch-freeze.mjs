#!/usr/bin/env node
'use strict';

// Проверка на instance production: зависшая служба слежения за папками НЕ
// останавливает главный процесс Noted.
//
// Шрам 03.11 12:08–12:21: служба слежения macOS (fseventsd) застряла на
// медленном внешнем диске; главный поток Noted ждал её внутри `close()` слежения
// за папкой и 4 минуты «не отвечал». Теперь папки слушает вспомогательный
// процесс. Настоящую службу вешать нельзя (это задело бы всю систему), поэтому
// замораживается сам исполнитель — SIGSTOP. Для главного процесса это то же
// самое: исполнитель не отвечает.
//
// Цепочка настоящая: окно → IPC `file:watch-folder` → главный процесс →
// исполнитель → FSEvents → событие `fs:change` обратно в окно.
//
// Запуск (стенд из scripts/e2e/stand.mjs --mode prod):
//   node scripts/e2e/dir-watch-freeze.mjs --cdp <порт> --profile <профиль стенда>
//     [--subdirs 200] [--cycles 20]
//
// Курсор и фокус не нужны: всё через CDP и сигналы процессу.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2)
  .map((value, index, all) => value.startsWith('--') ? [value.slice(2), all[index + 1]] : null)
  .filter(Boolean));
const CDP = `http://127.0.0.1:${args.cdp || 9225}`;
const PROFILE = args.profile;
const SUBDIRS = Number(args.subdirs ?? 200);
const CYCLES = Number(args.cycles ?? 20);
if (!PROFILE) { console.error('требуется --profile (профиль стенда)'); process.exit(2); }
const LOG = path.join(PROFILE, 'logs', 'production.log');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const logSize = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };
const logSince = offset => {
  try {
    const fd = fs.openSync(LOG, 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.max(0, size - offset));
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch { return ''; }
};
async function untilLog(offset, pattern, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = logSince(offset).match(pattern);
    if (match) return { match, ms: Date.now() - started };
    await sleep(100);
  }
  return null;
}

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && !t.url.includes('devtools'));
  if (!page) throw new Error('страница не найдена на ' + CDP);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  await new Promise(resolve => { socket.onopen = resolve; });
  // Срок на каждый вызов: если главный процесс встанет, IPC из окна не вернётся,
  // и это должно стать результатом проверки, а не зависшим скриптом.
  const evaluate = (expression, timeoutMs = 15000) => new Promise(resolve => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); resolve({ timedOut: true }); }, timeoutMs);
    pending.set(next, message => { clearTimeout(timer); resolve(message.result?.result?.value); });
    socket.send(JSON.stringify({ id: next, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => socket.close() };
}

const INVOKE = (channel, arg) => `(async()=>{const {ipcRenderer}=window.require('electron');
const t=performance.now();const r=await ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(arg)});
return {ms:Math.round((performance.now()-t)*10)/10, r};})()`;

const LISTEN = `(()=>{const {ipcRenderer}=window.require('electron');window.__dirWatchE2E=[];
if(!window.__dirWatchE2EListener){window.__dirWatchE2EListener=(_e,d)=>window.__dirWatchE2E.push({at:performance.now(),path:d&&d.path});
ipcRenderer.on('fs:change',window.__dirWatchE2EListener);}return 'listening';})()`;

const SEEN = file => `(()=>{const hit=(window.__dirWatchE2E||[]).find(e=>e.path===${JSON.stringify(file)});return hit?hit.at:null})()`;

async function eventLatency(evaluate, file) {
  const started = Date.now();
  // Подписка у исполнителя асинхронна: перезаписываем файл, пока событие не придёт.
  for (let attempt = 0; Date.now() - started < 8000; attempt++) {
    fs.writeFileSync(file, 'probe ' + attempt);
    const seen = await evaluate(SEEN(file), 3000);
    if (typeof seen === 'number') return Date.now() - started;
    await sleep(150);
  }
  return null;
}

function makeTree(root, count) {
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < count; i++) fs.mkdirSync(path.join(root, 'sub-' + i));
  return root;
}

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-dirwatch-e2e-'));
  const folderA = makeTree(path.join(base, 'A'), SUBDIRS);
  const folderB = makeTree(path.join(base, 'B'), Math.max(1, Math.round(SUBDIRS / 4)));
  const { evaluate, close } = await connect();
  const result = { subdirs: SUBDIRS, cycles: CYCLES };
  let hostPid = null;
  try {
    await evaluate(LISTEN);
    const startOffset = logSize();
    const first = await evaluate(INVOKE('file:watch-folder', folderA));
    result.baselineWatchMs = first?.ms ?? first;

    // Исполнитель поднимается при первом слежении за папкой (часто ещё при старте
    // приложения); берём последний pid из лога стенда.
    const ready = (logSince(0).match(/\[DirWatchHost\] ready pid=(\d+)/g) || []).pop();
    hostPid = ready ? Number(ready.match(/pid=(\d+)/)[1]) : null;
    if (!hostPid) {
      const later = await untilLog(startOffset, /\[DirWatchHost\] ready pid=(\d+)/, 5000);
      hostPid = later ? Number(later.match[1]) : null;
    }
    result.hostPid = hostPid;
    if (!hostPid) throw new Error('исполнитель не найден в логе стенда');
    process.kill(hostPid, 0);

    result.baselineEventMs = await eventLatency(evaluate, path.join(folderA, 'sub-7', 'probe-baseline.txt'));

    // ---- Заморозка: исполнитель не отвечает, как при застрявшей службе ----
    const freezeOffset = logSize();
    process.kill(hostPid, 'SIGSTOP');
    const frozenAt = Date.now();
    const durations = [];
    let timedOut = 0;
    for (let i = 0; i < CYCLES; i++) {
      const target = i % 2 === 0 ? folderB : folderA;
      const reply = await evaluate(INVOKE('file:watch-folder', target), 10000);
      if (reply?.timedOut) timedOut++;
      else durations.push(reply?.ms ?? -1);
    }
    result.frozen = {
      invokes: CYCLES,
      // Каждый вызов закрывает слежение за всеми папками прежнего дерева и
      // открывает новое: при прямом fs.watch первое же закрытие ждало бы службу.
      watchersClosedPerInvoke: `${Math.round(SUBDIRS / 4) + 1}..${SUBDIRS + 1}`,
      timedOut,
      maxInvokeMs: Math.max(...durations),
      medianInvokeMs: durations.slice().sort((a, b) => a - b)[Math.floor(durations.length / 2)],
    };
    const notResponding = await untilLog(freezeOffset, /\[DirWatchHost\] not-responding[^\n]*/, 10000);
    result.frozen.notRespondingLog = notResponding ? notResponding.match[0].slice(0, 160) : null;
    // Сторож главного процесса за всё время заморозки.
    const frozenLog = logSince(freezeOffset);
    result.frozen.mainStalls = (frozenLog.match(/\[Watchdog\] STALL proc=main[^\n]*/g) || []).map(line => line.slice(0, 120));
    result.frozen.heldMs = Date.now() - frozenAt;

    // ---- Служба «ожила» ----
    const thawOffset = logSize();
    process.kill(hostPid, 'SIGCONT');
    const again = await untilLog(thawOffset, /\[DirWatchHost\] responding-again[^\n]*/, 60000);
    result.thaw = { respondingAgainLog: again ? again.match[0].slice(0, 120) : null, afterMs: again?.ms ?? null };
    const current = CYCLES % 2 === 1 ? folderB : folderA;
    result.thaw.eventMs = await eventLatency(evaluate, path.join(current, 'sub-3', 'probe-after.txt'));

    result.pass = result.frozen.timedOut === 0 && result.frozen.maxInvokeMs < 500
      && result.frozen.mainStalls.length === 0 && !!result.frozen.notRespondingLog
      && !!result.thaw.respondingAgainLog && result.thaw.eventMs !== null && result.baselineEventMs !== null;
  } catch (error) {
    result.error = String(error?.message || error);
    result.pass = false;
  } finally {
    if (hostPid) { try { process.kill(hostPid, 'SIGCONT'); } catch {} }
    await evaluate(INVOKE('file:unwatch-folder', null), 10000).catch(() => {});
    close();
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(JSON.stringify(result, null, 1));
  process.exit(result.pass ? 0 : 1);
})().catch(error => { console.error('ОШИБКА:', error.message); process.exit(1); });
