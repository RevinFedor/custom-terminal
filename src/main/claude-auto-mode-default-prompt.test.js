'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  inspectClaudeAutoModeDefaultPromptSnapshot,
  looksLikeClaudeAutoModeDefaultPromptText,
} = require('./claude-auto-mode-default-prompt');

function snapshot(text, selectedRow = null, extra = {}) {
  return {
    success: true,
    authoritativeFrameCommitted: true,
    liveSynchronizedOutputOpen: false,
    lines: String(text).split('\n').map((line, row) => ({
      row,
      text: line,
      hasInverse: row === selectedRow,
    })),
    ...extra,
  };
}

const wrappedPrompt = [
  'Make auto mode your default',
  'permission mode?',
  '',
  'Auto mode lets Claude handle',
  'permission prompts automatically.',
  'Claude checks each tool call for risky',
  'actions and prompt injection before executing,',
  'runs the ones it assesses as lower-risk,',
  'and blocks the rest.',
  '',
  '❯ 1. Yes, set auto mode as my',
  '     default permission mode',
  '  2. No, keep bypass',
  '     permissions',
].join('\n');

test('recognizes the wrapped current modal with Yes selected', () => {
  assert.deepEqual(inspectClaudeAutoModeDefaultPromptSnapshot(snapshot(wrappedPrompt)), {
    visible: true,
    selectedOption: 1,
    reason: 'current-auto-mode-default-prompt-proven',
  });
});

test('recognizes narrower option wrapping', () => {
  const narrow = wrappedPrompt
    .replace('❯ 1. Yes, set auto mode as my\n     default permission mode', [
      '❯ 1. Yes, set auto',
      '     mode as my default',
      '     permission mode',
    ].join('\n'))
    .replace('  2. No, keep bypass\n     permissions', [
      '  2. No, keep',
      '     bypass permissions',
    ].join('\n'));
  assert.equal(inspectClaudeAutoModeDefaultPromptSnapshot(snapshot(narrow)).selectedOption, 1);
});

test('recognizes No selected and an optional current footer', () => {
  const frame = wrappedPrompt
    .replace('❯ 1. Yes', '  1. Yes')
    .replace('  2. No', '❯ 2. No')
    + '\nEnter to confirm · Esc to cancel';
  assert.equal(inspectClaudeAutoModeDefaultPromptSnapshot(snapshot(frame)).selectedOption, 2);
});

test('does not act on a partial differential paint', () => {
  const partial = wrappedPrompt.replace('     permissions', '');
  assert.deepEqual(inspectClaudeAutoModeDefaultPromptSnapshot(snapshot(partial)), {
    visible: false,
    selectedOption: null,
    reason: 'no-option-incomplete',
  });
});

test('does not act on stale modal text followed by a composer', () => {
  const stale = wrappedPrompt + '\nordinary output\n❯ current user draft';
  assert.equal(inspectClaudeAutoModeDefaultPromptSnapshot(snapshot(stale)).visible, false);
});

test('requires a committed closed frame', () => {
  assert.equal(inspectClaudeAutoModeDefaultPromptSnapshot(snapshot(wrappedPrompt, null, {
    authoritativeFrameCommitted: false,
  })).visible, false);
  assert.equal(inspectClaudeAutoModeDefaultPromptSnapshot(snapshot(wrappedPrompt, null, {
    liveSynchronizedOutputOpen: true,
  })).visible, false);
});

test('the rolling output hint tolerates wrapped and cursor-spaced title text', () => {
  assert.equal(looksLikeClaudeAutoModeDefaultPromptText([
    'Make auto mode your default',
    ' permission mode?',
  ].join('\n')), true);
  assert.equal(looksLikeClaudeAutoModeDefaultPromptText([
    '❯ 1. Yes, set auto mode as my default permission mode',
    '  2. No, keep bypass permissions',
  ].join('\n')), true);
  assert.equal(looksLikeClaudeAutoModeDefaultPromptText('ordinary Claude prompt'), false);
});

test('main wires the modal through current-frame proof and selects keep bypass', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const commit = main.slice(
    main.indexOf('function commitHeadlessVisibleBufferSnapshot'),
    main.indexOf('function parseClaudeDraftFromVisibleSnapshot'),
  );
  const handler = main.slice(
    main.indexOf('async function handleClaudeAutoModeDefaultPrompt'),
    main.indexOf('function clearClaudeConfirmDialogCooldown'),
  );
  assert.match(commit, /observeClaudeAutoModeDefaultPromptCommittedFrame/);
  assert.match(handler, /withPtyWriteLock\(expectedTerm/);
  assert.match(handler, /waitForCommittedSemanticFrame/);
  assert.match(handler, /claudeLaunchGenerationByTab\.get\(tabId\)\?\.generation/);
  assert.match(handler, /selectedOption === 1/);
  assert.match(handler, /'\\x1b\[B',[\s\S]{0,80}'select-keep-bypass'/);
  assert.match(handler, /selectedOption === 2/);
  assert.match(handler, /'\\r',[\s\S]{0,80}'confirm-keep-bypass'/);
  assert.match(handler, /expectedTerm\.write\(data\)/);
  assert.doesNotMatch(handler, /safePasteAndSubmit/);
  assert.match(main, /!autoModeDefaultPromptHint[\s\S]{0,180}!claudePromptReady\.has/);
  assert.match(main, /currentState === 'WAITING_PROMPT'[\s\S]{0,120}!autoModeDefaultPromptHint/);
  assert.match(main, /cancelled false prompt debounce/);
  assert.match(handler, /hint disproven by current composer/);
  assert.match(handler, /publishClaudePromptReady\(tabId, 'auto-mode onboarding dismissed'\)/);
  assert.match(main, /!claudePromptReady\.has\(tabId\)[\s\S]{0,100}claudeAutoModeDefaultPromptHintTabs\.has\(tabId\)/);
  const clearLaunch = main.slice(
    main.indexOf('function clearClaudeLaunchGeneration'),
    main.indexOf('function readClaudeStartupIntent'),
  );
  assert.match(clearLaunch, /claudeAutoModeDefaultPromptHintTabs\.delete\(tabId\)/);
  assert.match(clearLaunch, /claudeAutoModeDefaultPromptHintBuffers\.delete\(tabId\)/);
});
