'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clampPreviewRegionLines,
  createTerminalHistoryStructuredProof,
  deriveTerminalHistoryPreviewTextAfterBaseline,
  extractCodexQueuedMessageProofs,
  extractTerminalHistoryPreviewText,
  findTerminalHistorySubmittedPromptBoundary,
  logicalTerminalLines,
  mergeTerminalHistoryPreviewText,
  previewTextHash,
  subtractTerminalHistoryMaterializedText,
  subtractTerminalHistoryStructuredProjection,
} = require('./terminal-history-preview');

const row = (text, extra = {}) => ({ text, wrapped: false, ...extra });

// Production Fable diagnostic captured 2026-09-04T23:59:18Z. This 57-char
// preview had frozen at22:47:29.769Z. The complete source is exact thinking
// block27 (197 chars), not an assistant text block; the CLI added the badge.
const FABLE_THINKING_SUMMARY = 'Собираю в один заход все независимые части: фиксацию handoff в History, входы HistoryPanel/RunAfter/MCP, main-хендлеры paste/send/grab/settings, durable receipt store и Project API draft/interrupt.';
const FABLE_CLIPPED_SUMMARY_PREVIEW = 'receipt store и Project API draft/interrupt. · summarized';

test('exact thinking receipt clears the actual57-char Claude summarized projection', () => {
  assert.equal(FABLE_CLIPPED_SUMMARY_PREVIEW.length, 57);
  assert.equal(previewTextHash(FABLE_CLIPPED_SUMMARY_PREVIEW), '49193bf3c72a');
  const proof = createTerminalHistoryStructuredProof([FABLE_THINKING_SUMMARY]);
  const result = subtractTerminalHistoryStructuredProjection(proof, FABLE_CLIPPED_SUMMARY_PREVIEW);
  assert.equal(result.status, 'empty');
  assert.equal(result.text, '');
  // Once the exact receipt removes the old projection, the next unrelated
  // real answer starts normally instead of freezing on the garbage prefix.
  assert.equal(mergeTerminalHistoryPreviewText(result.text, 'Настоящий новый ответ.').status, 'updated');
});

test('summarized receipt removes only its own prefix and retains following real answer', () => {
  const proof = createTerminalHistoryStructuredProof([FABLE_THINKING_SUMMARY]);
  for (const badge of [' · summarized', '\n  ·\u00a0summarized']) {
    const candidate = 'receipt store и Project API draft/interrupt.' + badge + '\n\nНовый ответ остаётся полностью.';
    const result = subtractTerminalHistoryStructuredProjection(proof, candidate);
    assert.equal(result.status, 'text');
    assert.equal(result.reason, 'structured-projection-prefix-removed');
    assert.equal(result.text, 'Новый ответ остаётся полностью.');
  }
});

test('ordinary summarized prose is not a system row without exact structured ownership', () => {
  const candidates = [
    FABLE_CLIPPED_SUMMARY_PREVIEW,
    'The independent assistant answer has been reviewed · summarized',
  ];
  for (const candidate of candidates) {
    const extracted = extractTerminalHistoryPreviewText({ provider: 'claude', physicalLines: [row('⏺ ' + candidate)] });
    assert.equal(extracted.status, 'text');
    assert.equal(extracted.text, candidate);
    const noReceipt = subtractTerminalHistoryStructuredProjection(createTerminalHistoryStructuredProof([]), candidate);
    assert.equal(noReceipt.text, candidate);
  }
  const unrelatedReceipt = createTerminalHistoryStructuredProof(['A different substantial structured payload which does not own the prose.']);
  assert.equal(subtractTerminalHistoryStructuredProjection(unrelatedReceipt, FABLE_CLIPPED_SUMMARY_PREVIEW).text,
    FABLE_CLIPPED_SUMMARY_PREVIEW);
});

test('short matches, receipt prefixes and inline mentions cannot authorize summarized removal', () => {
  const cases = [
    ['A long structured payload ending with done.', 'done. · summarized'],
    [FABLE_THINKING_SUMMARY + ' Further structured content.', FABLE_CLIPPED_SUMMARY_PREVIEW],
    [FABLE_THINKING_SUMMARY, FABLE_CLIPPED_SUMMARY_PREVIEW + ' — это пример подписи в обычном ответе.'],
    [FABLE_THINKING_SUMMARY, 'Независимый ответ перед примером.\n' + FABLE_CLIPPED_SUMMARY_PREVIEW],
  ];
  for (const [known, candidate] of cases) {
    const result = subtractTerminalHistoryStructuredProjection(createTerminalHistoryStructuredProof([known]), candidate);
    assert.equal(result.status, 'text');
    assert.equal(result.text, candidate);
  }
});

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

test('Claude short Doing activity and its viewport-clipped dim thinking tail stay out of preview', () => {
  const thinkingStyle = {
    firstTextStyle: 'fg=50331648:10066329,bg=0:-1,dim,italic',
    styles: ['fg=50331648:10066329,bg=0:-1,dim,italic x48'],
    hasDim: true,
    allTextDim: true,
    hasNonDefaultFg: true,
  };
  const activityStyle = {
    firstTextStyle: 'fg=50331648:16761095,bg=0:-1,bold',
    styles: ['fg=50331648:16761095,bg=0:-1 x48'],
    hasNonDefaultFg: true,
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('open a new window instead, mirroring what a plain', thinkingStyle),
      row('     click currently does. I need to find the relevant…', thinkingStyle),
      row(''),
      row('✽ Doing… (51s · ↓ 2.0k tokens · thought for 20s)', activityStyle),
      row('  ⎿ Tip: Use /clear to start fresh', thinkingStyle),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.filteredBlockKinds, ['activity', 'branch-status']);
  assert.equal(result.styleEvidenceUsed, true);
});

test('ordinary assistant prose before Claude Doing activity remains visible', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('⏺ Настоящий ответ перед следующим служебным кадром.'),
      row(''),
      row('✶ Doing… (almost done thinking with max effort)', {
        firstTextStyle: 'fg=50331648:16761095,bg=0:-1',
        hasNonDefaultFg: true,
      }),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ перед следующим служебным кадром.');
  assert.deepEqual(result.filteredBlockKinds, ['activity']);
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

test('Claude narrow API retry card is service chrome, not streamed assistant prose', () => {
  // Exact text/hash from production incident 061006b6-… . Claude painted its
  // two-column retry card over three physical rows, with the spinner isolated.
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('✻'),
      row('Waiting for API         · will retry in 2m 38s · check your'),
      row('response               network'),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.filteredBlockKinds, ['retry-status']);
  assert.equal(result.composerFound, true);
});

test('Claude retry words remain prose without the complete provider card receipt', () => {
  const ordinarySentence = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('Waiting for API — клиент will retry in 2m, если это потребуется.'),
      row('❯ '),
    ],
  });
  assert.equal(ordinarySentence.status, 'text');

  const spinnerThenProse = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('✻'),
      row('Обычный ответ после значка не является retry-карточкой.'),
      row('❯ '),
    ],
  });
  assert.equal(spinnerThenProse.status, 'text');
  assert.match(spinnerThenProse.text, /Обычный ответ/);
  assert.deepEqual(spinnerThenProse.filteredBlockKinds, []);
});

test('a Claude Tip continuation stays system chrome when its root is above the owned boundary', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    leadingPhysicalLines: [
      row('· Puzzling… (25m 43s · ↓ 118.3k tokens)', {
        row: 838,
        hasNonDefaultFg: true,
      }),
      row('  ⎿ Tip: Use /permissions to pre-approve and pre-deny bash, edit, and', {
        row: 839,
        hasNonDefaultFg: true,
      }),
    ],
    physicalLines: [
      row('     MCP tools', { row: 840, hasNonDefaultFg: true }),
      row('', { row: 841 }),
      row('❯ ', { row: 843 }),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.equal(result.leadingContextLinesRemoved, 2);
  assert.ok(result.filteredBlockKinds.includes('boundary-system-continuation'));
});

test('a Codex plan continuation stays system chrome when Updated Plan is above the boundary', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    leadingPhysicalLines: [
      row('• Updated Plan', { row: 986, hasDim: true }),
      row('  └ □ Разобрать границу baseline', { row: 987, hasDim: true }),
      row('    □ Добавить регрессионные тесты', { row: 989, hasDim: true }),
    ],
    physicalLines: [
      row('      continuation', { row: 990, hasDim: true, allTextDim: true }),
      row('    □ Внести capability-preserving исправление', { row: 991, hasDim: true }),
      row('    □ Запустить unit/integration проверки', { row: 993, hasDim: true }),
      row('› ', { row: 1016 }),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.equal(result.leadingContextLinesRemoved, 3);
  assert.ok(result.filteredBlockKinds.includes('boundary-system-continuation'));
});

test('a Claude queued user card stays outside preview when the exact boundary cuts off its prompt root', () => {
  const promptStyle = {
    firstTextStyle: 'fg=50331648:16777215,bg=50331648:3618615',
    hasNonDefaultFg: true,
    hasNonDefaultBg: true,
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    leadingPhysicalLines: [
      row('❯ L1VzZXJz... <pasted_content>', { row: 2191, ...promptStyle }),
      row('  во время стриминга есть последний блок,', { row: 2192, ...promptStyle }),
    ],
    physicalLines: [
      row('  какой-то, и он постепенно обновляется. Прикол в чём:', {
        row: 2193,
        ...promptStyle,
      }),
      row('  перед тем как появился пустой инпут, было подёргивание.', {
        row: 2194,
        ...promptStyle,
      }),
      row('  </pasted_content>', { row: 2195, ...promptStyle }),
      row('', { row: 2196 }),
      row('✻ Working (2s · esc to interrupt)', {
        row: 2197,
        hasNonDefaultFg: true,
      }),
      row('❯ ', { row: 2198 }),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.equal(result.leadingContextLinesRemoved, 3);
  assert.ok(result.filteredBlockKinds.includes('boundary-prompt-card-continuation'));
});

test('a full provider-styled Claude user card is removed without hiding an ordinary quote', () => {
  const promptStyle = {
    firstTextStyle: 'fg=50331648:16777215,bg=50331648:3618615',
    hasNonDefaultBg: true,
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('❯ следующий пользовательский prompt', promptStyle),
      row('  продолжение prompt', promptStyle),
      row(''),
      row('⏺ Настоящий ответ Claude.'),
      row('❯ '),
    ],
  });
  assert.equal(result.text, 'Настоящий ответ Claude.');
  assert.equal(result.residualPromptLinesRemoved, 2);
  assert.equal(result.residualPromptBlocksRemoved, 1);

  const ordinaryQuote = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('⏺ Обычная цитата:'),
      row('❯ это текст без provider-owned background'),
      row('❯ '),
    ],
  });
  assert.equal(ordinaryQuote.text, 'Обычная цитата:\n❯ это текст без provider-owned background');
  assert.equal(ordinaryQuote.residualPromptLinesRemoved, 0);
});

test('a dim Codex transcript body cut by the exact boundary stays inside its tool card', () => {
  const dim = { hasDim: true, allTextDim: true };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    leadingPhysicalLines: [
      row('    … +496 lines (ctrl + t to view transcript)', { row: 1101, ...dim }),
      row('                "lineFeeds": 28,', { row: 1102, ...dim }),
    ],
    physicalLines: [
      row('      {', { row: 1103, ...dim }),
      row('    … +262 lines (ctrl + t to view transcript)', { row: 1104, ...dim }),
      row('      }', { row: 1105, ...dim }),
      row('    ]', { row: 1106, ...dim }),
      row('', { row: 1107 }),
      row('• Explored', { row: 1108, hasDim: true }),
      row('  └ Read terminal-history-preview.js', { row: 1109, hasDim: true }),
      row('', { row: 1110 }),
      row('• Настоящий ответ после большого результата.', { row: 1111 }),
      row('› ', { row: 1112 }),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ после большого результата.');
  assert.ok(result.filteredBlockKinds.includes('boundary-tool-result-continuation'));
  assert.ok(result.filteredBlockKinds.includes('tool-card'));
  assert.equal(result.styleEvidenceUsed, true);
});

test('an exact Codex tool boundary owns a huge dim invocation after its receipt scrolled away', () => {
  const dim = { hasDim: true, allTextDim: true };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    exactStructuredBoundaryKind: 'tool-use',
    leadingPhysicalLines: [
      row('        agrofield_4 показывает круговой progress', { row: 1225, ...dim }),
      row('        «Импорт данных / Анализ датасета»', { row: 1226, ...dim }),
    ],
    physicalLines: [
      row('        переключатель сырого вывода.\\n- Нельзя выдавать', {
        row: 1227,
        ...dim,
      }),
      row('        придуманные этапы за фактические.', { row: 1228, ...dim }),
      row('        Issue.\",\"notifySource\":true,\"waitForDescendants\":true})', {
        row: 1229,
        hasDim: true,
        allTextDim: false,
      }),
      row('    {\"ok\": true, \"accepted\": true, \"queued\": true,', {
        row: 1230,
        ...dim,
      }),
      row('        \"auditPending\": false, \"run\": null}', { row: 1231, ...dim }),
      row('', { row: 1232 }),
      row('• Working (2m 08s • esc to interrupt)', { row: 1233, hasDim: true }),
      row('', { row: 1234 }),
      row('• Настоящий ответ после делегации.', { row: 1235 }),
      row('› Write tests for @filename', { row: 1236 }),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ после делегации.');
  assert.deepEqual(result.filteredBlockKinds, [
    'boundary-exact-tool-card-continuation',
    'tool-card',
    'activity',
  ]);
  assert.equal(result.styleEvidenceUsed, true);
});

test('ordinary dim prose spanning a boundary is preserved without a transcript receipt', () => {
  const dim = { hasDim: true, allTextDim: true };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    leadingPhysicalLines: [
      row('• В этом ответе первая часть находится выше границы.', { row: 40, ...dim }),
    ],
    physicalLines: [
      row('Вторая часть всё ещё является обычным ответом.', { row: 41, ...dim }),
      row('› ', { row: 42 }),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Вторая часть всё ещё является обычным ответом.');
  assert.deepEqual(result.filteredBlockKinds, []);
});

test('a viewport-clipped Codex Explored child stays inside its tool card', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    leadingPhysicalLines: [
      row('• Explored', { row: 1423, hasDim: true }),
      row('  └ Read terminal-history-preview.js, terminal-history-preview-', {
        row: 1424,
        hasDim: true,
      }),
    ],
    physicalLines: [
      row('         controller.js, terminal-history-preview.test.js, terminal-', {
        row: 1425,
        hasDim: true,
      }),
      row('         history-preview-controller.test.js', {
        row: 1426,
        hasDim: true,
      }),
      row('', { row: 1427 }),
      row('• Настоящий ответ уже печатается.', { row: 1428 }),
      row('› ', { row: 1430 }),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ уже печатается.');
  assert.ok(result.leadingContextLinesRemoved >= 2);
  assert.ok(result.filteredBlockKinds.includes('boundary-system-continuation'));
});

test('leading system context cannot consume a new unindented assistant answer', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    leadingPhysicalLines: [
      row('· Puzzling…', { row: 20, hasNonDefaultFg: true }),
      row('  ⎿ Tip: Provider-owned hint', { row: 21, hasNonDefaultFg: true }),
    ],
    physicalLines: [
      row('Настоящий ответ начался.', { row: 22 }),
      row('❯ ', { row: 23 }),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ начался.');
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

test('Codex service-tier confirmation is lifecycle chrome, not assistant prose', () => {
  const statusOnly = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Service tier set to priority', { hasDim: true }),
      row('• Working (9s • esc to interrupt)', { hasDim: true }),
      row('› '),
    ],
  });
  assert.equal(statusOnly.status, 'empty');
  assert.ok(statusOnly.filteredBlockKinds.includes('lifecycle-status'));

  const ordinaryProse = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('Service tier set to priority is the exact status text.'),
      row('› '),
    ],
  });
  assert.equal(ordinaryProse.status, 'text');
  assert.equal(ordinaryProse.text, 'Service tier set to priority is the exact status text.');
});

test('Codex dim queue footer is composer chrome even when the composer is above the boundary', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('tab to queue message                              52% context left', {
        hasDim: true,
        allTextDim: true,
      }),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.ok(result.filteredBlockKinds.includes('composer-footer'));

  const unstyledQuote = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('tab to queue message                              52% context left'),
    ],
  });
  assert.equal(unstyledQuote.status, 'text');
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

test('Claude bare expandable read summary cannot become the first streamed answer', () => {
  // Production PTY frame 2197 (incident 393909f5-…): Claude deliberately
  // repainted the gray expandable title without either `⏺` or `●`.
  const systemStyle = {
    firstTextStyle: 'fg=50331648:10066329,bg=0:-1',
    styles: ['fg=50331648:10066329,bg=0:-1 x34'],
    hasNonDefaultFg: true,
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row(' Reading 1 file… (ctrl+o to expand)', systemStyle),
      row('✢ Wandering… (1m 15s · ↓ 3.3k tokens)', {
        ...systemStyle,
        firstTextStyle: 'fg=1:3,bg=0:-1',
      }),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.filteredBlockKinds, ['structured-summary', 'activity']);
  assert.equal(result.styleEvidenceUsed, true);
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

test('Codex Working footer accepts provider telemetry without enumerating its nouns', () => {
  for (const footer of [
    '• Working (41s • esc to interrupt) · 4 background tasks',
    '• Working (36s • esc to interrupt) · 1 background terminal running · …',
    '• Working (2m 04s • esc to interrupt) · future provider telemetry',
  ]) {
    const result = extractTerminalHistoryPreviewText({
      provider: 'codex',
      physicalLines: [
        row(footer, {
          firstTextStyle: 'fg=1:8,bg=0:-1,dim',
          hasDim: true,
          allTextDim: true,
        }),
        row('› Write tests for @filename'),
      ],
    });
    assert.equal(result.status, 'empty', footer);
    assert.deepEqual(result.filteredBlockKinds, ['activity'], footer);
  }
});

test('ordinary Codex prose quoting activity wording survives without provider evidence', () => {
  const text = 'Working (36s • esc to interrupt) · это строка из документации, а не статус.';
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row(text),
      row('› Write tests for @filename'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, text);
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

test('Codex queued-message card is reconstructed across explicit narrow-pane rows', () => {
  const statusStyle = {
    firstTextStyle: 'fg=1:8,bg=0:-1,dim',
    hasDim: true,
    allTextDim: true,
    hasNonDefaultFg: true,
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Messages to be submitted after next', statusStyle),
      row('tool call (press esc to interrupt and', statusStyle),
      row('send immediately)', statusStyle),
      row('↳ [Image #1] queued user prompt', statusStyle),
      row('  that continues on another explicit row', statusStyle),
      row(''),
      row('• Настоящий ответ уже печатается.'),
      row('› Use /skills to list available skills'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ уже печатается.');
  assert.deepEqual(result.filteredBlockKinds, ['queue-status']);
  assert.equal(result.styleEvidenceUsed, true);
});

test('Codex queued-message proof returns exact branch payloads and explicit continuations', () => {
  const statusStyle = {
    firstTextStyle: 'fg=1:8,bg=0:-1,dim',
    hasDim: true,
    allTextDim: true,
    hasNonDefaultFg: true,
  };
  const proofs = extractCodexQueuedMessageProofs([
    row('• Messages to be submitted after next', { ...statusStyle, row: 10 }),
    row('tool call (press esc to interrupt and', { ...statusStyle, row: 11 }),
    row('send immediately)', { ...statusStyle, row: 12 }),
    row('↳ [Image #1] это ты написал? зачем?', { ...statusStyle, row: 13 }),
    row('  причем тут юджай', { ...statusStyle, row: 14 }),
    row('↳ второй queued prompt', { ...statusStyle, row: 15 }),
    row('', { row: 16 }),
    row('› Ask Codex to do anything', { row: 17 }),
  ]);
  assert.deepEqual(proofs.map((proof) => proof.text), [
    '[Image #1] это ты написал? зачем? причем тут юджай',
    'второй queued prompt',
  ]);
  assert.deepEqual(proofs.map(({ startRow, endRow }) => ({ startRow, endRow })), [
    { startRow: 13, endRow: 14 },
    { startRow: 15, endRow: 15 },
  ]);
});

test('Codex queued-message proof rejects a quoted branch without provider queue header', () => {
  assert.deepEqual(extractCodexQueuedMessageProofs([
    row('В документации написано: Messages to be submitted after next tool call'),
    row('↳ это всё ещё обычная проза'),
    row('› Ask Codex to do anything'),
  ]), []);
});

test('Codex queue blank rows do not swallow a composer or an untinted following answer', () => {
  const tinted = { hasDim: true, allTextDim: true };
  for (const following of [row('› not queued', tinted), row('    not queued')]) {
    const proofs = extractCodexQueuedMessageProofs([
      row('• Messages to be submitted after next tool call', tinted),
      row('  ↳ first', tinted), row(''), following, row('    …', tinted),
    ]);
    assert.deepEqual(proofs.map(p => [p.text, p.truncated]), [['first', false]]);
  }
});

test('Codex queued-message proof reads a branch painted on the status line', () => {
  assert.deepEqual(
    extractCodexQueuedMessageProofs([
      row('• Messages to be submitted after next tool call ↳ inline queued prompt'),
      row('› Ask Codex to do anything'),
    ]).map((proof) => proof.text),
    ['inline queued prompt'],
  );
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

test('Codex transport warning is reconstructed across explicit narrow-pane rows', () => {
  const warningStyle = {
    hasNonDefaultFg: true,
    firstTextStyle: 'fg=3:3,bg=0:-1',
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('⚠ Falling back from WebSockets to HTTPS', warningStyle),
      row('  transport. stream disconnected before', warningStyle),
      row('  completion: websocket closed by', warningStyle),
      row('  server before response.completed', warningStyle),
      row(''),
      row('• Настоящий ответ после переподключения.'),
      row('› Use /skills to list available skills'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ после переподключения.');
  assert.deepEqual(result.filteredBlockKinds, ['transport-status']);
});

test('Codex MCP startup warnings stay outside assistant preview', () => {
  const warningStyle = {
    hasNonDefaultFg: true,
    firstTextStyle: 'fg=33554432:3,bg=0:-1',
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('⚠ MCP client for `sc-desktop-tg-search` timed out after 30', warningStyle),
      row('  seconds. Add or adjust `startup_timeout_sec` in your', warningStyle),
      row('  config.toml:', warningStyle),
      row('  [mcp_servers.sc-desktop-tg-search]', warningStyle),
      row('  startup_timeout_sec = XX', warningStyle),
      row(''),
      row('⚠ MCP startup incomplete (failed: sc-desktop-tg-search)', warningStyle),
      row(''),
      row('• Настоящий ответ после предупреждения.'),
      row('› Use /skills to list available skills'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ после предупреждения.');
  assert.deepEqual(result.filteredBlockKinds, ['startup-warning']);

  const ordinaryProse = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• В документации упомянут startup_timeout_sec, но это часть ответа.'),
      row('› Use /skills to list available skills'),
    ],
  });
  assert.equal(
    ordinaryProse.text,
    'В документации упомянут startup_timeout_sec, но это часть ответа.',
  );
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

test('a provider-styled Codex prompt embedded below old tool rows is removed as one card', () => {
  const promptStyle = {
    activeByInverse: true,
    hasInverse: true,
    hasNonDefaultBg: true,
  };
  const toolChildStyle = {
    hasDim: true,
    allTextDim: true,
    hasNonDefaultFg: true,
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Ran rg'),
      row('  └ old output', toolChildStyle),
      row(''),
      row('› Окей, если нам необходимо продолжить', promptStyle),
      row('  то этот текст принадлежит вопросу', promptStyle),
      row(''),
      row('• Настоящий новый ответ.'),
      row('› Use /skills to list available skills'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий новый ответ.');
  assert.equal(result.residualPromptLinesRemoved, 2);
  assert.equal(result.residualPromptBlocksRemoved, 1);
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

test('a viewport-clipped styled Codex tool child cannot become assistant prose', () => {
  const dim = {
    firstTextStyle: 'fg=1:8,bg=0:-1,dim',
    hasDim: true,
    allTextDim: true,
    hasNonDefaultFg: true,
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('└ Search mixed-or-image-draft exact-original', dim),
      row('  PromptQueueAssets durable GrabImages LoaderCircle', dim),
      row('  inspectClaudePostEnterTimeout', {
        ...dim,
        hasNonDefaultBg: true,
      }),
      row('  Read main.js', dim),
      row(''),
      row('• Настоящий ответ после инструмента.'),
      row('› Implement {feature}'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ после инструмента.');
  assert.deepEqual(result.filteredBlockKinds, ['tool-card']);
  assert.equal(result.styleEvidenceUsed, true);
});

test('a late-painted clipped Codex numbered diff card cannot become assistant prose', () => {
  const deleted = {
    hasDim: true,
    hasNonDefaultBg: true,
    firstTextStyle: 'fg=0:-1,bg=50331648:4858397,dim',
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('     90 -            console.log("Done!");', deleted),
      row('     91 -            cb();', deleted),
      row('     92 -        });', deleted),
      row('     93 -', deleted),
      row('     94 -        archive.on(\'error\', err => {', deleted),
      row('     95 -            console.log(`Bundle failed:', deleted),
      row('          ${err.message}`);', deleted),
      row(''),
      row('• Ran set -e'),
      row('  └ exact tool output', { hasDim: true, allTextDim: true }),
      row(''),
      row('• Настоящий ответ после поздно дорисованного diff.'),
      row('› Implement {feature}'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ после поздно дорисованного diff.');
  assert.deepEqual(result.filteredBlockKinds, ['tool-card']);
  assert.equal(result.styleEvidenceUsed, true);
});

test('numbered plus/minus prose without Codex diff-card styling is preserved', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('• Пример обычного ответа:'),
      row('90 - это не удалённая строка инструмента'),
      row('91 + это тоже часть объяснения'),
      row('› Implement {feature}'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(
    result.text,
    'Пример обычного ответа:\n90 - это не удалённая строка инструмента\n91 + это тоже часть объяснения',
  );
  assert.deepEqual(result.filteredBlockKinds, []);
});

test('an unstyled clipped tree prefix remains ordinary Codex prose', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'codex',
    physicalLines: [
      row('└ это обычная схема ответа'),
      row('  продолжение схемы'),
      row('› Find and fix a bug'),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, '└ это обычная схема ответа\n  продолжение схемы');
  assert.deepEqual(result.filteredBlockKinds, []);
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

test('Claude bare tool invocation is chrome before its result child appears', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row("⏺ Bash(python3 - <<'PY'…)", {
        hasNonDefaultFg: true,
        firstTextStyle: 'fg=1:2,bg=0:-1',
      }),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'empty');
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

test('Claude multi-line Bash cards stay chrome when explicit cursor moves break wrapping', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('⏺ Bash(grep -n "itemContent"', {
        hasNonDefaultFg: true,
        firstTextStyle: 'fg=1:2,bg=0:-1',
      }),
      row('      src/renderer/components/Workspace/HistoryPanel.tsx | head -5;'),
      row("      sed -n '14040,14200p'"),
      row('      src/renderer/components/Workspace/HistoryPanel.tsx)'),
      row('  ⎿  8335:// Scroll-seek placeholders replace itemContent', {
        hasNonDefaultFg: true,
        firstTextStyle: 'fg=1:8,bg=0:-1',
      }),
      row('     … +160 lines (ctrl+o to expand)', {
        hasDim: true,
        allTextDim: true,
      }),
      row(''),
      row('⏺ Настоящий ответ после инструмента.'),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ после инструмента.');
  assert.deepEqual(result.filteredBlockKinds, ['tool-card']);
});

test('a clipped Claude Bash continuation inherits its tool root across the preview boundary', () => {
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    leadingPhysicalLines: [
      row("⏺ Bash(sed -n '1360,1400p'", {
        row: 4995,
        hasNonDefaultFg: true,
        firstTextStyle: 'fg=1:2,bg=0:-1',
      }),
      row('      src/renderer/components/Workspace/HistoryPanel.tsx; sed -n', {
        row: 4996,
      }),
    ],
    physicalLines: [
      row("      '1399,1440p' src/renderer/components/Workspace/HistoryPanel.tsx;", {
        row: 4997,
      }),
      row('      echo "=== History…)', { row: 4998 }),
      row('  ⎿  return;', {
        row: 4999,
        hasNonDefaultFg: true,
        firstTextStyle: 'fg=1:8,bg=0:-1',
      }),
      row('', { row: 5000 }),
      row('⏺ Настоящий ответ после инструмента.', { row: 5001 }),
      row('❯ ', { row: 5002 }),
    ],
  });
  assert.equal(result.status, 'text');
  assert.equal(result.text, 'Настоящий ответ после инструмента.');
  assert.ok(result.filteredBlockKinds.includes('boundary-system-continuation'));
  assert.ok(result.filteredBlockKinds.includes('tool-card'));
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

test('Claude expandable summary split by explicit cursor rows stays out of prose', () => {
  const systemStyle = {
    hasNonDefaultFg: true,
    firstTextStyle: 'fg=50331648:10066329,bg=0:-1',
  };
  const result = extractTerminalHistoryPreviewText({
    provider: 'claude',
    physicalLines: [
      row('⏺ Thinking for 1m 4s, searching for 1 pattern… (ctrl+o to ', systemStyle),
      row('  expand)', systemStyle),
      row('❯ '),
    ],
  });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.filteredBlockKinds, ['structured-summary']);
  assert.equal(result.styleEvidenceUsed, true);
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

test('exact structured JSONL proof suppresses an explicitly reflowed tool command tail', () => {
  const command = [
    'rg -n "classify|branch-status|scrolled-character-overlap|',
    'provisional-text-not-yet-materialized|BOUNDARY_HELD|tool-use"',
    ' src/main/terminal-history-preview.js',
  ].join('');
  const proof = createTerminalHistoryStructuredProof([command]);
  const projected = [
    'classify|branch-status|scrol',
    'led-',
    'character-overlap|provisiona',
    'l-',
    'text-not-yet-materialized|',
    'BOUNDARY_HELD|tool-use in terminal-history-preview.js',
  ].join('\n');
  const result = subtractTerminalHistoryStructuredProjection(proof, projected);
  assert.equal(result.status, 'empty');
  assert.equal(result.reason, 'structured-projection-only');
});

test('Codex JSON-string arguments derive the same exact semantic tool projection', () => {
  const command = 'rg -n "classify|branch-status|scrolled-character-overlap|'
    + 'provisional-text-not-yet-materialized|BOUNDARY_HELD|tool-use" '
    + 'src/main/terminal-history-preview.js';
  const proof = createTerminalHistoryStructuredProof([
    JSON.stringify({ cmd: command, workdir: '/Users/example/Desktop/custom-terminal' }),
  ]);
  const projected = [
    'classify|branch-status|scrol',
    'led-character-overlap|provisiona',
    'l-text-not-yet-materialized|',
    'BOUNDARY_HELD|tool-use in terminal-history-preview.js',
  ].join('\n');
  const result = subtractTerminalHistoryStructuredProjection(proof, projected);
  assert.equal(result.status, 'empty');
  assert.equal(result.reason, 'structured-projection-only');
});

test('structured JSONL proof removes only the tool prefix and preserves later prose', () => {
  const toolOutput = 'Searching the web for a bounded exact query';
  const proof = createTerminalHistoryStructuredProof([toolOutput]);
  const result = subtractTerminalHistoryStructuredProjection(
    proof,
    toolOutput + '\nНастоящий ответ после инструмента.',
  );
  assert.equal(result.status, 'text');
  assert.equal(result.reason, 'structured-projection-prefix-removed');
  assert.equal(result.text, 'Настоящий ответ после инструмента.');
});

test('exact structured tool proof removes its numbered diff tail', () => {
  const header = 'Updated docs/tmp/terminal-history-streaming.md (+22 -0)';
  const proof = createTerminalHistoryStructuredProof([header]);
  const result = subtractTerminalHistoryStructuredProjection(
    proof,
    header + '\n'
      + '64 +\n'
      + '    65 +### E37 — нативная очередь Claude\n'
      + '        является отдельным доказанным состоянием\n'
      + '    66 +\n'
      + '    67 +- Production handoff не завис\n'
      + '    68 +  точная операция сохранена\n'
      + '    69',
  );
  assert.equal(result.status, 'empty');
  assert.equal(result.reason, 'structured-projections-only');
});

test('numbered diff tail removal preserves a later unindented assistant answer', () => {
  const header = 'Updated docs/tmp/terminal-history-streaming.md (+4 -0)';
  const proof = createTerminalHistoryStructuredProof([header]);
  const result = subtractTerminalHistoryStructuredProjection(
    proof,
    header + '\n'
      + '41 +### Изменения\n'
      + '    42 +- Первый пункт\n'
      + '    43 +  продолжение строки\n'
      + '    44\n\n'
      + 'Настоящий ответ после tool-карточки.',
  );
  assert.equal(result.status, 'text');
  assert.equal(result.reason, 'structured-projection-prefix-removed');
  assert.equal(result.text, 'Настоящий ответ после tool-карточки.');
});

test('structured JSONL proof never consumes unrelated assistant prose', () => {
  const proof = createTerminalHistoryStructuredProof([
    'jq .diagnostic.composerTrace.transitions[] incident.json',
  ]);
  const text = 'Проверка закончена: причина найдена и исправлена.';
  const result = subtractTerminalHistoryStructuredProjection(proof, text);
  assert.equal(result.status, 'text');
  assert.equal(result.reason, 'candidate-not-structured-projection');
  assert.equal(result.text, text);
});

test('exact Claude receipts suppress a short thinking tail followed by a clipped Bash card', () => {
  const thinking = 'I should check the existing parser in the project and consider '
    + 'whether to use parallel subagents for the scripting work.';
  const command = "cd /tmp/vh-research && cat > shape.js <<'EOF'\n"
    + "const fs=require('fs');\nconsole.log(fs.readdirSync('.'));\nEOF";
  const proof = createTerminalHistoryStructuredProof([
    thinking,
    `Bash(${command})`,
  ]);
  const result = subtractTerminalHistoryStructuredProjection(
    proof,
    "the scripting work.\n\nBash(cd /tmp/vh-research && cat > shape.js <<'EOF'\n"
      + "      const fs=require('fs');…)",
  );
  assert.equal(result.status, 'empty');
  assert.equal(result.reason, 'structured-projection-chain-only');
});

test('an exact long Claude thinking receipt accepts a terminal ellipsis at the end', () => {
  const thinking = 'pattern of commentary appearing between actions, confirm whether '
    + 'codex exec really lacks a description field, and look closer at how reliable '
    + 'the final-answer signal actually is. A few more probes like this and I will '
    + 'be ready to write up the report.';
  const proof = createTerminalHistoryStructuredProof([thinking]);
  const result = subtractTerminalHistoryStructuredProjection(
    proof,
    'pattern of commentary appearing between actions, confirm whether\n'
      + 'codex exec really lacks a description field, and look closer at how reliable\n'
      + 'the final-answer signal actually is. A few more probes like this and I…',
  );
  assert.equal(result.status, 'empty');
  assert.equal(result.reason, 'structured-projection-only');
});

test('exact Codex receipts suppress a short Read child followed by a Search child', () => {
  const command = "sed -n '2070,2145p' src/main/main.js && "
    + "rg -n 'function terminalHistoryStructuredProofTexts|"
    + "terminalHistoryStructuredProofTexts' src/main/main.js";
  const proof = createTerminalHistoryStructuredProof([command]);
  const result = subtractTerminalHistoryStructuredProjection(
    proof,
    'Read main.js\n'
      + '    Search function terminalHistoryStructuredProofTexts|\n'
      + '           terminalHistoryStructuredProofTexts in main.js',
  );
  assert.equal(result.status, 'empty');
  assert.equal(result.reason, 'structured-projection-chain-only');
});

test('a short coincidental prose prefix is preserved without an exact structured receipt', () => {
  const command = "rg -n 'exact-pattern-that-is-long-enough-for-proof' src/main/main.js";
  const proof = createTerminalHistoryStructuredProof([command]);
  const text = 'Короткий ответ.\nSearch exact-pattern-that-is-long-enough-for-proof in main.js';
  const result = subtractTerminalHistoryStructuredProjection(proof, text);
  assert.equal(result.status, 'text');
  assert.equal(result.reason, 'candidate-not-structured-projection');
  assert.equal(result.text, text);
});

test('an exact short structured label alone has no authority to suppress text', () => {
  const proof = createTerminalHistoryStructuredProof([
    "sed -n '1,40p' src/main/main.js",
  ]);
  const result = subtractTerminalHistoryStructuredProjection(proof, 'Read main.js');
  assert.equal(result.status, 'text');
  assert.equal(result.reason, 'candidate-not-structured-projection');
  assert.equal(result.text, 'Read main.js');
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

test('inline-code Markdown already saved to JSONL matches its rendered terminal projection', () => {
  const canonical = [
    'Запускаю полный узкий пакет parser/controller/wiring/diagnostics,',
    'затем зафиксирую причины в `terminal-history-streaming.md`.',
  ].join('\n');
  const rendered = [
    'Запускаю полный узкий пакет parser/controller/wiring/diagnostics,',
    'затем зафиксирую причины в terminal-history-streaming.md.',
  ].join('\n');

  const exactProjection = subtractTerminalHistoryMaterializedText(canonical, rendered);
  assert.equal(exactProjection.status, 'empty');
  assert.equal(exactProjection.reason, 'materialized-record-only');
  assert.equal(exactProjection.projection, 'terminal-inline-code');

  const clippedProjection = subtractTerminalHistoryMaterializedText(
    canonical,
    'затем зафиксирую причины в terminal-history-streaming.md.\nНовый вывод.',
  );
  assert.equal(clippedProjection.status, 'text');
  assert.equal(clippedProjection.reason, 'materialized-record-clipped-tail-removed');
  assert.equal(clippedProjection.text, 'Новый вывод.');
  assert.equal(clippedProjection.projection, 'terminal-inline-code');
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
