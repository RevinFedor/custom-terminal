'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const taskPlanSource = fs.readFileSync(
  path.join(__dirname, '../renderer/components/Workspace/TabTaskPlanPanel.tsx'),
  'utf8',
);

test('exact Claude retry and clear own one lock across capture and mutation', () => {
  const inspectStart = mainSource.indexOf('async function inspectClaudeExactSettingInputAtWriteBoundary(');
  const inspectWrapper = mainSource.indexOf('async function inspectClaudeExactSettingInput(', inspectStart);
  const inspectBody = mainSource.slice(inspectStart, inspectWrapper);
  assert.match(inspectBody, /captureAgentInputAtWriteBoundary\(/);
  assert.doesNotMatch(inspectBody, /captureClaudeInput\(/);
  assert.match(
    mainSource.slice(inspectWrapper, mainSource.indexOf("ipcMain.handle('claude:retry-exact-setting-input'", inspectWrapper)),
    /withPtyWriteLock\(/,
  );

  const clearStart = mainSource.indexOf('async function clearClaudeExactSettingInputAtWriteBoundary(');
  const clearIpc = mainSource.indexOf("ipcMain.handle('claude:clear-exact-setting-input'", clearStart);
  const clearBody = mainSource.slice(clearStart, clearIpc);
  assert.equal((clearBody.match(/captureAgentInputAtWriteBoundary\(/g) || []).length, 2);
  assert.match(clearBody, /'copy'[\s\S]*'restore'/);
  assert.doesNotMatch(clearBody, /write\('\x07'\)/);
  assert.match(
    mainSource.slice(clearIpc, mainSource.indexOf("ipcMain.handle('claude:clear-input'", clearIpc)),
    /withPtyWriteLock\(/,
  );
});

test('legacy Claude clear delegates to the acknowledged restore transaction', () => {
  assert.match(
    mainSource,
    /ipcMain\.handle\('claude:clear-input'[\s\S]{0,180}restoreAgentInput\(tabId, '', 'claude'\)/,
  );
});

test('TaskPlan terminal transfers use main-owned compare-and-swap IPC', () => {
  assert.match(
    mainSource,
    /ipcMain\.handle\('claude:replace-input-if-unchanged'[\s\S]{0,260}replaceAgentInputIfUnchanged/,
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\('codex:replace-input-if-unchanged'[\s\S]{0,260}replaceAgentInputIfUnchanged/,
  );
  assert.match(
    taskPlanSource,
    /ipcRenderer\.invoke\(`\$\{target\}:replace-input-if-unchanged`, \{[\s\S]{0,160}expectedText,[\s\S]{0,80}text/,
  );
  assert.doesNotMatch(
    taskPlanSource,
    /ipcRenderer\.invoke\(`\$\{target\}:restore-input`, tabId, text\)/,
  );
});
