import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildStartAiRequest } from './terminal-start-ai-request.mjs';

const serverSource = fs.readFileSync(fileURLToPath(new URL('./terminal-server.mjs', import.meta.url)), 'utf8');

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

test('typed start_ai model selection is resolved by Project API before the legacy start write', () => {
  const start = serverSource.indexOf("case 'start_ai':");
  const end = serverSource.indexOf("case 'read_output':", start);
  const block = serverSource.slice(start, end);
  const capability = block.indexOf('ensureAgentModelSelectionSupport');
  const resolution = block.indexOf("'/api/agent-models/resolve'");
  const body = block.indexOf('buildStartAiRequest');
  const write = block.indexOf("'/terminal/ai-start'");
  assert.ok(capability >= 0 && capability < resolution);
  assert.ok(resolution < body && body < write);
});
