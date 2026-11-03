#!/usr/bin/env node
'use strict';

// Замер лага «перешёл на вкладку и сразу скроллю» — НАСТОЯЩИМ системным колесом.
//
// Зачем отдельный скрипт, а не вызовы MCP по одному: между отдельными вызовами
// фокус окна успевает уйти (пользователь кликает в своём приложении), и
// нативный ввод отклоняется защитой `expected Main PID is not frontmost`.
// Здесь подъём окна, колесо и чтение счётчиков идут в ОДНОМ процессе без
// разрывов, поэтому расписание выдерживается: клик → N мс → колесо.
//
// Синтетическое колесо (CDP, electron_steps) для этого не годится: панель
// History его игнорирует и удерживает хвост. Нужен CGEvent — его шлёт тот же
// Swift-помощник, что использует Electron MCP.
//
// Запуск:
//   node scripts/e2e/scroll-after-switch.mjs \
//     --pid <main pid стенда> --cdp 9225 --tab arrow-1 \
//     [--delay 200] [--delta -2000] [--repeats 3] [--watch 8000]
//
// Перед запуском ОБЯЗАТЕЛЬНО предупредить пользователя (см. SKILL.md):
// скрипт двигает системный курсор и забирает фокус окна.

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileP = promisify(execFile);

const args = Object.fromEntries(process.argv.slice(2)
  .map((value, index, all) => value.startsWith('--') ? [value.slice(2), all[index + 1]] : null)
  .filter(Boolean));

const PID = String(args.pid || '');
const CDP = `http://127.0.0.1:${args.cdp || 9225}`;
const TAB = args.tab || 'arrow-1';
const DELAY_MS = Number(args.delay ?? 200);
const DELTA = Number(args.delta ?? -2000);
const REPEATS = Number(args.repeats ?? 3);
const WATCH_MS = Number(args.watch ?? 8000);
const X = Number(args.x ?? 1364);
const Y = Number(args.y ?? 619);

if (!PID) { console.error('требуется --pid (Main процесс стенда)'); process.exit(2); }

/** Тот же Swift-помощник, что использует Electron MCP. Компилируется один раз. */
async function nativeHelper() {
  const source = path.join(os.homedir(), 'Desktop/electron-mcp/src/native-input.swift');
  const bin = path.join(os.tmpdir(), 'noted-e2e-native-input');
  try { await fs.access(bin); return bin; } catch {}
  const build = `${bin}-${process.pid}`;
  await fs.copyFile(source, `${build}.swift`);
  await execFileP('/usr/bin/swiftc', ['-O', `${build}.swift`, '-o', build], { timeout: 120_000 });
  await fs.rename(build, bin);
  await fs.unlink(`${build}.swift`).catch(() => {});
  return bin;
}

/** CGEvent-колесо в точке экрана; помощник сам проверяет владельца окна. */
function nativeWheel(bin, { x, y, deltaY, pid }) {
  const request = JSON.stringify({ op: 'wheel', x, y, deltaX: 0, deltaY,
    modifiers: [], expectedMainPid: Number(pid), requireFrontmost: true });
  const out = execFileSync(bin, [], { input: request, encoding: 'utf8', timeout: 15_000 });
  return JSON.parse(out);
}

const frontmost = pid => execFileSync('osascript',
  ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`],
  { encoding: 'utf8', timeout: 10_000 });

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
  const evaluate = expression => new Promise(resolve => {
    const next = ++id;
    pending.set(next, message => resolve(message.result?.result?.value));
    socket.send(JSON.stringify({ id: next, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => socket.close() };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Счётчик задержек кадров: прямая мера «поток занят». Пауза между кадрами
// больше 100мс — подвисание, которое пользователь ощущает как рывок.
const ARM_COUNTER = ms => `(()=>{window.__lag={max:0,o100:0,o250:0,o500:0,frames:0,start:performance.now()};
let prev=performance.now();const tick=()=>{const now=performance.now(),d=now-prev;prev=now;const L=window.__lag;
L.frames++;if(d>L.max)L.max=d;if(d>100)L.o100++;if(d>250)L.o250++;if(d>500)L.o500++;
if(now-L.start<${ms})requestAnimationFrame(tick);};requestAnimationFrame(tick);return 'armed';})()`;

// Задержка ПЕРВОГО колеса после перехода — ровно то, что чувствует
// пользователь: «перешёл, крутанул, оно подвисло». Задержки кадров её не
// показывают: поток может быть свободен, а событие стоять в очереди IPC.
const ARM_WHEEL_PROBE = `(()=>{window.__wheel=[];
const seen=new WeakSet();
window.addEventListener('wheel',event=>{
  if(seen.has(event))return; seen.add(event);
  window.__wheel.push({at:Math.round(performance.now()-window.__lag.start),
    delayMs:Math.round(performance.now()-event.timeStamp)});
},{capture:true,passive:true});
return 'probe-armed';})()`;

const READ_COUNTER = `(()=>{const L=window.__lag||{};
const sc=[...document.querySelectorAll('div')].find(d=>d.scrollHeight>d.clientHeight+200);
const a=document.querySelector('[data-history-scroll-to-bottom]');
return {frames:L.frames,maxGapMs:Math.round(L.max||0),over100:L.o100,over250:L.o250,over500:L.o500,
scrollTop:sc?Math.round(sc.scrollTop):null,dist:sc?Math.round(sc.scrollHeight-sc.scrollTop-sc.clientHeight):null,
arrow:a?(a.style.display===''?'visible':a.style.display):'no-node',
wheelEvents:(window.__wheel||[]).length,
firstWheelDelayMs:(window.__wheel||[])[0]?.delayMs ?? null,
maxWheelDelayMs:(window.__wheel||[]).reduce((m,w)=>Math.max(m,w.delayMs),0),
panels:document.querySelectorAll('[data-history-owner]').length};})()`;

const GO_HOME = `(()=>{const b=document.querySelector('[data-app-home-button]');
const v=document.querySelector('[data-workspace-presentation]')?.getAttribute('data-workspace-presentation');
if(v!=='dashboard'&&b)b.click();return v;})()`;

const OPEN_TAB = name => `(()=>{const el=[...document.querySelectorAll('[data-tab-card-label]')]
.find(n=>n.textContent.trim()===${JSON.stringify(name)});
if(!el)return 'not-found';(el.closest('[data-tab-id]')||el).click();return 'clicked';})()`;

(async () => {
  const bin = await nativeHelper();
  const { evaluate, close } = await connect();
  const runs = [];

  for (let run = 1; run <= REPEATS; run++) {
    // Холодный заход: уйти на Home, вернуться, открыть вкладку заново.
    await evaluate(GO_HOME);
    await sleep(900);
    await evaluate(ARM_COUNTER(WATCH_MS));
    await evaluate(ARM_WHEEL_PROBE);
    const opened = await evaluate(OPEN_TAB(TAB));
    if (opened === 'not-found') { console.error('вкладка не найдена:', TAB); break; }

    // Ровно DELAY_MS после клика — системное колесо, без разрыва процессов.
    await sleep(DELAY_MS);
    let wheel;
    try { frontmost(PID); wheel = nativeWheel(bin, { x: X, y: Y, deltaY: DELTA, pid: PID }); }
    catch (error) { wheel = { ok: false, error: String(error.message || error).slice(0, 120) }; }

    await sleep(WATCH_MS - DELAY_MS);
    const measured = await evaluate(READ_COUNTER);
    runs.push({ run, delayMs: DELAY_MS, wheelPosted: wheel?.events?.posted ?? 0,
      wheelError: wheel?.ok === false ? (wheel.error || wheel.stderr) : null, ...measured });
    console.log(JSON.stringify(runs.at(-1)));
  }

  const ok = runs.filter(r => r.wheelPosted > 0);
  console.log('\nИТОГ ' + JSON.stringify({
    прогонов: runs.length,
    колесоДоставлено: ok.length,
    максЗадержкаКадраМс: Math.max(0, ...runs.map(r => r.maxGapMs || 0)),
    задержекБольше100: runs.reduce((s, r) => s + (r.over100 || 0), 0),
    задержекБольше250: runs.reduce((s, r) => s + (r.over250 || 0), 0),
    прокрутилось: ok.map(r => r.dist),
    задержкаПервогоКолесаМс: runs.map(r => r.firstWheelDelayMs),
    максЗадержкаКолесаМс: Math.max(0, ...runs.map(r => r.maxWheelDelayMs || 0)),
  }, null, 1));
  close();
})().catch(error => { console.error('ОШИБКА:', error.message); process.exit(1); });
