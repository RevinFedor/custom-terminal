'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('capture crash probe is disabled in normal runtime and holds after actual apply, before consumer delivery', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const helperOutcome = source.indexOf('const helperOutcome = readCaptureOutcome(pending.captureOperation)');
  const afterApply = source.indexOf("kind: 'agent-capture-after-apply'", helperOutcome);
  const release = source.indexOf('releaseAgentInputCapturePending(tabId, pending, { parentReturned: true })', afterApply);
  const reply = source.indexOf('pending.resolve({', afterApply);
  assert.ok(helperOutcome > 0 && afterApply > helperOutcome && release > afterApply && reply > release);
  assert.match(source.slice(helperOutcome, afterApply), /aiBoundaryTestGate\.enabled && helperApplied && mode === 'grab'/);
  assert.match(source.slice(afterApply, release), /validateAgentInputIdentity\(tabId, pending\.captureIdentity\)/);
});
