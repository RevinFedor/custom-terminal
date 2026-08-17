import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('both xterm Enter handlers bypass screen command parsing for a live/unknown foreground process', () => {
  const source = read('src/renderer/components/Workspace/Terminal.tsx');
  const calls = source.match(/shouldInterpretPtyScreenAsShellCommand\(\{/g) || [];
  assert.equal(calls.length, 2, 'primary and reattached xterm must share the same boundary');
  assert.match(source, /foregroundProcessKnownRef\.current\s*\?\s*false\s*:\s*undefined/);

  const firstGuard = source.indexOf('shouldInterpretPtyScreenAsShellCommand({');
  const firstScrape = source.indexOf('const fullLine = getCurrentCommand(term).trim()', firstGuard);
  assert.ok(firstGuard >= 0 && firstScrape > firstGuard, 'live-process guard must precede screen scraping');
});

test('rejected provider launch restores the pre-launch tab transaction', () => {
  const terminal = read('src/renderer/components/Workspace/Terminal.tsx');
  const store = read('src/renderer/store/useWorkspaceStore.ts');
  assert.match(terminal, /restoreRejectedAiLaunchSnapshot\([\s\S]*?attemptedToolType/);
  assert.match(terminal, /ptyAgentLaunchAttemptSeq/);
  assert.match(terminal, /if \(isCurrentAttempt\(\)\)[\s\S]*restoreRejectedAiLaunchSnapshot/);
  assert.match(store, /restoreRejectedAiLaunchSnapshot:\s*\(tabId, toolType/);
  assert.match(store, /tab\.commandType = snap\.commandType/);
  assert.match(store, /saveTabsThenNotifyProjectLayoutChanged\([^\n]+\n?[^\n]*'ai-launch-rejected'/);
  assert.match(store, /stale rejection ignored[\s\S]*newer-session-materialized/);
});

test('History, queue, lifecycle and close routes consume the same effective PTY owner', () => {
  for (const relative of [
    'src/renderer/App.tsx',
    'src/renderer/components/Workspace/Workspace.tsx',
    'src/renderer/components/Workspace/SplitPaneSurface.tsx',
    'src/renderer/components/Workspace/TerminalArea.tsx',
    'src/renderer/components/Workspace/ClaudeControlBar.tsx',
    'src/renderer/components/Workspace/TabBar.tsx',
    'src/renderer/hooks/usePromptQueueRunner.ts',
    'src/renderer/store/useWorkspaceStore.ts',
  ]) {
    assert.match(
      read(relative),
      /resolvePtyAgentOwner/,
      `${relative} must not invent its own commandType/session precedence`,
    );
  }

  const store = read('src/renderer/store/useWorkspaceStore.ts');
  assert.match(store, /commandType: effectiveCommandType/);
  assert.match(store, /toolType: effectiveCommandType/);
  assert.match(store, /rejected owner mutation[\s\S]*action=keep-committed-owner/);

  const workspace = read('src/renderer/components/Workspace/Workspace.tsx');
  assert.match(workspace, /const toolType = resolvePtyAgentOwner\(ownerTab\)/);
  assert.match(workspace, /const effectivePtyOwner = resolvePtyAgentOwner\(/);
  assert.match(workspace, /const primaryHistoryTool = effectivePtyOwner/);
  assert.match(workspace, /const timelineToolType = effectivePtyOwner/);
  const controlBar = read('src/renderer/components/Workspace/ClaudeControlBar.tsx');
  assert.match(controlBar, /const resolvedPtyOwner = resolvePtyAgentOwner\(/);
  assert.match(controlBar, /const sessionType:[^=]+=[^;]*resolvedPtyOwner/);
  const app = read('src/renderer/App.tsx');
  assert.match(app, /const toolForTab =[^]*?return resolvePtyAgentOwner\(tab\);/);
});

test('main and Project API prefer live/session owner over caller or stored label', () => {
  const main = read('src/main/main.js');
  const resolverStart = main.indexOf('function resolveAiToolTypeForTab(');
  const resolverEnd = main.indexOf('\nfunction getAiRuntimeSessionId', resolverStart);
  const resolver = main.slice(resolverStart, resolverEnd);
  assert.ok(resolverStart >= 0);
  assert.match(resolver, /const runtimeOwners = getLiveAiRuntimeOwners\(tabId\)/);
  assert.match(resolver, /resolveAiToolOwner\(\{ runtimeOwners \}\)/);
  assert.match(resolver, /resolveAiToolOwner\(\{[\s\S]*claudeSessionId:[\s\S]*codexSessionId:[\s\S]*fallback/);
  assert.match(main, /archive_provider_owner_unknown/);
  assert.match(main, /resolvedArchiveTab[\s\S]*commandType: resolvedToolType/);
  assert.match(main, /resolveAgentToolType: \(tabId\) => \{/);
  assert.match(main, /classifyClaudeResumeShellInput\(\{/);
  assert.match(main, /pendingLine: terminalInputLineBuffers\.get\(tabId\)/);
  assert.doesNotMatch(main, /CLAUDE_RESUME_COMMAND_RE/);
  assert.match(main, /const outputToolType = resolveAiToolTypeForTab\(tabId\);[\s\S]*if \(outputToolType === 'codex'\)/);
  assert.doesNotMatch(main, /outputToolType !== 'claude'/);

  const web = read('src/main/web-server.js');
  assert.match(web, /function resolvePersistedPtyAgentOwner\(tab\)/);
  assert.match(web, /function resolveCurrentPtyAgentOwner\(tab\)/);
  assert.match(web, /const persistedOwner = resolveCurrentPtyAgentOwner\(t\)/);
});

test('idle/active process state is color-only; text is reserved for transitions and errors', () => {
  const history = read('src/renderer/components/Workspace/HistoryPanel.tsx');
  const from = history.indexOf('const showStatusText =');
  const to = history.indexOf('const showBusyLoader', from);
  const decision = history.slice(from, to);
  assert.ok(from >= 0 && to > from);
  assert.doesNotMatch(decision, /status === 'active'/);
  assert.doesNotMatch(decision, /status === 'busy'/);
  assert.doesNotMatch(decision, /inputStatusPresentation/);
  assert.match(decision, /status === 'starting'/);
  assert.match(decision, /status === 'stopping'/);
});
