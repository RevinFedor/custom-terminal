'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const source = fs.readFileSync(path.join(process.env.ACTUAL_SOURCE_DIR || __dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const names = ['_gracefulShutdownInProgress', '_gracefulShutdownDone', '_gracefulShutdownAiSessions',
  '_gracefulShutdownLiveTabIds', 'SHUTDOWN_OVERLAY_MIN_VISIBLE_MS'];
const declarations = names.map(name => ast.statements.find(n => ts.isVariableStatement(n)
  && n.declarationList.declarations.some(d => d.name.getText(ast) === name)).getText(ast));
const callback = ast.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
  && n.expression.expression.getText(ast) === 'app.on' && n.expression.arguments[0]?.text === 'before-quit').getText(ast);
const tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

function fixture(dispose) {
  let handler, quits = 0, prevented = 0; const warnings = [];
  const context = { app: { on: (_event, fn) => { handler = fn; }, quit: () => { quits++; } },
    getInterruptedAiSessionEntries: () => new Map(), initialShutdownLiveTabIds: () => new Set(),
    perfWatchdog: null, projectManager: null, mainWindow: null, terminals: new Map(),
    flushOpenActivityIntervals() {}, augmentShutdownStateFromProcessProof: async (entries, tabs) => ({ recoverableEntries: entries, liveTabIds: tabs }),
    reconcileInterruptedAiSessionEntries: () => ({ cleared: 0, marked: 0 }), formatInterruptedAiSessionIds: () => '',
    proxyGracefulShutdown: async () => {}, terminalRawWindow: { dispose },
    console: { log() {}, error: x => warnings.push(x), warn: x => warnings.push(x) } };
  vm.runInNewContext(declarations.join('\n') + '\n' + callback, context);
  return { start: () => handler({ preventDefault: () => { prevented++; } }),
    get quits() { return quits; }, get prevented() { return prevented; }, warnings };
}

test('actual Main before-quit owns and joins raw shutdown once, before allowing app.quit', async () => {
  let release, drains = 0;
  const held = new Promise(resolve => { release = resolve; });
  const h = fixture(() => { drains++; return held; });
  const first = h.start(); await tick();
  assert.equal(drains, 1, 'will-quit cannot join asynchronous persistence');
  assert.equal(h.quits, 0);
  await h.start(); assert.equal(h.prevented, 2); assert.equal(drains, 1);
  release({ drained: true, timedOut: false }); await first;
  assert.equal(h.quits, 1);
  await h.start(); assert.equal(h.prevented, 2); assert.equal(drains, 1);
});

test('actual Main bounded raw timeout reports incomplete and still completes its owned graceful quit', async () => {
  const h = fixture(async () => ({ drained: false, timedOut: true }));
  await h.start(); assert.equal(h.quits, 1);
  assert.ok(h.warnings.some(x => x.includes('shutdown artifact incomplete')));
});
