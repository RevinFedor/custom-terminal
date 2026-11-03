#!/usr/bin/env node
'use strict';

// Изолированный DEV-стенд для ручной и E2E-проверки Noted.
//
// Зачем отдельная команда: такой стенд уже собирали руками несколько раз, и
// каждый раз он не стартовал по одним и тем же причинам. Они зафиксированы
// здесь, чтобы следующий запуск был одной командой, а не часовой отладкой:
//
//   1. Приложение требует `NOTED_E2E_CLI_ISOLATION_ROOT`, и корень не должен
//      содержать домашний каталог процесса. HOME стенда поэтому живёт РЯДОМ с
//      корнем, а не внутри него (иначе guard бросает root_too_broad).
//   2. PTY поднимает login-shell в этом HOME. Без профиля с PATH он не находит
//      `claude`/`codex`, и запуск агента падает мгновенно.
//   3. Свежий CLAUDE_CONFIG_DIR не имеет «уже принятых» решений: Claude CLI
//      встаёт в диалогах (тема, доверие каталогу, Bypass Permissions) и никогда
//      не доходит до готового ввода — любой Send падает по таймауту.
//   4. Без `statusLine` приложение не связывает JSONL сессии с вкладкой и вечно
//      показывает «Configuring claude…».
//
// Стенд изолирует ПРИЛОЖЕНИЕ (профиль, порты, CLI-homes), но не файловую
// систему: вкладки на нём читают живой репозиторий. Правило «репозиторий только
// для чтения» написано словами в AGENTS.md стенда — тем же способом, что у
// соседнего мини-оркестратора, после его шрама с правкой живого репозитория.

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
if (!fss.existsSync(electron)) throw Error('Сначала выполните npm install / обычную установку для macOS.');

// Постоянный корень, а не mkdtemp: стенд переживает перезапуск, и его профиль
// (принятые диалоги, токен, созданные вкладки) не собирается заново каждый раз.
const base = process.env.NOTED_E2E_STAND_ROOT
  ? path.resolve(process.env.NOTED_E2E_STAND_ROOT)
  : '/private/tmp/noted-e2e-runs';
const name = process.argv[2] && /^[A-Za-z0-9._-]+$/.test(process.argv[2]) ? process.argv[2] : 'bgkill';
const root = path.join(base, name);
// HOME снаружи корня: см. причину 1 выше.
const home = path.join(base, name + '-home');
const cwd = repo;
// Каталог, в котором реально работают вкладки стенда. Он ДРУГОЙ, чем repo, и
// доверие Claude запоминает по точному пути: отметка только для repo оставляла
// вкладку в диалоге «Is this a project you trust?», а снаружи это выглядело
// как сбой запуска (agent_ready_owner_changed, код выхода 130).
const tabCwd = path.join(root, 'cwd');

for (const dir of [root, home, path.join(root, 'data'), path.join(root, 'discovery'),
  path.join(root, 'claude'), path.join(root, 'codex'), path.join(root, 'tmp'), tabCwd]) {
  await fs.mkdir(dir, { recursive: true });
}

// Один стенд с этим именем за раз: второй Electron на том же профиле разойдётся
// с первым по SQLite и оставит вторую иконку в Dock.
const lockPath = path.join(root, 'STAND.lock');
const lockBody = JSON.stringify({ root, pid: process.pid });
try {
  await fs.writeFile(lockPath, lockBody, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const previous = JSON.parse(await fs.readFile(lockPath, 'utf8').catch(() => '{}'));
  let running = Number.isInteger(previous.pid);
  if (running) try { process.kill(previous.pid, 0); } catch (lookup) { if (lookup.code === 'ESRCH') running = false; else throw lookup; }
  if (running) { console.log('[Stand] Этот стенд уже открыт: ' + root); process.exit(0); }
  await fs.unlink(lockPath);
  await fs.writeFile(lockPath, lockBody, { flag: 'wx', mode: 0o600 });
}
process.once('exit', () => { try { if (fss.readFileSync(lockPath, 'utf8') === lockBody) fss.unlinkSync(lockPath); } catch { /* уже убран */ } });

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const cdpPort = await freePort();
const apiPort = await freePort();
if (cdpPort === apiPort) throw Error('Свободные порты столкнулись; повторите запуск.');

await prepareShellProfile(home);
await prepareClaudeProfile(root, [cwd, tabCwd]);
await prepareCodexProfile(root);
await fs.writeFile(path.join(root, 'AGENTS.md'), [
  '# Тестовый стенд',
  '',
  '`' + repo + '` — ТОЛЬКО ДЛЯ ЧТЕНИЯ. Читай его файлы, если задача просит',
  'разобраться в коде, но НИКОГДА не правь, не создавай и не удаляй в нём файлы:',
  'это живой репозиторий пользователя, в котором параллельно работают другие',
  'сессии.',
  '',
].join('\n'), { mode: 0o600 }).catch(() => {});

// Собранный renderer, а не Vite: стенд должен показывать ровно тот код, что в
// dist, и не делить HMR-сессию с рабочим dev пользователя.
if (!process.env.NOTED_E2E_STAND_SKIP_BUILD) {
  console.log('[Stand] Сборка renderer…');
  await new Promise((resolve, reject) => {
    const build = spawn(path.join(repo, 'node_modules/.bin/electron-vite'), ['build'], { cwd: repo, stdio: 'inherit' });
    build.once('error', reject);
    build.once('exit', code => code === 0 ? resolve() : reject(Error('Сборка завершилась с кодом ' + code)));
  });
}

const env = { ...process.env };
// Маркеры родительской AI-сессии выключают сохранение транскрипта у дочернего
// Claude: стенд должен стартовать как обычный запуск пользователя.
//
// Вторая группа — выбор модели и адрес провайдера. Шрам02Nov: у вызывающей
// сессии стоял `ANTHROPIC_MODEL=opus[1m]`, он унаследовался стендом и перебил
// запрошенный haiku — МОЛЧА. Запуск вернул success, вкладка поднялась, и
// только модель в bridge-файле выдала Opus5.5 вместо Haiku5.5. Это хуже
// громкого отказа: прогон зелёный, в отчёте «проверено на haiku», а работала
// и тарифицировалась другая модель. ANTHROPIC_BASE_URL из той же группы:
// он указывает на per-tab прокси РОДИТЕЛЬСКОГО приложения, и стенд обязан
// поставить свой. Приложение само выставляет эти переменные своим вкладкам.
for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NOTED_PARENT_TAB_ID', 'NOTED_PARENT_PROJECT_ID',
  'NOTED_MAIN_PID', 'NOTED_MCP_INSTANCE_ROUTE', 'NOTED_MCP_CLIENT_TOKEN',
  'NOTED_SOURCE_TAB_ID', 'NOTED_SOURCE_PROJECT_ID', 'NOTED_MCP_IDENTITY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'MAX_THINKING_TOKENS', 'CLAUDE_CODE_SUBAGENT_MODEL']) delete env[key];
Object.assign(env, {
  HOME: home,
  TMPDIR: path.join(root, 'tmp'),
  SHELL: '/bin/zsh',
  PATH: path.join(os.homedir(), '.local/bin') + ':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  NOTED_E2E_TEST: 'true',
  NOTED_E2E_USE_BUILT_RENDERER: 'true',
  NOTED_E2E_CLI_ISOLATION_ROOT: root,
  NOTED_USER_DATA_DIR: path.join(root, 'data'),
  NOTED_DISCOVERY_DIR: path.join(root, 'discovery'),
  NOTED_CDP_PORT: String(cdpPort),
  NOTED_WEB_PORT: String(apiPort),
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  CODEX_HOME: path.join(root, 'codex'),
});

await fs.writeFile(path.join(root, 'STAND.json'), JSON.stringify({
  root, home, cdpPort, apiPort, repo, mode: 'built renderer', startedAt: new Date().toISOString(),
}, null, 2), { mode: 0o600 });

console.log('[Stand] Профиль: ' + root);
console.log('[Stand] CDP ' + cdpPort + ' · API ' + apiPort + ' — подключение: electron_connect({ port: ' + cdpPort + ' })');

// Своя группа процессов: убить один PID мало — у Electron остаются дети, и
// каждый держит собственную иконку в Dock.
const child = spawn(electron, [repo, '--remote-debugging-port=' + cdpPort],
  { cwd: repo, env, stdio: 'inherit', detached: true });
let stopped = false;
const stopGroup = (signal) => {
  if (stopped || child.exitCode !== null || !Number.isSafeInteger(child.pid)) return;
  stopped = true;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') try { child.kill(signal); } catch { /* уже мёртв */ } }
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stopGroup(signal));
process.on('exit', () => stopGroup('SIGTERM'));
child.once('exit', (code) => { process.exitCode = code || 0; });

// Профиль shell: PTY стартует login-shell в HOME стенда, и без этого в нём нет
// пути до пользовательских бинарников (причина 2 выше).
async function prepareShellProfile(target) {
  const body = [
    '# Профиль тестового стенда: PTY поднимает здесь login-shell.',
    'export PATH="' + path.join(os.homedir(), '.local/bin') + ':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
    '',
  ].join('\n');
  for (const file of ['.zshrc', '.zprofile']) {
    await fs.writeFile(path.join(target, file), body, { mode: 0o600 });
  }
}

// Переносит в приватный профиль ТОЛЬКО «уже принятые решения» и токен входа:
// ни историй, ни MCP-конфигурации хоста.
async function prepareClaudeProfile(target, projectCwds) {
  const configPath = path.join(target, 'claude', '.claude.json');
  const host = await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const current = await fs.readFile(configPath, 'utf8').then(JSON.parse).catch(() => ({}));
  for (const key of Object.keys(host)) {
    if (/^has(Completed|Seen|Ide|Reset)|Onboarding|^theme$|^installMethod$|KeyBindingInstalled$|^optionAsMetaKeyInstalled$|Nudge$|Warning$|DialogBeenShown$/.test(key)) {
      current[key] = host[key];
    }
  }
  current.hasCompletedOnboarding ??= true;
  current.theme ??= 'dark';
  current.projects ??= {};
  // Каждый каталог, где может запуститься вкладка: и репозиторий, и рабочий
  // каталог стенда. Доверие хранится по ТОЧНОМУ пути, промах = диалог в TUI.
  for (const projectCwd of [].concat(projectCwds)) {
    current.projects[projectCwd] = {
      ...(current.projects[projectCwd] || {}),
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
      allowedTools: [],
    };
  }
  await fs.writeFile(configPath, JSON.stringify(current, null, 2), { mode: 0o600 });

  // Диалог «Bypass Permissions mode» — пятый блокер, не покрытый флагами выше:
  // его согласие живёт в settings.json, а не в .claude.json. Без него TUI
  // останавливается на подтверждении и до ввода не доходит.
  const settingsPath = path.join(target, 'claude', 'settings.json');
  const hostSettings = await fs.readFile(path.join(os.homedir(), '.claude/settings.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const settings = await fs.readFile(settingsPath, 'utf8').then(JSON.parse).catch(() => ({}));
  settings.skipDangerousModePermissionPrompt = true;
  // statusLine связывает JSONL сессии с вкладкой Noted (причина 4 выше).
  // Скрипт копируется в профиль, чтобы стенд не зависел от файла в HOME хоста.
  const bridgeSource = (hostSettings.statusLine && hostSettings.statusLine.command || '').replace(/^~/, os.homedir());
  if (bridgeSource && fss.existsSync(bridgeSource)) {
    const bridgeTarget = path.join(target, 'claude', path.basename(bridgeSource));
    await fs.copyFile(bridgeSource, bridgeTarget);
    await fs.chmod(bridgeTarget, 0o700);
    settings.statusLine = { ...hostSettings.statusLine, command: bridgeTarget };
  } else if (hostSettings.statusLine) {
    settings.statusLine = hostSettings.statusLine;
  }
  if (hostSettings.hooks) settings.hooks = hostSettings.hooks;
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  // Токен входа: на этой машине он лежит в Keychain, файла может не быть.
  const credentials = await new Promise(resolve => {
    const probe = spawn('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    probe.stdout.on('data', chunk => { out += chunk; });
    probe.once('exit', code => resolve(code === 0 ? out.trim() : ''));
    probe.once('error', () => resolve(''));
  });
  const fromFile = await fs.readFile(path.join(os.homedir(), '.claude/.credentials.json'), 'utf8').catch(() => '');
  const payload = credentials || fromFile;
  if (payload) await fs.writeFile(path.join(target, 'claude', '.credentials.json'), payload, { mode: 0o600 });
  else console.warn('[Stand] Токен Claude не найден; вкладки попросят /login.');
}

async function prepareCodexProfile(target) {
  const source = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  for (const file of ['auth.json', 'models_cache.json']) {
    const bytes = await fs.readFile(path.join(source, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!bytes) continue;
    await fs.writeFile(path.join(target, 'codex', file), bytes, { mode: 0o600, flag: 'wx' })
      .catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
}
