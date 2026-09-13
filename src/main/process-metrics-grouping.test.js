'use strict';

const assert = require('node:assert');
const test = require('node:test');

const { groupProcessMetrics, describeTool, describeAgent, describeCommand, isSharedService } = require('./process-metrics-grouping');

const MB = 1024 * 1024;

function proc(pid, ppid, footprintMb, execPath, name) {
  return {
    pid,
    ppid,
    pgid: pid,
    name: name || (execPath ? execPath.split('/').pop() : 'proc'),
    execPath: execPath || '',
    commandLine: execPath || '',
    footprintBytes: footprintMb * MB,
    cpuNs: 0,
  };
}

function snapshotOf(processes) {
  return { ok: true, processes, scannedAt: 1000, durationMs: 4 };
}

/** Процесс, у которого командная строка отличается от пути к файлу. */
function procCmd(pid, ppid, footprintMb, commandLine, execPath) {
  return {
    pid,
    ppid,
    pgid: pid,
    name: (commandLine || '').split(/[\s\/]/).pop() || 'proc',
    execPath: execPath || '',
    commandLine,
    footprintBytes: footprintMb * MB,
    cpuNs: 0,
  };
}

test('вкладка считается как сессия плюс все её инструменты', () => {
  const snapshot = snapshotOf([
    proc(100, 1, 200, '/usr/local/bin/codex'),
    proc(101, 100, 60, '/Users/x/Desktop/electron-mcp/src/index.mjs'),
    proc(102, 100, 40, '/Users/x/.claude/mcp/knowledge-server.mjs'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 100, title: 'codex', projectId: 'p1' }],
    projectId: 'p1',
  });

  const tab = result.projectTabs[0];
  assert.equal(tab.selfBytes, 200 * MB);
  assert.equal(tab.toolsBytes, 100 * MB);
  assert.equal(tab.totalBytes, 300 * MB);
  assert.equal(tab.toolCount, 2);
  assert.deepEqual(tab.tools.map(t => t.label), ['electron', 'knowledge']);
});

test('инструмент через обёртку показан одной строкой с полным весом', () => {
  // npm exec yougile-mcp → node yougile-mcp: в дереве два процесса,
  // но для пользователя это один инструмент.
  const snapshot = snapshotOf([
    proc(200, 1, 100, '/usr/local/bin/claude'),
    proc(201, 200, 30, '/Users/x/node_modules/.bin/yougile-mcp'),
    proc(202, 201, 50, '/Users/x/_npx/node_modules/.bin/yougile-mcp'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 200, projectId: 'p1' }],
    projectId: 'p1',
  });

  const tab = result.projectTabs[0];
  assert.equal(tab.tools.length, 1, 'обёртка и её потомок — одна строка');
  assert.equal(tab.tools[0].label, 'yougile');
  assert.equal(tab.tools[0].bytes, 80 * MB, 'вес обёртки схлопнут в инструмент');
  assert.equal(tab.totalBytes, 180 * MB, 'итог вкладки без двойного счёта');
});

test('память не считается дважды при пересечении поддеревьев', () => {
  const snapshot = snapshotOf([
    proc(300, 1, 100, '/usr/local/bin/codex'),
    proc(301, 300, 50, '/Users/x/mcp/browser/index.js'),
  ]);

  // Две вкладки объявляют один и тот же процесс своим корнем.
  const result = groupProcessMetrics({
    snapshot,
    tabs: [
      { tabId: 't1', pid: 300, projectId: 'p1' },
      { tabId: 't2', pid: 300, projectId: 'p1' },
    ],
    projectId: 'p1',
  });

  const total = result.projectTabs.reduce((sum, tab) => sum + tab.totalBytes, 0);
  assert.equal(total, 150 * MB, 'общий процесс учтён ровно один раз');
});

test('процессы приложения не утекают во вкладки', () => {
  const snapshot = snapshotOf([
    proc(1, 0, 10, '/sbin/launchd'),
    proc(400, 1, 1500, '/Applications/Noted Terminal.app/Contents/MacOS/Noted Terminal'),
    proc(401, 400, 900, '/Applications/Noted Terminal.app/Contents/Frameworks/Noted Terminal Helper (Renderer).app/Contents/MacOS/Noted Terminal Helper (Renderer)'),
    proc(402, 400, 120, '/usr/local/bin/codex'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 402, projectId: 'p1' }],
    appPids: [400, 401],
    projectId: 'p1',
  });

  assert.equal(result.app.totalBytes, 2400 * MB);
  assert.equal(result.projectTabs[0].totalBytes, 120 * MB, 'вкладка не утащила приложение');
  assert.deepEqual(result.app.rows.map(r => r.label), ['Ядро приложения', 'Отрисовка окна']);
});

test('одноимённые процессы приложения слиты в одну строку с количеством', () => {
  // Окон отрисовки бывает несколько. Две строки с одинаковой подписью
  // неразличимы для читающего.
  const renderer = '/Applications/Noted Terminal.app/Contents/Frameworks/Noted Terminal Helper (Renderer).app/Contents/MacOS/Noted Terminal Helper (Renderer)';
  const snapshot = snapshotOf([
    proc(410, 1, 300, renderer),
    proc(411, 1, 260, renderer),
    proc(412, 1, 150, '/Applications/Noted Terminal.app/Contents/MacOS/Noted Terminal'),
  ]);

  const result = groupProcessMetrics({ snapshot, tabs: [], appPids: [410, 411, 412], projectId: 'p1' });

  const rendererRow = result.app.rows.find(row => row.label === 'Отрисовка окна');
  assert.equal(rendererRow.bytes, 560 * MB, 'вес обоих окон сложен');
  assert.equal(rendererRow.count, 2, 'количество показано явно');
  assert.equal(result.app.rows.filter(row => row.label === 'Отрисовка окна').length, 1);
  assert.equal(result.app.totalBytes, 710 * MB, 'итог приложения не изменился');
});

test('брошенные инструменты найдены, общий шлюз в них не попал', () => {
  const snapshot = snapshotOf([
    proc(500, 1, 4, '/Users/x/Desktop/sc-desktop/mcp/browser/index.js'),
    proc(501, 1, 4, '/Users/x/Desktop/sc-desktop/mcp/browser/index.js'),
    proc(502, 1, 16, '/Users/x/Desktop/sc-desktop/mcp/browser/bridge.js'),
  ]);

  const result = groupProcessMetrics({ snapshot, tabs: [], projectId: 'p1' });

  assert.equal(result.orphans.count, 2, 'два брошенных инструмента');
  assert.equal(result.orphans.totalBytes, 8 * MB);
  assert.equal(result.sharedServices.length, 1, 'общий шлюз — служебный, не брошенный');
  assert.equal(result.sharedServices[0].pid, 502);
});

test('живой инструмент не считается брошенным', () => {
  const snapshot = snapshotOf([
    proc(600, 1, 100, '/usr/local/bin/codex'),
    proc(601, 600, 50, '/Users/x/mcp/browser/index.js'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 600, projectId: 'p1' }],
    projectId: 'p1',
  });

  assert.equal(result.orphans.count, 0);
});

test('закрывшийся процесс вкладки даёт нулевую строку, а не пропажу', () => {
  const result = groupProcessMetrics({
    snapshot: snapshotOf([]),
    tabs: [{ tabId: 't1', pid: 999, title: 'codex', projectId: 'p1' }],
    projectId: 'p1',
  });

  assert.equal(result.projectTabs.length, 1, 'строка вкладки не исчезает');
  assert.equal(result.projectTabs[0].alive, false);
  assert.equal(result.projectTabs[0].totalBytes, 0);
});

test('вкладки чужих проектов отделены от текущего', () => {
  const snapshot = snapshotOf([
    proc(700, 1, 100, '/usr/local/bin/codex'),
    proc(701, 1, 200, '/usr/local/bin/claude'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [
      { tabId: 't1', pid: 700, projectId: 'p1' },
      { tabId: 't2', pid: 701, projectId: 'p2' },
    ],
    projectId: 'p1',
  });

  assert.equal(result.projectTabs.length, 1);
  assert.equal(result.otherTabs.length, 1);
  assert.equal(result.totals.projectBytes, 100 * MB);
  assert.equal(result.totals.otherBytes, 200 * MB);
});

test('цикл в дереве процессов не вешает обход', () => {
  const snapshot = snapshotOf([
    proc(800, 801, 10, '/usr/local/bin/codex'),
    proc(801, 800, 10, '/Users/x/mcp/browser/index.js'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 800, projectId: 'p1' }],
    projectId: 'p1',
  });

  assert.equal(result.projectTabs[0].totalBytes, 20 * MB);
});

test('загрузка процессора складывается по вкладке', () => {
  const snapshot = snapshotOf([
    proc(900, 1, 100, '/usr/local/bin/codex'),
    proc(901, 900, 50, '/Users/x/mcp/browser/index.js'),
  ]);
  const cpu = new Map([[900, 12.5], [901, 7.5]]);

  const result = groupProcessMetrics({
    snapshot,
    cpuByPid: cpu,
    tabs: [{ tabId: 't1', pid: 900, projectId: 'p1' }],
    projectId: 'p1',
  });

  assert.equal(result.hasCpu, true);
  assert.equal(result.projectTabs[0].totalCpu, 20);
});

test('без второго замера загрузка не выдумывается', () => {
  const result = groupProcessMetrics({
    snapshot: snapshotOf([proc(910, 1, 100, '/usr/local/bin/codex')]),
    cpuByPid: null,
    tabs: [{ tabId: 't1', pid: 910, projectId: 'p1' }],
    projectId: 'p1',
  });

  assert.equal(result.hasCpu, false);
  assert.equal(result.projectTabs[0].totalCpu, null, 'null, а не ноль — это разные утверждения');
});

test('имена инструментов человекочитаемы', () => {
  assert.equal(describeTool({ commandLine: 'node /x/.claude/mcp/knowledge-server.mjs' }), 'knowledge');
  assert.equal(describeTool({ commandLine: 'npm exec @nebelov/yougile-mcp' }), 'yougile');
  assert.equal(describeTool({ commandLine: 'node /x/sc-desktop/mcp/browser/index.js' }), 'browser');
  assert.equal(isSharedService({ execPath: '/x/mcp/browser/bridge.js' }), true);
});

test('PTY-вкладка: цепочка агента — одна строка, оболочка терминала — нет', () => {
  // Реальная форма: zsh → node-обёртка codex → бинарь → code-mode-host.
  // Раньше всё это падало в безымянное «прочее», а «самой сессией»
  // называлась оболочка на 3 МБ.
  const snapshot = snapshotOf([
    procCmd(1000, 1, 3, '-zsh', '/bin/zsh'),
    procCmd(1001, 1000, 12, 'node /Users/x/.local/bin/codex --no-alt-screen resume abc'),
    procCmd(1002, 1001, 345, '/Users/x/.local/lib/node_modules/@openai/codex/vendor/bin/codex --no-alt-screen'),
    procCmd(1003, 1002, 15, '/Users/x/.local/lib/node_modules/@openai/codex/vendor/bin/codex-code-mode-host'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 1000, projectId: 'p1' }],
    projectId: 'p1',
  });

  const tab = result.projectTabs[0];
  assert.equal(tab.selfBytes, 3 * MB, 'сама строка вкладки — только оболочка');
  assert.equal(tab.agents.length, 1, 'вся цепочка запуска — одна строка агента');
  assert.equal(tab.agents[0].label, 'Codex');
  assert.equal(tab.agents[0].bytes, 372 * MB);
  assert.equal(tab.agents[0].count, 3);
  assert.equal(tab.totalBytes, 375 * MB);
});

test('запущенная во вкладке команда — своя строка со всем поддеревом', () => {
  // npm run dev поднимает вложенный экземпляр приложения, внутри которого
  // живут собственные agent-процессы. Их вес принадлежит команде, а не
  // «сессии» вкладки: иначе вкладка раздувается на чужой гигабайт.
  const snapshot = snapshotOf([
    procCmd(1100, 1, 3, '-zsh', '/bin/zsh'),
    procCmd(1101, 1100, 50, 'npm run dev'),
    procCmd(1102, 1101, 400, '/Users/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .'),
    procCmd(1103, 1102, 200, 'claude --dangerously-skip-permissions'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 1100, projectId: 'p1' }],
    projectId: 'p1',
  });

  const tab = result.projectTabs[0];
  assert.equal(tab.agents.length, 0, 'вложенный claude не приписан вкладке как агент');
  assert.equal(tab.commands.length, 1);
  assert.equal(tab.commands[0].label, 'npm run dev');
  assert.equal(tab.commands[0].bytes, 650 * MB, 'поддерево команды целиком у команды');
  assert.equal(tab.commands[0].count, 3);
  assert.equal(tab.totalBytes, 653 * MB);
});

test('лёгкая команда не получает строку — уходит в «прочее»', () => {
  const snapshot = snapshotOf([
    procCmd(1200, 1, 3, '-zsh', '/bin/zsh'),
    procCmd(1201, 1200, 5, 'git status'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 1200, projectId: 'p1' }],
    projectId: 'p1',
  });

  const tab = result.projectTabs[0];
  assert.equal(tab.commands.length, 0, 'git на 5 МБ не мерцает отдельной строкой');
  assert.equal(tab.otherBytes, 5 * MB);
  assert.equal(tab.totalBytes, 8 * MB);
});

test('прозрачная оболочка не строка: потомки классифицируются сами', () => {
  const snapshot = snapshotOf([
    procCmd(1300, 1, 3, '-zsh', '/bin/zsh'),
    procCmd(1301, 1300, 2, 'sh -c npm run dev'),
    procCmd(1302, 1301, 500, 'npm run dev'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 1300, projectId: 'p1' }],
    projectId: 'p1',
  });

  const tab = result.projectTabs[0];
  assert.equal(tab.commands.length, 1, 'команда найдена сквозь sh -c');
  assert.equal(tab.commands[0].label, 'npm run dev');
  assert.equal(tab.commands[0].bytes, 500 * MB);
  assert.equal(tab.otherBytes, 2 * MB, 'вес самой оболочки — в прочем');
});

test('агент, запущенный другим агентом, — отдельная строка', () => {
  const snapshot = snapshotOf([
    procCmd(1400, 1, 3, '-zsh', '/bin/zsh'),
    procCmd(1401, 1400, 300, '/Users/x/.local/lib/node_modules/@openai/codex/vendor/bin/codex resume abc'),
    procCmd(1402, 1401, 200, 'claude --print задача'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 1400, projectId: 'p1' }],
    projectId: 'p1',
  });

  const tab = result.projectTabs[0];
  assert.deepEqual(tab.agents.map(row => row.label), ['Codex', 'Claude'],
    'вес claude не растворился в строке codex');
  assert.equal(tab.agents[0].bytes, 300 * MB);
  assert.equal(tab.agents[1].bytes, 200 * MB);
});

test('MCP-инструмент под агентом остаётся строкой инструмента', () => {
  const snapshot = snapshotOf([
    procCmd(1500, 1, 3, '-zsh', '/bin/zsh'),
    procCmd(1501, 1500, 200, 'claude --dangerously-skip-permissions'),
    procCmd(1502, 1501, 60, 'node /Users/x/Desktop/electron-mcp/src/index.mjs'),
  ]);

  const result = groupProcessMetrics({
    snapshot,
    tabs: [{ tabId: 't1', pid: 1500, projectId: 'p1' }],
    projectId: 'p1',
  });

  const tab = result.projectTabs[0];
  assert.equal(tab.agents[0].label, 'Claude');
  assert.equal(tab.agents[0].bytes, 200 * MB);
  assert.deepEqual(tab.tools.map(row => row.label), ['electron']);
  assert.equal(tab.totalBytes, 263 * MB);
});

test('имена агентов и команд человекочитаемы', () => {
  assert.equal(describeAgent({ commandLine: 'node /x/.local/bin/codex resume abc' }), 'Codex');
  assert.equal(describeAgent({ commandLine: 'claude --dangerously-skip-permissions' }), 'Claude');
  assert.equal(describeAgent({ commandLine: 'npm run dev' }), null);

  assert.equal(describeCommand({ commandLine: 'npm run dev' }), 'npm run dev');
  assert.equal(describeCommand({ commandLine: 'node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run dev' }), 'npm run dev');
  assert.equal(describeCommand({ commandLine: 'node /x/node_modules/.bin/vite' }), 'vite');
  assert.equal(describeCommand({ commandLine: '/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .', execPath: '/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' }), 'Electron');
});
