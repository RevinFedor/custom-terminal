'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const { _api: codexData } = require('./ipc/codex-data');
const { TabWorkContext } = require('./tab-work-context');

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function openHarness(t, before) {
  let db;
  try {
    db = new Database(':memory:');
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-work-context-'));
  const filePath = path.join(dir, 'visual-history.md');
  fs.writeFileSync(filePath, before);
  const owner = {
    tabId: 'tab-visual-history',
    projectId: 'project',
    name: 'visual History',
    cwd: dir,
    tabType: 'terminal',
    commandType: 'codex',
    codexSessionId: 'session-visual-history',
  };
  const fileTab = {
    tabId: 'tab-visual-history-file',
    projectId: 'project',
    name: 'visual-history.md',
    cwd: dir,
    tabType: 'file',
    filePath,
    visualParentTabId: owner.tabId,
  };
  const context = new TabWorkContext({
    db,
    listTabs: () => [owner, fileTab],
    archivedTab: () => null,
    onChanged: () => {},
  });
  context.configure({
    transcriptService: null,
    decodeCodexCall: codexData.codexHistoryActionsForCall,
    decodeCodexPatch: codexData.parseCodexPatchApplyChanges,
    readReceipts: () => [],
  });
  await context.syncLinks();

  t.after(async () => {
    for (const watcher of context.watchers.values()) watcher.close();
    await Promise.allSettled([...context.reads.values()]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { context, filePath, owner };
}

function codexCall(callId, tool, args) {
  return {
    tabId: 'tab-visual-history',
    sessionId: 'session-visual-history',
    toolType: 'codex',
    message: {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: callId,
        name: tool,
        arguments: JSON.stringify(args),
      },
    },
  };
}

function codexResult(callId) {
  return {
    tabId: 'tab-visual-history',
    sessionId: 'session-visual-history',
    toolType: 'codex',
    message: {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: callId,
        output: '',
      },
    },
  };
}

for (const scenario of [
  {
    name: 'Edit',
    before: 'alpha\nbeta\n',
    after: 'alpha\nbeta\nself edit\n',
    args: (filePath) => ({
      file_path: filePath,
      old_string: 'alpha\nbeta\n',
      new_string: 'alpha\nbeta\nself edit\n',
    }),
  },
  {
    name: 'MultiEdit',
    before: 'alpha\nbeta\n',
    after: 'ALPHA\nBETA\n',
    args: (filePath) => ({
      file_path: filePath,
      edits: [
        { old_string: 'alpha', new_string: 'ALPHA' },
        { old_string: 'beta', new_string: 'BETA' },
      ],
    }),
  },
  {
    name: 'Write',
    before: 'old body\n',
    after: 'new body\n',
    args: (filePath) => ({ file_path: filePath, content: 'new body\n' }),
  },
]) {
  test(`a linked file ${scenario.name} by its own Codex tab removes the watcher chip`, async (t) => {
    const harness = await openHarness(t, scenario.before);
    if (!harness) return;
    const { context, filePath, owner } = harness;
    const args = scenario.args(filePath);
    const callId = `call-${scenario.name.toLowerCase()}`;

    // Production order: fs.watch can publish A->B before the transcript service
    // reaches the already-written call/result records.
    fs.writeFileSync(filePath, scenario.after);
    await context.readFile(filePath);
    assert.equal(context.get(owner.tabId).updates.length, 1, 'watcher first exposes the change');

    context.observeRecord(codexCall(callId, scenario.name, args));
    context.observeRecord(codexResult(callId));

    await waitFor(
      () => context.get(owner.tabId).updates.length === 0,
      `${scenario.name} result did not reconcile its own linked-file update`,
    );
  });
}

test('a linked file apply_patch by its own Codex tab removes the watcher chip', async (t) => {
  const before = 'alpha\nbeta\n';
  const after = 'ALPHA\nbeta\n';
  const harness = await openHarness(t, before);
  if (!harness) return;
  const { context, filePath, owner } = harness;

  fs.writeFileSync(filePath, after);
  await context.readFile(filePath);
  assert.equal(context.get(owner.tabId).updates.length, 1, 'watcher first exposes the change');

  context.observeRecord({
    tabId: owner.tabId,
    sessionId: owner.codexSessionId,
    toolType: 'codex',
    message: {
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'call-patch',
        success: true,
        changes: {
          [filePath]: {
            type: 'update',
            unified_diff: '@@ -1,2 +1,2 @@\n-alpha\n+ALPHA\n beta\n',
          },
        },
      },
    },
  });

  await waitFor(
    () => context.get(owner.tabId).updates.length === 0,
    'apply_patch event did not reconcile its own linked-file update',
  );
});
