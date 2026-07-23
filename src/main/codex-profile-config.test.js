'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteCodexDeveloperProfile } = require('./codex-profile-config');

test('developer profile preserves Codex-owned root settings', () => {
  const result = rewriteCodexDeveloperProfile([
    'model = "gpt-5.6-sol"',
    'model_provider = "openai"',
    'model_reasoning_effort = "max"',
    'plan_mode_reasoning_effort = "xhigh"',
    'developer_instructions = "old"',
    '',
    '[notice.model_migrations]',
    '"gpt-5.4-mini" = "gpt-5.6-luna"',
  ].join('\n'), 'new instructions');

  assert.match(result, /model = "gpt-5\.6-sol"/);
  assert.match(result, /model_provider = "openai"/);
  assert.match(result, /model_reasoning_effort = "max"/);
  assert.match(result, /plan_mode_reasoning_effort = "xhigh"/);
  assert.match(result, /developer_instructions = "new instructions"/);
  assert.match(result, /\[notice\.model_migrations\]/);
  assert.match(result, /"gpt-5\.4-mini" = "gpt-5\.6-luna"/);
});

test('ordinary profile preserves Codex-owned model settings', () => {
  const result = rewriteCodexDeveloperProfile(
    'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"\n',
    'instructions',
  );
  assert.match(result, /model = "gpt-5\.6-luna"/);
  assert.match(result, /model_reasoning_effort = "medium"/);
  assert.match(result, /developer_instructions = "instructions"/);
});
