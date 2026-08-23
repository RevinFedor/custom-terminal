import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..');
const src = path.join(renderer, '..');
const app = fs.readFileSync(path.join(renderer, 'App.tsx'), 'utf8');
const dashboard = fs.readFileSync(path.join(renderer, 'components', 'Dashboard', 'Dashboard.tsx'), 'utf8');
const continueFlow = fs.readFileSync(path.join(here, 'continueInterruptedSession.ts'), 'utf8');
const lifecycle = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'useAgentLifecycle.ts'), 'utf8');
const main = fs.readFileSync(path.join(src, 'main', 'main.js'), 'utf8');

test('boot restore is unconditional, sequential, and waits for ready before clearing interrupted', () => {
  assert.match(app, /restoreInterruptedSessionsSequentially\(/);
  assert.match(app, /launchSource: 'auto-resume'/);
  const restoreBlock = app.slice(
    app.indexOf('// Restore interrupted sessions'),
    app.indexOf('// Semantic index watchers'),
  );
  assert.match(restoreBlock, /app:get-startup-interrupted-snapshot/);
  assert.match(restoreBlock, /resolveInterruptedRestoreTargets\(/);
  assert.doesNotMatch(restoreBlock, /resolvePtyAgentOwner\(tab\)/,
    'renderer must not re-infer the provider after main froze exact identity');
  assert.match(main, /ipcMain\.handle\('app:get-startup-interrupted-snapshot'/);
  assert.doesNotMatch(restoreBlock, /overlayDismissed/);
  assert.doesNotMatch(app, /app:getState', 'auto_resume_sessions'/);
  assert.doesNotMatch(app, /sessions concurrently|Promise\.all\(tabs\.map\(startOne\)/);
  assert.doesNotMatch(dashboard, /Auto-resume AI sessions|auto_resume_sessions/);

  const waitAt = continueFlow.indexOf("ipcRenderer.invoke('agent:wait-start-ready'");
  const clearAt = continueFlow.indexOf('clearInterruptedState(tabId)', waitAt);
  assert.ok(waitAt >= 0, 'restore must wait on the main-owned lifecycle');
  assert.ok(clearAt > waitAt, 'wasInterrupted may clear only after ready proof');
  assert.match(app, /phase=' \+ phase/);
  assert.match(continueFlow, /settled: terminalFailure/);
});

test('a delayed restore step adopts the exact live session instead of launching it twice', () => {
  assert.match(continueFlow, /classifyInterruptedRestoreRuntime/);
  assert.match(continueFlow, /codex:get-runtime-projection/);
  assert.match(continueFlow, /claude:get-presence/);
  assert.match(continueFlow, /stage: 'before-launch'/);
  assert.match(continueFlow, /stage: 'after-launch-refusal'/);
  assert.match(continueFlow, /exact target while[\s\S]*never type a second launch command/);
  assert.match(continueFlow, /COLLISION_ERRORS[\s\S]*shell_not_idle[\s\S]*foreground_command_running/);
  assert.match(continueFlow, /alreadyRestored: true/);
});

test('automatic restore errors use the shared persistent toast with a copy report', () => {
  const restoreBlock = app.slice(
    app.indexOf('// Restore interrupted sessions'),
    app.indexOf('// Semantic index watchers'),
  );
  assert.match(restoreBlock, /buildInterruptedRestoreIncidentReport\(\{/);
  assert.match(restoreBlock, /'error',[\s\S]{0,120}true,[\s\S]{0,120}incidentReport/);
  assert.doesNotMatch(restoreBlock, /true,\s*undefined,[\s\S]{0,160}`Session /);
});

test('launch failure is visible before the retained interrupted fallback', () => {
  const startingAt = lifecycle.indexOf('if (sessionStarting && sessionStarting.tabId === tabId)');
  const interruptedAt = lifecycle.indexOf('if (interrupted)', startingAt);
  assert.ok(startingAt >= 0 && interruptedAt > startingAt);
  assert.match(lifecycle, /Waiting for automatic restore/);
});

test('stale commandRunning can self-repair only with prompt, foreground and process proof', () => {
  const start = main.indexOf('async function proveIdleShellForAgentLaunch');
  const end = main.indexOf('function writeAgentLaunchCommandToIdleShell', start);
  const body = main.slice(start, end);
  assert.match(body, /terminalShellReadiness\.snapshot/);
  assert.match(body, /terminalInputLineBuffers\.get\(tabId\)/);
  assert.match(body, /reason: 'terminal_has_unsent_input'/);
  assert.match(body, /classifyTerminalForegroundSnapshot/);
  assert.match(body, /lookup\.status === AI_PROCESS_LOOKUP_STATUS\.ABSENT/);
  assert.match(body, /stale-shell-command-reconciled/);
  assert.match(body, /process_lookup_unknown|AI_PROCESS_LOOKUP_STATUS\.UNKNOWN/);
});

test('blocking interrupted Continue modal is removed from all terminal surfaces', () => {
  assert.equal(
    fs.existsSync(path.join(renderer, 'components', 'Workspace', 'InterruptedSessionOverlay.tsx')),
    false,
  );
  for (const file of ['TerminalArea.tsx', 'SplitPaneSurface.tsx']) {
    const source = fs.readFileSync(path.join(renderer, 'components', 'Workspace', file), 'utf8');
    assert.doesNotMatch(source, /InterruptedSessionOverlay|ПРОДОЛЖИТЬ СЕССИЮ/);
  }
});
