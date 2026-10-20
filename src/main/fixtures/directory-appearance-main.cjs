'use strict';

// Actual Main declarations, actual card producer and settings IPC handlers.
// Physical runtime/owner, Electron IPC transport and existing wake debounce are
// controlled ports. No Electron process, provider, real user data or timer job.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { executionRefForInput } = require('../../shared/workflow-directory-catalog.cjs');
const mainDir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(mainDir, 'main.js'), 'utf8');
const tree = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
function mainCards(database, { sourceText = source } = {}) {
  const ast = sourceText === source ? tree : ts.createSourceFile('main.js', sourceText, ts.ScriptTarget.Latest, true);
  const timers = [], frames = [], handlers = new Map(); let ownerCurrent = true, runtimeCalls = 0;
  const scope = vm.createContext({ require, path, srcMainDir: mainDir, projectManager: { db: database }, projectCardSignals: null,
    appRuntimeIdentity: { instanceId: 'appearance-main-fixture' }, console: { log() {}, warn() {}, error() {} },
    terminalCommandState: new Map(), tabWorkContext: { summaries: ids => Object.fromEntries(ids.map(id =>
      [id, { known: true, revision: 0, count: 0 }])) },
    captureWorkflowDirectoryRuntime: entries => {
      runtimeCalls++;
      return { tabs: entries.map(entry => ({ tabId: entry.tabId, executionScope: executionRefForInput(entry).subject,
        liveKnown: false, live: null })), isCurrent: () => ownerCurrent };
    },
    projectActivityBroadcastTimer: null, projectLayoutChangedIds: new Set(), projectOrderChanged: false, idleSessionStopService: null,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    writeAppStateWithDiagnostics: require('../app-state-write-diagnostics').writeAppStateWithDiagnostics,
  });
  const originalRequire = scope.require;
  scope.require = name => name === path.join(mainDir, 'web-server') ? {
    invalidateTabActivity() {}, broadcastProjectActivity: reason => frames.push({ reason, cards: scope.projectCardSignals.wake() }),
  } : originalRequire(name);
  for (const name of ['getTaskStatusCatalog', 'readMainCardFast', 'getProjectCardSignals', 'noteProjectCardSignalsChanged',
    'noteCardSignalSettingsChanged', 'scheduleProjectActivityBroadcast', 'captureWorkflowDirectoryCards']) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (!node) throw Error('Missing actual Main declaration: ' + name);
    vm.runInContext(node.getText(ast), scope);
  }
  for (const name of ['app:setState', 'app:setStateSync', 'app:mirrorLocalStorageSync']) {
    const node = ast.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
      && n.expression.arguments[0]?.text === name);
    if (!node) throw Error('Missing actual settings handler: ' + name);
    vm.runInContext(node.getText(ast), scope);
  }
  return { capture: entries => scope.captureWorkflowDirectoryCards(entries),
    service: () => scope.getProjectCardSignals(), scope, timers, frames, handlers,
    replaceOwner: () => { ownerCurrent = false; }, runtimeCalls: () => runtimeCalls,
    flush: () => { for (const timer of timers.splice(0)) timer.fn(); } };
}
module.exports = { mainCards };
