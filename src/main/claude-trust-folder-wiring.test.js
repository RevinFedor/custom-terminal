'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function between(startNeedle, endNeedle) {
  const start = main.indexOf(startNeedle);
  const end = main.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, startNeedle);
  return main.slice(start, end);
}

test('folder trust owns the committed Claude frame before composer readiness', () => {
  const commit = between(
    'function commitHeadlessVisibleBufferSnapshot(',
    'function parseClaudeDraftFromVisibleSnapshot(',
  );
  assert.ok(
    commit.indexOf('observeClaudeTrustFolderPromptCommittedFrame(')
      < commit.indexOf('observeClaudeAutoModeDefaultPromptCommittedFrame('),
  );

  const stable = between(
    'function observeClaudeSynchronizedFrameFlushed(',
    'function currentClaudeFrameHasStashMarker(',
  );
  assert.ok(
    stable.indexOf('inspectClaudeTrustFolderPromptSnapshot(snapshot)')
      < stable.indexOf('parseClaudeComposerCurrentFrame(snapshot)'),
  );
});

test('raw trust title blocks false prompt glyph readiness until full-frame proof', () => {
  assert.match(main, /looksLikeClaudeTrustFolderPromptHintText\(nextTrustHint\)/);
  assert.match(main, /const onboardingPromptHint = autoModeDefaultPromptHint \|\| trustFolderPromptHint/);
  const readyGuard = main.indexOf('if (!onboardingPromptHint');
  const promptGlyph = main.indexOf('hasClaudeComposerPromptGlyph(hayStack)', readyGuard);
  assert.ok(readyGuard > 0 && promptGlyph > readyGuard && promptGlyph - readyGuard < 500);
  assert.match(main, /currentState === 'WAITING_PROMPT'[\s\S]{0,100}!onboardingPromptHint/);
});

test('only an exact selected Yes writes one generation-owned Enter', () => {
  const handler = between(
    'async function handleClaudeTrustFolderPrompt(',
    'function observeClaudeTrustFolderPromptCommittedFrame(',
  );
  assert.match(handler, /withPtyWriteLock\(expectedTerm/);
  assert.match(handler, /inspection\.selectedOption !== 1/);
  assert.match(handler, /bumpTerminalInputRevision\(tabId\)/);
  assert.match(handler, /claudeTrustFolderPromptFired\.set\(tabId/);
  assert.match(handler, /recordComposerForensicPtyInput\(tabId, '\\r'/);
  assert.match(handler, /expectedTerm\.write\('\\r'\)/);
  assert.match(handler, /acceptInspection:\s*\(next\) => next\.visible !== true/);
});

test('trust prompt is unknown draft state, never a startup slash composer', () => {
  assert.match(
    main,
    /trustFolderPrompt\.visible === true[\s\S]{0,260}proofReason:\s*'trust-folder-prompt'/,
  );
  assert.match(main, /claudeTrustFolderPromptFired\.delete\(tabId\)/);
});
