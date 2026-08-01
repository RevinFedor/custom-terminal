'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Codex launch wrapper maps pending admission through the runtime contract', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('async function runCodexCommandAfterLifecycleAdmission(sender, payload = {})');
  const end = source.indexOf('async function runCodexCommandFromPayloadInner', start);
  assert.ok(start >= 0 && end > start, 'Codex launch transaction must remain discoverable');
  const wrapper = source.slice(start, end);
  assert.match(
    wrapper,
    /agentLaunchPreparations\.finish\([\s\S]*classifyCodexLaunchPreparationResult\(result\)/,
  );
  assert.doesNotMatch(
    wrapper,
    /accepted:\s*result\?\.accepted\s*===\s*true/,
    'accepted:null is a pending launch, not a rejected preparation',
  );
});
