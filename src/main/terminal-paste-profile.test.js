'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { classifyTerminalPasteProfile } = require('./terminal-paste-profile');

test('raw paste and non-Claude submit preserve their existing capabilities', () => {
  assert.equal(classifyTerminalPasteProfile({ submit: false, liveClaude: true }).allowed, true);
  assert.equal(classifyTerminalPasteProfile({ submit: true, liveClaude: false, fast: true }).allowed, true);
});

test('live Claude submit requires the complete semantic send profile', () => {
  const safe = {
    submit: true,
    liveClaude: true,
    fast: false,
    verifyClaudeVisibleDraftBeforePaste: true,
    awaitClaudeUserMessageAudit: true,
    handoffId: 'history-handoff',
    source: 'history-panel',
  };
  assert.deepEqual(classifyTerminalPasteProfile(safe), {
    allowed: true,
    profile: 'claude-semantic-send',
  });
  for (const missing of [
    { fast: true },
    { verifyClaudeVisibleDraftBeforePaste: false },
    { awaitClaudeUserMessageAudit: false },
    { handoffId: null },
    { source: null },
  ]) {
    const result = classifyTerminalPasteProfile({ ...safe, ...missing });
    assert.equal(result.allowed, false);
    assert.equal(result.error, 'claude_semantic_submit_required');
  }
});

test('terminal:paste enforces the profile before the physical paste boundary', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('terminal:paste'");
  const end = source.indexOf('function mediaTypeFromImagePath', start);
  assert.ok(start >= 0 && end > start, 'terminal:paste handler not found');
  const handler = source.slice(start, end);
  const classification = handler.indexOf('classifyTerminalPasteProfile({');
  const physicalPaste = handler.indexOf('safePasteAndSubmit(term, content');
  assert.ok(classification >= 0, 'semantic paste profile is not enforced');
  assert.ok(physicalPaste > classification,
    'ambiguous live Claude submit must be rejected before any PTY write');
  assert.match(handler, /if \(!pasteProfile\.allowed\)[\s\S]*submitted: false/);
});
