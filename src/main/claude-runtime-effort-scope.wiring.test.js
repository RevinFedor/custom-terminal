'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const claudeData = fs.readFileSync(path.join(__dirname, 'ipc', 'claude-data.js'), 'utf8');
const controlBar = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'Workspace', 'ClaudeControlBar.tsx'),
  'utf8',
);
const statusBar = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'StatusBar.tsx'),
  'utf8',
);
const uiStore = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'store', 'useUIStore.ts'),
  'utf8',
);

test('confirmed effort is projected through the exact live Claude generation', () => {
  assert.match(main, /getClaudeRuntimeSettingsScope: \(tabId\) => \{[\s\S]*?generation: launch\?\.generation[\s\S]*?startedAt: Number\(launch\?\.at[\s\S]*?processAlive: isClaudeProcessRunningInTab\(tabId\)/);
  assert.match(claudeData, /projectConfirmedClaudeSettingsForRuntime\(result, runtimeScope\)/);
  assert.match(claudeData, /projectConfirmedSettingsForCurrentRuntime\([\s\S]*?cached\.result[\s\S]*?cleanTabId/);
});

test('renderer never seeds process-local effort from a previous bind', () => {
  assert.match(controlBar, /const modelOnlySeed = \{ model: seed\.model, effort: undefined \}/);
  assert.match(controlBar, /\[claudeSessionId, isCommandRunning, refreshClaudeConfirmedSettings, tabId\]/);
  assert.match(controlBar, /const sessionChanged = confirmedSettingsBoundSessionRef\.current !== claudeSessionId;[\s\S]*?if \(sessionChanged\) \{[\s\S]*?setEffortLocal\(seed\?\.effort\)/);
  const contextSeedEffect = controlBar.slice(
    controlBar.indexOf('// Seed the meter from the last value persisted for THIS tab'),
    controlBar.indexOf('// SDK tab: context % lives in ClaudeSDKTab local state'),
  );
  assert.doesNotMatch(contextSeedEffect, /setClaudeModel\(null\)/);
  assert.match(controlBar, /effortCurrentRuntime=/);
});

test('StatusBar max/default is the value applied to a new Claude generation', () => {
  assert.match(statusBar, /effortValue=\{defaultClaudeEffort\}/);
  assert.match(uiStore, /const APP_STATE_KEY_EFFORT = 'defaultClaudeEffort'/);
  assert.match(main, /getAppState\?\.\('defaultClaudeEffort'\)/);
  assert.match(main, /effort: result\.effort \|\| effort,/);
});
