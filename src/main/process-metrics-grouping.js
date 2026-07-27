'use strict';

/**
 * Раскладывает плоский снимок процессов по владельцам: вкладкам, самому
 * приложению и брошенным остаткам.
 *
 * Ключевая идея — мы НЕ опрашиваем вкладки по одной. Снимок системы делается
 * один раз, а здесь только строится дерево «родитель → дети», поэтому цена
 * не растёт от числа вкладок: что 5, что 50, что 500.
 *
 * Вкладка стоит ровно столько, сколько её собственный процесс плюс все его
 * потомки. Для AI-сессии потомки — это её MCP-инструменты, и обычно они весят
 * заметно больше самой сессии, поэтому показывать их отдельно обязательно.
 */

const OWNER_TAB = 'tab';
const OWNER_APP = 'app';
const OWNER_ORPHAN = 'orphan';
const OWNER_OTHER = 'other';

/**
 * Часть инструментов запускается намеренно отдельно от сессии, чтобы
 * переживать её и обслуживать все сессии сразу (общий шлюз к браузеру).
 * Такой процесс формально выглядит брошенным (родитель — система), но им
 * пользуются, и предлагать его убить — вредный совет.
 */
const SHARED_SERVICE_PATTERNS = [
  /\/mcp\/browser\/bridge\.js$/,
];

/** Инструменты агента: их и надо показывать внутри раскрытой вкладки. */
const TOOL_PATTERNS = [
  /\/mcp\//,
  /-mcp\//,
  /mcp-server/,
  /[\\/]mcp[^\\/]*\.(js|mjs|cjs)$/,
  /knowledge-server\.mjs$/,
  /terminal-server\.mjs$/,
  /yougile-mcp/,
];

function matchesAny(patterns, text) {
  if (!text) return false;
  return patterns.some(pattern => pattern.test(text));
}

function isSharedService(item) {
  return matchesAny(SHARED_SERVICE_PATTERNS, item.execPath) || matchesAny(SHARED_SERVICE_PATTERNS, item.commandLine);
}

function isToolProcess(item) {
  return matchesAny(TOOL_PATTERNS, item.execPath) || matchesAny(TOOL_PATTERNS, item.commandLine);
}

/**
 * Человеческое имя инструмента. Пользователю нужно «browser» и «knowledge»,
 * а не путь на сорок символов и не голое `node`.
 */
function describeTool(item) {
  const source = item.commandLine || item.execPath || item.name || '';

  const known = [
    [/yougile-mcp/, 'yougile'],
    [/knowledge-server\.mjs/, 'knowledge'],
    [/terminal-server\.mjs/, 'terminal'],
    [/\/mcp\/browser\//, 'browser'],
    [/electron-mcp/, 'electron'],
    [/ios-mcp/, 'ios'],
    [/gemini-mcp/, 'gemini'],
    [/sc-desktop\/mcp\/server\.js/, 'sc-desktop'],
  ];
  for (const [pattern, label] of known) {
    if (pattern.test(source)) return label;
  }

  const scriptMatch = source.match(/([^\\/\s]+)\.(?:mjs|cjs|js)(?:\s|$)/);
  if (scriptMatch) return scriptMatch[1];
  return item.name || 'процесс';
}

function buildChildrenIndex(processes) {
  const children = new Map();
  for (const item of processes) {
    if (!children.has(item.ppid)) children.set(item.ppid, []);
    children.get(item.ppid).push(item);
  }
  return children;
}

/**
 * Все потомки процесса. Обход итеративный и с защитой от повторов: дерево
 * процессов приходит из системы и в теории может содержать цикл (номера
 * переиспользуются), а рекурсия по такому дереву повесила бы main.
 */
function collectDescendants(rootPid, childrenIndex, claimed) {
  const collected = [];
  const stack = [rootPid];
  const seen = new Set([rootPid]);

  while (stack.length > 0) {
    const currentPid = stack.pop();
    for (const child of childrenIndex.get(currentPid) || []) {
      if (seen.has(child.pid)) continue;
      // Процесс уже приписан другой вкладке — второй раз его память не считаем,
      // иначе итог раздуется на величину общих поддеревьев.
      if (claimed.has(child.pid)) continue;
      seen.add(child.pid);
      claimed.add(child.pid);
      collected.push(child);
      stack.push(child.pid);
    }
  }
  return collected;
}

function sumFootprint(items) {
  let total = 0;
  for (const item of items) total += item.footprintBytes || 0;
  return total;
}

function sumCpu(items, cpuByPid) {
  if (!cpuByPid) return null;
  let total = 0;
  let known = false;
  for (const item of items) {
    const value = cpuByPid.get(item.pid);
    if (typeof value === 'number') { total += value; known = true; }
  }
  return known ? total : null;
}

/**
 * @param snapshot   результат captureNativeSnapshot()
 * @param cpuByPid   Map pid → процент (или null, если второго замера ещё не было)
 * @param tabs       [{ tabId, pid, title, projectId, kind }] — живые вкладки
 * @param appPids    номера процессов самого приложения (главный + вспомогательные)
 * @param projectId  проект, для которого строим панель
 */
function groupProcessMetrics({
  snapshot,
  cpuByPid = null,
  tabs = [],
  appPids = [],
  projectId = null,
} = {}) {
  const processes = (snapshot && snapshot.processes) || [];
  const byPid = new Map(processes.map(item => [item.pid, item]));
  const childrenIndex = buildChildrenIndex(processes);
  const claimed = new Set();

  // Процессы приложения забираем первыми: иначе вкладка, чей shell стартовал
  // из главного процесса, утащила бы в свой итог само приложение.
  const appPidSet = new Set(appPids.filter(pid => byPid.has(pid)));
  for (const pid of appPidSet) claimed.add(pid);

  const tabGroups = [];
  for (const tab of tabs) {
    const rootProcess = byPid.get(tab.pid);
    if (!rootProcess) {
      // Вкладка есть в интерфейсе, но её процесс уже завершился. Показываем
      // нулевой вес, а не выкидываем строку: пропавшая строка читается как
      // «вкладки нет», хотя она открыта.
      tabGroups.push({
        owner: OWNER_TAB,
        tabId: tab.tabId,
        projectId: tab.projectId || null,
        title: tab.title || '',
        kind: tab.kind || null,
        pid: tab.pid,
        alive: false,
        selfBytes: 0,
        toolsBytes: 0,
        totalBytes: 0,
        selfCpu: null,
        toolsCpu: null,
        totalCpu: null,
        tools: [],
      });
      continue;
    }

    // Тот же процесс уже приписан другой вкладке. Так бывает, когда две
    // вкладки смотрят на одну сессию. Считать его вес повторно нельзя —
    // итог в шапке раздуется на величину дубля.
    if (claimed.has(rootProcess.pid)) {
      tabGroups.push({
        owner: OWNER_TAB,
        tabId: tab.tabId,
        projectId: tab.projectId || null,
        title: tab.title || '',
        kind: tab.kind || null,
        pid: rootProcess.pid,
        alive: true,
        sharedWithOtherTab: true,
        selfBytes: 0,
        toolsBytes: 0,
        totalBytes: 0,
        selfCpu: null,
        toolsCpu: null,
        totalCpu: null,
        tools: [],
        otherBytes: 0,
        toolCount: 0,
      });
      continue;
    }

    claimed.add(rootProcess.pid);
    const descendants = collectDescendants(rootProcess.pid, childrenIndex, claimed);

    // Инструмент часто запускается через обёртку (`npm exec …` → node), и в
    // дереве это два-три процесса подряд. Показывать их отдельными строками —
    // значит трижды назвать один и тот же инструмент. Поэтому строкой
    // становится только верхний инструмент цепочки, а вложенные складываются
    // в его вес.
    const descendantPids = new Set(descendants.map(item => item.pid));
    const parentByPid = new Map(descendants.map(item => [item.pid, item.ppid]));

    const hasToolAncestor = (item) => {
      let currentPpid = parentByPid.get(item.pid);
      const visited = new Set([item.pid]);
      while (currentPpid !== undefined && descendantPids.has(currentPpid) && !visited.has(currentPpid)) {
        visited.add(currentPpid);
        const ancestor = byPid.get(currentPpid);
        if (ancestor && isToolProcess(ancestor)) return true;
        currentPpid = parentByPid.get(currentPpid);
      }
      return false;
    };

    const toolRoots = descendants.filter(item => isToolProcess(item) && !hasToolAncestor(item));

    // Локальный обход внутри уже собранного поддерева: он ничего не «занимает»
    // повторно, только суммирует вес инструмента вместе с его обёртками.
    const localChildren = new Map();
    for (const item of descendants) {
      if (!localChildren.has(item.ppid)) localChildren.set(item.ppid, []);
      localChildren.get(item.ppid).push(item);
    }
    const subtreeOf = (rootPid) => {
      const collected = [];
      const stack = [rootPid];
      const seen = new Set([rootPid]);
      while (stack.length > 0) {
        const currentPid = stack.pop();
        for (const child of localChildren.get(currentPid) || []) {
          if (seen.has(child.pid)) continue;
          seen.add(child.pid);
          collected.push(child);
          stack.push(child.pid);
        }
      }
      return collected;
    };

    const accountedByTools = new Set();
    const toolRows = toolRoots.map(item => {
      const group = [item, ...subtreeOf(item.pid)];
      for (const member of group) accountedByTools.add(member.pid);
      return {
        pid: item.pid,
        label: describeTool(item),
        bytes: sumFootprint(group),
        cpu: sumCpu(group, cpuByPid),
      };
    }).sort((a, b) => b.bytes - a.bytes);

    // Всё остальное поддерево (оболочки, обёртки без инструмента внутри) —
    // не отдельные строки, а «прочее» внутри вкладки.
    const helpers = descendants.filter(item => !accountedByTools.has(item.pid));

    const selfBytes = rootProcess.footprintBytes || 0;
    const toolsOnlyBytes = toolRows.reduce((total, row) => total + row.bytes, 0);
    const helpersBytes = sumFootprint(helpers);

    const selfCpu = cpuByPid ? (cpuByPid.get(rootProcess.pid) ?? null) : null;
    const toolsCpu = sumCpu(descendants, cpuByPid);

    tabGroups.push({
      owner: OWNER_TAB,
      tabId: tab.tabId,
      projectId: tab.projectId || null,
      title: tab.title || '',
      kind: tab.kind || null,
      pid: rootProcess.pid,
      alive: true,
      selfBytes,
      toolsBytes: toolsOnlyBytes + helpersBytes,
      totalBytes: selfBytes + toolsOnlyBytes + helpersBytes,
      selfCpu,
      toolsCpu,
      totalCpu: (selfCpu === null && toolsCpu === null)
        ? null
        : (selfCpu || 0) + (toolsCpu || 0),
      tools: toolRows,
      otherBytes: helpersBytes,
      toolCount: toolRows.length,
    });
  }

  // Процессы самого приложения — отдельной группой: они не принадлежат ни одной
  // вкладке, но это вторая по величине статья расхода, и без неё итог в шапке
  // не сойдётся с Activity Monitor.
  const appProcesses = [...appPidSet].map(pid => byPid.get(pid)).filter(Boolean);

  // Окон отрисовки бывает несколько (главное окно, плавающий терминал и т.п.).
  // Две одинаковые строки «Отрисовка окна» неразличимы, поэтому одноимённые
  // складываем в одну с указанием количества.
  const appRowsByLabel = new Map();
  for (const item of appProcesses) {
    const label = describeAppProcess(item);
    const existing = appRowsByLabel.get(label);
    const cpu = cpuByPid ? (cpuByPid.get(item.pid) ?? null) : null;
    if (existing) {
      existing.bytes += item.footprintBytes || 0;
      existing.count += 1;
      if (cpu !== null) existing.cpu = (existing.cpu || 0) + cpu;
    } else {
      appRowsByLabel.set(label, {
        pid: item.pid,
        label,
        bytes: item.footprintBytes || 0,
        cpu,
        count: 1,
      });
    }
  }
  const appRows = [...appRowsByLabel.values()].sort((a, b) => b.bytes - a.bytes);

  // Брошенные: инструменты, чья сессия умерла, а они остались под системным
  // корнем. Общие служебные процессы сюда не попадают — их убивать нельзя.
  const orphans = [];
  const sharedServices = [];
  for (const item of processes) {
    if (claimed.has(item.pid)) continue;
    if (!isToolProcess(item) && !isSharedService(item)) continue;
    if (item.ppid !== 1) continue;

    const row = {
      pid: item.pid,
      label: describeTool(item),
      bytes: item.footprintBytes || 0,
      cpu: cpuByPid ? (cpuByPid.get(item.pid) ?? null) : null,
    };
    if (isSharedService(item)) sharedServices.push(row);
    else orphans.push(row);
  }
  orphans.sort((a, b) => b.bytes - a.bytes);

  const projectTabs = projectId
    ? tabGroups.filter(group => group.projectId === projectId)
    : tabGroups;
  const otherTabs = projectId
    ? tabGroups.filter(group => group.projectId !== projectId)
    : [];

  return {
    scannedAt: snapshot ? snapshot.scannedAt : null,
    durationMs: snapshot ? snapshot.durationMs : null,
    hasCpu: !!cpuByPid,
    projectTabs,
    otherTabs,
    app: {
      owner: OWNER_APP,
      totalBytes: appRows.reduce((total, row) => total + row.bytes, 0),
      totalCpu: cpuByPid ? appRows.reduce((total, row) => total + (row.cpu || 0), 0) : null,
      rows: appRows,
    },
    orphans: {
      owner: OWNER_ORPHAN,
      count: orphans.length,
      totalBytes: orphans.reduce((total, row) => total + row.bytes, 0),
      rows: orphans,
    },
    sharedServices,
    totals: {
      projectBytes: projectTabs.reduce((total, group) => total + group.totalBytes, 0),
      otherBytes: otherTabs.reduce((total, group) => total + group.totalBytes, 0),
    },
  };
}

/** Понятное имя процесса приложения вместо `Noted Terminal Helper (Renderer)`. */
function describeAppProcess(item) {
  const source = item.execPath || item.name || '';
  if (/Helper \(Renderer\)/.test(source)) return 'Отрисовка окна';
  if (/Helper \(GPU\)/.test(source)) return 'Графика';
  if (/Helper/.test(source)) return 'Вспомогательный';
  if (/claude-agent-sdk/.test(source)) return 'Claude внутри приложения';
  return 'Ядро приложения';
}

module.exports = {
  groupProcessMetrics,
  describeTool,
  describeAppProcess,
  isToolProcess,
  isSharedService,
  OWNER_TAB,
  OWNER_APP,
  OWNER_ORPHAN,
  OWNER_OTHER,
};
