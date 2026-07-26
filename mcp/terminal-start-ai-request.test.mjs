import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStartAiRequest } from './terminal-start-ai-request.mjs';

test('start_ai leaves cwd unset so main uses the live tab cwd', () => {
  const body = buildStartAiRequest(
    { tabId: 'tab-a', agent: 'codex', mode: 'new' },
    { projectId: 'project-a', cwd: '/project/root' },
    { source: 'test' },
  );

  assert.equal(body.cwd, undefined);
  assert.equal(JSON.parse(JSON.stringify(body)).cwd, undefined);
  assert.equal(body.parentProjectId, 'project-a');
});

test('start_ai preserves an explicit cwd override', () => {
  const body = buildStartAiRequest(
    {
      tabId: 'tab-a',
      agent: 'codex',
      mode: 'new',
      cwd: '/private/tmp/fixture-a',
      model: 'gpt-test',
      effort: 'medium',
    },
    { projectId: 'project-a', cwd: '/project/root' },
    { source: 'test' },
  );

  assert.equal(body.cwd, '/private/tmp/fixture-a');
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.effort, 'medium');
});
