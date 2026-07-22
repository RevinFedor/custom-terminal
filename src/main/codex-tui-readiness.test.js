const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideCodexMcpStartupDeadline,
  findLastCodexComposerPromptIndex,
  hasCodexComposerPromptGlyph,
  inspectCodexInputReadyTextCore,
  isCodexMcpRestartSignalSafe,
  selectCodexCurrentInteractiveFrameText,
  shouldLaunchCodexMcpReplacement,
  stripLeadingCodexComposerPromptGlyph,
} = require('./codex-tui-readiness');

const readyFrame = (glyph) => [
  'Previous assistant output',
  `${glyph} Find and fix a bug in @filename`,
  'gpt-5.6-sol ultra fast · Full Access · Context 70% used',
].join('\n');

for (const glyph of ['›', '❯', '»']) {
  test(`recognizes Codex composer marker ${glyph}`, () => {
    const inspected = inspectCodexInputReadyTextCore(readyFrame(glyph), '', {
      requireSyncMarker: false,
      source: 'fixture',
    });
    assert.equal(inspected.ready, true);
    assert.equal(inspected.hasPromptGlyph, true);
    assert.equal(hasCodexComposerPromptGlyph(readyFrame(glyph)), true);
    assert.equal(stripLeadingCodexComposerPromptGlyph(`${glyph} prompt`), 'prompt');
  });
}

test('keeps ASCII composer fallback without treating it as a semantic draft marker', () => {
  const inspected = inspectCodexInputReadyTextCore(readyFrame('>'), '', {
    requireSyncMarker: false,
  });
  assert.equal(inspected.ready, true);
  assert.equal(hasCodexComposerPromptGlyph(readyFrame('>')), false);
});

test('finds the latest supported composer marker', () => {
  const text = '  › old text\n\t» new prompt';
  assert.equal(findLastCodexComposerPromptIndex(text), text.indexOf('»'));
});

test('does not mistake Russian guillemets inside a draft for composer markers', () => {
  const draft = '› Исправь кнопку «Старт» сейчас';
  assert.equal(findLastCodexComposerPromptIndex(draft), 0);
  assert.equal(hasCodexComposerPromptGlyph('Обычная строка: «готово»'), false);
});

test('a current startup blocker wins over a visible composer', () => {
  const inspected = inspectCodexInputReadyTextCore(readyFrame('»'), '', {
    requireSyncMarker: false,
    blockers: ['mcp-startup'],
  });
  assert.equal(inspected.ready, false);
  assert.equal(inspected.reason, 'blocked:mcp-startup');
  assert.equal(inspected.hasComposerFrame, true);
});

test('MCP watchdog only restarts from current positive blocker evidence', () => {
  assert.deepEqual(decideCodexMcpStartupDeadline({
    observationAvailable: true,
    inspected: { ready: true, blockers: [] },
  }), { action: 'mark-ready', reason: 'current-composer-ready' });

  assert.deepEqual(decideCodexMcpStartupDeadline({
    observationAvailable: true,
    inspected: { ready: false, blockers: [] },
  }), { action: 'cancel', reason: 'mcp-startup-not-current' });

  assert.deepEqual(decideCodexMcpStartupDeadline({
    observationAvailable: false,
    inspected: null,
  }), { action: 'retry', reason: 'current-state-unavailable' });

  assert.deepEqual(decideCodexMcpStartupDeadline({
    observationAvailable: true,
    inspected: { ready: false, blockers: ['mcp-startup'] },
    mcpVisible: true,
    destructiveProofAvailable: false,
  }), { action: 'retry', reason: 'destructive-proof-unavailable' });

  assert.deepEqual(decideCodexMcpStartupDeadline({
    observationAvailable: true,
    inspected: { ready: false, blockers: ['mcp-startup'] },
    mcpVisible: true,
    destructiveProofAvailable: true,
  }), { action: 'restart', reason: 'mcp-startup-current' });
});

test('current interactive frame excludes an obsolete MCP line above the composer', () => {
  const frame = selectCodexCurrentInteractiveFrameText([
    { row: 10, text: 'Starting MCP servers (1/2)' },
    { row: 11, text: 'old output' },
    { row: 12, text: '» Find and fix a bug in @filename' },
    { row: 13, text: 'gpt-5.6-sol · Full Access · Context 70% used' },
  ], 12);
  assert.equal(frame.includes('Starting MCP servers'), false);
  assert.equal(frame.startsWith('» Find and fix'), true);
  const fromText = selectCodexCurrentInteractiveFrameText([
    'Starting MCP servers (1/2)',
    '» Find and fix a bug in @filename',
    'gpt-5.6-sol · Full Access',
  ].join('\n'));
  assert.equal(fromText.includes('Starting MCP servers'), false);
});

test('current interactive frame retains a blocker rendered after an old composer', () => {
  const frame = selectCodexCurrentInteractiveFrameText([
    { row: 10, text: '› old composer' },
    { row: 11, text: 'Starting MCP servers (1/2)' },
    { row: 12, text: 'esc to interrupt' },
  ]);
  assert.equal(frame.includes('Starting MCP servers'), true);
});

test('MCP watchdog refuses a signal after lifecycle or screen sequence changes', () => {
  const watchdog = {};
  const base = {
    expectedWatchdog: watchdog,
    currentWatchdog: watchdog,
    expectedLaunchId: 'launch-1',
    currentLaunchId: 'launch-1',
    expectedWriteSeq: 41,
    currentWriteSeq: 41,
    expectedInputRevision: 9,
    currentInputRevision: 9,
  };
  assert.equal(isCodexMcpRestartSignalSafe(base), true);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentWriteSeq: 42 }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentInputRevision: 10 }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentLaunchId: 'launch-2' }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, inputReady: true }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, promptOrTurnInFlight: true }), false);
});

test('a replacement launch requires a confirmed successful stop', () => {
  assert.equal(shouldLaunchCodexMcpReplacement({ success: true }), true);
  assert.equal(shouldLaunchCodexMcpReplacement({ success: false }), false);
  assert.equal(shouldLaunchCodexMcpReplacement(null), false);
});
