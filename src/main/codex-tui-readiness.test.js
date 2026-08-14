const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyCodexMcpStartupBlockerHandling,
  decideCodexLateMcpCommittedFrame,
  decideClaimedCodexMcpReplacementHandoff,
  decideCodexMcpReplacementHandoff,
  decideCodexMcpStoppedGenerationSettlement,
  decideCodexMcpStartupDeadline,
  decideCodexMcpWatchdogReconcile,
  findLastCodexComposerPromptIndex,
  hasCodexComposerPromptGlyph,
  inspectCodexInputReadyTextCore,
  isCodexMcpRestartSignalSafe,
  parseCodexVerifiedComposerFooter,
  selectCodexCurrentInteractiveFrameText,
  shouldLaunchCodexMcpReplacement,
  shouldSuppressCodexMcpWatchdogArmForReplacementHandoff,
  stripLeadingCodexComposerPromptGlyph,
  validateCodexLateMcpRecoveryIdentity,
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

test('recognizes the fresh-conversation cwd footer without depending on placeholder prose', () => {
  const frame = [
    '› Write tests for @filename',
    'gpt-5.6-luna medium fast · /private/tmp/nested-workspace…',
  ].join('\n');
  const inspected = inspectCodexInputReadyTextCore(frame, '', {
    requireSyncMarker: false,
    source: 'headless-main',
  });
  assert.equal(inspected.ready, true);
  assert.equal(inspected.hasPromptGlyph, true);
  assert.deepEqual(parseCodexVerifiedComposerFooter(frame), {
    model: 'gpt-5.6-luna',
    effort: 'medium',
    fast: true,
    proof: 'verified-composer-footer',
  });
});

test('recognizes the narrow Codex composer footer captured after Resume', () => {
  const frame = [
    '⚠ Heads up, you have less than 5% of your weekly limit left. Run /status for a breakdown.',
    '› Write tests for @filename',
    'gpt-5.6-sol max · Full Acces… Goal achieved (53s)',
  ].join('\n');
  const inspected = inspectCodexInputReadyTextCore(frame, '', {
    requireSyncMarker: false,
    source: 'production-resume-frame',
  });
  assert.equal(inspected.ready, true);
  assert.equal(inspected.hasPromptGlyph, true);
  assert.deepEqual(parseCodexVerifiedComposerFooter(frame), {
    model: 'gpt-5.6-sol',
    effort: 'max',
    fast: false,
    proof: 'verified-composer-footer',
  });
});

test('recognizes the extra-narrow Codex composer footer captured after reload', () => {
  const frame = [
    '› Write tests for @filename',
    'gpt-5.6-sol max · Ful… Goal achieved (24m)',
  ].join('\n');
  const inspected = inspectCodexInputReadyTextCore(frame, '', {
    requireSyncMarker: false,
    source: 'production-reload-frame',
  });
  assert.equal(inspected.ready, true);
  assert.equal(inspected.hasPromptGlyph, true);
  assert.deepEqual(parseCodexVerifiedComposerFooter(frame), {
    model: 'gpt-5.6-sol',
    effort: 'max',
    fast: false,
    proof: 'verified-composer-footer',
  });
});

test('ignores the decorative Codex footer tail after the stable model and effort prefix', () => {
  const frame = [
    '› Write tests for @filename',
    'gpt-5.6-sol max fast · a future Codex footer that this app does not know',
  ].join('\n');
  assert.deepEqual(parseCodexVerifiedComposerFooter(frame), {
    model: 'gpt-5.6-sol',
    effort: 'max',
    fast: true,
    proof: 'verified-composer-footer',
  });
  assert.equal(inspectCodexInputReadyTextCore(frame, '', {
    requireSyncMarker: false,
    source: 'future-decorative-footer',
  }).ready, true);
});

test('does not accept prose that merely contains a model and effort', () => {
  for (const footer of [
    'assistant: gpt-5.6-sol max · Full Access',
    'gpt-5.6-sol max is what the user selected',
    'gpt-5.6-sol default · Full Access',
  ]) {
    const frame = ['› Write tests for @filename', footer].join('\n');
    assert.equal(parseCodexVerifiedComposerFooter(frame), null);
  }
});

test('cwd footer is not readiness proof without the current composer prompt', () => {
  const inspected = inspectCodexInputReadyTextCore(
    'gpt-5.6-luna medium fast · /private/tmp/old-scrollback',
    '',
    { requireSyncMarker: false },
  );
  assert.equal(inspected.ready, false);
  assert.equal(inspected.reason, 'no-composer-frame');
});

test('current startup blocker still wins over a cwd composer footer', () => {
  const inspected = inspectCodexInputReadyTextCore([
    'Starting MCP servers (1/2)',
    '› Write tests for @filename',
    'gpt-5.6-luna medium fast · /private/tmp/nested-workspace',
  ].join('\n'), '', {
    requireSyncMarker: false,
    blockers: ['mcp-startup'],
  });
  assert.equal(inspected.ready, false);
  assert.equal(inspected.reason, 'blocked:mcp-startup');
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

test('late MCP raw hint resolves only on its exact committed current frame', () => {
  assert.deepEqual(decideCodexLateMcpCommittedFrame({
    identityCurrent: true,
    candidateWriteSeq: null,
    committedWriteSeq: 8,
    authoritativeFrameCommitted: true,
    inspected: { ready: true, blockers: [] },
  }), { action: 'wait', reason: 'candidate-frame-not-committed' });
  assert.deepEqual(decideCodexLateMcpCommittedFrame({
    identityCurrent: true,
    candidateWriteSeq: 8,
    committedWriteSeq: null,
    authoritativeFrameCommitted: true,
    inspected: { ready: true, blockers: [] },
  }), { action: 'wait', reason: 'candidate-frame-not-committed' });
  assert.deepEqual(decideCodexLateMcpCommittedFrame({
    identityCurrent: false,
    candidateWriteSeq: 12,
    committedWriteSeq: 12,
    authoritativeFrameCommitted: true,
    inspected: { ready: false, blockers: ['mcp-startup'] },
  }), {
    action: 'cancel',
    reason: 'lifecycle-changed',
  });
  assert.deepEqual(decideCodexLateMcpCommittedFrame({
    identityCurrent: true,
    candidateWriteSeq: 12,
    committedWriteSeq: 11,
    authoritativeFrameCommitted: true,
    inspected: { ready: false, blockers: ['mcp-startup'] },
  }), {
    action: 'wait',
    reason: 'candidate-frame-not-committed',
  });
  assert.deepEqual(decideCodexLateMcpCommittedFrame({
    identityCurrent: true,
    candidateWriteSeq: 12,
    committedWriteSeq: 12,
    authoritativeFrameCommitted: true,
    inspected: { ready: false, blockers: ['mcp-startup'] },
  }), {
    action: 'block',
    reason: 'current-blocker:mcp-startup',
  });
  assert.deepEqual(decideCodexLateMcpCommittedFrame({
    identityCurrent: true,
    candidateWriteSeq: 12,
    committedWriteSeq: 13,
    authoritativeFrameCommitted: true,
    inspected: { ready: true, blockers: [] },
  }), {
    action: 'clear',
    reason: 'current-composer-ready',
  });
});

test('late MCP recovery authority belongs to one exact launch and input generation', () => {
  const terminal = {};
  const base = {
    expectedTerminal: terminal,
    currentTerminal: terminal,
    expectedTerminalGeneration: 'terminal-a:3',
    currentTerminalGeneration: 'terminal-a:3',
    expectedRunSeq: 7,
    currentRunSeq: 7,
    expectedInputRevision: 4,
    currentInputRevision: 4,
    expectedLaunchId: 'launch-7',
    currentLaunchId: 'launch-7',
  };
  assert.deepEqual(validateCodexLateMcpRecoveryIdentity(base), {
    valid: true,
    reason: 'exact-late-mcp-recovery-generation',
  });
  assert.equal(validateCodexLateMcpRecoveryIdentity({
    ...base,
    currentInputRevision: 5,
  }).reason, 'terminal-input-changed');
  assert.equal(validateCodexLateMcpRecoveryIdentity({
    ...base,
    currentRunSeq: 8,
  }).reason, 'terminal-run-changed');
  assert.equal(validateCodexLateMcpRecoveryIdentity({
    ...base,
    currentLaunchId: 'launch-8',
  }).reason, 'launch-generation-changed');
  assert.equal(validateCodexLateMcpRecoveryIdentity({
    ...base,
    currentProcessRunning: false,
  }).reason, 'terminal-process-stopped');
  assert.equal(validateCodexLateMcpRecoveryIdentity({
    ...base,
    currentStopping: true,
  }).reason, 'terminal-stopping');
  assert.equal(validateCodexLateMcpRecoveryIdentity({
    ...base,
    expectedRunSeq: 0,
    currentRunSeq: 0,
  }).reason, 'terminal-run-changed');
});

test('MCP watchdog only restarts from current positive blocker evidence', () => {
  assert.deepEqual(decideCodexMcpStartupDeadline({
    observationAvailable: true,
    inspected: { ready: true, blockers: [] },
  }), { action: 'mark-ready', reason: 'current-composer-ready' });

  assert.deepEqual(decideCodexMcpStartupDeadline({
    observationAvailable: true,
    inspected: { ready: false, blockers: [] },
  }), { action: 'retry', reason: 'current-frame-transitional' });

  assert.deepEqual(decideCodexMcpStartupDeadline({
    observationAvailable: true,
    inspected: { ready: false, blockers: ['auth-required'] },
  }), { action: 'cancel', reason: 'different-current-blocker' });

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

test('MCP watchdog survives an animated redraw gap until a decisive frame arrives', () => {
  assert.deepEqual(decideCodexMcpWatchdogReconcile({
    inspected: { ready: false, reason: 'blocked:mcp-startup', blockers: ['mcp-startup'] },
    mcpVisible: true,
  }), { action: 'keep', reason: 'mcp-startup-current' });
  assert.deepEqual(decideCodexMcpWatchdogReconcile({
    inspected: { ready: false, reason: 'no-codex-ui-text', blockers: [] },
    mcpVisible: false,
  }), { action: 'keep', reason: 'current-frame-transitional' });
  assert.deepEqual(decideCodexMcpWatchdogReconcile({
    inspected: { ready: true, reason: 'ready', blockers: [] },
    mcpVisible: false,
    synchronizedOutputOpen: true,
  }), { action: 'keep', reason: 'current-frame-transitional' });
  assert.deepEqual(decideCodexMcpWatchdogReconcile({
    inspected: { ready: true, reason: 'ready', blockers: [] },
    mcpVisible: false,
  }), { action: 'clear', reason: 'current-composer-ready' });
  assert.deepEqual(decideCodexMcpWatchdogReconcile({
    inspected: { ready: false, reason: 'blocked:auth-required', blockers: ['auth-required'] },
    mcpVisible: false,
  }), { action: 'clear', reason: 'different-current-blocker' });
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

test('MCP watchdog requires an exact lifecycle and a current committed MCP frame', () => {
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
    expectedMirrorGeneration: 'mirror-a',
    currentMirrorGeneration: 'mirror-a',
    expectedWriteSeq: 41,
    currentWriteSeq: 41,
    expectedCommittedFrameGeneration: 7,
    currentCommittedFrameGeneration: 7,
    expectedInputRevision: 9,
    currentInputRevision: 9,
    mcpStartupBlockerCurrent: true,
  };
  assert.equal(isCodexMcpRestartSignalSafe(base), true);
  assert.equal(isCodexMcpRestartSignalSafe({
    ...base,
    currentWriteSeq: 42,
    currentCommittedFrameGeneration: 8,
  }), true);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentWriteSeq: 40 }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentCommittedFrameGeneration: 6 }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentInputRevision: 10 }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentRunSeq: 5 }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentTerminal: {} }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentTerminalGeneration: 'terminal-b:4' }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentLaunchId: 'launch-2' }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, currentMirrorGeneration: 'mirror-b' }), false);
  assert.equal(isCodexMcpRestartSignalSafe({ ...base, mcpStartupBlockerCurrent: false }), false);
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

test('claimed MCP replacement advances from the stopped generation to one exact new generation', () => {
  const base = {
    sameTerminal: true,
    expectedTerminalGeneration: 'terminal-a:5',
    currentTerminalGeneration: 'terminal-a:5',
    previousRunSeq: 4,
    expectedRunSeq: 5,
    currentRunSeq: 5,
    expectedInputRevision: 9,
    currentInputRevision: 9,
    expectedLaunchId: 'launch-new',
    currentLaunchId: 'launch-new',
    processStatus: 'absent',
    replacementInputBarrierOwned: true,
  };
  assert.deepEqual(decideClaimedCodexMcpReplacementHandoff(base), {
    allowed: true,
    reason: 'exact-claimed-replacement-handoff',
  });
  assert.equal(decideClaimedCodexMcpReplacementHandoff({
    ...base,
    expectedTerminalGeneration: 'terminal-a:4',
  }).reason, 'terminal-generation-changed');
  assert.equal(decideClaimedCodexMcpReplacementHandoff({
    ...base,
    expectedRunSeq: 6,
    currentRunSeq: 6,
  }).reason, 'replacement-run-transition-invalid');
  assert.equal(decideClaimedCodexMcpReplacementHandoff({
    ...base,
    currentRunSeq: 6,
  }).reason, 'terminal-run-changed');
  assert.equal(decideClaimedCodexMcpReplacementHandoff({
    ...base,
    currentInputRevision: 10,
  }).reason, 'terminal-input-changed');
  assert.equal(decideClaimedCodexMcpReplacementHandoff({
    ...base,
    currentLaunchId: 'manual-launch',
  }).reason, 'launch-generation-changed');
  assert.equal(decideClaimedCodexMcpReplacementHandoff({
    ...base,
    processStatus: 'found',
  }).reason, 'replacement-process-already-present');
  assert.equal(decideClaimedCodexMcpReplacementHandoff({
    ...base,
    replacementInputBarrierOwned: false,
  }).reason, 'replacement-input-barrier-changed');
});

test('an owned Stop-to-replacement handoff suppresses residual watchdog generations only until write', () => {
  for (const handoffPhase of ['stopping', 'stopped', 'claiming', 'claimed']) {
    assert.equal(shouldSuppressCodexMcpWatchdogArmForReplacementHandoff({
      handoffOwned: true,
      handoffPhase,
    }), true, handoffPhase);
  }
  assert.equal(shouldSuppressCodexMcpWatchdogArmForReplacementHandoff({
    handoffOwned: false,
    handoffPhase: 'stopped',
  }), false);
  assert.equal(shouldSuppressCodexMcpWatchdogArmForReplacementHandoff({
    handoffOwned: true,
    handoffPhase: 'released',
  }), false);
  assert.equal(shouldSuppressCodexMcpWatchdogArmForReplacementHandoff(), false);
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
