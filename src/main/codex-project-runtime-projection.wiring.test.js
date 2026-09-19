'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');

test('Project API reads one main-owned Codex projection batch and never asks renderer for Codex', () => {
  assert.match(main, /resolveCodexRuntimeProjectionBatch:[\s\S]{0,160}getCodexRuntimeProjectionBatch/);
  assert.match(web, /partitionProjectRuntimeTabs\([\s\S]{0,160}rendererPtyAgentIds = runtimeRoutes\.rendererTabIds/);
  assert.match(web, /resolveCodexRuntimeProjectionBatch\([\s\S]{0,180}codexRows\.map/);
  assert.match(web, /conversationMaterializedMap\.get\(t\.tabId\) === true/);
  assert.doesNotMatch(web, /isCodex\s*\?\s*!!codexHistoricalSessionId/);
});

test('event projection is updated by lifecycle broadcasts while mutation boundaries force reconcile', () => {
  assert.match(main, /function _webBroadcast\([\s\S]{0,420}publishCodexRuntimeProjection/);
  const batchStart = main.indexOf('function getCodexRuntimeProjectionBatch');
  const batchEnd = main.indexOf('\nfunction broadcastCodexPublicRuntimeSnapshot', batchStart);
  const batch = main.slice(batchStart, batchEnd);
  assert.match(batch, /project-api-seed/);
  assert.doesNotMatch(batch, /getCodexRuntimeSessionSnapshot|reconcileCodexWriterFromProcess|loadSessionRecords|inspectAiDescendantProcessesByTab/);
  assert.match(main, /reason: 'archive-close',[\s\S]{0,180}forceWriterReconcile: true/);
  assert.match(main, /reason: 'codex-binding-point-write:' \+ reason,[\s\S]{0,180}forceWriterReconcile: true/);
});
