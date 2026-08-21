import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const lifecycle = read('renderer/components/Workspace/useAgentLifecycle.ts');
const workspace = read('renderer/components/Workspace/Workspace.tsx');
const pane = read('renderer/components/Workspace/SplitPaneSurface.tsx');
const store = read('renderer/utils/codexSurfaceReadIdentityStore.mjs');

test('the existing lifecycle snapshot publishes exact read identity without persisting a writer', () => {
  assert.match(
    lifecycle,
    /publishCodexSurfaceReadIdentity\(info\.tabId, presence\.runtimeSnapshot \|\| null\)/,
  );
  assert.match(lifecycle, /clearCodexSurfaceReadIdentity\(data\.tabId\)/);
  assert.doesNotMatch(store, /setCodexSessionId|updateCodexState|saveTabs/);
});

test('single and split History surfaces use read identity before first writer adoption', () => {
  assert.match(
    workspace,
    /effectiveCodexSurfaceSessionId = effectiveCodexSessionId \|\| effectiveCodexReadSessionId/,
  );
  assert.match(workspace, /timelineToolType === 'codex'\s*\? effectiveCodexSurfaceSessionId/);
  assert.match(workspace, /historyToolType === 'codex' \? effectiveCodexSurfaceSessionId/);
  assert.match(workspace, /getCodexSurfaceReadSessionId\(target\.id\)/);

  assert.match(pane, /codexSurfaceSessionId = codexSessionId \|\| codexReadSessionId \|\| ''/);
  assert.match(pane, /agentSessionId = isCodex \? codexSurfaceSessionId/);
  assert.match(pane, /timelineToolType === 'codex'\s*\? codexSurfaceSessionId/);
});
