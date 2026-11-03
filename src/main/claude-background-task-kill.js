'use strict';

// Остановка одной фоновой команды Claude (`Bash run_in_background`, `Monitor`).
//
// Убить её «снаружи» нельзя по имени: две задачи могут быть запущены одной и
// той же командой с одним описанием, и в списке процессов они неразличимы.
// Единственный точный адрес — файл вывода задачи: CLI заводит его на каждый
// запуск отдельно и называет по ID задачи. Кто держит этот файл открытым, тот
// и есть её процесс.
//
// Проверено на живых задачах 01Nov: две задачи с полностью совпадающей
// командой дали разные PID (82067 против 82515), убийство группы первой не
// тронуло вторую. Каждая задача — своя группа процессов, её корень является
// лидером группы, и в группе только её потомки.
//
// Если точность недостижима — функция отказывается и НЕ убивает ничего:
// неверно убитый процесс здесь дороже неудобства.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 4000 }, (error, stdout) => {
      // Непустой вывод полезен и при ненулевом коде (lsof так делает).
      resolve({ error: error || null, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

function parsePids(stdout) {
  return [...new Set(String(stdout).split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 1))];
}

/**
 * Путь к файлу вывода задачи.
 *
 * Главный источник — сама расписка CLI: он печатает полный путь («Output is
 * being written to: …») и это единственный адрес, который заведомо совпадает с
 * тем, куда пишет процесс. Собирать путь из своих предположений о каталоге
 * скретча нельзя: он зависит от версии CLI и переменных окружения сессии.
 *
 * `scratchRoot`+`sessionId` остаются запасным вариантом для старых расписок,
 * где пути в тексте не было. Имя файла в обоих случаях обязано совпасть с ID
 * задачи — иначе адрес принадлежит не ей.
 */
function claudeBackgroundTaskOutputPath({ acceptance, scratchRoot, sessionId, taskId }) {
  // taskId приходит из расписки провайдера, но в путь он попадает как имя
  // файла: посторонние символы означают, что это не ID, и адрес не строится.
  if (!taskId || !/^[A-Za-z0-9_-]+$/.test(taskId)) return '';
  const quoted = String(acceptance || '');
  // Путь заканчивается именем `<taskId>.output`, и дальше в расписке идёт
  // обычная точка конца предложения. Жадное `\S+` забирало её в путь, и адрес
  // переставал совпадать с ID задачи — остановка молча отказывала.
  const stated = /Output is being written to:\s*(\S*\.output)/i.exec(quoted)?.[1]
    || /output_file:\s*(\S*\.output)/i.exec(quoted)?.[1]
    || '';
  if (stated) {
    return path.basename(stated) === `${taskId}.output` ? stated : '';
  }
  if (!scratchRoot || !sessionId) return '';
  return path.join(scratchRoot, sessionId, 'tasks', `${taskId}.output`);
}

/**
 * Группа процессов задачи по её файлу вывода.
 *
 * Возвращает `{ ok, pgid, pids }` либо отказ с причиной. Отказ — это ответ,
 * а не ошибка: вызывающий обязан показать его пользователю и ничего не убивать.
 */
async function resolveClaudeBackgroundTaskGroup(outputPath) {
  if (!outputPath) return { ok: false, reason: 'no-output-path' };
  if (!fs.existsSync(outputPath)) return { ok: false, reason: 'output-missing' };

  const holders = await run('/usr/sbin/lsof', ['-t', '--', outputPath]);
  const pids = parsePids(holders.stdout);
  // Пустой список означает, что команда уже закончилась: файл остался, писателя
  // нет. Это не ошибка адресации, и убивать нечего.
  if (!pids.length) return { ok: false, reason: 'already-finished' };

  const groups = new Set();
  let leader = 0;
  for (const pid of pids) {
    const info = await run('/bin/ps', ['-o', 'pgid=', '-p', String(pid)]);
    const pgid = Number.parseInt(info.stdout.trim(), 10);
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    groups.add(pgid);
    if (pgid === pid) leader = pid;
  }
  // Несколько групп на один файл вывода означают, что адрес больше не
  // однозначен. Это ровно тот случай, когда убивать вслепую запрещено.
  if (groups.size !== 1) {
    return { ok: false, reason: groups.size ? 'ambiguous-process-group' : 'process-group-unknown' };
  }
  const pgid = [...groups][0];
  // Лидер группы — корень задачи. Без него группа могла быть переиспользована
  // чужим процессом, и сигнал по ней задел бы постороннюю работу.
  if (!leader || leader !== pgid) return { ok: false, reason: 'process-group-not-owned' };
  return { ok: true, pgid, pids };
}

/**
 * Остановить фоновую задачу. Сигнал идёт группе, поэтому умирает и сам шелл,
 * и его потомки (`sleep`, дочерние сборки), а не только верхний процесс.
 *
 * Жёсткий сигнал посылается только после того, как мягкий не сработал: у
 * команды должен остаться шанс закрыть свои файлы. Подтверждение — исчезновение
 * писателей, а не код возврата `kill`.
 */
async function killClaudeBackgroundTask({ acceptance, scratchRoot, sessionId, taskId, wait = waitForExit }) {
  const outputPath = claudeBackgroundTaskOutputPath({ acceptance, scratchRoot, sessionId, taskId });
  const resolved = await resolveClaudeBackgroundTaskGroup(outputPath);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, taskId: taskId || '' };

  const { pgid } = resolved;
  try { process.kill(-pgid, 'SIGTERM'); } catch (error) {
    if (error?.code === 'ESRCH') return { ok: true, taskId, pgid, signal: 'none', note: 'exited-before-signal' };
    return { ok: false, reason: 'signal-failed', taskId, pgid, error: String(error?.message || error) };
  }

  if (await wait(outputPath, 2000)) return { ok: true, taskId, pgid, signal: 'SIGTERM' };
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* уже мёртв — проверяем ниже */ }
  if (await wait(outputPath, 2000)) return { ok: true, taskId, pgid, signal: 'SIGKILL' };
  // Процесс пережил оба сигнала: сообщаем честно, а не выдаём это за успех.
  return { ok: false, reason: 'still-running', taskId, pgid };
}

async function waitForExit(outputPath, deadlineMs) {
  const until = Date.now() + Math.max(0, deadlineMs);
  for (;;) {
    const holders = await run('/usr/sbin/lsof', ['-t', '--', outputPath]);
    if (!parsePids(holders.stdout).length) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

module.exports = {
  claudeBackgroundTaskOutputPath,
  resolveClaudeBackgroundTaskGroup,
  killClaudeBackgroundTask,
};
