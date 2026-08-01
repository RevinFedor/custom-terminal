const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyCodexMcpStartupBlockerHandling,
  decideCodexMcpReplacementHandoff,
  decideCodexMcpStoppedGenerationSettlement,
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

test('authoritative current MCP blocker is never ignored after READY or during a prompt', () => {
  assert.deepEqual(classifyCodexMcpStartupBlockerHandling({
    authoritativeCurrentFrame: true,
    alreadyReady: true,
    startupLifecycleFresh: false,
  }), {
    ignore: false,
    reason: 'authoritative-current-frame',
  });
  assert.deepEqual(classifyCodexMcpStartupBlockerHandling({
    authoritativeCurrentFrame: true,
    promptOrTurnInFlight: true,
    startupLifecycleFresh: true,
  }), {
    ignore: false,
    reason: 'authoritative-current-frame',
  });
});

test('historical raw MCP blocker can still be ignored outside the startup lifecycle', () => {
  assert.deepEqual(classifyCodexMcpStartupBlockerHandling({
    alreadyReady: true,
    startupLifecycleFresh: false,
  }), {
    ignore: true,
    reason: 'already-ready',
  });
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
    'historical command output',
    '» Find and fix a bug in @filename',
    'gpt-5.6-sol · Full Access',
  ].join('\n'));
  assert.equal(fromText.includes('Starting MCP servers'), false);
});

test('current interactive frame retains a live MCP status band immediately above the composer', () => {
  const frame = selectCodexCurrentInteractiveFrameText([
    { row: 20, text: 'Starting MCP servers (0/12): docs, terminal' },
    { row: 21, text: '' },
    { row: 22, text: '› Find and fix a bug in @filename' },
    { row: 23, text: 'gpt-5.6-sol · Full Access · Context 70% used' },
  ], 22);
  assert.equal(frame.includes('Starting MCP servers (0/12)'), true);
  const inspected = inspectCodexInputReadyTextCore(frame, '', {
    requireSyncMarker: false,
    blockers: ['mcp-startup'],
  });
  assert.equal(inspected.ready, false);
  assert.equal(inspected.reason, 'blocked:mcp-startup');
});

test('current interactive frame retains a wrapped live MCP band owned by its interrupt footer', () => {
  const frame = selectCodexCurrentInteractiveFrameText([
    { row: 30, text: 'Starting MCP servers (0/12):' },
    { row: 31, text: 'browser, codex_apps, electron, terminal' },
    { row: 32, text: '(0s • esc to interrupt)' },
    { row: 33, text: '' },
    { row: 34, text: '› Summarize this codebase' },
    { row: 35, text: 'gpt-5.6-sol · Full Access' },
  ], 34);
  assert.equal(frame.includes('Starting MCP servers (0/12)'), true);
  assert.equal(frame.includes('browser, codex_apps'), true);
  assert.equal(frame.includes('esc to interrupt'), true);
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
  const terminal = {};
  const base = {
    expectedWatchdog: watchdog,
    currentWatchdog: watchdog,
    expectedTerminal: terminal,
    currentTerminal: terminal,
    expectedTerminalGeneration: 'terminal-a:4',
    currentTerminalGeneration: 'terminal-a:4',
    expectedRunSeq: 4,
    currentRunSeq: 4,
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
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentRunSeq: 5 }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentTerminal: {} }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentTerminalGeneration: 'terminal-b:4' }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentLaunchId: 'launch-2' }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, inputReady: true }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, promptOrTurnInFlight: true }), false);
});

test('a replacement launch requires a confirmed successful stop', () => {
  assert.equal(shouldLaunchCodexMcpReplacement({ success: true }), true);
  assert.equal(shouldLaunchCodexMcpReplacement({ success: false }), false);
  assert.equal(shouldLaunchCodexMcpReplacement(null), false);
});

test('MCP replacement inherits only the exact stopped launch generation', () => {
  const base = {
    stopSucceeded: true,
    sameTerminal: true,
    expectedTerminalGeneration: 'terminal-a:4',
    currentTerminalGeneration: 'terminal-a:4',
    expectedRunSeq: 4,
    currentRunSeq: 4,
    expectedInputRevision: 9,
    currentInputRevision: 9,
    expectedLaunchId: 'launch-old',
    currentLaunchId: 'launch-old',
    processStatus: 'absent',
  };
  assert.deepEqual(decideCodexMcpReplacementHandoff(base), {
    allowed: true,
    reason: 'exact-stopped-launch-handoff',
  });
  assert.equal(decideCodexMcpReplacementHandoff({
    ...base,
    currentRunSeq: 5,
  }).reason, 'terminal-run-changed');
  assert.equal(decideCodexMcpReplacementHandoff({
    ...base,
    currentInputRevision: 10,
  }).reason, 'terminal-input-changed');
  assert.equal(decideCodexMcpReplacementHandoff({
    ...base,
    currentLaunchId: 'manual-launch',
  }).reason, 'launch-generation-changed');
  assert.equal(decideCodexMcpReplacementHandoff({
    ...base,
    processStatus: 'found',
  }).reason, 'replacement-process-already-present');
  assert.equal(decideCodexMcpReplacementHandoff({
    ...base,
    processStatus: 'unknown',
  }).reason, 'replacement-process-state-unknown');
  assert.equal(decideCodexMcpReplacementHandoff({
    ...base,
    watchdogSuperseded: true,
  }).reason, 'watchdog-generation-changed');
});

test('a stopped watchdog generation settles from its exact stop proof when refresh is unknown', () => {
  const base = {
    stopAbsenceProven: true,
    sameTerminal: true,
    expectedTerminalGeneration: 'terminal-a:4',
    currentTerminalGeneration: 'terminal-a:4',
    expectedRunSeq: 4,
    currentRunSeq: 4,
    expectedInputRevision: 9,
    currentInputRevision: 9,
    expectedLaunchId: 'launch-old',
    currentLaunchId: 'launch-old',
    replacementInputBarrierOwned: true,
    processStatus: 'unknown',
  };
  assert.deepEqual(decideCodexMcpStoppedGenerationSettlement(base), {
    allowed: true,
    reason: 'exact-stopped-generation-settlement-from-stop-proof',
  });
  assert.equal(decideCodexMcpStoppedGenerationSettlement({
    ...base,
    processStatus: 'found',
  }).reason, 'replacement-process-already-present');
  assert.equal(decideCodexMcpStoppedGenerationSettlement({
    ...base,
    replacementInputBarrierOwned: false,
  }).reason, 'replacement-input-barrier-changed');
  assert.equal(decideCodexMcpStoppedGenerationSettlement({
    ...base,
    currentInputRevision: 10,
  }).reason, 'terminal-input-changed');
});
