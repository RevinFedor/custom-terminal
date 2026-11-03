'use strict';

// Остановка фоновой команды проверяется на НАСТОЯЩИХ процессах: вся ценность
// этого модуля в том, что он отличает две одинаковые по команде задачи, а
// такую ошибку подделанный `lsof` не поймает. Каждый тест поднимает свои
// короткоживущие шеллы в своём временном каталоге и убирает их за собой.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  claudeBackgroundTaskOutputPath,
  resolveClaudeBackgroundTaskGroup,
  killClaudeBackgroundTask,
} = require('./claude-background-task-kill');

const roots = [];
const spawned = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-bgkill-'));
  roots.push(root);
  return root;
}

// Тестовая задача повторяет форму настоящей: отдельная группа процессов,
// собственный файл вывода, живой потомок внутри.
function startTask(root, sessionId, taskId) {
  const dir = path.join(root, sessionId, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const outputPath = path.join(dir, `${taskId}.output`);
  const out = fs.openSync(outputPath, 'a');
  const child = spawn('/bin/bash', ['-c', 'while :; do sleep 1; done'],
    { detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  spawned.push(child);
  return { outputPath, pid: child.pid };
}

async function settle(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test.after(() => {
  for (const child of spawned) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* уже мёртв */ }
  }
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* не критично */ }
  }
});

test('адрес задачи берётся из её расписки и обязан совпасть с её ID', () => {
  const stated = claudeBackgroundTaskOutputPath({
    taskId: 'bkgmyo4um',
    acceptance: 'Command running in background with ID: bkgmyo4um. Output is being '
      + 'written to: /tmp/sess/tasks/bkgmyo4um.output. You will be notified.',
  });
  assert.equal(stated, '/tmp/sess/tasks/bkgmyo4um.output');

  // Путь из расписки, который принадлежит ДРУГОЙ задаче, адресом не является:
  // иначе одна карточка могла бы остановить чужую команду.
  assert.equal(claudeBackgroundTaskOutputPath({
    taskId: 'bkgmyo4um',
    acceptance: 'Output is being written to: /tmp/sess/tasks/bother999.output.',
  }), '');

  // Старые расписки без пути собираются из каталога сессии.
  assert.equal(claudeBackgroundTaskOutputPath({
    taskId: 'bash-1', scratchRoot: '/tmp/root', sessionId: 'sess',
  }), '/tmp/root/sess/tasks/bash-1.output');

  // ID, который не является именем файла, отбрасывается до любых действий.
  assert.equal(claudeBackgroundTaskOutputPath({
    taskId: '../../etc/passwd', scratchRoot: '/tmp/root', sessionId: 'sess',
  }), '');
  assert.equal(claudeBackgroundTaskOutputPath({ taskId: '', scratchRoot: '/r', sessionId: 's' }), '');
});

test('две задачи с ОДИНАКОВОЙ командой различаются, и остановка убивает только одну', async () => {
  const root = makeRoot();
  const sessionId = 'session-a';
  const alpha = startTask(root, sessionId, 'balpha001');
  const beta = startTask(root, sessionId, 'bbeta0002');
  await settle(300);

  const alphaGroup = await resolveClaudeBackgroundTaskGroup(alpha.outputPath);
  const betaGroup = await resolveClaudeBackgroundTaskGroup(beta.outputPath);
  assert.equal(alphaGroup.ok, true, 'живая задача обязана опознаться');
  assert.equal(betaGroup.ok, true);
  // Команда у них посимвольно одна и та же — различает только файл вывода.
  assert.notEqual(alphaGroup.pgid, betaGroup.pgid, 'у задач обязаны быть разные группы');

  const killed = await killClaudeBackgroundTask({ scratchRoot: root, sessionId, taskId: 'balpha001' });
  assert.equal(killed.ok, true, 'остановка обязана подтвердиться');
  assert.equal(killed.pgid, alphaGroup.pgid);

  assert.equal((await resolveClaudeBackgroundTaskGroup(alpha.outputPath)).reason, 'already-finished');
  const survivor = await resolveClaudeBackgroundTaskGroup(beta.outputPath);
  assert.equal(survivor.ok, true, 'соседняя задача обязана выжить');
  assert.equal(survivor.pgid, betaGroup.pgid);

  await killClaudeBackgroundTask({ scratchRoot: root, sessionId, taskId: 'bbeta0002' });
});

test('сигнал достаётся и потомкам задачи, не только её верхнему процессу', async () => {
  const root = makeRoot();
  const sessionId = 'session-b';
  const task = startTask(root, sessionId, 'bchild001');
  await settle(400);
  const group = await resolveClaudeBackgroundTaskGroup(task.outputPath);
  assert.equal(group.ok, true);
  // Внутри работает `sleep`: если бы сигнал шёл только корню, он бы остался.
  assert.ok(group.pids.length >= 2, 'у задачи обязаны быть живые потомки');

  assert.equal((await killClaudeBackgroundTask({ scratchRoot: root, sessionId, taskId: 'bchild001' })).ok, true);
  for (const pid of group.pids) {
    assert.throws(() => process.kill(pid, 0), 'потомок обязан умереть вместе с задачей');
  }
});

test('без однозначного адреса остановка отказывает, а не убивает наугад', async () => {
  const root = makeRoot();
  const sessionId = 'session-c';

  // Задача уже завершилась: файл остался, писателя нет.
  const dir = path.join(root, sessionId, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bdone0001.output'), '[killed]\n');
  assert.equal((await killClaudeBackgroundTask({ scratchRoot: root, sessionId, taskId: 'bdone0001' })).reason,
    'already-finished');

  // Файла вывода нет вовсе.
  assert.equal((await killClaudeBackgroundTask({ scratchRoot: root, sessionId, taskId: 'bmissing1' })).reason,
    'output-missing');

  // Адрес не строится — ни одного системного вызова делать нельзя.
  assert.equal((await killClaudeBackgroundTask({ taskId: 'bnopath01' })).reason, 'no-output-path');
});
