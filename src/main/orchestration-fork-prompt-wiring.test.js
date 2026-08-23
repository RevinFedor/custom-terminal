'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'App.tsx'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'mcp', 'terminal-server.mjs'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('existing Terminal MCP send and delegation tools accept server-resolved prompt chips', () => {
  assert.match(mcp, /name: 'delegate_to_session'[\s\S]*?prompts:[\s\S]*?forkFromTabId/);
  assert.match(mcp, /name: 'send_prompt'[\s\S]*?prompts:/);
  assert.match(web, /resolveSendPromptPresentation\(projectManager, body, taskPrompt\)/);
  assert.match(web, /deliveryIntent:\s*\{[\s\S]*?promptChips:/);
  assert.match(web, /presentationSnapshot: promptPresentation\.promptChips\.length/);
});

test('existing delegation targets keep their provider instead of inheriting the new-tab default', () => {
  const start = mcp.indexOf("case 'delegate_to_session':");
  const end = mcp.indexOf("case 'get_delegation':", start);
  const delegation = mcp.slice(start, end);

  assert.match(
    delegation,
    /const targetToolType = args\.toolType\s*\|\| \(args\.targetTabId \|\| args\.forkFromTabId \? undefined : 'claude'\)/,
  );
  assert.match(delegation, /toolType: targetToolType/);
  assert.doesNotMatch(delegation, /toolType: args\.toolType \|\| \(args\.forkFromTabId/);
  assert.match(delegation, /const runId = result\?\.runId \|\| result\?\.run\?\.runId/);
  assert.match(delegation, /accepted delegation without a durable runId/);
  assert.match(delegation, /JSON\.stringify\(\{ \.\.\.result, runId \}, null, 2\)/);
});

test('delegation errors and receipts remain structured across the MCP transport', () => {
  const start = mcp.indexOf("if (method === 'tools/call')");
  const end = mcp.indexOf('async function callTool', start);
  const transport = mcp.slice(start, end);

  assert.match(
    transport,
    /name === 'delegate_to_session'[\s\S]*toolResult\.structuredContent = JSON\.parse\(result\)/,
  );
  assert.match(
    transport,
    /name === 'delegate_to_session'[\s\S]*toolResult\.structuredContent = \{ ok: false, error: err\.message \}/,
  );
});

test('Terminal MCP history defaults to the latest compact without changing raw HTTP compatibility', () => {
  assert.match(mcp, /from: args\.from \|\| 'latest_compact'/);
  assert.match(main, /const from = \['latest_compact', 'end', 'start'\]/);
  assert.match(main, /item\.kind === 'compact_summary' \|\| item\.kind === 'compact_boundary'/);
  assert.match(main, /windowStartTurnIndex/);
});

test('Terminal MCP exposes ordinary cross-project session search with dates and iteration totals', () => {
  assert.match(mcp, /name: 'search_sessions'/);
  assert.match(mcp, /period:[\s\S]*?today[\s\S]*?yesterday/);
  assert.match(mcp, /dateField:[\s\S]*?created[\s\S]*?closed/);
  assert.match(main, /p === '\/overseer\/search-sessions'/);
  assert.match(main, /iterationIndex/);
  assert.match(main, /totalIterationsAcrossSessions/);
  assert.match(main, /totalIterations:/);
});

test('fork-backed delegation materializes the reserved visual child from the latest compact', () => {
  assert.match(web, /async function materializeReservedOrchestrationTarget/);
  assert.match(web, /bridgeRequest\('forkAgentTab'/);
  assert.match(web, /fromLatestCompact: run\.fullHistoryFork !== true/);
  assert.match(web, /materializeReservedOrchestrationTarget\(\s*internalReservedRun/);

  assert.match(app, /const forkAgentTab = async/);
  assert.match(app, /fromLatestCompact = options\.fromLatestCompact !== false/);
  assert.match(app, /'claude:fork-session-file'/);
  assert.match(app, /'codex:fork-from-latest-compact'/);
  assert.match(app, /appendToEnd: true/);
  assert.match(app, /visualParentTabId: requestedParentId/);
  assert.match(app, /action === 'forkAgentTab'/);
});

test('optional pre-task compact completes before the durable task can dispatch', () => {
  assert.match(mcp, /compactBeforeTask/);
  assert.match(web, /async function prepareOrchestrationTargetForDelivery/);
  assert.match(web, /bridgeRequest\('compactAgentTab'/);
  assert.match(web, /targetPreparationCompletedAt/);
  assert.match(web, /if \(current\.compactBeforeTask && !current\.targetPreparationCompletedAt\)/);
  assert.match(app, /const compactAgentTab = async/);
  assert.match(app, /waitForCompactCompletion/);
  assert.match(app, /action === 'compactAgentTab'/);
  assert.match(main, /pendingManualCompact\.source === 'programmatic-live-slash'/);
  assert.match(main, /task_started-after-programmatic-slash/);
});
