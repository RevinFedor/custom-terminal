'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withTerminalMcpPromptSource } = require('./terminal-mcp-prompt-source');

const sender = { tabId: 'sender', tabName: 'Captured name', projectId: 'P' };
const meta = { server: 'terminal', mode: 'internal', tabId: 'sender', projectId: 'P', tabName: 'FORGED' };
const headers = value => ({ 'x-noted-terminal-source': Buffer.from(JSON.stringify(value)).toString('base64url') });

test('catalog resolves source display fields without reading or granting execution identity', () => {
  let calls = 0;
  const chips = [{ id: 'rules', kind: 'prompt', text: 'Keep rules' }], images = [{ id: 1, path: '/fixture.png' }];
  const snapshot = { promptChips: chips, imagePaths: images };
  const actual = withTerminalMcpPromptSource(snapshot, 'terminal-mcp', headers(meta), id => {
    calls++; assert.equal(id, 'sender'); return sender;
  });
  assert.equal(calls, 1);
  assert.equal(actual.promptChips, chips); assert.equal(actual.imagePaths, images);
  assert.deepEqual(actual.semanticTags, [{ kind: 'prompt-origin', source: 'terminal-mcp',
    sourceTabId: 'sender', sourceTabName: 'Captured name', sourceProjectId: 'P' }]);
  assert.equal(snapshot.semanticTags, undefined);
});

test('missing or foreign identity remains generic and cannot guess a source from body fields', () => {
  for (const value of [{ ...meta, mode: 'external' }, { ...meta, server: 'other' },
    { ...meta, tabId: '' }, { ...meta, projectId: 'foreign' }, null, [], 'quoted sender']) {
    const actual = withTerminalMcpPromptSource(null, 'terminal-mcp', headers(value), () => sender);
    assert.deepEqual(actual.semanticTags, [{ kind: 'prompt-origin', source: 'terminal-mcp' }]);
  }
  for (const value of [[], '!', 'x'.repeat(8193)]) {
    assert.doesNotThrow(() => withTerminalMcpPromptSource(null, 'terminal-mcp',
      { 'x-noted-terminal-source': value }, () => assert.fail('invalid header must not resolve')));
  }
  assert.equal(withTerminalMcpPromptSource(null, 'history-panel', headers(meta), () => assert.fail('not MCP')), null);
});

test('descriptor mismatch and failed lookup cannot attribute a different tab or block Send', () => {
  for (const lookup of [() => null, () => ({ ...sender, tabId: 'different' }), () => { throw Error('controlled unavailable'); }]) {
    const actual = withTerminalMcpPromptSource(null, 'terminal-mcp', headers(meta), lookup);
    assert.equal(actual.semanticTags[0].sourceTabId, undefined);
  }
});

test('missing-header provenance is diagnosed without logging prompt bytes or guessing the sender', () => {
  const original = console.warn, logs = [];
  console.warn = value => logs.push(value);
  try {
    const snapshot = withTerminalMcpPromptSource(null, 'terminal-mcp', {}, () => assert.fail('no sender to resolve'));
    assert.deepEqual(snapshot.semanticTags, [{ kind: 'prompt-origin', source: 'terminal-mcp' }]);
    assert.deepEqual(logs, ['[TerminalMcpPromptSource] sender unavailable reason=missing-header']);
    withTerminalMcpPromptSource(null, 'terminal-mcp', {}, () => assert.fail('immutable replay'), { presentationSnapshot: null });
    assert.equal(logs.length, 1, 'an old frozen replay is not diagnosed as a fresh missing sender');
  } finally { console.warn = original; }
});

test('new MCP/replaced sender cannot rewrite the presentation of an immutable old queue entry', () => {
  for (const presentationSnapshot of [null, { semanticTags: [{ kind: 'prompt-origin', source: 'terminal-mcp' }] },
    { semanticTags: [{ kind: 'prompt-origin', source: 'terminal-mcp', sourceTabId: 'original', sourceTabName: 'Old name' }] }]) {
    const frozen = { prompt: 'Same prompt', presentationSnapshot };
    const before = JSON.stringify(frozen);
    assert.equal(withTerminalMcpPromptSource(null, 'terminal-mcp', headers(meta),
      () => assert.fail('replay must not re-resolve sender'), frozen), presentationSnapshot);
    assert.equal(JSON.stringify(frozen), before);
  }
});
