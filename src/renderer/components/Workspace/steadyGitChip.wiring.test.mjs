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
const gitHost = read('FocusedWorkspaceGitStatus.tsx');
const titlebar = read('WorkspaceTitleBarTools.tsx');
const chrome = read('SplitPaneChrome.tsx');
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

test('одна кнопка titlebar следует показанной вкладке окна в фокусе и владеет Git status/watch', () => {
  assert.equal((titlebar.match(/<FocusedWorkspaceGitStatus \/>/g) || []).length, 1);
  assert.doesNotMatch(chrome, /<PersistentPaneGitStatus|<GitStatusButton/);
  assert.match(gitHost, /state\.splitPanes\[state\.splitFocusedIndex\]/);
  assert.match(gitHost, /pane\.selectedSlotId \|\| pane\.displayHidden/);
  assert.match(gitHost, /key=\{targetKey\}/);
  assert.match(gitHost, /targetTabId=\{target\.tabId\}/);
  assert.match(gitHost, /foreground\s*\/>/);
  assert.doesNotMatch(gitHost, /selectFocusedProjectId|activeArea/);
  assert.match(git, /foreground: boolean/);
  assert.match(git, /if \(!foreground\) \{[\s\S]{0,220}statusRequestRef\.current \+= 1/);
  assert.match(git, /if \(!foreground \|\| !effectiveRepoPath \|\| hydratedStateKey !== panelStateKey\) return/);
  assert.match(git, /if \(!foreground\) return undefined;[\s\S]{0,120}const onFsChange/);
});

test('закрытый Git получает только summary, полная metadata начинается после открытия', () => {
  assert.match(git, /const detail = visible \|\| openRef\.current \? 'full' : 'summary'/);
  assert.match(git, /ipcRenderer\.invoke\('git:status', \{[\s\S]{0,100}detail,/);
  assert.match(git, /if \(status\?\.summaryOnly\) return;[\s\S]{0,120}const files = status\?\.files \|\| \[\]/,
    'count-only refresh must not erase the panel file selection');
});

test('окна чужих пространств прогреваются completion-serial', () => {
  // Idle/rAF is only an admission boundary. The next hidden surface cannot
  // start until the current exact source lease completes.
  assert.match(surface, /createDormantSurfaceAdmissionQueue/);
  assert.match(surface, /requestIdleCallback/);
  assert.match(surface, /dormantSurfaceAdmission\.enqueue\(admissionKey/);
  assert.match(surface, /dormantSurfaceAdmission\.cancel\(admissionKey, 'unmount'\)/);
  assert.match(surface, /dormantSurfaceAdmission\.promote\(admissionKey\)/);
  assert.match(surface, /history:load/);
  assert.match(surface, /timeline:load/);
});
