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
  // MCP-хаб и его дети: один общий комплект MCP-серверов на все AI-вкладки.
  // Живут отдельно от сессий (переживают рестарт приложения) — «брошенными»
  // не считаются, убивать их из панели нельзя: инструменты пропадут у всех
  // вкладок разом. Управление — в чипе MCP-хаба (рестарт per-server).
  /\/mcp-hub\.js$/,
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

/**
 * Сам агент вкладки (Codex/Claude/Gemini). Корневой процесс вкладки — это
 * оболочка терминала (zsh), а не агент: агент запускается командой внутри неё
 * и оказывается среди потомков. Без отдельного распознавания панель писала
 * «сама сессия 3 МБ, прочее 944 МБ» — «сессией» называлась оболочка, а весь
 * реальный вес агента прятался в безымянном «прочем» (юзер, 2026-09-12).
 *
 * Шаблоны ловят всю цепочку запуска (node-обёртка → бинарь → code-mode-host):
 * каждое её звено само подходит под шаблон и складывается в одну строку.
 */
const AGENT_PATTERNS = [
  [/@openai\/codex|codex-code-mode-host|(^|[\\/])codex(\s|$)/, 'Codex'],
  [/(^|[\\/])claude(\s|$)/, 'Claude'],
  [/(^|[\\/])gemini(\s|$)/, 'Gemini'],
];

function describeAgent(item) {
  for (const [pattern, label] of AGENT_PATTERNS) {
    if (pattern.test(item.commandLine || '') || pattern.test(item.execPath || '')) return label;
  }
  return null;
}

/**
 * Прозрачные оболочки (sh -c, login): сами по себе ничего не значат и весят
 * мегабайты, но через них запускается настоящий процесс. Такую оболочку не
 * называем строкой — её потомки классифицируются сами, а её собственный вес
 * уходит в «прочее».
 */
const SHELL_WRAPPER_PATTERNS = [
  /(^|[\\/])-?(zsh|bash|sh|dash|fish|login|env|script|caffeinate)(\s|$)/,
];

function isShellWrapper(item) {
  // Явно запущенный shell-скрипт — задача со своим поддеревом. `sh -c …`
  // остаётся прозрачной обёрткой: настоящая команда будет её потомком.
  const command = item.commandLine || '';
  const directScript = /^\s*(?:\S*\/)?-?(?:zsh|bash|sh|dash|fish)\s+(?:-[A-Za-z]+\s+)*(?:--\s+)?(?:"[^"]+\.sh"|'[^']+\.sh'|\S+\.sh)(?:\s|$)/.test(command);
  if (directScript && !/(?:^|\s)-[A-Za-z]*c(?:\s|$)/.test(command)) return false;
  return matchesAny(SHELL_WRAPPER_PATTERNS, item.commandLine)
    || matchesAny(SHELL_WRAPPER_PATTERNS, item.execPath)
    || matchesAny(SHELL_WRAPPER_PATTERNS, item.name);
}

/**
 * Команда легче этого порога не заслуживает собственной строки: короткоживущие
 * git/ps на пару мегабайт создавали бы мерцающий список. Всё, что ниже, — в
 * «прочее».
 */
const MIN_COMMAND_ROW_BYTES = 12 * 1024 * 1024;

/**
 * Имя для команды, запущенной во вкладке. Пользователь должен прочитать
 * «npm run dev», а не «node» с путём на сорок символов: по имени он вспоминает,
 * что сам это запускал, и понимает, почему вкладка потяжелела.
 */
function describeCommand(item) {
  const source = item.commandLine || '';

  const runner = source.match(/(?:^|[\\/\s])(npm|pnpm|yarn|bun|npx)(?:-cli\.c?js)?\s+(.+)$/);
  if (runner) {
    const rest = runner[2].trim().split(/\s+/).slice(0, 2).join(' ');
    return (runner[1] + ' ' + rest).trim();
  }

  // Расширение — часть пользовательского смысла: `main` выглядит как
  // безымянный системный процесс, а `main.js` сразу читается как скрипт.
  const script = source.match(/([^\\/\s]+\.(?:mjs|cjs|js|ts|sh))(?:\s|$)/);
  if (script) return script[1];

  // `node /…/node_modules/.bin/vite` — бинарь без расширения: именем служит
  // сам файл, который node запускает. Флаги (`node -e …`) именем не являются.
  const nodeTarget = source.match(/(?:^|[\\/\s])node\s+(\S+)/);
  if (nodeTarget && !nodeTarget[1].startsWith('-')) {
    const base = nodeTarget[1].split('/').pop();
    if (base) return base;
  }

  const appBundle = (item.execPath || '').match(/([^\\/]+)\.app\//);
  if (appBundle) return appBundle[1];

  // Имя берём из команды, а не из пути к файлу: у части программ файл лежит в
  // каталоге версии (у Claude это `…/versions/2.1.269`), и basename пути дал бы
  // «2.1.269» вместо имени.
  const executable = source.trim().split(/\s+/)[0];
  if (executable) {
    const base = executable.split('/').pop();
    if (base) return base;
  }

  return item.name || (item.execPath ? item.execPath.split('/').pop() : 'процесс');
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
        cwd: tab.cwd || null,
        kind: tab.kind || null,
        pid: tab.pid,
        alive: false,
        selfBytes: 0,
        agents: [],
        agentBytes: 0,
        commands: [],
        commandBytes: 0,
        commandTotalBytes: 0,
        commandTotalCpu: null,
        smallCommandBytes: 0,
        smallCommandCpu: null,
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
        cwd: tab.cwd || null,
        kind: tab.kind || null,
        pid: rootProcess.pid,
        alive: true,
        sharedWithOtherTab: true,
        selfBytes: 0,
        agents: [],
        agentBytes: 0,
        commands: [],
        commandBytes: 0,
        commandTotalBytes: 0,
        commandTotalCpu: null,
        smallCommandBytes: 0,
        smallCommandCpu: null,
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

    // Локальный индекс детей внутри уже собранного поддерева.
    const localChildren = new Map();
    for (const item of descendants) {
      if (!localChildren.has(item.ppid)) localChildren.set(item.ppid, []);
      localChildren.get(item.ppid).push(item);
    }

    // Поддерево раскладывается ОДНИМ обходом от корня, а не плоским поиском по
    // шаблонам. Причина — вложенные экземпляры: команда, запущенная во вкладке
    // (npm run dev), поднимает внутри себя целое приложение со своими
    // agent-процессами и инструментами. Плоский поиск приписал бы их «сессии»
    // вкладки, раздув её на чужой гигабайт; обход отдаёт всё поддерево команды
    // ей самой.
    //
    // Правила на каждом процессе, по приоритету:
    //  - внутри уже открытой строки (инструмент/команда) — всё поддерево её;
    //  - инструмент (MCP) — своя строка, обёртки схлопнуты (npm exec → node);
    //  - агент (Codex/Claude/Gemini) — строка «сессия X»; каждое звено цепочки
    //    запуска (node-обёртка → бинарь → code-mode-host) само подходит под
    //    шаблон и складывается в ту же строку по совпадению ярлыка. Агент,
    //    запущенный другим агентом (claude из-под codex), — отдельная строка:
    //    приписать его вес родителю значило бы соврать о том, кто весит;
    //  - прозрачная оболочка (sh -c, login) — не строка: вес в «прочее»,
    //    потомки классифицируются сами;
    //  - остальное — команда, запущенная во вкладке: строка с её именем
    //    («npm run dev»), если тяжелее порога, иначе «прочее».
    const toolBuckets = [];
    const commandBuckets = [];
    const agentRowsByLabel = new Map();
    const helpers = [];
    const classifyStack = [{ pid: rootProcess.pid, bucket: null }];
    while (classifyStack.length > 0) {
      const frame = classifyStack.pop();
      for (const child of localChildren.get(frame.pid) || []) {
        if (frame.bucket) {
          frame.bucket.items.push(child);
          classifyStack.push({ pid: child.pid, bucket: frame.bucket });
          continue;
        }
        if (isToolProcess(child)) {
          const bucket = { root: child, items: [child] };
          toolBuckets.push(bucket);
          classifyStack.push({ pid: child.pid, bucket });
          continue;
        }
        const label = describeAgent(child);
        if (label) {
          const cpu = cpuByPid ? (cpuByPid.get(child.pid) ?? null) : null;
          const existing = agentRowsByLabel.get(label);
          if (existing) {
            existing.bytes += child.footprintBytes || 0;
            existing.count += 1;
            if (cpu !== null) existing.cpu = (existing.cpu || 0) + cpu;
          } else {
            agentRowsByLabel.set(label, {
              pid: child.pid,
              label,
              bytes: child.footprintBytes || 0,
              cpu,
              count: 1,
            });
          }
          classifyStack.push({ pid: child.pid, bucket: null });
          continue;
        }
        if (isShellWrapper(child)) {
          helpers.push(child);
          classifyStack.push({ pid: child.pid, bucket: null });
          continue;
        }
        const bucket = { root: child, items: [child] };
        commandBuckets.push(bucket);
        classifyStack.push({ pid: child.pid, bucket });
      }
    }

    const toolRows = toolBuckets.map(bucket => ({
      pid: bucket.root.pid,
      label: describeTool(bucket.root),
      bytes: sumFootprint(bucket.items),
      cpu: sumCpu(bucket.items, cpuByPid),
    })).sort((a, b) => b.bytes - a.bytes);

    const agentRows = [...agentRowsByLabel.values()].sort((a, b) => b.bytes - a.bytes);
    const agentBytes = agentRows.reduce((total, row) => total + row.bytes, 0);

    // Команда легче порога не заслуживает строки: короткоживущие git/ps на
    // пару мегабайт мерцали бы в списке. Их вес уходит в «прочее».
    const commandRows = [];
    const commandItems = [];
    const smallCommandItems = [];
    for (const bucket of commandBuckets) {
      commandItems.push(...bucket.items);
      const bytes = sumFootprint(bucket.items);
      if (bytes < MIN_COMMAND_ROW_BYTES) {
        smallCommandItems.push(...bucket.items);
        helpers.push(...bucket.items);
        continue;
      }
      commandRows.push({
        pid: bucket.root.pid,
        label: describeCommand(bucket.root),
        bytes,
        cpu: sumCpu(bucket.items, cpuByPid),
        count: bucket.items.length,
      });
    }
    commandRows.sort((a, b) => b.bytes - a.bytes);
    const commandBytes = commandRows.reduce((total, row) => total + row.bytes, 0);
    // Порог скрывает строку, но не расход команды. Отдельный итог включает
    // маленькие команды; прежние commandBytes/otherBytes сохраняют свою
    // раскладку, чтобы общий totalBytes не посчитал их дважды.
    const commandTotalBytes = sumFootprint(commandItems);
    const smallCommandBytes = sumFootprint(smallCommandItems);

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
      cwd: tab.cwd || null,
      kind: tab.kind || null,
      pid: rootProcess.pid,
      alive: true,
      selfBytes,
      agents: agentRows,
      agentBytes,
      commands: commandRows,
      commandBytes,
      commandTotalBytes,
      commandTotalCpu: cpuByPid && commandItems.length === 0 ? 0 : sumCpu(commandItems, cpuByPid),
      smallCommandBytes,
      smallCommandCpu: cpuByPid && smallCommandItems.length === 0 ? 0 : sumCpu(smallCommandItems, cpuByPid),
      toolsBytes: toolsOnlyBytes + agentBytes + commandBytes + helpersBytes,
      totalBytes: selfBytes + toolsOnlyBytes + agentBytes + commandBytes + helpersBytes,
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
    totals: (() => {
      const projectBytes = projectTabs.reduce((total, group) => total + group.totalBytes, 0);
      const otherBytes = otherTabs.reduce((total, group) => total + group.totalBytes, 0);
      const commandGroups = tabGroups.filter(group => group.commandTotalBytes > 0);
      return {
        projectBytes,
        otherBytes,
        commandBytes: tabGroups.reduce((total, group) => total + group.commandTotalBytes, 0),
        commandCpu: !cpuByPid ? null : commandGroups.length === 0 ? 0
          : commandGroups.some(group => group.commandTotalCpu !== null)
            ? commandGroups.reduce((total, group) => total + (group.commandTotalCpu || 0), 0)
            : null,
        // Итог считается ЗДЕСЬ, а не складывается заново у каждого потребителя.
        // Чип в шапке и подпись внизу панели показывают одно и то же число, и
        // две копии формулы разъезжаются на первом же новом слагаемом.
        allBytes: projectBytes
          + otherBytes
          + appRows.reduce((total, row) => total + row.bytes, 0)
          + orphans.reduce((total, row) => total + row.bytes, 0),
      };
    })(),
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
  describeAgent,
  describeCommand,
  describeAppProcess,
  isToolProcess,
  isSharedService,
  OWNER_TAB,
  OWNER_APP,
  OWNER_ORPHAN,
  OWNER_OTHER,
};
