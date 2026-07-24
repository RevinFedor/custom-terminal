const test = require('node:test');
const assert = require('node:assert/strict');

const { _api } = require('./claude-data');

function editFixture(overrides = {}) {
  const resultBlock = {
    tool_use_id: 'tool-edit-1',
    type: 'tool_result',
    content: 'updated',
  };
  const assistantEntry = {
    uuid: 'assistant-1',
    cwd: '/tmp/project',
  };
  const toolBlock = {
    type: 'tool_use',
    id: 'tool-edit-1',
    name: 'Edit',
    input: {
      file_path: '/tmp/project/src/main.js',
      old_string: 'old',
      new_string: 'new',
      replace_all: false,
    },
  };
  const resultEntry = {
    sourceToolAssistantUUID: 'assistant-1',
    cwd: '/tmp/project',
    message: {
      content: [resultBlock],
    },
    toolUseResult: {
      filePath: '/tmp/project/src/main.js',
      oldString: 'old',
      newString: 'new',
      replaceAll: false,
      structuredPatch: [{
        oldStart: 40,
        oldLines: 2,
        newStart: 43,
        newLines: 3,
        lines: [
          ' context',
          '-old',
          '+new-a',
          '+new-b',
        ],
      }],
    },
  };
  return {
    assistantEntry,
    toolBlock,
    resultEntry,
    resultBlock,
    ...overrides,
  };
}

test('extracts exact Claude structured patch starts and entries', () => {
  const diffHunks = _api.extractClaudeToolDiffHunks(editFixture());
  assert.deepEqual(diffHunks, [{
    oldStart: 40,
    newStart: 43,
    entries: [
      { tag: 'eq', line: 'context' },
      { tag: 'del', line: 'old' },
      { tag: 'add', line: 'new-a' },
      { tag: 'add', line: 'new-b' },
    ],
  }]);
});

test('fails closed when Claude result ownership or file identity is ambiguous', () => {
  const sourceMismatch = editFixture();
  sourceMismatch.resultEntry.sourceToolAssistantUUID = 'assistant-other';
  assert.equal(_api.extractClaudeToolDiffHunks(sourceMismatch), null);

  const toolIdMismatch = editFixture();
  toolIdMismatch.resultBlock.tool_use_id = 'tool-other';
  assert.equal(_api.extractClaudeToolDiffHunks(toolIdMismatch), null);

  const pathMismatch = editFixture();
  pathMismatch.resultEntry.toolUseResult.filePath = '/tmp/project/src/other.js';
  assert.equal(_api.extractClaudeToolDiffHunks(pathMismatch), null);

  const batched = editFixture();
  batched.resultEntry.message.content.push({
    tool_use_id: 'tool-other',
    type: 'tool_result',
    content: 'also updated',
  });
  assert.equal(_api.extractClaudeToolDiffHunks(batched), null);
});

test('fails closed when Claude structured patch counts do not match its rows', () => {
  const fixture = editFixture();
  fixture.resultEntry.toolUseResult.structuredPatch[0].oldLines = 99;
  assert.equal(_api.extractClaudeToolDiffHunks(fixture), null);
});

test('accepts Write metadata only when its exact content belongs to the matched result', () => {
  const fixture = editFixture();
  fixture.toolBlock.name = 'Write';
  fixture.toolBlock.input = {
    file_path: '/tmp/project/src/new.js',
    content: 'export const ready = true;\n',
  };
  fixture.resultEntry.toolUseResult = {
    filePath: '/tmp/project/src/new.js',
    content: 'export const ready = true;\n',
    structuredPatch: [{
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      lines: ['+export const ready = true;'],
    }],
  };

  assert.deepEqual(_api.extractClaudeToolDiffHunks(fixture), [{
    oldStart: 0,
    newStart: 1,
    entries: [{ tag: 'add', line: 'export const ready = true;' }],
  }]);

  fixture.resultEntry.toolUseResult.content = 'different content';
  assert.equal(_api.extractClaudeToolDiffHunks(fixture), null);
});
