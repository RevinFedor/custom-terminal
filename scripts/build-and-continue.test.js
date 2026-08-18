'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONTINUE_PROMPT,
  classifyContinueSendResponse,
  validateTargetSnapshot,
} = require('./build-and-continue');

test('command sends exactly the requested lower-case word', () => {
  assert.equal(CONTINUE_PROMPT, 'continue');
});

test('exact target snapshot must belong to this build source process', () => {
  const snapshot = {
    source: 'exact-shutdown-snapshot',
    shutdownPid: 42,
    capturedAt: 10_500,
    targets: [{ tabId: 'tab', provider: 'claude', sessionId: 'sid' }],
    unresolved: [],
  };
  const plan = validateTargetSnapshot(snapshot, { previousPid: 42, buildStartedAt: 10_000 });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.legacy, false);
  assert.throws(
    () => validateTargetSnapshot(snapshot, { previousPid: 43, buildStartedAt: 10_000 }),
    /different app process/,
  );
});

test('first install accepts only the already-resolved legacy target list', () => {
  const plan = validateTargetSnapshot({
    source: 'legacy-interrupted-fallback',
    targets: [{ tabId: 'tab', provider: 'codex', sessionId: 'sid' }],
    unresolved: [{ tabId: 'ambiguous', reason: 'owner-ambiguous' }],
  }, { previousPid: 1, buildStartedAt: 1 });
  assert.equal(plan.legacy, true);
  assert.deepEqual(plan.targets.map((item) => item.tabId), ['tab']);
  assert.equal(plan.unresolved.length, 1);
});

test('only 2xx send responses are accepted and 202 remains non-retryable verification', () => {
  assert.deepEqual(classifyContinueSendResponse({ statusCode: 200, body: { status: 'sent' } }), {
    accepted: true,
    uncertain: false,
    status: 'sent',
  });
  assert.deepEqual(classifyContinueSendResponse({ statusCode: 202, body: { status: 'audit-pending' } }), {
    accepted: true,
    uncertain: true,
    status: 'audit-pending',
  });
  assert.equal(classifyContinueSendResponse({ statusCode: 409, body: { error: 'conflict' } }).accepted, false);
});

test('package command and script stay wired to canonical build and Project API', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const source = fs.readFileSync(path.join(__dirname, 'build-and-continue.js'), 'utf8');
  assert.equal(pkg.scripts['build:i-cont'], 'node scripts/build-and-continue.js');
  assert.match(source, /spawn\('npm', \['run', 'build:install'\]/);
  assert.match(source, /\/api\/build-continue-targets/);
  assert.match(source, /\/api\/terminal-tabs\//);
  assert.match(source, /'\/send'/);
  assert.match(source, /for \(let index = 0; index < plan\.targets\.length; index \+= 1\)/);
});
