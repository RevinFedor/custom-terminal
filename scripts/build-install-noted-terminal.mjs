#!/usr/bin/env node
// Run from an external owner (Voice Record AI-hop or the user's terminal).
// Never quit the installed host until a fully validated replacement is ready.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAsarArchive } from './validate-app-asar.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'Noted Terminal.app';
// The portable build produces an ad-hoc bundle. The installed maintainer build
// needs the stable local certificate before release/staging validation and quit.
export const PREPARE_SCRIPTS = ['build:markdown', 'build:mobile', 'build', 'sign:local-fast', 'install:terminal-mcp', 'install:claude-hook'];
export const INSTALL_READY_PREFIX = '[NotedInstall:ready-to-quit] ';
export const INSTALL_RESULT_PREFIX = '[NotedInstall:result] ';

export function runCommand(command, args, { cwd, signal, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, detached: grouped, stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    let output = '';
    let killTimer;
    const kill = (kind) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch {}
    };
    const onAbort = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 5000);
      killTimer.unref();
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (capture) {
      child.stdout.on('data', chunk => { output += chunk.toString(); });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
    }
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, exitSignal) => {
      cleanup();
      if (signal?.aborted) return reject(signal.reason || new Error('install cancelled'));
      if (code === 0) resolve(output);
      else reject(new Error(command + ' ' + args.join(' ') + ' exited ' + code + (exitSignal ? ' (' + exitSignal + ')' : '') + (output ? ': ' + output.trim() : '')));
    });
  });
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || new Error('install cancelled');
}

async function exists(target, fileSystem) {
  try { return await fileSystem.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

const LOCK_OWNER_FILE = 'owner.json';

/**
 * Живой ли процесс. Сигнал 0 ничего не посылает, только проверяет доступность:
 * ESRCH — процесса нет, EPERM — есть, но чужой (значит, жив).
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function readLockOwner(lockDir, fileSystem) {
  try {
    const raw = await fileSystem.readFile(path.join(lockDir, LOCK_OWNER_FILE), 'utf8');
    const owner = JSON.parse(raw);
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
    return owner;
  } catch { return null; }
}

/**
 * Замок на /Applications: два инсталлера не должны одновременно подменять
 * приложение. `mkdir` атомарен, поэтому гонку он закрывает.
 *
 * Внутрь пишется, КТО его держит. Без этого аварийно убитый инсталлер
 * (двойной Ctrl+C, SIGKILL, обрыв питания) оставлял пустой каталог, и каждый
 * следующий запуск падал с `EEXIST … mkdir` навсегда — руками. Так и вышло
 * 12.09: юзер прервал инсталл, и `build:i` перестал стартовать вообще.
 *
 * Захват чужого замка разрешён, только когда смерть владельца ДОКАЗАНА: его
 * процесса нет в системе. Неизвестного владельца (нет файла или он битый)
 * по-прежнему не угадываем — отказ, но с готовой командой снятия вместо
 * голого EEXIST. Переиспользование номеров процессов сдвигает ошибку в
 * безопасную сторону: чужой живой процесс читается как «занято».
 */
export async function acquireInstallLock({ lockDir, fileSystem = fs, aliveCheck = isProcessAlive, log = () => {} }) {
  const claim = async () => {
    await fileSystem.mkdir(lockDir);
    await fileSystem.writeFile(
      path.join(lockDir, LOCK_OWNER_FILE),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
  };

  try {
    await claim();
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const owner = await readLockOwner(lockDir, fileSystem);
  if (!owner) {
    throw new Error('install lock ' + lockDir + ' exists without a readable owner; '
      + 'if no install is running, release it with: rmdir ' + JSON.stringify(lockDir));
  }
  if (aliveCheck(owner.pid)) {
    throw new Error('another install is already running (pid ' + owner.pid
      + (owner.startedAt ? ', started ' + owner.startedAt : '') + ')');
  }

  log('taking over install lock from dead owner pid ' + owner.pid
    + (owner.startedAt ? ' (started ' + owner.startedAt + ')' : ''));
  await releaseInstallLock({ lockDir, fileSystem });
  try {
    await claim();
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('another install acquired the lock concurrently');
    throw error;
  }
}

/**
 * Освобождение: сначала файл владельца, затем сам каталог, и только он.
 * Рекурсивного удаления здесь нет намеренно — оно однажды снесло бы рядом
 * лежащие артефакты приложения.
 */
export async function releaseInstallLock({ lockDir, fileSystem = fs }) {
  try { await fileSystem.unlink(path.join(lockDir, LOCK_OWNER_FILE)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fileSystem.rmdir(lockDir);
}

const STAGING_PREFIX = '.noted-terminal-install-';
export const STAGING_KEEP_DEFAULT = 2;

/**
 * Уборка старых откатных каталогов.
 *
 * Каждый инсталл сохраняет заменённое приложение как `previous.app` в своём
 * staging-каталоге и НИКОГДА его не удалял — «откат дороже места». За неделю
 * это дало 26 каталогов по 686 МБ (17 ГБ в /Applications, найдено 12.09).
 *
 * Возможность откатиться сохраняется: `keep` последних каталогов остаются
 * целиком, включая только что созданный. Уходят только те, что старше — на
 * них всё равно нельзя откатиться осмысленно (настройки и база с тех пор
 * прошли миграции), а `git` держит исходники любой версии.
 *
 * Замок не каталог staging и под шаблон не попадает; текущий каталог
 * исключается явно. Ошибка уборки не влияет на результат установки — место
 * не важнее уже установленного приложения.
 */
export async function pruneInstallStaging({
  applicationsDir,
  keep = STAGING_KEEP_DEFAULT,
  currentStagingRoot = null,
  fileSystem = fs,
  log = () => {},
}) {
  const root = path.resolve(applicationsDir);
  let entries;
  try { entries = await fileSystem.readdir(root); }
  catch (error) { log('could not list staging roots: ' + error.message); return []; }

  const candidates = [];
  for (const name of entries) {
    // Только каталоги вида `.noted-terminal-install-<random>`: замок
    // (`…-install-lock`) и что-либо ещё рядом трогать нельзя.
    if (!name.startsWith(STAGING_PREFIX) || name === STAGING_PREFIX + 'lock') continue;
    const target = path.join(root, name);
    if (currentStagingRoot && path.resolve(currentStagingRoot) === target) continue;
    try {
      const info = await fileSystem.lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      candidates.push({ target, mtimeMs: info.mtimeMs });
    } catch { /* исчез между чтением каталога и проверкой — и не надо */ }
  }

  // Новейшие первыми: свежий откат — самый нужный.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepCount = Math.max(0, keep - (currentStagingRoot ? 1 : 0));
  const removed = [];
  for (const { target } of candidates.slice(keepCount)) {
    try {
      await fileSystem.rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) { log('could not prune ' + target + ': ' + error.message); }
  }
  if (removed.length > 0) log('pruned ' + removed.length + ' old rollback staging root(s)');
  return removed;
}

export async function validateAppBundle(appPath, { run = runCommand, fileSystem = fs, signal } = {}) {
  const app = await fileSystem.lstat(appPath);
  if (!app.isDirectory() || app.isSymbolicLink()) throw new Error('expected a real app directory: ' + appPath);
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const identifier = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { capture: true, signal })).trim();
  if (identifier !== 'com.noted.terminal') throw new Error('unexpected app identifier: ' + identifier);
  const executable = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { capture: true, signal })).trim();
  if (!executable || executable === '.' || executable === '..' || path.basename(executable) !== executable) throw new Error('invalid app executable');
  for (const file of [path.join(appPath, 'Contents', 'MacOS', executable), path.join(appPath, 'Contents', 'Resources', 'app.asar')]) {
    const info = await fileSystem.lstat(file);
    if (!info.isFile() || info.size === 0) throw new Error('missing/empty app artifact: ' + file);
  }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { signal });
  // Reuse sign:local-fast's identity contract, including its explicit override.
  const signature = await run('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { capture: true, signal });
  const authority = signature.match(/^Authority=(.+)$/m)?.[1]?.trim();
  const expectedAuthority = process.env.LOCAL_CODESIGN_IDENTITY || 'Noted Terminal Dev';
  if (authority !== expectedAuthority) throw new Error('unexpected signing authority: ' + (authority || 'missing'));
  await validateAsarArchive(path.join(appPath, 'Contents', 'Resources', 'app.asar'));
}

export function waitForInstallAck({ nonce, input = process.stdin, output = process.stdout, signal, timeoutMs = 30 * 60 * 1000 }) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(nonce || '')) return Promise.reject(new Error('invalid install ACK identity'));
  return new Promise((resolve, reject) => {
    let buffered = '';
    let settled = false;
    let timer;
    const armDeadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error('install owner ACK deadline expired; installed app left untouched')), timeoutMs);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('close', onEnd);
      input.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      input.pause();
      if (error) reject(error); else resolve();
    };
    const onEnd = () => finish(new Error('install owner closed the ACK channel before authorization'));
    const onError = (error) => finish(error);
    const onAbort = () => finish(signal.reason || new Error('install cancelled before ACK'));
    const onData = (chunk) => {
      buffered += chunk.toString();
      if (buffered.length > 4096) return finish(new Error('invalid install ACK payload'));
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        // Reuse the owner's existing idle-observation progress, not another
        // polling loop. A legitimately busy neighbour may take arbitrarily
        // long; only a silent/lost owner exhausts this channel deadline.
        if (line === 'waiting ' + nonce) { armDeadline(); continue; }
        return finish(line === 'install ' + nonce ? null : new Error('install ACK does not match this job'));
      }
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('close', onEnd);
    input.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    if (input.destroyed || input.readableEnded) return onEnd();
    armDeadline();
    // A build tool may finish its progress output without a final newline.
    output.write('\n' + INSTALL_READY_PREFIX + nonce + '\n');
  });
}

export async function buildInstallNotedTerminal({
  projectDir = projectRoot,
  applicationsDir = '/Applications',
  releaseApp = path.join(projectDir, 'release', 'mac-arm64', APP_NAME),
  fileSystem = fs,
  run = runCommand,
  validate = validateAppBundle,
  aliveCheck = isProcessAlive,
  stagingKeep = STAGING_KEEP_DEFAULT,
  prune = pruneInstallStaging,
  beforeQuit = async () => {},
  signal,
  log = message => console.log('[NotedInstall] ' + message),
} = {}) {
  const installedApp = path.join(path.resolve(applicationsDir), APP_NAME);
  const lockDir = path.join(path.resolve(applicationsDir), '.noted-terminal-install-lock');
  let lockOwned = false;
  let stagingRoot = null;
  let stagedApp = null;
  let previousApp = null;
  let previousMoved = false;
  let replacementInstalled = false;
  let quitAttempted = false;
  let launchAttempted = false;
  let step = 'lock';
  let recovery = null;
  const runStep = async (command, args, options = {}) => {
    checkAbort(signal);
    return run(command, args, { cwd: projectDir, signal, ...options });
  };
  try {
    // A concurrent installer must not build/swap over this operation. Only a
    // provably dead owner's lock is taken over; an unknown one is surfaced
    // with the exact release command, never guessed away or removed recursively.
    await acquireInstallLock({ lockDir, fileSystem, aliveCheck, log });
    lockOwned = true;
    for (const script of PREPARE_SCRIPTS) {
      step = script;
      log('prepare ' + script + ' (installed app remains available)');
      await runStep('npm', ['run', script]);
    }
    step = 'validate-release';
    await validate(releaseApp, { run, fileSystem, signal });
    const prior = await exists(installedApp, fileSystem);
    if (prior && (!prior.isDirectory() || prior.isSymbolicLink())) throw new Error('refusing to replace a non-directory/symlink installed app');
    step = 'stage';
    stagingRoot = await fileSystem.mkdtemp(path.join(path.resolve(applicationsDir), '.noted-terminal-install-'));
    stagedApp = path.join(stagingRoot, APP_NAME);
    previousApp = path.join(stagingRoot, 'previous.app');
    // ditto preserves macOS bundle metadata and symlinks. Never merge a copy
    // into the installed bundle, and never remove the previous application.
    await runStep('/usr/bin/ditto', [releaseApp, stagedApp]);
    step = 'validate-stage';
    await validate(stagedApp, { run, fileSystem, signal });
    step = 'owner-idle-ack';
    await beforeQuit({ stagingRoot, installedApp, signal });
    checkAbort(signal);
    step = 'quit';
    quitAttempted = true;
    // Do not abort the shutdown helper halfway through and race its remaining
    // cleanup with reopening the old app. Cancellation is checked just after.
    await runStep('bash', ['scripts/graceful-quit.sh', '20'], { signal: undefined });
    checkAbort(signal);
    if (prior) {
      step = 'preserve-previous';
      await fileSystem.rename(installedApp, previousApp);
      previousMoved = true;
    }
    step = 'install';
    await fileSystem.rename(stagedApp, installedApp);
    replacementInstalled = true;
    checkAbort(signal);
    step = 'validate-installed';
    await validate(installedApp, { run, fileSystem, signal });
    step = 'launch';
    launchAttempted = true;
    await runStep('/usr/bin/open', [installedApp]);
    step = 'complete';
    log('installed verified app; launch requested; previous app preserved at ' + (previousMoved ? previousApp : '(first install)'));
    // Уборка только после успеха: пока установка не доехала, каждый старый
    // откат ещё может понадобиться.
    try { await prune({ applicationsDir, keep: stagingKeep, currentStagingRoot: stagingRoot, fileSystem, log }); }
    catch (error) { log('staging prune skipped: ' + error.message); }
    return { ok: true, installed: true, launchRequested: true, installedApp, previousApp: previousMoved ? previousApp : null, stagingRoot };
  } catch (error) {
    log('failed step=' + step + ' error=' + error.message);
    if (quitAttempted) {
      try {
        // If launch itself failed, stop any partially launched new app before
        // moving bundles. Recovery deliberately ignores the cancelled signal.
        if (launchAttempted && replacementInstalled) await run('bash', ['scripts/graceful-quit.sh', '20'], { cwd: projectDir });
        if (replacementInstalled) {
          await fileSystem.rename(installedApp, path.join(stagingRoot, 'failed.app'));
          replacementInstalled = false;
        }
        if (previousMoved) {
          await fileSystem.rename(previousApp, installedApp);
          previousMoved = false;
        }
        if (await exists(installedApp, fileSystem)) {
          await run('/usr/bin/open', [installedApp], { cwd: projectDir });
          recovery = { status: 'previous-app-reopened', path: installedApp };
          log('reopened previous installed app at ' + installedApp);
        } else recovery = { status: 'no-previous-app', path: null };
      } catch (recoveryError) {
        recovery = { status: 'failed', error: recoveryError.message, previousApp: previousMoved ? previousApp : installedApp };
        log('recovery failed; preserved artifacts at ' + (stagingRoot || installedApp) + ': ' + recoveryError.message);
      }
    } else recovery = { status: 'installed-app-untouched', path: installedApp };
    return { ok: false, installed: replacementInstalled, launchRequested: false, error: error.message, failedStep: step, recovery, previousApp: previousMoved ? previousApp : null, stagingRoot };
  } finally {
    // Only our empty lock directory is removed. All app artifacts (including
    // the last known installed version) remain recoverable on disk.
    if (lockOwned) {
      try { await releaseInstallLock({ lockDir, fileSystem }); }
      catch (error) { log('could not release install lock ' + lockDir + ': ' + error.message); }
    }
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Noted Terminal installation requires macOS');
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('install cancelled'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const nonce = process.env.NOTED_INSTALL_IDLE_ACK_ID || '';
  let controlBuffer = '';
  const onControlData = chunk => {
    controlBuffer += chunk.toString();
    if (controlBuffer.length > 4096) return controller.abort(new Error('invalid install control payload'));
    let newline;
    while ((newline = controlBuffer.indexOf('\n')) >= 0) {
      const line = controlBuffer.slice(0, newline).replace(/\r$/, '');
      controlBuffer = controlBuffer.slice(newline + 1);
      if (line === 'cancel ' + nonce) cancel();
    }
  };
  const onControlEnd = () => controller.abort(new Error('install owner control channel closed'));
  if (nonce) {
    process.stdin.on('data', onControlData);
    process.stdin.once('end', onControlEnd);
    process.stdin.once('error', onControlEnd);
  }
  try {
    const result = await buildInstallNotedTerminal({
      signal: controller.signal,
      beforeQuit: nonce ? async ({ signal }) => {
        await waitForInstallAck({ nonce, signal });
        process.stdin.resume(); // keep cancellation observable after the ACK
      } : async () => {},
    });
    console.log(INSTALL_RESULT_PREFIX + JSON.stringify({ protocol: 1, nonce: nonce || null, ...result }));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    process.stdin.off('data', onControlData);
    process.stdin.off('end', onControlEnd);
    process.stdin.off('error', onControlEnd);
    if (nonce) process.stdin.pause();
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('[NotedInstall] ' + error.message); process.exitCode = 1; });
}
