'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const renderer = fs.readFileSync(
  path.join(__dirname, '../renderer/components/Workspace/ClaudeControlBar.tsx'),
  'utf8',
);
const signals = fs.readFileSync(
  path.join(__dirname, '../renderer/components/Workspace/TabSignals.tsx'),
  'utf8',
);
const service = fs.readFileSync(path.join(__dirname, 'session-transcript-service.js'), 'utf8');
const database = fs.readFileSync(path.join(__dirname, 'database.js'), 'utf8');
const observer = fs.readFileSync(path.join(__dirname, 'codex-context-session-observer.js'), 'utf8');

test('PTY context is persisted by main before renderer publication', () => {
  const bridgeStart = main.indexOf('const bridgeContextPct = normalizeAuthoritativeContextPct');
  const bridgeCommit = main.indexOf("provider: 'claude'", bridgeStart);
  const bridgePublish = main.indexOf("mainWindow.webContents.send('claude:bridge-update'", bridgeStart);
  assert.ok(bridgeStart >= 0 && bridgeCommit > bridgeStart && bridgePublish > bridgeCommit);

  const codexStart = main.indexOf('function emitCodexContextPct');
  const codexObserve = main.indexOf('codexSessionContextObserver?.observe({', codexStart);
  assert.ok(codexStart >= 0 && codexObserve > codexStart);
  assert.match(main.slice(codexStart, codexObserve + 200), /sessionId,[\s\S]*observation/);
});

test('renderer mirrors authoritative zero but does not own PTY persistence', () => {
  const claudeStart = renderer.indexOf("ipcRenderer.on('claude:bridge-update', handler)");
  const claudeEffectStart = renderer.lastIndexOf('useEffect(() => {', claudeStart);
  const claudeEffect = renderer.slice(claudeEffectStart, claudeStart);
  assert.match(claudeEffect, /data\.contextPct >= 0/);
  assert.doesNotMatch(claudeEffect, /persistContextPct\(data\.contextPct\)/);

  const codexStart = renderer.indexOf("ipcRenderer.on('codex:context-update', handler)");
  const codexEffectStart = renderer.lastIndexOf('useEffect(() => {', codexStart);
  const codexEffect = renderer.slice(codexEffectStart, codexStart);
  assert.match(codexEffect, /data\.contextPct >= 0/);
  assert.match(codexEffect, /contextInvalidated === true[\s\S]*setContextPct\(0\)/);
  assert.match(codexEffect, /data\.sessionId !== codexSessionId/);
  assert.doesNotMatch(codexEffect, /persistContextPct\(data\.contextPct\)/);

  const tabHook = signals.slice(
    signals.indexOf('export function useTabContextUsage'),
    signals.indexOf('export function TabContextUsageBadge'),
  );
  assert.match(tabHook, /contextInvalidated === true[\s\S]*setPct\(null\)/);
  assert.match(tabHook, /tab\.codexSessionId \|\| tab\.claudeSessionId/);
});

test('Codex session transcript owns compact invalidation and exact DB writes', () => {
  assert.match(service, /onCodexContextObservation/);
  assert.match(service, /readLatestCodexContextObservation/);
  assert.match(service, /codexContextObservationFromRecord/);
  assert.match(main, /clearCodexTabContextPctForSession/);
  assert.match(main, /createCodexContextSessionObserver/);
  assert.match(main, /codexSessionContextObserver\?\.scheduleHydration/);
  assert.match(observer, /main:codex-context:/);
  assert.match(database, /WHERE tab_id = \? AND codex_session_id = \?/);
});

test('Terminal session API exposes exact live Codex context before persisted fallback', () => {
  const routeStart = main.indexOf("if (p === '/overseer/sessions')");
  const routeEnd = main.indexOf("const m = p.match(/^\\/overseer\\/session", routeStart);
  const route = main.slice(routeStart, routeEnd);
  assert.match(route, /agentContextUsageState\.read\(tabId, \{ provider: 'codex', sessionId \}\)/);
  assert.match(route, /isCodex \? 'rollout' : 'bridge'/);
});
