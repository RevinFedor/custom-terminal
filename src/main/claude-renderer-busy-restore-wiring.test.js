'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'renderer', 'App.tsx'), 'utf8');

test('Claude presence and renderer restore share one main-process projection', () => {
  assert.match(main, /function getClaudePtyRuntimePresence\(tabId, evidence = \{\}\)/);
  assert.match(
    main,
    /ipcMain\.handle\('claude:get-presence',[\s\S]*?expectedProcess: 'claude',[\s\S]*?requireProviderProof: true,[\s\S]*?providerProcessAlive: commandState\?\.expectedProcess === 'claude'[\s\S]*?getClaudePtyRuntimePresence\(tabId,/,
  );
  assert.match(
    main,
    /ipcMain\.handle\('terminal:getCommandStates',[\s\S]*?resolvedToolType === 'claude'[\s\S]*?expectedProcess: resolvedToolType,[\s\S]*?requireProviderProof: wantsClaude,[\s\S]*?getClaudePtyRuntimePresence\(tabId,/,
  );
  assert.match(main, /states\[tabId\] = \{[\s\S]*?resolvedToolType,[\s\S]*?claudePresence,/);
});

test('stale renderer process hints cannot make Claude look like absent Codex', () => {
  assert.match(
    main,
    /const expectedProcess = resolveAiToolTypeForTab\(tabId, requestedExpectedProcess\);/,
  );
  assert.match(
    main,
    /const requireProviderProof = requestOptions\.requireProviderProof === true[\s\S]*?expectedProcess === 'claude';/,
  );
  assert.match(main, /providerProcessAlive: evidence\.providerProcessAlive === true/);
  assert.match(main, /processLookupUnknown: evidence\.processLookupUnknown === true/);
});

test('renderer hydrates Claude and Codex turns in the same batch without overwriting newer IPC', () => {
  assert.match(app, /collectAgentBusyHydration\(\{[\s\S]*?eventObserved: authoritativeBusyEventsSeen/);
  assert.match(app, /authoritativeBusyEventsSeen\.add\(data\.tabId\)/);
  assert.match(app, /authoritativeBusyEventsSeen\.add\(tabId\)/);
  assert.match(app, /applyClaudeVisualBusy\(update\.tabId, update\.busy, update\.reason\)/);
  assert.doesNotMatch(app, /App\.codexTurnBusySync/);
});
