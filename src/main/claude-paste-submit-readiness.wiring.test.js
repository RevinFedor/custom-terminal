'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('shared Claude submit waits for a semantic final composer form before Enter', () => {
  const start = main.indexOf('async function _safePasteAndSubmitInner');
  const end = main.indexOf('\n// Programmatic paste', start);
  const body = main.slice(start, end);
  const paste = body.indexOf('term.write(payload)');
  const semanticWait = body.indexOf('waitForClaudePasteReadyBeforeSubmit({');
  const enter = body.indexOf('term.write(submitSequence)');
  assert.ok(paste >= 0 && semanticWait > paste && enter > semanticWait);
  assert.match(body, /error: semanticReady\?\.error \|\| 'claude_paste_not_ready_before_submit'/);
  assert.match(body, /draftPreserved: true/);
});

test('Claude audit timeout retries Enter only once after exact operation-owned draft capture', () => {
  const start = main.indexOf("if (stagedClaudeAudit && awaitClaudeUserMessageAudit");
  const end = main.indexOf("if (stagedCodexAudit && awaitCodexUserMessageAudit", start);
  const body = main.slice(start, end);
  assert.match(body, /auditResult\?\.retryRecommended === true/);
  assert.match(body, /stagedClaudeAudit\.enterRetryCount === 0/);
  assert.match(body, /kind: 'programmatic-enter-retry'/);
  assert.match(body, /stagedClaudeAudit\.enterRetryCount = 1/);
  assert.match(body, /term\.write\(submitSequence\)/);
});

test('provider-transformed image prompt binds to the same audit generation', () => {
  assert.match(main, /hookInputRevision: getTerminalInputRevision\(tabId\)/);
  assert.match(main, /promptAuditOwner\.reason === 'unique-owned-provider-transform'/);
  assert.match(main, /promptSubmitAudit\.providerAcceptedHash = pasteAuditHash\(submitted_prompt\)/);
});
