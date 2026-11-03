'use strict';
// A manual model/effort choice that failed left no PTY byte window.
//
// `captureClaudeSettingFailureBytes` existed and worked — but it hung on
// `publishGate`, which only the STARTUP auto-inject path calls. Clicking a
// level in the control bar goes through `claude:apply-setting`, so a refusal
// there produced a toast and nothing else.
//
// 03.11, tab 5b20bf267cca: `/effort max` was refused twice
// (`wrapperSeen=false stdoutSeen=false session=-`), the session transcript
// held no `<command-name>/effort` record after 00:15 although the session was
// alive and writing 102 later records, and the log contained zero
// `claude-setting-not-confirmed` incidents. Without the byte window three very
// different causes stayed indistinguishable: the bytes never reached the
// terminal, Claude swallowed them into an already-open picker, or it applied
// them without recording the pair (the 02.11 ANTHROPIC_MODEL case).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const section = (from, to) => {
  const start = main.indexOf(from);
  assert.ok(start > 0, 'anchor not found: ' + from);
  const end = main.indexOf(to, start);
  assert.ok(end > start, 'end not found: ' + to);
  return main.slice(start, end);
};
const capture = section('function captureClaudeManualSettingFailureBytes',
  "ipcMain.handle('claude:apply-setting'");

test('both manual setting handlers pin the byte window on failure', () => {
  const single = section("ipcMain.handle('claude:apply-setting'", '// Decision 01.11 (Fedor)');
  const pair = section("ipcMain.handle('claude:apply-settings'", "ipcMain.handle('claude:send-prompt-with-settings'");
  for (const [label, body] of [['apply-setting', single], ['apply-settings', pair]]) {
    assert.match(body, /captureClaudeManualSettingFailureBytes\(request, applied\)/,
      label + ' must capture a refused result');
    assert.match(body, /captureClaudeManualSettingFailureBytes\(request, outcome\)/,
      label + ' must capture a thrown failure too');
  }
});

test('a success never pins a window', () => {
  assert.match(capture, /if \(!tabId \|\| outcome\?\.success === true\) return;/,
    'only a failure may produce an incident');
});

test('it reuses the existing capture, not a second mechanism', () => {
  assert.match(capture, /captureClaudeSettingFailureBytes\(\{/,
    'the startup capture is the one that already pins raw PTY bytes');
  assert.match(capture, /status: 'failed'/, 'that capture ignores any other status');
});

test('the failed command is named even when the result omits it', () => {
  // A thrown transport error carries no failedCommand, and the report is
  // useless without knowing which command it is about.
  assert.match(capture, /request\?\.kind \? '\/' \+ request\.kind \+ ' ' \+ String\(request\.value \?\? ''\)/,
    'single-setting fallback');
  assert.match(capture, /request\?\.model \? '\/model ' \+ request\.model/, 'pair fallback: model');
  assert.match(capture, /request\?\.effort \? '\/effort ' \+ request\.effort/, 'pair fallback: effort');
});

test('the current launch generation is attached', () => {
  // Without it a report cannot be matched to the process that refused.
  assert.match(capture, /claudeLaunchGenerationByTab\.get\(tabId\)\?\.generation/);
});

test('the user is not shown a second toast for the same failure', () => {
  // The settings card already reports it; the byte window is for the report.
  const startup = section('function captureClaudeSettingFailureBytes', 'function ensureClaudeStartupSettingsInMain');
  assert.match(startup, /silent: true/,
    'the shared capture must stay silent, so reusing it adds no duplicate toast');
});

test('capture failure can never break the setting result', () => {
  const startup = section('function captureClaudeSettingFailureBytes', 'function ensureClaudeStartupSettingsInMain');
  assert.match(startup, /catch \(error\) \{/, 'the shared capture swallows its own errors');
  assert.match(startup, /\[ClaudeSettingBytes\] capture failed/);
});
