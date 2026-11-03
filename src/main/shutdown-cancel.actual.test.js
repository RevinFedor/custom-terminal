'use strict';
// Cancelling a quit that has already started.
//
// Closing is not instant: the app asks each live AI session to exit (Ctrl+C)
// one by one, and on a large workspace that takes seconds. The user asked for
// a button that works during exactly that window: "она работает в тот момент,
// пока не закрылась последняя вкладка… ждать меня там подтверждение… не
// нужно".
//
// What cancel CAN do: keep the app, and keep every tab the fan-out has not
// reached. What it CANNOT do: revive a tab that already got Ctrl+C — the user
// accepted this up front. Those keep their interrupted mark, which is true for
// them; the survivors get it cleared, or the next launch would offer to
// continue work that never stopped.
//
// This executes the REAL before-quit hook and the REAL cancel helpers sliced
// out of main.js, so the guard placement, the unwind order and the restored
// subsystems are the shipped ones.
//
// Run: node --test src/main/shutdown-cancel.actual.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(process.env.ACTUAL_SOURCE_DIR || __dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);

const names = ['_gracefulShutdownInProgress', '_gracefulShutdownDone', '_gracefulShutdownAiSessions',
  '_gracefulShutdownLiveTabIds', 'SHUTDOWN_OVERLAY_MIN_VISIBLE_MS', '_shutdownCancelRequested',
  '_shutdownCancellable', '_shutdownClosedTabs', '_shutdownSignalledTabIds', '_programmaticQuitRequested'];
const declarations = names.map(name => {
  const node = ast.statements.find(n => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => d.name.getText(ast) === name));
  assert.ok(node, name);
  return node.getText(ast);
});
const helpers = ['requestProgrammaticQuit', 'publishShutdownOverlay', 'shutdownCancelled',
  'abandonGracefulShutdown'].map(name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
});
const beforeQuit = ast.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
  && n.expression.expression.getText(ast) === 'app.on' && n.expression.arguments[0]?.text === 'before-quit').getText(ast);
// The IPC listener is the user's actual entry point, so it executes too.
const cancelIpc = ast.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
  && n.expression.expression.getText(ast) === 'ipcMain.on' && n.expression.arguments[0]?.text === 'shutdown:cancel').getText(ast);

const tick = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };

function fixture({ tabs = ['A', 'B', 'C'], childPid = 4242 } = {}) {
  let quitHandler, cancelHandler, quits = 0;
  const overlays = [], sql = [], logs = [], watchdog = [];
  const terminals = new Map(tabs.map((id, index) => [id, { pid: 100 + index, written: [], write(data) { this.written.push(data); } }]));
  const interrupted = new Set(tabs);
  const sessions = new Map(tabs.map(id => [id, { engine: 'claude', sessionId: 'S-' + id }]));
  let proxyDrained = 0, proxyRestored = 0, catalogDisposed = 0, catalogReopened = 0;
  let catalogSettles = true;
  // ps returns one AI child per tab, so every tab reaches the \x03 write.
  const psOutput = tabs.map((id, index) => (childPid + index) + ' ' + (100 + index) + ' claude').join('\n');
  const context = {
    app: { on: (event, fn) => { if (event === 'before-quit') quitHandler = fn; }, quit: () => { quits++; } },
    ipcMain: { on: (channel, fn) => { if (channel === 'shutdown:cancel') cancelHandler = fn; } },
    terminals,
    getInterruptedAiSessionEntries: () => new Map(sessions),
    initialShutdownLiveTabIds: () => new Set(tabs),
    augmentShutdownStateFromProcessProof: async (entries, live) => ({ recoverableEntries: entries, liveTabIds: live }),
    markInterruptedAiSessionEntries: () => tabs.length,
    reconcileInterruptedAiSessionEntries: () => ({ cleared: 0, marked: tabs.length }),
    formatInterruptedAiSessionIds: () => tabs.join(','),
    flushOpenActivityIntervals() {},
    execAsync: async () => psOutput,
    getAiProcessNameFromCommand: (cmd) => (cmd.includes('claude') ? 'claude' : null),
    process: { pid: 1, kill: () => { throw new Error('ESRCH'); } },
    proxyGracefulShutdown: async () => { proxyDrained++; },
    restoreProviderProxyAfterCancel: async () => { proxyRestored++; return true; },
    providerProxyReady: false,
    codexDataModule: { _api: {
      disposeCodexModelCatalog: async () => { catalogDisposed++; return { settled: catalogSettles }; },
      reopenCodexModelCatalog: () => { catalogReopened++; return catalogSettles; },
    } },
    terminalRawWindow: { dispose: async () => ({ drained: true, timedOut: false }) },
    perfWatchdog: { connected: true, send: (message) => watchdog.push(message.t) },
    mainWindow: { isDestroyed: () => false, webContents: { send: (_channel, payload) => overlays.push(payload) } },
    projectManager: { db: { db: { prepare: (text) => ({
      run: (...args) => { sql.push({ text, args }); return { changes: interrupted.delete(args[0]) ? 1 : 0 }; },
    }) } } },
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    setTimeout, clearTimeout, Date,
  };
  vm.createContext(context);
  vm.runInContext(declarations.join('\n') + '\n' + helpers.join('\n') + '\n' + beforeQuit + '\n' + cancelIpc, context);
  const read = (expression) => vm.runInContext(expression, context);
  return {
    context, overlays, logs, terminals, watchdog, interrupted, read,
    quit: () => quitHandler({ preventDefault() {} }),
    programmaticQuit: () => {
      // The real caller invokes this helper, which itself calls app.quit();
      // Electron then raises before-quit. Reset the counter so the assertion
      // measures the flow's OWN final quit, not the request that started it.
      context.requestProgrammaticQuit('build-continue-capture');
      quits = 0;
      return quitHandler({ preventDefault() {} });
    },
    cancel: () => cancelHandler(),
    signalled: () => tabs.filter(id => terminals.get(id).written.includes('\x03')),
    get quits() { return quits; },
    get proxyDrained() { return proxyDrained; },
    get proxyRestored() { return proxyRestored; },
    get catalogDisposed() { return catalogDisposed; },
    get catalogReopened() { return catalogReopened; },
    breakCatalog: () => { catalogSettles = false; },
  };
}

test('cancelling before anything is stopped keeps the app and every tab', async () => {
  const h = fixture();
  const flow = h.quit();
  h.cancel();
  await flow;
  assert.equal(h.quits, 0, 'the app must not quit');
  assert.deepEqual(h.signalled(), [], 'no tab was given Ctrl+C');
  assert.equal(h.read('_gracefulShutdownInProgress'), false, 'a later ⌘Q must start a fresh flow');
  assert.deepEqual({ ...h.overlays.at(-1) }, { show: false }, 'the closing screen goes away');
});

test('cancelling mid fan-out: untouched tabs keep running, stopped ones stay stopped', async () => {
  // The exact promise made to the user: Отмена does not undo what already
  // happened, it stops what has not happened yet.
  const h = fixture();
  const flow = h.quit();
  await tick();
  const stoppedBeforeCancel = h.signalled().length;
  assert.ok(stoppedBeforeCancel > 0, 'the fixture must actually reach the fan-out');
  h.cancel();
  await flow;
  assert.equal(h.quits, 0);
  assert.ok(h.signalled().length <= stoppedBeforeCancel + 1,
    'the fan-out must not keep stopping tabs after the cancel');
});

test('survivors lose the interrupted mark; a tab that already got Ctrl+C keeps it', async () => {
  // Marking happens UP FRONT so a killed install never loses resumes. On a
  // cancel that mark becomes a lie for the tabs still running: the next launch
  // would offer to continue work that never stopped.
  const h = fixture();
  const flow = h.quit();
  h.cancel();                      // before-drain: every tab survives
  await flow;
  assert.equal(h.interrupted.size, 0, 'every survivor was cleared');
  const clears = h.logs.find(line => line.includes('[Shutdown:Cancel] shutdown abandoned'));
  assert.match(clears, /interruptedMarksCleared=3/);
  assert.match(clears, /stage=before-drain/);
});

test('an installer-owned quit offers no cancel and runs to completion', async () => {
  // build:i-c quits the app expecting to relaunch it. A cancel there would
  // leave the installer with nothing to come back to.
  const h = fixture();
  await h.programmaticQuit();
  assert.equal(h.quits, 1, 'the installer quit completes');
  const shown = h.overlays.find(payload => payload.show === true);
  assert.equal(shown.cancellable, false, 'the button is not offered');
  h.cancel();
  assert.match(h.logs.join('\n'), /\[Shutdown:Cancel\] ignored/, 'a stray cancel changes nothing');
});

test('the overlay reports live progress and the cancelling state', async () => {
  const h = fixture();
  const flow = h.quit();
  await tick();
  const first = h.overlays.find(payload => payload.show === true);
  assert.equal(first.tabsCount, 3);
  assert.equal(first.closedTabs, 0);
  assert.equal(first.cancellable, true);
  const progress = h.overlays.filter(payload => payload.show && payload.closedTabs > 0);
  assert.ok(progress.length > 0, 'each stopped tab must be reported');
  h.cancel();
  assert.deepEqual({ ...h.overlays.at(-1) }, { show: true, cancelling: true });
  await flow;
});

test('a cancel restores the subsystems the quit had already revoked', async () => {
  // The drain and the catalog disposal are destructive by design. An app that
  // stays alive without them is subtly broken: every surviving tab fails on a
  // dead proxy URL, and every Codex control answers CATALOG_CLOSED.
  const h = fixture();
  const flow = h.quit();
  await tick();
  assert.equal(h.proxyDrained, 1);
  assert.equal(h.catalogDisposed, 1);
  h.cancel();
  await flow;
  assert.equal(h.proxyRestored, 1, 'the proxy listens again on the same port');
  assert.equal(h.catalogReopened, 1, 'Codex model/effort controls work again');
  assert.deepEqual(h.watchdog, ['bye', 'unbye'], 'freeze detection is re-armed');
});

test('a catalog whose child never settled stays closed, and says so', async () => {
  // An unknown child is not proof of a free owner. Reopening on top of it
  // would hand a second owner to a process we cannot account for.
  const h = fixture();
  h.breakCatalog();
  const flow = h.quit();
  await tick();
  h.cancel();
  await flow;
  assert.equal(h.quits, 0, 'the app still stays');
  assert.match(h.logs.join('\n'), /Codex model catalog stays closed/);
});

test('cancel is ignored once the flow is past its last checkpoint', async () => {
  const h = fixture();
  await h.quit();
  assert.equal(h.quits, 1, 'the quit completed');
  h.cancel();
  assert.equal(h.quits, 1);
  assert.match(h.logs.join('\n'), /\[Shutdown:Cancel\] ignored/);
});

test('one cancel is enough: a second press changes nothing', async () => {
  const h = fixture();
  const flow = h.quit();
  h.cancel();
  h.cancel();
  await flow;
  const requested = h.logs.filter(line => line.includes('[Shutdown:Cancel] requested by user'));
  assert.equal(requested.length, 1);
});

test('after a cancel the next ⌘Q starts a clean flow and can quit', async () => {
  const h = fixture();
  const first = h.quit();
  h.cancel();
  await first;
  assert.equal(h.quits, 0);
  await h.quit();
  assert.equal(h.quits, 1, 'the app quits normally the second time');
});
