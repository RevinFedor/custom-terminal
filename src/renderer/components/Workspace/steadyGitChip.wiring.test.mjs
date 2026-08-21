// Git-чип не дёргается, окна чужих пространств прогреваются фоном.
//
// Запросы (2026-08-20): «он сразу дёргается… нахуя обновлять состояние при
// каждом фокусе? Нужно держать его в базе и отрисовывать задним фоном…
// либо смена названия ветки, либо ничего» и «по первому пункту [прогрев]
// понятно: это база».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name), 'utf8');
const git = read('GitStatusButton.tsx');
const surface = read('SplitPaneSurface.tsx');

test('git-чип показывает последний известный ответ, скелет — только незнакомому репозиторию', () => {
  // Общая память по пути репозитория на всё приложение: пересозданная кнопка
  // (смена проекта у окна, новое окно, прогрев) рисует настоящую ветку сразу.
  assert.match(git, /const lastGitStatusByPath = new Map<string, GitStatus>\(\);/);
  assert.match(git, /function rememberGitStatus\(requestPath: string, status: GitStatus\)/);
  // Каждый успешный ответ пополняет память.
  assert.match(git, /rememberGitStatus\(requestPath, nextStatus\);/);
  // Скелет — только когда показывать нечего; смена пути запроса больше не
  // прячет ветку («либо смена названия ветки, либо ничего»).
  assert.match(git, /const showProbe = !hasCurrentStatus;/);
  assert.ok(!/requestPath !== currentStatusPath/.test(git), 'смена пути не включает скелет');
  // Сброс проекта сеется из памяти, а не начинается с null.
  assert.match(git, /const rememberedNext = lastGitStatusByPath\.get\(tabCwd \|\| nextProjectPath\) \|\| null;/);
  assert.match(git, /setStatusLoading\(Boolean\(nextProjectPath\) && !rememberedNext\);/);
  // Память ограничена — это кэш, не утечка.
  assert.match(git, /const LAST_GIT_STATUS_CAP = 60;/);
});

test('окна чужих пространств прогреваются фоном по одному на кадр', () => {
  // Первый вход в пространство больше не платит постройку: очередь будит
  // спящие окна после простоя (requestIdleCallback → по одному rAF на окно).
  assert.match(surface, /const dormantWakeQueue: Array<\(\) => void> = \[\];/);
  assert.match(surface, /requestIdleCallback/);
  assert.match(surface, /enqueueDormantWake\(wake\);/);
  // Отписка обязательна: окно могло размонтироваться до своей очереди.
  assert.match(surface, /cancelDormantWake\(wake\);/);
  // Фокус по-прежнему будит мгновенно и идёт ПЕРЕД веткой dormant.
  assert.ok(
    surface.indexOf('if (focused) {') < surface.indexOf('if (dormant) {'),
    'фокус будит раньше фоновой очереди',
  );
});
