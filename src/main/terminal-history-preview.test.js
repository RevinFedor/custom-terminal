'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clampPreviewRegionLines,
  deriveTerminalHistoryPreviewTextAfterBaseline,
  extractTerminalHistoryPreviewText,
  findTerminalHistorySubmittedPromptBoundary,
  logicalTerminalLines,
  mergeTerminalHistoryPreviewText,
  subtractTerminalHistoryMaterializedText,
} = require('./terminal-history-preview');

const row = (text, extra = {}) => ({ text, wrapped: false, ...extra });

test('joins xterm wrapped rows and excludes Claude composer/status chrome', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('Первый длинный фраг'),
      row('мент ответа', { wrapped: true }),
      row(''),
      row('✻ Working (4s · esc to interrupt)'),
      row('❯ '),
      row('[Opus 5] 100%'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Первый длинный фрагмент ответа');
  assert.equal(result.composerFound, true);
});

test('a new Claude spinner verb is status, not the first streamed answer frame', () => {
  const statusOnly = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('✳ Reticulating… (1s · ↓ 2 tokens)'),
      row('❯ '),
    ],
  });
  assert.equal(statusOnly.status, 'empty');

  const withAnswer = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('Первый абзац уже печатается.'),
      row('✳ Recombobulating…'),
      row('  ⎿ Tip: Running multiple Claude sessions?'),
      row('     Use /color and /rename to tell them apart.'),
      row('❯ '),
    ],
  });
  assert.equal(withAnswer.status, 'text');
  assert.equal(withAnswer.text, 'Первый абзац уже печатается.');
});

test('Claude activity block may include an assistant bullet and changing multi-line tip', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('⏺ ✢ Calculating… (2s · ↓ 7 tokens)'),
      row('  ⎿ Tip: Paste images using control+v'),
      row('     rather than cmd+v.'),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'empty');
});

test('Claude activity chrome is removed even when later TUI footer rows make it non-trailing', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('✳ Boogieing…'),
      row('  ⎿ Tip: You can control how big a workflow is just by prompting.'),
      row('     Set a default with Dynamic workflow size in /config.'),
      row('[Opus 5] 0%'),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.filteredBlockKinds, ['activity']);
});

test('Claude answer after an earlier activity block becomes the first provisional text', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('✳ Boogieing…'),
      row('  ⎿ Tip: You can control workflow size in /config.'),
      row('⏺ STREAM-CLAUDE-1 Настоящий ответ уже печатается.'),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'STREAM-CLAUDE-1 Настоящий ответ уже печатается.');
  assert.deepEqual(result.filteredBlockKinds, ['activity']);
});

test('standalone Claude answer marker is chrome until prose reaches the frame', () => {
  const markerOnly = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('✳ Boogieing…'),
      row('  ⎿ Tip: You can control workflow size in /config.'),
      row('⏺'),
      row('❯ '),
    ],
  });
  assert.equal(markerOnly.status, 'empty');
  assert.equal(markerOnly.answerMarkerRemoved, true);

  const withProse = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('✳ Boogieing…'),
      row('  ⎿ Tip: You can control workflow size in /config.'),
      row('⏺ STREAM-CLAUDE-1 Настоящий ответ уже печатается.'),
      row('❯ '),
    ],
  });
  assert.equal(withProse.status, 'text');
  assert.equal(withProse.text, 'STREAM-CLAUDE-1 Настоящий ответ уже печатается.');
});

test('Claude interrupted and recap cards stay outside a partially streamed answer', () => {
  const systemStyle = {
    firstTextStyle: 'fg=1:8,bg=0:-1,dim',
    styles: ['fg=1:8,bg=0:-1,dim x12'],
    hasDim: true,
    allTextDim: true,
    hasNonDefaultFg: true,
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('⏺ Хорошо, ещё раз — пять абзацев.'),
      row('  Первый абзац уже частично появился.'),
      row('  ⎿ Interrupted · What should Claude do', systemStyle),
      row('※ recap: Ты тестировал длинный вывод.', systemStyle),
      row('  Никакой работы по коду не велось.', systemStyle),
      row('  (disable recaps in /config)', systemStyle),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(
    result.text,
    'Хорошо, ещё раз — пять абзацев.\n  Первый абзац уже частично появился.',
  );
  assert.deepEqual(result.filteredBlockKinds, ['branch-status', 'system-card']);
  assert.equal(result.styleEvidenceUsed, true);
  assert.equal(result.answerMarkerRemoved, true);
});

test('a tinted trailing Claude branch is system chrome without naming its message', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('⏺ Настоящий ответ.'),
      row('  ⎿ A future Claude status we do not enumerate', {
        firstTextStyle: 'fg=1:12,bg=0:-1,dim',
        hasNonDefaultFg: true,
        allTextDim: true,
      }),
      row('     Its child row follows the same card geometry.', {
        firstTextStyle: 'fg=1:12,bg=0:-1,dim',
        hasNonDefaultFg: true,
        allTextDim: true,
      }),
      row('❯ '),
    ],
  });
  assert.equal(result.text, 'Настоящий ответ.');
  assert.deepEqual(result.filteredBlockKinds, ['branch-status']);
  assert.equal(result.styleEvidenceUsed, true);
});

test('Claude bare expandable thinking card cannot become the first streamed answer', () => {
  const systemStyle = {
    firstTextStyle: 'fg=1:8,bg=0:-1,dim',
    styles: ['fg=1:8,bg=0:-1,dim x24'],
    hasDim: true,
    allTextDim: true,
    hasNonDefaultFg: true,
  };
  const systemOnly = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('  Thinking for 45s… (ctrl+o to expand)', systemStyle),
      row('    I am mapping out how globalTabMru works across the system.', systemStyle),
      row('    That defeats the purpose of…', systemStyle),
      row('✳ Lollygagging… (thinking with max effort)', systemStyle),
      row('  ⎿ ◻ Средний клик по вкладке Codex не зак…', systemStyle),
      row('❯ '),
    ],
  });
  assert.equal(systemOnly.status, 'empty');
  assert.deepEqual(
    systemOnly.filteredBlockKinds,
    ['structured-summary', 'activity', 'branch-status'],
  );
  assert.equal(systemOnly.styleEvidenceUsed, true);

  const withAnswer = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('Thought for 45s (ctrl+o to expand)', systemStyle),
      row('    That defeats the purpose of…', systemStyle),
      row('⏺ Проверил код — теперь могу ответить предметно.'),
      row('❯ '),
    ],
  });
  assert.equal(withAnswer.status, 'text');
  assert.equal(withAnswer.text, 'Проверил код — теперь могу ответить предметно.');
  assert.deepEqual(withAnswer.filteredBlockKinds, ['structured-summary']);
});

test('Thinking for text without Claude card proof remains ordinary prose', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('⏺ Thinking for 45s (ctrl+o to expand) — пример текста ответа.'),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(
    result.text,
    'Thinking for 45s (ctrl+o to expand) — пример текста ответа.',
  );
  assert.deepEqual(result.filteredBlockKinds, []);
  assert.equal(result.styleEvidenceUsed, false);
});

test('colour alone never turns ordinary answer text into terminal chrome', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('⏺ Этот текст специально окрашен темой.', {
        firstTextStyle: 'fg=1:12,bg=0:-1,dim',
        hasNonDefaultFg: true,
        allTextDim: true,
      }),
      row('❯ '),
    ],
  });
  assert.equal(result.text, 'Этот текст специально окрашен темой.');
  assert.deepEqual(result.filteredBlockKinds, []);
  assert.equal(result.styleEvidenceUsed, false);
});

test('a spinner glyph in ordinary Claude answer text is not globally stripped', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('✳ Testing — это пример строки самого ответа.'),
      row('Следующая строка подтверждает, что это не trailing status.'),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'text');
  assert.match(result.text, /^✳ Testing/);
});

test('cuts Codex composer and removes a submitted prompt only at the owned prefix', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    promptText: 'проверь поток',
    physicalLines: [
      row('проверь поток'),
      row('Ответ появляется до JSONL.'),
      row('› Find and fix a bug'),
      row('gpt-5.6-sol high · Full Access · Context 12%'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Ответ появляется до JSONL.');
  assert.equal(result.promptLinesRemoved, 1);
});

test('Codex Working footer is not assistant prose and its TUI bullet is removed', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    promptText: 'применяй фиксы',
    physicalLines: [
      row('применяй фиксы'),
      row('• Исправляю три доказанные точки.'),
      row('  Сначала сверю реальные ветки layout и proof.'),
      row('• Working (16s • esc to interrupt)', {
        firstTextStyle: 'fg=1:8,bg=0:-1,dim',
        hasDim: true,
        allTextDim: true,
      }),
      row('› Write tests for @filename'),
    ],
  });
  assert.equal(
    result.text,
    'Исправляю три доказанные точки.\n  Сначала сверю реальные ветки layout и proof.',
  );
  assert.deepEqual(result.filteredBlockKinds, ['activity']);
  assert.equal(result.answerMarkerRemoved, true);
});

test('Codex Working footer with background-task telemetry is still system chrome', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Working (41s • esc to interrupt) · 4 background tasks', {
        firstTextStyle: 'fg=1:8,bg=0:-1,dim',
        hasDim: true,
        allTextDim: true,
      }),
      row('› Write tests for @filename'),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.filteredBlockKinds, ['activity']);
});

test('Codex queued-message card and its submitted text stay outside assistant preview', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Messages to be submitted after next tool call'),
      row('  (press esc to interrupt and send immediately)'),
      row('  ↳ оке исправляй это, но не меняй архитектуру'),
      row(''),
      row('• Настоящий ответ уже печатается.'),
      row('› Use /skills to list available skills'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ уже печатается.');
  assert.deepEqual(result.filteredBlockKinds, ['queue-status']);

  const clipped = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('  (press esc to interrupt and send immediately)'),
      row('  ↳ оке исправляй это, но не меняй архитектуру'),
      row('› Use /skills to list available skills'),
    ],
  });
  assert.equal(clipped.status, 'empty');
  assert.deepEqual(clipped.filteredBlockKinds, ['queue-status']);
});

test('Codex transport fallback warning stays outside assistant preview', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('⚠ Falling back from WebSockets to HTTPS transport.'),
      row('  stream disconnected before completion: websocket'),
      row('    closed by server before response.completed'),
      row(''),
      row('• Настоящий ответ после переподключения.'),
      row('› Use /skills to list available skills'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ после переподключения.');
  assert.deepEqual(result.filteredBlockKinds, ['transport-status']);
});

test('a provider-styled historical Codex prompt is removed after a full-screen redraw', () => {
  const promptStyle = {
    activeByInverse: true,
    hasInverse: true,
    hasNonDefaultBg: true,
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('› [Image #1] и как это понимать', promptStyle),
      row('• Уже сохранённый точный ответ.'),
      row(''),
      row('• Новый абзац ещё не сохранён.'),
      row('› Use /skills to list available skills'),
    ],
  });
  assert.equal(
    result.text,
    'Уже сохранённый точный ответ.\n\nНовый абзац ещё не сохранён.',
  );
  assert.equal(result.residualPromptLinesRemoved, 1);
  assert.equal(result.residualPromptBlocksRemoved, 1);

  const ordinaryQuote = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Обычная цитата внутри ответа:'),
      row('› этот символ не является пользовательским блоком'),
      row('› Use /skills to list available skills'),
    ],
  });
  assert.equal(
    ordinaryQuote.text,
    'Обычная цитата внутри ответа:\n› этот символ не является пользовательским блоком',
  );
  assert.equal(ordinaryQuote.residualPromptLinesRemoved, 0);
});

test('a clipped exact prompt suffix is removed after its boundary was already proven', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    promptText: 'Напиши десять абзацев. Между абзацами оставляй пустую строку. Не используй инструменты.',
    promptPrefixClipped: true,
    physicalLines: [
      row('абзацами оставляй пустую строку.'),
      row('Не используй инструменты.'),
      row('• STREAM-CODEX-1 Настоящий ответ уже печатается.'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'STREAM-CODEX-1 Настоящий ответ уже печатается.');
  assert.equal(result.promptLinesRemoved, 2);
});

test('Codex tool cards between two prose blocks are filtered structurally', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Сначала проверю фактическое состояние.'),
      row(''),
      row('• Any future tool title'),
      row('  └ machine output that is not assistant prose', {
        firstTextStyle: 'fg=1:8,bg=0:-1,dim',
        hasNonDefaultFg: true,
        allTextDim: true,
      }),
      row(''),
      row('• После проверки исправление готово.'),
      row('• Working (4s • esc to interrupt)'),
      row('› Find and fix a bug'),
    ],
  });
  assert.equal(
    result.text,
    'Сначала проверю фактическое состояние.\n\nПосле проверки исправление готово.',
  );
  assert.deepEqual(result.filteredBlockKinds, ['activity', 'tool-card']);
  assert.equal(result.styleEvidenceUsed, true);
});

test('Codex web-search progress and compaction lifecycle stay outside streamed prose', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Searching the web'),
      row(''),
      row('• Searched the web for site:wimhofmethod.com breathing exercises safety'),
      row(''),
      row('Context compacted'),
      row(''),
      row('• Да, настоящий ответ уже печатается.'),
      row('  Второй фрагмент ответа.'),
      row('› Find and fix a bug'),
    ],
  });
  assert.equal(
    result.text,
    'Да, настоящий ответ уже печатается.\n  Второй фрагмент ответа.',
  );
  assert.deepEqual(result.filteredBlockKinds, ['tool-status', 'lifecycle-status']);
  assert.equal(result.answerMarkerRemoved, true);
});

test('Codex namespaced Calling row is tool chrome while ordinary prose remains', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Calling electron.electron_connect({"port":'),
      row('9224})', { wrapped: true }),
      row(''),
      row('• В ответе можно упомянуть Calling и Searching the web как обычные слова.'),
      row('› Find and fix a bug'),
    ],
  });
  assert.equal(
    result.text,
    'В ответе можно упомянуть Calling и Searching the web как обычные слова.',
  );
  assert.deepEqual(result.filteredBlockKinds, ['tool-status']);
  assert.equal(result.answerMarkerRemoved, true);
});

test('Codex long Ran command remains a tool card across explicit root wraps', () => {
  const dim = { hasDim: true, allTextDim: true };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Ran git status --short -- src/main/'),
      row('│ agent-send-receipt-store.js src/main/'),
      row('  └ M src/main/main.js', dim),
      row('    … +6 lines (ctrl + t to view transcript)', dim),
      row(''),
      row('• Настоящий ответ после команды.'),
      row('› Find and fix a bug'),
    ],
  });
  assert.equal(result.text, 'Настоящий ответ после команды.');
  assert.deepEqual(result.filteredBlockKinds, ['tool-card']);
  assert.equal(result.styleEvidenceUsed, true);
});

test('an ordinary Codex answer with an unstyled tree glyph is not a tool card', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Вот обычная схема внутри ответа:'),
      row('  первый уровень'),
      row('  └ второй уровень'),
      row('› Find and fix a bug'),
    ],
  });
  assert.equal(
    result.text,
    'Вот обычная схема внутри ответа:\n  первый уровень\n  └ второй уровень',
  );
  assert.deepEqual(result.filteredBlockKinds, []);
});

test('Claude tool result cards do not become provisional assistant text', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('⏺ До вызова инструмента.'),
      row(''),
      row('⏺ Arbitrary tool title'),
      row('  ⎿ raw tool output'),
      row(''),
      row('⏺ После вызова инструмента.'),
      row('❯ '),
    ],
  });
  assert.equal(result.text, 'До вызова инструмента.\n\nПосле вызова инструмента.');
  assert.deepEqual(result.filteredBlockKinds, ['tool-card']);
});

test('Claude keyboard-affordance tools, activity Tip and image attachment chrome stay out of prose', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row("⏺ Bash(sed -n '400,500p' src/renderer/componen"),
      row('ts/Workspace/TerminalArea.tsx)', { wrapped: true }),
      row("  ⎿                  borderColor: 'rgba(239,68,68,0.5)',"),
      row("                     background: 'rgba(23… +98 lines (ctrl+o to expand)'"),
      row(''),
      row('⏺ Searching for 1 pattern… (ctrl+o to expand)'),
      row(''),
      row('✽ Puzzling… (37s · ↓ 1.2k tokens)'),
      row('  ⎿ Tip: Press Shift+Enter to send a'),
      row('     multi-line message'),
      row(''),
      row('─────────[imagePath: /tmp/prompt-image.png]'),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.equal(result.text, '');
  assert.deepEqual(result.filteredBlockKinds, ['activity', 'tool-card']);
});

test('Claude expandable thinking summary and its wrapped children stay out of prose', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('● Thinking for 53s, searching for 6', {
        hasDim: true,
        allTextDim: true,
      }),
      row(' patterns, reading 2 files… (ctrl+o to', { wrapped: true, hasDim: true }),
      row(' expand)', { wrapped: true, hasDim: true }),
      row('  └ src/renderer/utils/splitPanesModel', { hasDim: true }),
      row('    .mjs', { wrapped: true, hasDim: true }),
      row(''),
      row('· Musing… (1m 27s · thinking)', { hasDim: true }),
      row('  └ Tip: Dynamic workflows let Claude', { hasDim: true }),
      row('     write a script that orchestrates agents.', { hasDim: true }),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.equal(result.text, '');
  assert.deepEqual(result.filteredBlockKinds, ['structured-summary', 'activity']);
});

test('ordinary Claude prose mentioning the expand shortcut remains assistant text', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('В документации можно написать (ctrl+o to expand), и это часть ответа.'),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(
    result.text,
    'В документации можно написать (ctrl+o to expand), и это часть ответа.',
  );
});

test('a tinted viewport-clipped Claude expand summary is still structural chrome', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('… +2 lines (ctrl+o to expand) Thinking for 1m 13s,', {
        hasDim: true,
        allTextDim: true,
      }),
      row(' searching for 1 pattern… (ctrl+o to expand)', {
        wrapped: true,
        hasDim: true,
        allTextDim: true,
      }),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.filteredBlockKinds, ['structured-summary']);
});

test('does not delete the same words when they occur in the assistant body', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    promptText: 'повтори фразу',
    physicalLines: [
      row('В ответе я могу повтори фразу использовать как пример.'),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'text');
  assert.match(result.text, /повтори фразу/);
  assert.equal(result.promptLinesRemoved, 0);
});

test('growing frame replaces the current preview instead of appending duplicates', () => {
  const merged = mergeTerminalHistoryPreviewText(
    'Первая часть',
    'Первая часть продолжается',
  );
  assert.deepEqual(merged, {
    status: 'updated',
    reason: 'growing-frame',
    text: 'Первая часть продолжается',
  });
});

test('exact frame baseline exposes only the new prose after filtered tool output', () => {
  const delta = deriveTerminalHistoryPreviewTextAfterBaseline(
    'Уже сохранённый ответ.',
    'Уже сохранённый ответ.\nНовый потоковый абзац.',
  );
  assert.equal(delta.status, 'text');
  assert.equal(delta.reason, 'output-after-exact-baseline');
  assert.equal(delta.text, 'Новый потоковый абзац.');
  assert.match(delta.hash, /^[a-f0-9]{12}$/);
});

test('reflow of an exact frame baseline produces no provisional duplicate', () => {
  const delta = deriveTerminalHistoryPreviewTextAfterBaseline(
    'Уже сохранённый\nответ.',
    'Уже сохранённый ответ.',
  );
  assert.equal(delta.status, 'empty');
  assert.equal(delta.reason, 'no-output-after-exact-baseline');
});

test('an incompatible frame cannot cross an exact JSONL baseline', () => {
  const delta = deriveTerminalHistoryPreviewTextAfterBaseline(
    'Уже сохранённый ответ.',
    'Совершенно чужая область терминала.',
  );
  assert.equal(delta.status, 'unknown');
  assert.equal(delta.reason, 'frame-does-not-extend-exact-baseline');
});

test('a JSONL-materialized paragraph is removed before new terminal prose', () => {
  const canonical = 'Здесь мыслительный поток собрал две важные вещи в одну.';
  const result = subtractTerminalHistoryMaterializedText(
    canonical,
    canonical + '\nНовый абзац ещё не сохранён.',
  );
  assert.equal(result.status, 'text');
  assert.equal(result.reason, 'materialized-record-prefix-removed');
  assert.equal(result.text, 'Новый абзац ещё не сохранён.');
});

test('a partially painted canonical paragraph never becomes provisional output', () => {
  const result = subtractTerminalHistoryMaterializedText(
    'Здесь мыслительный поток собрал две важные вещи в одну.',
    'Здесь мыслительный поток собрал две',
  );
  assert.equal(result.status, 'empty');
  assert.equal(result.reason, 'materialized-record-partial-frame');
});

test('a clipped canonical tail is removed before genuinely new terminal prose', () => {
  const result = subtractTerminalHistoryMaterializedText(
    'Проверю только точный кейс с Казахстаном, чтобы не додумывать его за тебя.',
    'точный кейс с Казахстаном, чтобы не додумывать его за тебя.\nНовый вывод.',
  );
  assert.equal(result.status, 'text');
  assert.equal(result.reason, 'materialized-record-clipped-tail-removed');
  assert.equal(result.text, 'Новый вывод.');
});

test('unrelated text after a canonical record remains eligible for preview', () => {
  const result = subtractTerminalHistoryMaterializedText(
    'Уже сохранённый абзац.',
    'Совершенно новый потоковый абзац.',
  );
  assert.equal(result.status, 'text');
  assert.equal(result.reason, 'candidate-after-materialized-record');
  assert.equal(result.text, 'Совершенно новый потоковый абзац.');
});

test('scrolling viewport appends only rows after a meaningful overlap', () => {
  const merged = mergeTerminalHistoryPreviewText(
    'Строка первая\nСтрока вторая',
    'Строка вторая\nСтрока третья',
  );
  assert.equal(merged.status, 'updated');
  assert.equal(merged.reason, 'scrolled-overlap');
  assert.equal(merged.text, 'Строка первая\nСтрока вторая\nСтрока третья');
});

test('scrolling through the middle of a wrapped line uses exact character overlap', () => {
  const merged = mergeTerminalHistoryPreviewText(
    'Первый абзац начинается здесь и заканчивается фразой про текущее состояние сетевого пакета.',
    'текущее состояние сетевого пакета. Второй абзац уже появился в следующем кадре.',
  );
  assert.equal(merged.status, 'updated');
  assert.equal(merged.reason, 'scrolled-character-overlap');
  assert.equal(
    merged.text,
    'Первый абзац начинается здесь и заканчивается фразой про текущее состояние сетевого пакета.\n'
      + 'Второй абзац уже появился в следующем кадре.',
  );
});

test('an unrelated redraw is unknown and preserves the last proven preview', () => {
  const merged = mergeTerminalHistoryPreviewText(
    'Доказанный ответ',
    'Старое меню совершенно другой формы',
  );
  assert.equal(merged.status, 'unknown');
  assert.equal(merged.reason, 'frame-does-not-extend-owned-output');
  assert.equal(merged.text, 'Доказанный ответ');
});

test('logical lines preserve a physical row identity across wrapped rows', () => {
  const logical = logicalTerminalLines([
    row('abc', { row: 20 }),
    row('def', { row: 21, wrapped: true }),
  ]);
  assert.deepEqual(
    logical.map(({ text, startRow, endRow }) => ({ text, startRow, endRow })),
    [{ text: 'abcdef', startRow: 20, endRow: 21 }],
  );
});

test('logical wrapped lines retain dim and foreground style evidence', () => {
  const [logical] = logicalTerminalLines([
    row('system', {
      row: 20,
      firstTextStyle: 'fg=1:8,bg=0:-1,dim',
      styles: ['fg=1:8,bg=0:-1,dim x7'],
      hasDim: true,
      allTextDim: true,
      hasNonDefaultFg: true,
    }),
    row(' card', {
      row: 21,
      wrapped: true,
      firstTextStyle: 'fg=1:8,bg=0:-1,dim',
      styles: ['fg=1:8,bg=0:-1,dim x4'],
      hasDim: true,
      allTextDim: true,
      hasNonDefaultFg: true,
    }),
  ]);
  assert.equal(logical.text, 'system card');
  assert.equal(logical.hasDim, true);
  assert.equal(logical.allTextDim, true);
  assert.equal(logical.hasNonDefaultFg, true);
  assert.equal(logical.hasSystemTint, true);
});

test('region clamping is explicit and keeps the newest rows', () => {
  const source = Array.from({ length: 805 }, (_, index) => row(String(index)));
  const result = clampPreviewRegionLines(source);
  assert.equal(result.truncated, true);
  assert.equal(result.dropped, 5);
  assert.equal(result.lines[0].text, '5');
  assert.equal(result.lines.at(-1).text, '804');
});

test('finds an exact submitted prompt across explicit TUI row breaks', () => {
  const boundary = findTerminalHistorySubmittedPromptBoundary({
    promptText: 'напечатай длинный ответ из пяти абзацев',
    beforeRow: 18,
    physicalLines: [
      row('› старый prompt', { row: 8 }),
      row('› напечатай длинный ответ из пяти', { row: 12 }),
      row('абзацев', { row: 13 }),
      row('• Working (0s • esc to interrupt)', { row: 15 }),
      row('› Find and fix a bug', { row: 18 }),
    ],
  });
  assert.deepEqual({
    startRow: boundary?.startRow,
    endRow: boundary?.endRow,
    rows: boundary?.rows,
  }, { startRow: 12, endRow: 13, rows: 2 });
});

test('finds an exact Codex prompt when an explicit TUI break splits one token', () => {
  const boundary = findTerminalHistorySubmittedPromptBoundary({
    provider: 'codex',
    promptText: 'Начни STREAM-CODEX-WARM-1 и продолжи STREAM-CODEX-WARM-2',
    beforeRow: 18,
    physicalLines: [
      row('› Начни STREAM-CODEX-WARM-1 и продолжи STREAM-CODEX-', {
        row: 12,
        hasInverse: true,
        hasNonDefaultBg: true,
      }),
      row('  WARM-2', { row: 13 }),
      row('• Working (0s • esc to interrupt)', { row: 15 }),
      row('› Find and fix a bug', { row: 18 }),
    ],
  });
  assert.deepEqual({
    startRow: boundary?.startRow,
    endRow: boundary?.endRow,
    rows: boundary?.rows,
  }, { startRow: 12, endRow: 13, rows: 2 });
});

test('Codex never falls through a newer different prompt to an older identical prompt', () => {
  const boundary = findTerminalHistorySubmittedPromptBoundary({
    provider: 'codex',
    promptText: 'повтори точный запрос',
    beforeRow: 30,
    physicalLines: [
      row('› повтори точный запрос', { row: 10, hasInverse: true }),
      row('• старый ответ', { row: 11 }),
      row('› уже другой новый запрос', { row: 20, hasInverse: true }),
      row('• новый ответ', { row: 21 }),
      row('› Find and fix a bug', { row: 30 }),
    ],
  });
  assert.equal(boundary, null);
});

test('does not use a similar old prompt as the current turn boundary', () => {
  const boundary = findTerminalHistorySubmittedPromptBoundary({
    promptText: 'напечатай новый точный ответ',
    physicalLines: [
      row('› напечатай старый точный ответ', { row: 20 }),
      row('старый ответ', { row: 21 }),
      row('› ', { row: 22 }),
    ],
  });
  assert.equal(boundary, null);
});
