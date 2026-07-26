'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  authorizeClaudeRewindTargetSelection,
  findClaudeRewindPrimarySelectedLine,
  inspectClaudeRewindMenuScope,
} = require('./claude-rewind-menu-state');

function line(row, text, extra = {}) {
  return { row, text, rawText: text, ...extra };
}

test('deep Rewind menu treats more-below as the lower boundary', () => {
  const scope = inspectClaudeRewindMenuScope([
    line(170, 'Rewind'),
    line(172, 'Restore and fork the conversation to the point before…'),
    line(174, '↑ 3 more above'),
    line(176, 'TARGET'),
    line(178, 'NEXT-1'),
    line(180, '❯ NEXT-2', { hasNonDefaultFg: true }),
    line(182, 'NEXT-3'),
    line(187, '↓ 6 more below'),
    line(189, 'Enter to continue · Esc to cancel'),
  ]);

  assert.equal(scope.scopeFound, true);
  assert.equal(scope.reason, 'anchored-current-menu');
  assert.deepEqual(scope.scopedLines.map((entry) => entry.text), [
    'TARGET',
    'NEXT-1',
    '❯ NEXT-2',
    'NEXT-3',
  ]);
  assert.equal(scope.hasMoreAbove, true);
  assert.equal(scope.hasMoreBelow, true);
  assert.equal(scope.scopeStartRow, 176);
  assert.equal(scope.scopeEndRow, 182);
  assert.ok(scope.scopeStartRow <= scope.scopeEndRow);
});

test('short Rewind menu scopes items between its description and footer', () => {
  const scope = inspectClaudeRewindMenuScope([
    line(40, 'Rewind'),
    line(42, 'Restore and fork the conversation to the point before…'),
    line(44, '❯ latest prompt'),
    line(46, 'older prompt'),
    line(48, 'Enter to continue · Esc to cancel'),
  ]);

  assert.equal(scope.scopeFound, true);
  assert.deepEqual(scope.scopedLines.map((entry) => entry.text), [
    '❯ latest prompt',
    'older prompt',
  ]);
  assert.equal(scope.hasMoreAbove, false);
  assert.equal(scope.hasMoreBelow, false);
});

test('clipped menu segment can be proven by more-below plus current footer', () => {
  const scope = inspectClaudeRewindMenuScope([
    line(80, 'older prompt'),
    line(82, '❯ target prompt'),
    line(84, '↓ 8 more below'),
    line(86, 'Enter to continue · Esc to cancel'),
  ]);

  assert.equal(scope.scopeFound, true);
  assert.equal(scope.reason, 'clipped-current-menu');
  assert.deepEqual(scope.scopedLines.map((entry) => entry.text), [
    'older prompt',
    '❯ target prompt',
  ]);
});

test('old picker footer above an ordinary composer is not current proof', () => {
  const scope = inspectClaudeRewindMenuScope([
    line(100, 'Rewind'),
    line(102, 'Restore and fork the conversation to the point before…'),
    line(104, '❯ target prompt'),
    line(106, 'Enter to continue · Esc to cancel'),
    line(108, '─── History 7/17 ───'),
    line(110, '❯ target prompt'),
  ]);

  assert.equal(scope.scopeFound, false);
  assert.equal(scope.reason, 'footer-not-current');
  assert.deepEqual(scope.scopedLines, []);
});

test('composer History selection cannot authorize Rewind confirmation', () => {
  assert.deepEqual(authorizeClaudeRewindTargetSelection({
    menuScopeFound: false,
    selectedText: 'target prompt',
    selectedMatchesTarget: true,
  }), {
    matchedTarget: false,
    reason: 'rewind-menu-not-proven',
  });

  assert.deepEqual(authorizeClaudeRewindTargetSelection({
    menuScopeFound: false,
    targetBeforeSelected: true,
  }), {
    matchedTarget: false,
    reason: 'rewind-menu-not-proven',
  });
});

test('both proven current-menu picker layouts can authorize Enter', () => {
  assert.equal(authorizeClaudeRewindTargetSelection({
    menuScopeFound: true,
    selectedText: 'another prompt',
    selectedMatchesTarget: false,
  }).matchedTarget, false);

  assert.deepEqual(authorizeClaudeRewindTargetSelection({
    menuScopeFound: true,
    selectedText: 'target prompt',
    selectedMatchesTarget: true,
  }), {
    matchedTarget: true,
    reason: 'current-menu-selected-target',
  });

  assert.deepEqual(authorizeClaudeRewindTargetSelection({
    menuScopeFound: true,
    selectedText: '',
    targetBeforeSelected: true,
  }), {
    matchedTarget: true,
    reason: 'current-menu-target-before-selected',
  });
});

test('target-before-selected cannot authorize a slash-command control row', () => {
  assert.deepEqual(authorizeClaudeRewindTargetSelection({
    menuScopeFound: true,
    selectedText: '/model haiku',
    targetBeforeSelected: true,
    selectedIsSlashCommand: true,
  }), {
    matchedTarget: false,
    reason: 'target-before-selected-control-row',
  });
});

test('marker-only old-layout active row remains detectable', () => {
  const selected = findClaudeRewindPrimarySelectedLine([
    line(40, 'target prompt'),
    line(42, '❯'),
    line(44, 'next prompt'),
  ]);

  assert.equal(selected?.row, 42);
  assert.equal(selected?.text, '❯');
});

test('footer text alone is insufficient to prove the picker', () => {
  const scope = inspectClaudeRewindMenuScope([
    line(200, 'some transcript prose'),
    line(202, 'Enter to continue · Esc to cancel'),
  ]);

  assert.equal(scope.scopeFound, false);
  assert.equal(scope.reason, 'menu-anchor-missing');
});
