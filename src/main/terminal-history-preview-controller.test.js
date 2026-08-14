'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTerminalHistoryPreviewController,
} = require('./terminal-history-preview-controller');

function createHarness() {
  const emitted = [];
  const logs = [];
  const timers = new Map();
  let timerSeq = 0;
  let markerLine = 10;
  const terminal = {};
  const mirrorTerminal = {
    registerMarker() {
      const marker = {
        line: markerLine,
        isDisposed: false,
        dispose() { this.isDisposed = true; },
      };
      return marker;
    },
  };
  const mirror = {
    generation: 'mirror-a',
    generationOrdinal: 4,
    terminal: mirrorTerminal,
  };
  let lifecycleGeneration = 'life-a:1';
  let enabled = true;
  let context = { terminal, mirror, lifecycleGeneration };
  const controller = createTerminalHistoryPreviewController({
    getContext: () => context,
    readFrame: ({ state, snapshot }) => {
      if (snapshot.useExactBaseline === true) {
        return {
          status: 'ready',
          reason: 'owned-output-after-exact-jsonl-frame-baseline',
          boundaryKind: 'exact-jsonl-frame-baseline',
          boundaryRow: 9,
          physicalLines: snapshot.lines,
          baselinePhysicalLines: state.rebaseBaselineSnapshot?.lines || [],
          baselineFrameGeneration:
            state.rebaseBaselineSnapshot?.committedFrameGeneration ?? null,
          baselineWriteSeq: state.rebaseBaselineSnapshot?.writeSeq ?? null,
        };
      }
      return {
        status: 'ready',
        reason: 'test-frame',
        physicalLines: snapshot.lines.filter((line) => (
          line.row > Number(state.marker?.line ?? 10)
        )),
      };
    },
    emit: (detail) => emitted.push(detail),
    log: {
      log: (line) => logs.push(line),
      warn: (line) => logs.push(line),
      error: (line) => logs.push(line),
    },
    now: (() => {
      let value = 1000;
      return () => ++value;
    })(),
    setTimer: (fn) => {
      const id = ++timerSeq;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    isEnabled: () => enabled,
  });
  const flushTimers = () => {
    for (const [id, fn] of Array.from(timers)) {
      timers.delete(id);
      fn();
    }
  };
  const frame = (lines, extra = {}) => ({
    authoritativeFrameCommitted: true,
    mirrorGeneration: mirror.generation,
    committedFrameGeneration: 7,
    writeSeq: 9,
    viewportY: 10,
    lines,
    ...extra,
  });
  return {
    controller,
    emitted,
    logs,
    mirror,
    frame,
    flushTimers,
    setMarkerLine: (value) => { markerLine = value; },
    setEnabled: (value) => { enabled = value; },
    replaceLifecycle: (value) => {
      lifecycleGeneration = value;
      context = { terminal, mirror, lifecycleGeneration };
    },
  };
}

test('publishes terminal output only after an exact owned committed frame', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'session-a',
    turnId: 'turn-a',
    promptText: 'question',
  });
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 10, text: 'question', wrapped: false },
    { row: 11, text: 'streamed answer', wrapped: false },
    { row: 12, text: '❯ ', wrapped: false },
  ])), true);
  assert.equal(h.emitted.length, 0, 'renderer updates are coalesced');
  h.flushTimers();
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].action, 'update');
  assert.equal(h.emitted[0].preview.text, 'streamed answer');
  assert.match(h.logs.join('\n'), /FRAME .*frame=7 .*writeSeq=9/);
});

test('late exact Codex prompt may arm an absent turn but cannot replace an active one', () => {
  const h = createHarness();
  const started = h.controller.beginIfAbsent({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    promptText: 'late exact prompt',
    sourceSequence: 7,
    sourceBoundary: 200,
  });
  assert.equal(started?.turnId, 'turn-a');

  const rejected = h.controller.beginIfAbsent({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-b',
    turnId: 'turn-b',
    promptText: 'foreign prompt',
  });
  assert.equal(rejected, null);

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 10, text: 'late exact prompt', wrapped: false },
    { row: 11, text: '• streamed Codex answer', wrapped: false },
    { row: 12, text: '› ', wrapped: false },
  ])), true);
  h.flushTimers();
  assert.equal(h.emitted.at(-1).preview.turnId, 'turn-a');
  assert.equal(h.emitted.at(-1).preview.text, 'streamed Codex answer');
});

test('Claude activity repaint cannot poison the first assistant frame', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'session-a',
    turnId: 'turn-a',
  });
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '✳ Reticulating… (1s · ↓ 2 tokens)', wrapped: false },
    { row: 12, text: '❯ ', wrapped: false },
  ])), false);
  h.flushTimers();
  assert.equal(h.emitted.length, 0);
  assert.match(h.logs.join('\n'), /WAIT .*reason=only-composer-or-status/);

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'Настоящий ответ уже печатается.', wrapped: false },
    { row: 12, text: '✳ Recombobulating…', wrapped: false },
    { row: 13, text: '  ⎿ Tip: Running multiple Claude sessions?', wrapped: false },
    { row: 14, text: '     Use /color and /rename to tell them apart.', wrapped: false },
    { row: 15, text: '❯ ', wrapped: false },
  ], { committedFrameGeneration: 8, writeSeq: 10 })), true);
  h.flushTimers();
  assert.equal(h.emitted.at(-1).preview.text, 'Настоящий ответ уже печатается.');
});

test('Claude non-trailing activity frame waits instead of freezing the later answer', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'session-a',
    turnId: 'turn-a',
  });
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '✳ Boogieing…', wrapped: false },
    { row: 12, text: '  ⎿ Tip: You can control workflow size in /config.', wrapped: false },
    { row: 13, text: '[Opus 5] 0%', wrapped: false },
  ])), false);
  h.flushTimers();
  assert.equal(h.emitted.length, 0);
  assert.match(h.logs.join('\n'), /WAIT .*systemBlocks=activity/);

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '✳ Boogieing…', wrapped: false },
    { row: 12, text: '  ⎿ Tip: You can control workflow size in \/config.', wrapped: false },
    { row: 13, text: '⏺ STREAM-CLAUDE-1 Настоящий ответ уже печатается.', wrapped: false },
    { row: 14, text: '❯ ', wrapped: false },
  ], { committedFrameGeneration: 8, writeSeq: 10 })), true);
  h.flushTimers();
  assert.equal(
    h.emitted.at(-1).preview.text,
    'STREAM-CLAUDE-1 Настоящий ответ уже печатается.',
  );
});

test('Claude bare expandable thinking repaint cannot poison the later assistant frame', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'session-a',
    turnId: 'turn-a',
  });
  const systemStyle = {
    firstTextStyle: 'fg=1:8,bg=0:-1,dim',
    hasDim: true,
    allTextDim: true,
    hasNonDefaultFg: true,
  };
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'Thinking for 45s… (ctrl+o to expand)', wrapped: false, ...systemStyle },
    { row: 12, text: '    I am mapping out how globalTabMru works.', wrapped: false, ...systemStyle },
    { row: 13, text: '    That defeats the purpose of…', wrapped: false, ...systemStyle },
    { row: 14, text: '❯ ', wrapped: false },
  ])), false);
  h.flushTimers();
  assert.equal(h.emitted.length, 0);
  assert.match(h.logs.join('\n'), /WAIT .*systemBlocks=structured-summary .*styleEvidence=true/);

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'Thought for 45s (ctrl+o to expand)', wrapped: false, ...systemStyle },
    { row: 12, text: '    That defeats the purpose of…', wrapped: false, ...systemStyle },
    { row: 13, text: '⏺ Проверил код — теперь могу ответить предметно.', wrapped: false },
    { row: 14, text: '❯ ', wrapped: false },
  ], { committedFrameGeneration: 8, writeSeq: 10 })), true);
  h.flushTimers();
  assert.equal(
    h.emitted.at(-1).preview.text,
    'Проверил код — теперь могу ответить предметно.',
  );
  assert.doesNotMatch(h.emitted.at(-1).preview.text, /That defeats the purpose/);
});

test('Codex search, call and compaction chrome cannot poison the first answer frame', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
  });
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '• Calling electron.electron_connect({"port":9224})', wrapped: false },
    { row: 12, text: '', wrapped: false },
    { row: 13, text: '• Searching the web', wrapped: false },
    { row: 14, text: '', wrapped: false },
    { row: 15, text: 'Context compacted', wrapped: false },
    { row: 16, text: '› ', wrapped: false },
  ])), false);
  h.flushTimers();
  assert.equal(h.emitted.length, 0);
  assert.match(
    h.logs.join('\n'),
    /WAIT .*systemBlocks=tool-status,lifecycle-status/,
  );

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '• Calling electron.electron_connect({"port":9224})', wrapped: false },
    { row: 12, text: '• Searching the web', wrapped: false },
    { row: 13, text: '• Searched the web for official docs', wrapped: false },
    { row: 14, text: 'Context compacted', wrapped: false },
    { row: 15, text: '• Настоящий ответ уже печатается.', wrapped: false },
    { row: 16, text: '› ', wrapped: false },
  ], { committedFrameGeneration: 8, writeSeq: 10 })), true);
  h.flushTimers();
  assert.equal(h.emitted.at(-1).preview.text, 'Настоящий ответ уже печатается.');
});

test('Claude interruption and recap chrome cannot enter the first published answer', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'session-a',
    turnId: 'turn-a',
  });
  const systemStyle = {
    firstTextStyle: 'fg=1:8,bg=0:-1,dim',
    hasDim: true,
    allTextDim: true,
    hasNonDefaultFg: true,
  };
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '⏺ Частичный ответ уже виден.', wrapped: false },
    { row: 12, text: '  ⎿ Interrupted · What should Claude do', wrapped: false, ...systemStyle },
    { row: 13, text: '※ recap: Служебное резюме.', wrapped: false, ...systemStyle },
    { row: 14, text: '  (disable recaps in /config)', wrapped: false, ...systemStyle },
    { row: 15, text: '❯ ', wrapped: false },
  ])), true);
  h.flushTimers();
  assert.equal(h.emitted.at(-1).preview.text, 'Частичный ответ уже виден.');
  assert.match(h.logs.join('\n'), /FRAME .*systemBlocks=branch-status,system-card .*styleEvidence=true/);
});

test('foreign lifecycle clears the provisional preview instead of reusing it', () => {
  const h = createHarness();
  h.controller.begin({ tabId: 'tab-a', provider: 'codex', turnId: 'turn-a' });
  h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'owned output', wrapped: false },
  ]));
  h.flushTimers();
  h.replaceLifecycle('life-a:2');
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'foreign output', wrapped: false },
  ])), false);
  assert.equal(h.emitted.at(-1).action, 'clear');
  assert.equal(h.emitted.at(-1).reason, 'lifecycle-replaced');
  assert.equal(h.controller.get('tab-a'), null);
});

test('canonical assistant record clears and rebases an active preview', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    sourceSequence: 20,
  });
  h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'first block', wrapped: false },
  ]));
  h.flushTimers();
  h.setMarkerLine(20);
  assert.equal(h.controller.observeCanonical({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 21,
    identity: 'assistant-1',
  }), true);
  assert.equal(h.emitted.at(-1).action, 'clear');
  assert.equal(h.emitted.at(-1).reason, 'canonical-materialized');
  assert.equal(h.controller.get('tab-a'), null, 'rebased turn has no duplicate text yet');

  h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 21, text: 'second block', wrapped: false },
  ], { committedFrameGeneration: 8, writeSeq: 10 }));
  h.flushTimers();
  assert.equal(h.emitted.at(-1).preview.text, 'second block');
});

test('a late terminal paint of canonical text is suppressed while the fresh marker survives', () => {
  const h = createHarness();
  const canonical = 'Уже сохранённый точный ответ.';
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    sourceSequence: 20,
  });
  h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '• Working (1s • esc to interrupt)', wrapped: false },
  ]));
  h.setMarkerLine(20);
  assert.equal(h.controller.observeCanonical({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 21,
    identity: 'assistant-1',
    canonicalText: canonical,
  }), true);
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 21, text: '• ' + canonical, wrapped: false },
    { row: 22, text: '› ', wrapped: false },
  ], { committedFrameGeneration: 8, writeSeq: 10 })), false);
  h.flushTimers();
  assert.equal(h.controller.get('tab-a'), null);
  assert.match(h.logs.join('\n'), /CANONICAL_SUPPRESS .*reason=materialized-record-only/);
});

test('settled preview remains visible until the exact canonical record arrives', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'session-a',
    turnId: 'turn-a',
    sourceBoundary: 500,
  });
  h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'final terminal text', wrapped: false },
  ]));
  h.controller.finish({
    tabId: 'tab-a', provider: 'claude', turnId: 'turn-a', reason: 'stop',
  });
  assert.equal(h.emitted.at(-1).action, 'settle');
  assert.equal(h.controller.get('tab-a').phase, 'settled');

  assert.equal(h.controller.observeCanonical({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'session-a',
    sourceEndOffset: 499,
    identity: 'old-record',
  }), false);
  assert.equal(h.controller.get('tab-a').phase, 'settled');

  assert.equal(h.controller.observeCanonical({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'session-a',
    sourceEndOffset: 501,
    identity: 'assistant-new',
  }), true);
  assert.equal(h.emitted.at(-1).action, 'clear');
  assert.equal(h.controller.get('tab-a'), null);
});

test('a long scrolling turn keeps a bounded provisional tail', () => {
  const h = createHarness();
  h.controller.begin({ tabId: 'tab-a', provider: 'codex', turnId: 'turn-a' });
  const chunks = ['a', 'b', 'c', 'd', 'e'].map((char) => char.repeat(18_000));
  h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: chunks[0], wrapped: false },
  ]));
  h.flushTimers();
  for (let index = 1; index < chunks.length; index += 1) {
    h.controller.observeFrame('tab-a', h.mirror, h.frame([
      { row: 11, text: chunks[index - 1], wrapped: false },
      { row: 12, text: chunks[index], wrapped: false },
    ], { committedFrameGeneration: 7 + index, writeSeq: 9 + index }));
    h.flushTimers();
  }
  const current = h.controller.get('tab-a');
  assert.equal(current.text.length, 64 * 1024);
  assert.equal(current.truncated, true);
});

test('a full-screen redraw may dispose the xterm marker without ending the owned turn', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    turnId: 'turn-a',
    promptText: 'exact prompt',
  });
  const state = h.controller._turns.get('tab-a');
  state.marker.isDisposed = true;
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'stream survives redraw', wrapped: false },
  ])), true);
  h.flushTimers();
  assert.equal(h.emitted.at(-1).preview.text, 'stream survives redraw');
  assert.match(h.logs.join('\n'), /ANCHOR_LOST .*action=recover-from-exact-prompt/);
  assert.doesNotMatch(h.logs.join('\n'), /CLEAR .*reason=marker-disposed/);
});

test('late canonical user_message binds only the same prompt to the active turn', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
  });
  assert.equal(h.controller.bindPrompt({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    promptText: 'current prompt',
    sourceSequence: 12,
  }), true);
  assert.equal(h.controller.bindPrompt({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    promptText: 'queued next prompt',
    sourceSequence: 13,
  }), false);
  assert.equal(h.controller._turns.get('tab-a').promptText, 'current prompt');
  assert.match(h.logs.join('\n'), /PROMPT_BOUND/);
  assert.match(h.logs.join('\n'), /STALE .*reason=prompt-text-mismatch/);
});

test('exact Codex user_message upgrades only a newer provisional prompt tail', () => {
  const h = createHarness();
  const exactPrompt = 'full prompt prefix ' + 'x'.repeat(230) + ' exact tail';
  const provisionalTail = exactPrompt.slice(-200);
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    promptText: provisionalTail,
    promptSource: 'manual-terminal-enter',
    promptAuthority: 'provisional-tail',
    sourceSequence: 10,
    sourceBoundary: 100,
  });

  assert.equal(h.controller.bindPrompt({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    promptText: exactPrompt,
    promptSource: 'rollout-user-message',
    promptAuthority: 'exact-transcript',
    sourceSequence: 12,
    sourceBoundary: 100,
  }), true);
  const state = h.controller._turns.get('tab-a');
  assert.equal(state.promptText, exactPrompt);
  assert.equal(state.promptAuthority, 'exact-transcript');
  assert.match(h.logs.join('\n'), /PROMPT_UPGRADE .*proof=exact-transcript-contains-provisional-tail/);

  assert.equal(h.controller.bindPrompt({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    promptText: 'queued next prompt',
    promptSource: 'rollout-user-message',
    promptAuthority: 'exact-transcript',
    sourceSequence: 13,
    sourceBoundary: 300,
  }), false);
  assert.equal(state.promptText, exactPrompt);
});

test('exact thinking and tool boundaries rearm the next streamed answer block', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    sourceSequence: 20,
  });
  h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'first answer block', wrapped: false },
  ]));
  h.flushTimers();

  h.setMarkerLine(20);
  assert.equal(h.controller.observeCanonical({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 21,
    identity: 'assistant-1',
  }), true);
  h.setMarkerLine(30);
  assert.equal(h.controller.observeBoundary({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 22,
    identity: 'tool-1',
    kind: 'tool-use',
  }), true);

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 30, text: 'BASH tool output', wrapped: false },
    { row: 31, text: 'second answer block', wrapped: false },
  ], { committedFrameGeneration: 9, writeSeq: 11 })), true);
  h.flushTimers();
  assert.equal(h.emitted.at(-1).preview.text, 'second answer block');
  assert.match(h.logs.join('\n'), /BOUNDARY_REBASE .*kind=tool-use .*markerLine=30/);
});

test('disposed post-tool marker recovers from the exact committed frame baseline', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    sourceSequence: 40,
  });
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '• Working (1s • esc to interrupt)', wrapped: false },
    { row: 12, text: '', wrapped: false },
    { row: 13, text: '› ', wrapped: false },
  ])), false);

  h.setMarkerLine(20);
  assert.equal(h.controller.observeBoundary({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 41,
    identity: 'tool-result-41',
    kind: 'tool-result',
  }), true);
  const state = h.controller._turns.get('tab-a');
  assert.equal(state.rebaseBaselineSnapshot.committedFrameGeneration, 7);

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 20, text: '• Searched the web', wrapped: false },
    { row: 21, text: '', wrapped: false },
    { row: 22, text: '› ', wrapped: false },
  ], {
    committedFrameGeneration: 8,
    writeSeq: 10,
  })), false);
  assert.equal(state.rebaseBaselineSnapshot.committedFrameGeneration, 8);
  state.marker.isDisposed = true;

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 21, text: '• Searched the web', wrapped: false },
    { row: 22, text: '', wrapped: false },
    { row: 23, text: '• Настоящий ответ уже печатается.', wrapped: false },
    { row: 24, text: '› ', wrapped: false },
  ], {
    committedFrameGeneration: 9,
    writeSeq: 11,
    useExactBaseline: true,
  })), true);
  h.flushTimers();
  assert.equal(h.emitted.at(-1).preview.text, 'Настоящий ответ уже печатается.');
  assert.match(h.logs.join('\n'), /BASELINE_CAPTURE .*kind=tool-result/);
  assert.match(h.logs.join('\n'), /BASELINE_ADVANCE .*kind=tool-result/);
  assert.match(h.logs.join('\n'), /ANCHOR_LOST .*action=recover-from-exact-jsonl-baseline/);
  assert.match(h.logs.join('\n'), /BASELINE_DELTA .*kind=tool-result/);
});

test('JSONL-before-xterm ordering cannot duplicate an already materialized Codex paragraph', () => {
  const h = createHarness();
  const canonical = 'Здесь мыслительный поток собрал две важные вещи в одну.';
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    sourceSequence: 50,
  });
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '• Working (1s • esc to interrupt)', wrapped: false },
    { row: 12, text: '› ', wrapped: false },
  ])), false);

  h.setMarkerLine(20);
  assert.equal(h.controller.observeCanonical({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 51,
    identity: 'assistant-51',
    canonicalText: canonical,
  }), true);
  const state = h.controller._turns.get('tab-a');
  state.marker.isDisposed = true;

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 20, text: '• ' + canonical, wrapped: false },
    { row: 21, text: '› ', wrapped: false },
  ], {
    committedFrameGeneration: 8,
    writeSeq: 10,
    useExactBaseline: true,
  })), false);
  h.flushTimers();
  assert.equal(h.controller.get('tab-a'), null);
  assert.match(h.logs.join('\n'), /CANONICAL_SUPPRESS .*reason=materialized-record-only/);

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 20, text: '• ' + canonical, wrapped: false },
    { row: 21, text: '', wrapped: false },
    { row: 22, text: '• Новый абзац ещё не сохранён.', wrapped: false },
    { row: 23, text: '› ', wrapped: false },
  ], {
    committedFrameGeneration: 9,
    writeSeq: 11,
    useExactBaseline: true,
  })), true);
  h.flushTimers();
  assert.equal(h.emitted.at(-1).preview.text, 'Новый абзац ещё не сохранён.');
});

test('a redraw cannot prepend a historical Codex prompt to materialized assistant text', () => {
  const h = createHarness();
  const canonical = 'Да, это реальный провал приёмки, и точный ответ уже сохранён.';
  const promptStyle = {
    wrapped: false,
    activeByInverse: true,
    hasInverse: true,
    hasNonDefaultBg: true,
  };
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    sourceSequence: 50,
  });
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '• Working (1s • esc to interrupt)', wrapped: false },
    { row: 12, text: '› Use /skills to list available skills', wrapped: false },
  ])), false);

  h.setMarkerLine(20);
  assert.equal(h.controller.observeCanonical({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 51,
    identity: 'assistant-51',
    canonicalText: canonical,
  }), true);
  h.setMarkerLine(30);
  assert.equal(h.controller.observeBoundary({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 52,
    identity: 'tool-use-52',
    kind: 'tool-use',
  }), true);
  const state = h.controller._turns.get('tab-a');
  state.marker.isDisposed = true;

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 20, text: '› [Image #1] и как это понимать', ...promptStyle },
    { row: 21, text: '• ' + canonical, wrapped: false },
    { row: 22, text: '› Use /skills to list available skills', wrapped: false },
  ], {
    committedFrameGeneration: 8,
    writeSeq: 10,
    useExactBaseline: true,
  })), false);
  h.flushTimers();
  assert.equal(h.controller.get('tab-a'), null);
  assert.match(
    h.logs.join('\n'),
    /CANONICAL_SUPPRESS .*reason=materialized-record-only/,
  );
  assert.match(h.logs.join('\n'), /WAIT .*promptRowsRemoved=1/);

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 20, text: '› [Image #1] и как это понимать', ...promptStyle },
    { row: 21, text: '• ' + canonical, wrapped: false },
    { row: 22, text: '', wrapped: false },
    { row: 23, text: '• Новый ответ после Bash ещё не сохранён.', wrapped: false },
    { row: 24, text: '› Use /skills to list available skills', wrapped: false },
  ], {
    committedFrameGeneration: 9,
    writeSeq: 11,
    useExactBaseline: true,
  })), true);
  h.flushTimers();
  assert.equal(
    h.emitted.at(-1).preview.text,
    'Новый ответ после Bash ещё не сохранён.',
  );
  assert.match(h.logs.join('\n'), /FRAME .*promptRowsRemoved=1/);
});

test('task completion after canonical JSONL closes the turn before a late Codex repaint', () => {
  const h = createHarness();
  const canonical = [
    'Откуда знакома эта сцена?',
    'То есть распутывать нужно не все звенья аргумента.',
    'Нужно обнаружить порождающую предпосылку.',
  ].join('\n');
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    sourceSequence: 50,
  });
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '• Откуда знакома эта сцена?', wrapped: false },
  ])), true);
  h.flushTimers();

  h.setMarkerLine(20);
  assert.equal(h.controller.observeCanonical({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 51,
    identity: 'assistant-51',
    canonicalText: canonical,
  }), true);
  assert.equal(h.emitted.at(-1).action, 'clear');

  assert.equal(h.controller.finish({
    tabId: 'tab-a',
    provider: 'codex',
    turnId: 'turn-a',
    reason: 'task_complete',
  }), true);
  assert.equal(h.controller.get('tab-a'), null);
  const emittedAfterFinish = h.emitted.length;

  // Codex paints the final viewport after task_complete. It is the same
  // canonical answer, clipped by the viewport, and must not resurrect the
  // provisional block.
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 20, text: '• Откуда знакома эта сцена?', wrapped: false },
    { row: 21, text: 'То есть распутывать нужно не все звенья аргумента.', wrapped: false },
    { row: 22, text: 'Нужно обнаружить порождающую предпосылку.', wrapped: false },
    { row: 23, text: '› ', wrapped: false },
  ], {
    committedFrameGeneration: 9,
    writeSeq: 11,
    useExactBaseline: true,
  })), false);
  h.flushTimers();
  assert.equal(h.emitted.length, emittedAfterFinish);
  assert.match(h.logs.join('\n'), /SETTLE_CANONICAL .*reason=task_complete/);
});

test('a structured boundary after canonical keeps the final post-tool repaint eligible', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    sourceSequence: 50,
  });
  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: '• Working (1s • esc to interrupt)', wrapped: false },
  ])), false);
  h.setMarkerLine(20);
  assert.equal(h.controller.observeCanonical({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 51,
    identity: 'assistant-before-tool',
    canonicalText: 'Промежуточный ответ уже сохранён.',
  }), true);
  assert.equal(h.controller.observeBoundary({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 52,
    identity: 'tool-after-answer',
    kind: 'tool-use',
  }), true);
  assert.equal(h.controller.finish({
    tabId: 'tab-a',
    provider: 'codex',
    turnId: 'turn-a',
    reason: 'task_complete',
  }), true);
  assert.equal(h.controller.get('tab-a'), null);
  assert.equal(h.controller._turns.get('tab-a').phase, 'settled');

  assert.equal(h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 20, text: '• Финальный ответ после инструмента.', wrapped: false },
    { row: 21, text: '› ', wrapped: false },
  ], {
    committedFrameGeneration: 9,
    writeSeq: 11,
    useExactBaseline: true,
  })), true);
  h.flushTimers();
  assert.equal(h.emitted.at(-1).action, 'settle');
  assert.equal(h.emitted.at(-1).preview.text, 'Финальный ответ после инструмента.');
  assert.doesNotMatch(h.logs.join('\n'), /SETTLE_CANONICAL/);
});

test('a structured boundary never discards provisional text that is not canonical yet', () => {
  const h = createHarness();
  h.controller.begin({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    turnId: 'turn-a',
    sourceSequence: 30,
  });
  h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'answer waiting for JSONL', wrapped: false },
  ]));
  h.flushTimers();

  assert.equal(h.controller.observeBoundary({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    sourceSequence: 31,
    identity: 'tool-before-canonical',
    kind: 'tool-use',
  }), true);
  assert.equal(h.controller.get('tab-a', 'codex').text, 'answer waiting for JSONL');
  assert.match(h.logs.join('\n'), /BOUNDARY_HELD .*reason=provisional-text-not-yet-materialized/);
});

test('global disable clears every provisional turn and blocks new starts', () => {
  const h = createHarness();
  h.controller.begin({ tabId: 'tab-a', provider: 'codex', turnId: 'turn-a' });
  h.controller.observeFrame('tab-a', h.mirror, h.frame([
    { row: 11, text: 'visible preview', wrapped: false },
  ]));
  h.flushTimers();
  h.setEnabled(false);
  assert.equal(h.controller.clearAll('global-toggle-disabled'), 1);
  assert.equal(h.emitted.at(-1).action, 'clear');
  assert.equal(h.controller.begin({
    tabId: 'tab-a', provider: 'codex', turnId: 'turn-b',
  }), null);
  assert.match(h.logs.join('\n'), /START_SKIPPED .*reason=feature-disabled/);
});
