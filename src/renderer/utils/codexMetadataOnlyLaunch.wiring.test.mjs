import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('every renderer fresh Codex entrypoint materializes one UUID then resumes it', () => {
  const runtime = read('./historyAgentRuntimes.ts');
  const admission = read('./agentLaunchAdmission.mjs');
  const app = read('../App.tsx');

  const start = runtime.match(/export async function startFreshCodexSession[\s\S]*?async function sendCodexPrompt/)?.[0] || '';
  assert.match(start, /await admission\.materialize\(/);
  assert.match(admission, /call\('codex:materialize-empty-session', frozen, 0\)/);
  assert.match(start, /await admission\.run\('codex:run-command', runPayload\)/);
  assert.ok(start.indexOf('getCodexLaunchOptions(tabId)') < start.indexOf('await admission.ready()'));
  assert.ok(start.indexOf('await admission.materialize(') < start.indexOf('await admission.run('));
  assert.match(start, /setCodexSessionId[\s\S]*?'detected'/);
  assert.match(start, /command: 'codex-c'/);
  assert.match(start, /materializedFresh: materialized\.metadataOnly === true/);
  assert.doesNotMatch(start, /command: 'codex'/);

  const controlBar = read('../components/Workspace/ClaudeControlBar.tsx');
  const terminal = read('../components/Workspace/Terminal.tsx');
  assert.doesNotMatch(controlBar, /runCodexCommand\(\{ tabId, command: 'codex'/);
  assert.match(controlBar, /startFreshCodexSession\(\{ tabId, cwd: launchCwd \}\)/);
  assert.doesNotMatch(terminal, /buildCodexRunPayload\(\{ tabId, command: 'codex'/);
  assert.match(terminal, /startFreshCodexSession\(\{ tabId, cwd/);
  assert.doesNotMatch(app, /command: 'codex',[\s\S]{0,80}developerInstructions/);
  assert.match(app, /startFreshCodexSession\(\{/);
});

test('main binds metadata-only identity before launch and validates it again at Resume', () => {
  const main = read('../../main/main.js');
  const materialize = main.match(/ipcMain\.handle\('codex:materialize-empty-session'[\s\S]*?ipcMain\.handle\('tab:set-codex-session-id'/)?.[0] || '';
  assert.match(materialize, /compareAndSetTabCodexSessionId/);
  assert.match(materialize, /processLookupUnknown/);
  assert.match(materialize, /commandState\?\.isRunning/);
  assert.match(main, /requestedMaterializedFresh === true[\s\S]*?sourceMaterialization\?\.metadataOnly === true/);
  assert.match(main, /codex_materialized_fresh_source_not_empty/);
});
