import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const hook = read('renderer/components/Workspace/useAgentLifecycle.ts');
const area = read('renderer/components/Workspace/TerminalArea.tsx');
const pane = read('renderer/components/Workspace/SplitPaneSurface.tsx');
const summary = read('renderer/components/Workspace/agentLifecycleSummary.ts');

// Проверять надо КОД, а не комментарии: иначе тест запрещает объяснить в
// комментарии, что именно было сломано, — а это самая ценная часть шрама.
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');
const hookCode = codeOnly(hook);
const areaCode = codeOnly(area);

/**
 * Плашка процесса — свойство ВКЛАДКИ, не фокуса.
 *
 * Машина состояний запуска/остановки жила в одном экземпляре и читала
 * `activeTabId`, поэтому для неактивной вкладки состояние не строилось вовсе:
 * «CLAUDE START FAILED» с кнопкой RETRY не показывался ни в неактивной вкладке,
 * ни во второй панели сплита. Пользователь: «на вкладке вообще с этим не связано
 * никак, и не может быть связано».
 *
 * Здесь закреплено то, что легко откатить молча: параметризация по `tabId`,
 * отсутствие чтения активной вкладки внутри машины, свой экземпляр у панели и
 * приоритет состояний.
 */

test('машина параметризована tabId, а не активной вкладкой', () => {
  assert.match(hook, /export function useAgentLifecycle\(\{\s*\n\s*projectId,\s*\n\s*tabId,\s*\n\s*enabled,/);
  // Внутри машины активной вкладки нет ни в одном виде — иначе она снова стала
  // бы состоянием фокуса.
  assert.doesNotMatch(hookCode, /activeTabId/);
});

test('целевая вкладка определяется по её записи, а не по фокусу', () => {
  const target = hook.slice(
    hook.indexOf('export function useAgentLifecycleTarget'),
    hook.indexOf('export function useAgentLifecycle('),
  );
  assert.ok(target.length > 0);
  assert.match(target, /s\.openProjects\.get\(projectId\)/);
  assert.match(target, /ws\?\.tabs\.get\(tabId\)/);
  assert.doesNotMatch(codeOnly(target), /activeTabId/);
  // Владелец PTY решается общим резолвером, а не своей копией условий.
  assert.match(target, /resolvePtyAgentOwner\(tab\)/);
});

test('каждое событие адресуется СВОЕЙ вкладке', () => {
  // Прежние обработчики сравнивали tabId события с активной вкладкой. Теперь
  // сравнение идёт с целью этого экземпляра.
  assert.match(hook, /const isMine = \(eventTabId\?: string \| null\) => \{/);
  assert.match(hook, /return !!eventTabId && !!info && info\.tabId === eventTabId;/);
  for (const handler of ['onCommandStarted', 'onLaunchPreparation']) {
    const idx = hook.indexOf(`const ${handler} =`);
    assert.ok(idx > 0, handler + ' существует');
    const body = hook.slice(idx, idx + 320);
    assert.match(body, /isMine\(/, handler + ' фильтрует по своей вкладке');
  }
});

test('панель сплита собирает состояние сама, а не получает пропом', () => {
  // Фильтр по tabId в панели был верным, но фильтровать было нечего: для
  // неактивной вкладки состояние не строилось.
  assert.match(pane, /import \{ useAgentLifecycle \} from '\.\/useAgentLifecycle'/);
  assert.match(pane, /const paneLifecycleStatus = useAgentLifecycle\(\{/);
  assert.doesNotMatch(codeOnly(pane), /lifecycleStatus\?: AgentLifecycleSummary \| null;/);
  assert.doesNotMatch(codeOnly(pane), /lifecycleStatus = null,/);
  // И родитель больше не передаёт его вниз.
  assert.doesNotMatch(areaCode, /lifecycleStatus=\{lifecycleSummary\}/);
});

test('одиночный режим использует тот же хук, без своей копии машины', () => {
  assert.match(area, /import \{ useAgentLifecycle \} from '\.\/useAgentLifecycle'/);
  assert.match(area, /const lifecycleSummary = useAgentLifecycle\(\{/);
  // Копии машины в TerminalArea не осталось: ни состояния, ни обработчиков.
  for (const dead of [
    'const [sessionStarting, setSessionStarting]',
    'const [agentStopping, setAgentStopping]',
    'syncSessionStartingWithPresence',
    'applyClaudeStartupDefaultsGate',
    'fetchClaudeStartupDefaultsGate',
    'const showSessionStartingOverlay',
  ]) {
    assert.equal(areaCode.includes(dead), false, 'остался мёртвый код: ' + dead);
  }
  // И второй формулировки статуса тоже нет.
  assert.equal(areaCode.includes('const getSessionStartingPresentation'), false);
});

test('движок едет полем сводки, а не разбором заголовка', () => {
  // `title.startsWith('CODEX')` связал бы возобновление сессии с текстом
  // подписи: правка формулировки молча сломала бы «продолжить».
  assert.match(summary, /engine\?: 'claude' \| 'codex';/);
  assert.match(hook, /engine: interrupted\.engine/);
  assert.doesNotMatch(areaCode, /title\.startsWith\('CODEX'\)/);
});

test('приоритет состояний: остановка → текущий launch/error → durable interrupted fallback', () => {
  const build = hook.slice(hook.indexOf('return useMemo<AgentLifecycleSummary | null>'));
  const iStop = build.indexOf("kind: 'stopping'");
  const iInt = build.indexOf("kind: 'interrupted'");
  const iStart = build.indexOf("isWarning ? 'warning' : presentation.isError ? 'error' : 'starting'");
  assert.ok(iStop >= 0 && iInt >= 0 && iStart >= 0);
  assert.ok(iStop < iStart, 'остановка перекрывает launch');
  assert.ok(iStart < iInt, 'текущий отказ запуска не скрывается старым interrupted-marker');
});

test('Codex capacity is a yellow dismissible lifecycle warning, not another loader', () => {
  assert.match(summary, /'warning'/);
  assert.match(hook, /title: '⚠ CODEX MODEL AT CAPACITY'/);
  assert.match(hook, /spinner: !presentation\.isError && !isWarning/);
  assert.match(hook, /ipcRenderer\.invoke\('codex:clear-lifecycle-warning'/);
});

test('durable-восстановление осталось: события — быстрый путь, не единственный', () => {
  // В инциденте 2026-07-25 событие о провале пришло через 549ms после
  // переключения и было отброшено; чтение снимка — контракт.
  assert.match(hook, /ipcRenderer\.invoke\('agent:get-launch-preparation-state', target\.tabId\)/);
  assert.match(hook, /ipcRenderer\.invoke\('agent:get-stopping-state', tabId\)/);
  assert.match(hook, /fetchClaudeStartupDefaultsGate\(target\.tabId\)/);
});

test('прерванная сессия читается гранулярным селектором, без подписки на Map', () => {
  const block = hook.slice(
    hook.indexOf('const interruptedKey = useWorkspaceStore('),
    hook.indexOf('const interrupted = useMemo('),
  );
  assert.ok(block.length > 0);
  assert.match(block, /s\.openProjects\.get\(projectId\)/);
  assert.doesNotMatch(block, /for \(const/);
  // Восстановление раскладки не должно показывать прерванную сессию.
  assert.match(block, /s\.isRestoring/);
});
