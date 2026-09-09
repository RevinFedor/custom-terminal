'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { waitForCodexRewindActionReady } = require('./codex-rewind-action-ready');
const { inspectCodexInputReadyTextCore, selectCodexCurrentInteractiveFrameText } = require('./codex-tui-readiness');

const composer = '\n› Ask Codex to do anything\n\n  gpt-5.6-luna low · Context 1% used';
const startup = '• Starting MCP servers (9/10): openaiDeveloperDocs\n  esc to interrupt\n' + composer;
const inspectReady = snapshot => {
  const text = selectCodexCurrentInteractiveFrameText(snapshot.lines);
  return inspectCodexInputReadyTextCore(text, '', {
    requireSyncMarker: false,
    blockers: /Starting MCP servers/.test(text) ? ['mcp-startup'] : [],
  });
};
function fixture(text = startup) {
  const listeners = new Set();
  let current = true;
  let snapshot;
  let cancel;
  const cancelPromise = new Promise(resolve => { cancel = resolve; });
  const frame = (value, committed = true) => {
    snapshot = { success: true, authoritativeFrameCommitted: committed,
      lines: value.split('\n').map((text, row) => ({ text, row })) };
    for (const listener of listeners) listener();
  };
  frame(text);
  return {
    frame, cancel, listeners,
    changeOwner() { current = false; for (const listener of listeners) listener(); },
    wait(timeoutMs = 200) { return waitForCodexRewindActionReady({
      readSnapshot: () => snapshot, inspectReady, isCurrent: () => current,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      cancelPromise, timeoutMs,
    }); },
  };
}

test('production first-turn Resume: text-ready during MCP 9/10 does not authorize Rewind Escape', async () => {
  assert.equal(inspectReady({ lines: startup.split('\n').map(text => ({ text })) }).ready, true);
  const f = fixture();
  let writes = 0;
  const result = f.wait().then(value => { if (value.success) writes++; return value; });
  await Promise.resolve();
  assert.equal(writes, 0);
  f.frame(composer, false);
  await Promise.resolve();
  assert.equal(writes, 0, 'raw/uncommitted ready is not permission');
  f.frame(composer);
  assert.equal((await result).success, true);
  assert.equal(writes, 1);
  assert.equal(f.listeners.size, 0);
});

test('historical MCP warning does not block the current composer', async () => {
  const f = fixture('MCP startup interrupted\n\nAn earlier answer completed.\n' + composer);
  assert.equal((await f.wait()).success, true);
});

test('scope change, cancellation and timeout produce no control write or successful rollback', async () => {
  for (const kind of ['owner', 'cancel', 'timeout']) {
    const f = fixture();
    const p = f.wait(15);
    if (kind === 'owner') f.changeOwner();
    if (kind === 'cancel') f.cancel();
    const result = await p;
    assert.equal(result.success, false, kind);
    assert.equal(result.rollbackMayHaveApplied, false);
    assert.equal(f.listeners.size, 0);
  }
});

test('the actual native scenario waits before authorization/arming; proof and one Enter stay owned there', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('codex:open-history-menu'");
  const end = main.indexOf("ipcMain.handle(", start + 30);
  const handler = main.slice(start, end);
  assert.ok(handler.indexOf('await waitForCodexRewindActionReady(')
    < handler.indexOf("authorizeCodexRewindAtWriteBoundary('locked-before-target-load')"));
  assert.match(handler, /if \(!actionReady\.success\) return actionReady/);
  assert.match(handler, /actionMirror\?\.synchronizedFrameWaiters\?\.add\(listener\)/);
  assert.match(handler, /getTerminalInputRevision\(tabId\) === actionScope\.inputRevision/);
  assert.match(handler, /launchId === actionScope\.launchId/);
});
