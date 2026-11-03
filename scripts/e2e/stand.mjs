#!/usr/bin/env node
'use strict';

// Поднимает тестовый стенд Noted и печатает всё, что нужно для работы с ним.
//
// Два режима, оба с ПРИВАТНЫМ профилем и собственными портами:
//
//   prod  — «instance production»: собранная копия из release/, минифицированный
//           код, тот же что у установленного приложения. ЕДИНСТВЕННЫЙ годный
//           стенд для замеров производительности.
//   dev   — Vite + горячая перезагрузка. Логика, IPC, HTTP API. Для скорости
//           НЕ годится: React в dev тратит время на проверки, которых в
//           собранном коде нет.
//
// Порты берутся от pid процесса, поэтому две вкладки, запустившие это
// одновременно, не столкнутся. Сам перебирается только HTTP API; порт отладки
// и профиль не перебираются никогда — без явных значений вторая вкладка молча
// подключится к ЧУЖОМУ инстансу и будет кликать в нём.
//
// Запуск:
//   node scripts/e2e/stand.mjs --mode prod [--tabs 3] [--history] [--keep]
//
// --history привязывает к вкладкам реальные сессии Claude (большие транскрипты)
//           для проверок History/Timeline; требует остановки инстанса, поэтому
//           делается до первого старта.
// --keep    не чистить профиль, если он уже есть (продолжить прошлый стенд).

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const args = Object.fromEntries(process.argv.slice(2)
  .map((value, index, all) => value.startsWith('--')
    ? [value.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? true : all[index + 1]]
    : null)
  .filter(Boolean));

const MODE = args.mode === 'dev' ? 'dev' : 'prod';
const TABS = Number(args.tabs ?? 3);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

// Смещение от собственного pid: уникально у каждой вкладки, без согласования.
const OFFSET = (process.pid % 90) + 1;
const WEB_PORT = 7900 + OFFSET;
const CDP_PORT = 9300 + OFFSET;
// Прибито внутри `npm run dev` в package.json; меняется только там.
const DEV_FIXED_WEB_PORT = 7979;
const STAND = path.join(os.tmpdir(), `noted-stand-${process.pid}`);
const PROFILE = path.join(STAND, 'profile');
const CWD_FOR_TABS = path.join(STAND, 'cwd');

// Перед вторым стендом проверяем память: один инстанс Noted ~1ГБ. Запуск при
// нехватке не падает, а замедляет ВСЁ — замеры становятся недействительными,
// и виноватым выглядит измеряемый код.
function freeMemoryMb() {
  try {
    const out = execFileSync('vm_stat', { encoding: 'utf8' });
    const pageSize = Number(out.match(/page size of (\d+)/)?.[1] || 16384);
    const free = Number(out.match(/Pages free:\s+(\d+)/)?.[1] || 0);
    const inactive = Number(out.match(/Pages inactive:\s+(\d+)/)?.[1] || 0);
    return Math.round(((free + inactive) * pageSize) / 1024 / 1024);
  } catch { return null; }
}

const APP = path.join(REPO, 'release',
  process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Noted Terminal.app');
const EXECUTABLE = path.join(APP, 'Contents/MacOS/Noted Terminal');

function ensureBuild() {
  if (fs.existsSync(EXECUTABLE)) return 'уже собран';
  console.log('[stand] сборки нет, запускаю npm run build:app (~2 мин)…');
  execFileSync('npm', ['run', 'build:app'], { cwd: REPO, stdio: 'inherit', timeout: 900_000 });
  return 'собран сейчас';
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(url, label, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try { const res = await fetch(url, { signal: AbortSignal.timeout(900) }); if (res.status) return i + 1; }
    catch {}
    await sleep(500);
  }
  throw new Error(`${label} не поднялся: ${url}`);
}

// Какой порт НА САМОМ ДЕЛЕ слушает стенд. В режиме dev наш NOTED_WEB_PORT не
// действует: `npm run dev` задаёт `NOTED_WEB_PORT=7979` внутри самой команды в
// package.json, и значение из окружения её не перебивает. Обвязка, которая
// верит своей переменной, будет ждать API на несуществующем порту до таймаута
// и выглядеть как «стенд не поднялся».
const apiPort = () => (MODE === 'dev' ? DEV_FIXED_WEB_PORT : WEB_PORT);

const token = () => fs.readFileSync(path.join(os.homedir(), '.noted-terminal/web-token.txt'), 'utf8').trim();
const api = async (route, body, method = 'POST') => {
  const res = await fetch(`http://127.0.0.1:${apiPort()}${route}`, { method,
    headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// Сессии с большой историей — для проверок History/Timeline. Берутся реальные
// файлы пользователя: копировать их в приватный профиль нельзя (они лежат в
// общем ~/.claude), но привязать к своей вкладке можно.
function biggestSessions(count) {
  const dir = path.join(os.homedir(), '.claude/projects/-Users-fedor-Desktop-custom-terminal');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))
    .map(n => ({ id: n.replace(/\.jsonl$/, ''), size: fs.statSync(path.join(dir, n)).size }))
    .sort((a, b) => b.size - a.size).slice(0, count);
}

function attachHistory(names) {
  const file = fs.readdirSync(PROFILE).find(n => n.endsWith('.db'));
  if (!file) return 'база не найдена';
  const db = new DatabaseSync(path.join(PROFILE, file));
  const sessions = biggestSessions(names.length);
  const update = db.prepare('UPDATE tabs SET claude_session_id=?, cwd=? WHERE name=?');
  names.forEach((name, index) => {
    if (sessions[index]) update.run(sessions[index].id, REPO, name);
  });
  return sessions.map((s, i) => `${names[i]}=${(s.size / 1024 / 1024).toFixed(0)}МБ`).join(' ');
}

(async () => {
  const free = freeMemoryMb();
  console.log(`[stand] свободная память: ${free ?? '?'} МБ`);
  if (free !== null && free < 2000) {
    console.log('[stand] ВНИМАНИЕ: меньше 2 ГБ свободно. Замеры производительности будут недостоверны.');
  }

  fs.mkdirSync(PROFILE, { recursive: true });
  fs.mkdirSync(CWD_FOR_TABS, { recursive: true });

  const env = { ...process.env,
    NOTED_USER_DATA_DIR: PROFILE,
    NOTED_WEB_PORT: String(WEB_PORT),
    NOTED_CDP_PORT: String(CDP_PORT) };

  let child, buildNote = '';
  if (MODE === 'prod') {
    buildNote = ensureBuild();
    child = spawn(EXECUTABLE, [`--remote-debugging-port=${CDP_PORT}`],
      { env, detached: true, stdio: ['ignore',
        fs.openSync(path.join(STAND, 'stand.log'), 'a'),
        fs.openSync(path.join(STAND, 'stand.log'), 'a')] });
  } else {
    child = spawn('npm', ['run', 'dev'],
      { cwd: REPO, env: { ...env, ELECTRON_EXTRA_LAUNCH_ARGS: `--remote-debugging-port=${CDP_PORT}` },
        detached: true, stdio: ['ignore',
          fs.openSync(path.join(STAND, 'stand.log'), 'a'),
          fs.openSync(path.join(STAND, 'stand.log'), 'a')] });
  }
  child.unref();

  await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, 'CDP');
  await waitFor(`http://127.0.0.1:${apiPort()}/api/me`, 'HTTP API');

  // Main pid: у prod это сам процесс, у dev — потомок npm.
  const mainPid = MODE === 'prod' ? child.pid : Number(execFileSync('pgrep',
    ['-f', 'electron.*--remote-debugging-port=' + CDP_PORT], { encoding: 'utf8' }).trim().split('\n')[0]);

  const names = [];
  // Первая вкладка нередко не создаётся: приложение в этот момент ещё
  // доделывает собственный старт и API отвечает отказом. Молчать об этом
  // нельзя — дальше тест пойдёт на другой вкладке и это будет выглядеть как
  // его собственная ошибка. Поэтому отказ печатается, а попытка повторяется.
  for (let i = 1; i <= TABS; i++) {
    const name = `stand-${i}`;
    let made = await api('/api/terminal-tabs', { name, cwd: CWD_FOR_TABS });
    if (!made.body?.tabId) {
      await sleep(1200);
      made = await api('/api/terminal-tabs', { name, cwd: CWD_FOR_TABS });
    }
    if (made.body?.tabId) names.push(name);
    else console.log(`[stand] вкладка ${name} не создана: ${made.status} ${JSON.stringify(made.body).slice(0, 120)}`);
  }

  let historyNote = '';
  if (args.history && names.length) {
    // Привязка требует остановленного инстанса: работающее приложение держит
    // это состояние в памяти и перезапишет диск.
    process.kill(mainPid, 'SIGTERM');
    await sleep(2500);
    historyNote = attachHistory(names);
    const again = spawn(MODE === 'prod' ? EXECUTABLE : 'npm',
      MODE === 'prod' ? [`--remote-debugging-port=${CDP_PORT}`] : ['run', 'dev'],
      { cwd: REPO, env, detached: true, stdio: ['ignore',
        fs.openSync(path.join(STAND, 'stand.log'), 'a'),
        fs.openSync(path.join(STAND, 'stand.log'), 'a')] });
    again.unref();
    await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, 'CDP (после привязки)');
  }

  const livePid = Number(execFileSync('pgrep',
    ['-f', (MODE === 'prod' ? 'release/mac-arm64' : 'electron') + '.*remote-debugging-port=' + CDP_PORT],
    { encoding: 'utf8' }).trim().split('\n')[0]);

  console.log('\n' + JSON.stringify({
    режим: MODE === 'prod' ? 'instance production (собранный код)' : 'dev (Vite, НЕ для замеров)',
    сборка: buildNote || '—',
    pid: livePid,
    cdp: CDP_PORT,
    api: apiPort(),
    профиль: PROFILE,
    лог: path.join(STAND, 'stand.log'),
    вкладки: names,
    история: historyNote || '—',
    остановить: `pkill -f "remote-debugging-port=${CDP_PORT}"`,
    замерСкролла: `node scripts/e2e/scroll-after-switch.mjs --pid ${livePid} --cdp ${CDP_PORT} --tab ${names[0] || 'stand-1'}`,
  }, null, 1));
})().catch(error => { console.error('ОШИБКА:', error.message); process.exit(1); });
