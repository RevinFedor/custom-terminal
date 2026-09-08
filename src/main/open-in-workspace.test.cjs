'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.join(__dirname, 'web-server.js');
const text = fs.readFileSync(file, 'utf8');
const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
assert.equal(source.parseDiagnostics.length, 0);

function functionText(name) {
  const node = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `function ${name} exists`);
  return node.getText(source);
}

function placementHarness({ spaces, restored = true } = {}) {
  const calls = [];
  const timers = [{ id: 'stop' }, { id: 'close' }];
  const run = { runId: 'run-A', tabId: 'tab-A', stopTimer: timers[0], closeTimer: timers[1],
    autoStopAt: 1, autoCloseAt: 2, cleanupCancelled: false };
  const context = vm.createContext({
    Date,
    externalRunByTabId: new Map([['tab-A', 'run-A']]),
    externalRuns: new Map([['run-A', run]]),
    cleanOptionalString: (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    ensureExplicitAgentTabOpen: async () => ({ descriptor: { projectId: '__noted_inbox__', toolType: 'codex' }, restored }),
    bridgeRequest: async (action, payload) => {
      calls.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
      if (action === 'describeWorkspaceLayout') return { spaces: spaces || [{
        id: 'space-docs', name: 'Докс', windows: [
          { index: 0, windowRef: 'ww1:docs:0:fingerprint', tabs: [{ tabId: 'left' }, { tabId: 'middle' }] },
          { index: 1, windowRef: 'ww1:docs:1:fingerprint', tabs: [] },
        ],
      }] };
      return { ok: true, shownTabId: 'tab-A', insertedAt: 2 };
    },
    clearExternalRunTimer: (target, key) => { calls.push({ action: 'clear:' + key }); target[key] = null; },
    setExternalRunMeta: (tabId, meta) => calls.push({ action: 'meta', tabId, meta }),
    revealTerminalApplicationWindow: () => ({ ok: true, revealed: false, e2eSuppressed: true }),
  });
  vm.runInContext(functionText('openAgentTabInWorkspace'), context);
  return { context, calls, run };
}

test('exact Inbox tab is appended on the right of the first Docs window and revealed', async () => {
  assert.match(text, /\/open-in-workspace\$\/\);/);
  assert.match(text, /openAgentTabInWorkspace\(\{/);
  const h = placementHarness();
  const result = await h.context.openAgentTabInWorkspace({ tabId: 'tab-A', workspaceName: 'докс' });
  assert.equal(result.ok, true);
  assert.equal(result.restored, true);
  assert.equal(result.spaceId, 'space-docs');
  const commit = h.calls.find((call) => call.action === 'commitWorkspaceWindowAction');
  assert.deepEqual(commit.payload, {
    sourceTabId: 'tab-A',
    windowTarget: {
      spaceId: 'space-docs', windowRef: 'ww1:docs:0:fingerprint', mode: 'same-window', insertIndex: 2, reveal: true,
    },
    entries: [{ projectId: '__noted_inbox__', tabId: 'tab-A' }],
    show: true, focus: true, reveal: true, moveExisting: true,
  });
  assert.equal(h.run.cleanupCancelled, true);
  assert.equal(h.run.stopTimer, null);
  assert.equal(h.run.closeTimer, null);
  assert.equal(h.run.autoStopAt, null);
  assert.equal(h.run.autoCloseAt, null);
  assert.match(text, /findOrchestrationTabDescriptor\(tabId\)\?\.externalRun\?\.openedInTerminalAt/);
  assert.match(text, /if \(!run \|\| !run\.tabId \|\| run\.openedInTerminalAt\) return/);
});

test('missing and ambiguous workspace names fail without a placement mutation', async () => {
  for (const spaces of [
    [{ id: 'other', name: 'Main', windows: [] }],
    [{ id: 'a', name: 'Докс', windows: [] }, { id: 'b', name: 'докс', windows: [] }],
  ]) {
    const h = placementHarness({ spaces });
    await assert.rejects(
      () => h.context.openAgentTabInWorkspace({ tabId: 'tab-A', workspaceName: 'Докс' }),
      (error) => ['workspace_not_found', 'workspace_ambiguous'].includes(error.code),
    );
    assert.equal(h.calls.some((call) => call.action === 'commitWorkspaceWindowAction'), false);
  }
});

test('background E2E reveal never shows or focuses an OS window', () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    getTitle: () => 'Noted Terminal',
    webContents: { getURL: () => 'file:///test/index.html' },
    show: () => calls.push('show'), moveTop: () => calls.push('moveTop'), focus: () => calls.push('focus'),
  };
  const context = vm.createContext({
    BrowserWindow: { getAllWindows: () => [win] },
    process: { env: { NOTED_E2E_WINDOWED: '1' }, platform: 'darwin' },
    app: { focus: () => calls.push('app.focus') },
  });
  vm.runInContext(functionText('revealTerminalApplicationWindow'), context);
  const result = context.revealTerminalApplicationWindow();
  assert.equal(result.e2eSuppressed, true);
  assert.deepEqual(calls, []);
});

test('normal reveal activates the exact Noted Terminal window', () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    getTitle: () => 'Noted Terminal',
    webContents: { getURL: () => 'file:///app/index.html' },
    show: () => calls.push('show'), moveTop: () => calls.push('moveTop'), focus: () => calls.push('focus'),
  };
  const context = vm.createContext({
    BrowserWindow: { getAllWindows: () => [win] },
    process: { env: {}, platform: 'darwin' },
    app: { focus: () => calls.push('app.focus') },
  });
  vm.runInContext(functionText('revealTerminalApplicationWindow'), context);
  const result = context.revealTerminalApplicationWindow();
  assert.equal(result.revealed, true);
  assert.deepEqual(calls, ['show', 'moveTop', 'app.focus', 'focus']);
});
