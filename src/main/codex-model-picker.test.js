'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CODEX_ALL_MODELS_VALUE,
  CODEX_EFFORT_APPLICATION_CONVERSATION,
  CODEX_EFFORT_APPLICATION_PERSISTENT,
  CODEX_MORE_REASONING_VALUE,
  CODEX_PLAN_SCOPE_PLAN_ONLY_VALUE,
  CODEX_PLAN_SCOPE_ALL_MODES_VALUE,
  codexEffortApplicationMode,
  codexEffortCanUsePlanScope,
  codexModelEffortAppliedMessageCount,
  classifyCodexManualEnterFrame,
  decideCodexOwnedSlashDraft,
  decideCodexModelMigrationAcknowledgement,
  decideCodexModelMigrationAutoEnter,
  decideCodexPickerCleanupFrame,
  inspectCodexModelMigrationPrompt,
  inspectCodexModelPickerFrame,
  isCodexModelEffortAppliedMessage,
  isCodexModelEffortConfirmationObserved,
  isCodexNativeRewindFrameText,
  parseCodexAdvancedEffortPicker,
  parseCodexModelMigrationAcknowledgement,
  parseCodexVerifiedComposerFooter,
  parseCodexVerifiedLaunchCardSettings,
  parseCodexModelMigrationsConfig,
  parseCodexPlanReasoningScopePicker,
  parseCodexAllModelPicker,
  parseCodexStandardEffortPicker,
  parseCodexTopLevelConfig,
  parseCodexTopModelPicker,
  planCodexEffortSelection,
  planCodexModelSelection,
  unionCodexEffortOptions,
  isCodexActivePickerFrame,
  isCodexPickerFrameComposer,
  isCodexPickerStateReady,
  verifyCodexModelMigrationConfig,
  verifyCodexTopLevelConfig,
} = require('./codex-model-picker');

test('only an exact unchanged app-owned slash draft may be retried or cleared', () => {
  const exact = {
    slashInserted: true,
    enterSubmitted: false,
    identityCurrent: true,
    draftProofAvailable: true,
    hasDraft: true,
    expectedCommand: '/model',
    currentDraft: '/model',
  };
  assert.deepEqual(decideCodexOwnedSlashDraft(exact), {
    action: 'use-exact-draft',
    owned: true,
    reason: 'exact-owned-slash-draft',
  });
  assert.equal(decideCodexOwnedSlashDraft({
    ...exact,
    currentDraft: '/model user edit',
  }).reason, 'draft-changed-after-slash-insert');
  assert.equal(decideCodexOwnedSlashDraft({
    ...exact,
    identityCurrent: false,
    identityReason: 'terminal-generation-changed',
  }).reason, 'terminal-generation-changed');
  assert.equal(decideCodexOwnedSlashDraft({
    ...exact,
    enterSubmitted: true,
  }).reason, 'slash-draft-not-owned');
});

test('verified composer footer proves exact model, effort, and optional FAST state', () => {
  assert.deepEqual(parseCodexVerifiedComposerFooter([
    '› Ask Codex',
    '',
    'gpt-5.6-sol max fast · Full Access · Context 0%',
  ].join('\n')), {
    model: 'gpt-5.6-sol',
    effort: 'max',
    fast: true,
    proof: 'verified-composer-footer',
  });
  assert.deepEqual(parseCodexVerifiedComposerFooter([
    '› Ask Codex',
    'gpt-5.6-sol ultra · Full Access · Context 49% used · weekly 83% left',
  ].join('\n')), {
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    fast: false,
    proof: 'verified-composer-footer',
  });
  assert.deepEqual(parseCodexVerifiedComposerFooter(
    'gpt-5.6-sol max fast · Full Access · Context 94% used Goal achieved (2h 14m)'
  ), {
    model: 'gpt-5.6-sol',
    effort: 'max',
    fast: true,
    proof: 'verified-composer-footer',
  });
});

test('verified composer footer accepts the fresh-conversation cwd form', () => {
  assert.deepEqual(parseCodexVerifiedComposerFooter([
    '› Write tests for @filename',
    'gpt-5.6-luna medium fast · /private/tmp/ct-nested-terminal…',
  ].join('\n')), {
    model: 'gpt-5.6-luna',
    effort: 'medium',
    fast: true,
    proof: 'verified-composer-footer',
  });
});

test('verified composer footer rejects defaults, missing effort, and history-like prose', () => {
  assert.equal(parseCodexVerifiedComposerFooter(
    '› Ask Codex\ngpt-5.6-sol default · Full Access · Context 0%'
  ), null);
  assert.equal(parseCodexVerifiedComposerFooter(
    '› Ask Codex\ngpt-5.6-sol · Full Access · Context 0%'
  ), null);
  assert.equal(parseCodexVerifiedComposerFooter(
    'assistant: gpt-5.6-sol max fast · Full Access · Context 0%'
  ), null);
  assert.equal(parseCodexVerifiedComposerFooter([
    'gpt-5.6-sol max fast · Full Access · Context 0%',
    '› quoted status from history',
  ].join('\n')), null);
});

test('verified launch card proves the fresh launch settings without accepting prose', () => {
  assert.deepEqual(parseCodexVerifiedLaunchCardSettings([
    '╭────────────────────────────────────────────────────────╮',
    '│ model:       gpt-5.6-luna medium   fast   /model to change │',
    '│ directory:   ~/Desktop/custom-terminal                 │',
    '╰────────────────────────────────────────────────────────╯',
  ].join('\n')), {
    model: 'gpt-5.6-luna',
    effort: 'medium',
    fast: true,
    proof: 'verified-launch-card',
  });
  assert.deepEqual(parseCodexVerifiedLaunchCardSettings(
    '│ model: gpt-5.6-sol max /model to change │'
  ), {
    model: 'gpt-5.6-sol',
    effort: 'max',
    fast: false,
    proof: 'verified-launch-card',
  });
  assert.equal(parseCodexVerifiedLaunchCardSettings(
    'assistant: model: gpt-5.6-sol max fast /model to change'
  ), null);
  assert.equal(parseCodexVerifiedLaunchCardSettings(
    '│ model: loading /model to change │'
  ), null);
});

const promotionFrame = (selected = 2, title = true) => [
  ...(title ? ['Meet GPT-6 Luna', 'Our latest Luna is significantly more efficient.'] : []),
  `${selected === 1 ? '›' : ' '} 1. Try new model`,
  `${selected === 2 ? '›' : ' '} 2. Use existing model`,
  'enter/esc confirm · ⌃c quit',
].join('\n');

for (const selected of [1, 2]) for (const title of [true, false]) {
  test('current model promotion is manual picker input, never a prompt or automatic migration: ' + selected + '/' + title, () => {
    const frame = promotionFrame(selected, title);
    assert.deepEqual(classifyCodexManualEnterFrame(frame), {
      action: 'picker-control', kind: 'model-promotion', reason: 'model-promotion-picker',
    });
    assert.equal(isCodexActivePickerFrame(frame), true);
    assert.equal(inspectCodexModelMigrationPrompt(frame).canAutoEnter, false);
    assert.equal(decideCodexModelMigrationAutoEnter({ sameTerminal: true, sameRunSeq: true,
      sameInputRevision: true, screenAvailable: true, cleanText: frame,
      expectedSourceModel: 'gpt-5.6-luna', expectedTargetModel: 'gpt-6-luna' }).allowed, false);
  });
}

for (const [name, frame] of [
  ['missing footer', promotionFrame().replace('enter/esc confirm · ⌃c quit', '')],
  ['missing second action', promotionFrame().replace('› 2. Use existing model', '')],
  ['no selected action', promotionFrame(0)],
  ['ambiguous selection', promotionFrame(1).replace('  2. Use existing model', '› 2. Use existing model')],
  ['newer composer', promotionFrame() + '\n› send this ordinary prompt\ngpt-5.6-luna medium · Full Access'],
  ['later output', promotionFrame() + '\nThe menu above is an example.'],
  ['different action', promotionFrame().replace('Use existing model', 'Delete existing model')],
]) test('model promotion evidence does not claim another surface: ' + name, () => {
  assert.notEqual(classifyCodexManualEnterFrame(frame).kind, 'model-promotion');
});

test('a latest promotion menu cannot borrow old migration metadata or change its automatic policy', () => {
  const old = ['Codex now uses GPT-5.6 Luna in place of GPT-5.4 Mini.',
    'Switch to GPT-5.6 Luna to continue.', "Choose how you'd like Codex to proceed.",
    '› 1. Try new model', '  2. Use existing model', 'Use ↑/↓ to move, press enter to confirm'].join('\n');
  assert.equal(inspectCodexModelMigrationPrompt(old).canAutoEnter, true);
  const current = old + '\n' + promotionFrame(1);
  assert.equal(classifyCodexManualEnterFrame(current).kind, 'model-promotion');
  assert.equal(inspectCodexModelMigrationPrompt(current).visible, false);
  assert.equal(decideCodexModelMigrationAutoEnter({ sameTerminal: true, sameRunSeq: true,
    sameInputRevision: true, screenAvailable: true, cleanText: current,
    expectedSourceModel: 'gpt-5.4-mini', expectedTargetModel: 'gpt-5.6-luna' }).allowed, false);
});

test('Codex model migration prompt accepts only the selected Try new model action', () => {
  const frame = [
    'Codex now uses GPT-5.6 Luna in place of GPT-5.4 Mini.',
    'Switch to GPT-5.6 Luna to continue.',
    '',
    "Choose how you'd like Codex to proceed.",
    '',
    '› 1. Try new model',
    '  2. Use existing model',
    '',
    'Use ↑/↓ to move, press enter to confirm',
  ].join('\n');

  assert.deepEqual(inspectCodexModelMigrationPrompt(frame), {
    visible: true,
    canAutoEnter: true,
    targetModel: 'GPT-5.6 Luna',
    existingModel: 'GPT-5.4 Mini',
    switchTargetModel: 'GPT-5.6 Luna',
    modelMetadataValid: true,
    firstOptionSelected: true,
    secondOptionSelected: false,
    missing: [],
    skipReason: null,
  });
});

test('Codex model migration prompt does not override a user-selected existing model', () => {
  const frame = [
    'Codex now uses GPT-5.6 Luna in place of GPT-5.4 Mini.',
    'Switch to GPT-5.6 Luna to continue.',
    "Choose how you’d like Codex to proceed.",
    '  1. Try new model',
    '» 2. Use existing model',
    'Use ↑/↓ to move, press enter to confirm',
  ].join('\n');

  const inspected = inspectCodexModelMigrationPrompt(frame);
  assert.equal(inspected.visible, true);
  assert.equal(inspected.canAutoEnter, false);
  assert.equal(inspected.secondOptionSelected, true);
  assert.equal(inspected.skipReason, 'existing-model-selected');
});

test('Codex model migration prompt does not auto-enter when source and target metadata are unavailable', () => {
  const frame = [
    'GPT-5.4 will be deprecated soon.',
    'GPT-5.6 Terra is the recommended replacement.',
    '',
    "Choose how you'd like Codex to proceed.",
    '',
    '› 1. Try new model',
    '  2. Use existing model',
    '',
    'Use ↑/↓ to move, press enter to confirm',
  ].join('\n');

  const inspected = inspectCodexModelMigrationPrompt(frame);
  assert.equal(inspected.visible, true);
  assert.equal(inspected.canAutoEnter, false);
  assert.equal(inspected.targetModel, null);
  assert.equal(inspected.existingModel, null);
  assert.equal(inspected.skipReason, 'migration-model-metadata-missing');
});

test('model migration words in ordinary output are not enough to authorize Enter', () => {
  const frame = [
    '• Codex now uses GPT-5.6 Luna in place of GPT-5.4 Mini.',
    '  The release notes say to try the new model.',
    '',
    '› explain the migration',
    'Context 80%',
  ].join('\n');

  const inspected = inspectCodexModelMigrationPrompt(frame);
  assert.equal(inspected.visible, false);
  assert.equal(inspected.canAutoEnter, false);
});

test('model migration action requires an unchanged generation and fresh selected frame', () => {
  const selected = [
    'Codex now uses GPT-5.6 Luna in place of GPT-5.4 Mini.',
    'Switch to GPT-5.6 Luna to continue.',
    "Choose how you'd like Codex to proceed.",
    '› 1. Try new model',
    '  2. Use existing model',
    'Use ↑/↓ to move, press enter to confirm',
  ].join('\n');
  const existingSelected = selected
    .replace('› 1. Try new model', '  1. Try new model')
    .replace('  2. Use existing model', '› 2. Use existing model');

  assert.equal(decideCodexModelMigrationAutoEnter({
    sameTerminal: true,
    sameRunSeq: true,
    sameInputRevision: true,
    screenAvailable: true,
    cleanText: selected,
  }).allowed, true);
  assert.equal(decideCodexModelMigrationAutoEnter({
    sameTerminal: true,
    sameRunSeq: true,
    sameInputRevision: true,
    screenAvailable: true,
    cleanText: existingSelected,
  }).reason, 'existing-model-selected');
  assert.equal(decideCodexModelMigrationAutoEnter({
    sameTerminal: true,
    sameRunSeq: true,
    sameInputRevision: false,
    screenAvailable: true,
    cleanText: selected,
  }).reason, 'input-revision-changed');
  assert.equal(decideCodexModelMigrationAutoEnter({
    sameTerminal: true,
    sameRunSeq: false,
    sameInputRevision: true,
    screenAvailable: true,
    cleanText: selected,
  }).reason, 'command-generation-changed');
});

test('model migration selection chevron is not mistaken for the composer', () => {
  const frame = [
    "Choose how you'd like Codex to proceed.",
    '› 1. Try new model',
    '  2. Use existing model',
    'Use ↑/↓ to move, press enter to confirm',
  ].join('\n');

  assert.equal(isCodexActivePickerFrame(frame), true);
  assert.equal(isCodexPickerFrameComposer(frame), false);
});

test('an old model migration chooser above the current composer cannot authorize Enter', () => {
  const frame = [
    "Choose how you'd like Codex to proceed.",
    '› 1. Try new model',
    '  2. Use existing model',
    'Use ↑/↓ to move, press enter to confirm',
    '',
    '› Explain this codebase',
    'gpt-5.6-luna medium · Full Access',
  ].join('\n');

  const inspected = inspectCodexModelMigrationPrompt(frame);
  assert.equal(inspected.visible, false);
  assert.equal(inspected.canAutoEnter, false);
  assert.equal(inspected.skipReason, 'newer-interactive-surface');
});

test('only the latest model migration chooser redraw owns the selected option', () => {
  const frame = [
    "Choose how you'd like Codex to proceed.",
    '› 1. Try new model',
    '  2. Use existing model',
    'Use ↑/↓ to move, press enter to confirm',
    '',
    "Choose how you'd like Codex to proceed.",
    '  1. Try new model',
    '› 2. Use existing model',
    'Use ↑/↓ to move, press enter to confirm',
  ].join('\n');

  const inspected = inspectCodexModelMigrationPrompt(frame);
  assert.equal(inspected.visible, true);
  assert.equal(inspected.canAutoEnter, false);
  assert.equal(inspected.skipReason, 'existing-model-selected');
});

test('post-Enter migration acknowledgement proves the exact applied model and effort', () => {
  assert.deepEqual(
    parseCodexModelMigrationAcknowledgement(
      '\x1b[32m• Model changed to gpt-5.6-luna medium\x1b[0m'
    ),
    {
      model: 'gpt-5.6-luna',
      effort: 'medium',
      applicationMode: CODEX_EFFORT_APPLICATION_PERSISTENT,
      proof: 'startup-model-migration-ack',
    },
  );
  assert.equal(
    parseCodexModelMigrationAcknowledgement('Model changed to gpt-5.6-luna'),
    null,
  );
  assert.equal(
    parseCodexModelMigrationAcknowledgement(
      'Model changed to gpt-5.6-luna ultra for this conversation'
    ),
    null,
  );
  assert.deepEqual(
    parseCodexModelMigrationAcknowledgement(
      '•\x1b[1CModel\x1b[2Cchanged\x1b[1Cto gpt-5.6-luna\x1b[1Cmedium'
    ),
    {
      model: 'gpt-5.6-luna',
      effort: 'medium',
      applicationMode: CODEX_EFFORT_APPLICATION_PERSISTENT,
      proof: 'startup-model-migration-ack',
    },
    'xterm cursor-forward drawing must preserve acknowledgement word boundaries',
  );
  const realTwoChunkCapture = [
    '\x1b[?2026h\x1b[1;45r\x1b[1;1H\x1bM\x1b[r\x1b[1;1r\x1b[1;1H\r\n',
    '\x1b[;m\x1b[K\x1b[2m• \x1b[22mModel changed to gpt-5.6-luna medium\x1b[m\x1b[m\x1b[0m\x1b[r',
  ].join('');
  assert.deepEqual(
    parseCodexModelMigrationAcknowledgement(realTwoChunkCapture),
    {
      model: 'gpt-5.6-luna',
      effort: 'medium',
      applicationMode: CODEX_EFFORT_APPLICATION_PERSISTENT,
      proof: 'startup-model-migration-ack',
    },
  );
});

test('migration acknowledgement belongs to the unchanged terminal, command, and launch generations', () => {
  const base = {
    sameTerminal: true,
    sameRunSeq: true,
    sameLaunchId: true,
    sameInputRevision: true,
    expectedTargetModel: 'GPT-5.6 Luna',
    output: '• Model changed to gpt-5.6-luna medium',
  };
  assert.equal(decideCodexModelMigrationAcknowledgement(base).allowed, true);
  assert.equal(decideCodexModelMigrationAcknowledgement({
    ...base,
    output: 'Model changed to gpt-5.6-luna',
  }).settled, false);
  assert.equal(decideCodexModelMigrationAcknowledgement({
    ...base,
    sameLaunchId: false,
  }).reason, 'launch-generation-changed');
  assert.equal(decideCodexModelMigrationAcknowledgement({
    ...base,
    sameInputRevision: false,
  }).reason, 'migration-ack-observed', 'typing after the exact Enter does not invalidate its acknowledgement');
  assert.equal(decideCodexModelMigrationAcknowledgement({
    ...base,
    expectedTargetModel: 'gpt-5.6-sol',
  }).reason, 'migration-ack-target-mismatch');
  assert.equal(
    parseCodexModelMigrationAcknowledgement('› Model changed to gpt-5.6-luna medium'),
    null,
    'a resumed user message is not a startup acknowledgement',
  );
});

test('top model parser uses the latest header and gives All models a semantic value', () => {
  const frame = [
    'Select Model',
    '› 1. codex-auto-fast (current) Old fast mode',
    '  2. All models Choose a specific model',
    '',
    'stale redraw text',
    'Select Model',
    '  1. codex-auto-fast Fast responses',
    '› 2. codex-auto-review (current) Balanced review',
    '  3. All models Choose a specific model and reasoning level',
  ].join('\n');

  const picker = parseCodexTopModelPicker(frame);
  assert.deepEqual(picker.items.map(item => item.value), [
    'codex-auto-fast',
    'codex-auto-review',
    CODEX_ALL_MODELS_VALUE,
  ]);
  assert.equal(picker.selectedIndex, 1);
  assert.equal(picker.items.some(item => item.value === 'codex-auto-fast' && item.selected), false);
});

test('manual Enter on the ordinary model picker is a picker action, not a prompt submit', () => {
  const pickerFrame = [
    'Select Model',
    '› 1. codex-auto-review (current) Balanced review',
    '  2. All models Choose a specific model',
    '',
    'Press enter to confirm or esc to go back',
  ].join('\n');
  assert.deepEqual(classifyCodexManualEnterFrame(pickerFrame), {
    action: 'picker-control',
    kind: 'top-model',
    reason: 'active-model-effort-picker',
  });

  assert.deepEqual(classifyCodexManualEnterFrame([
    '› write a normal prompt',
    'Context 97%',
  ].join('\n')), {
    action: 'prompt-submit',
    kind: null,
    reason: 'active-picker-not-proven',
  });
});

test('manual Enter leaves migration and Rewind pickers to their specialized contracts', () => {
  const migrationFrame = [
    'Codex now uses GPT-5.6 Luna in place of GPT-5.4 Mini.',
    'Switch to GPT-5.6 Luna to continue.',
    '',
    "Choose how you'd like Codex to proceed.",
    '› 1. Try new model',
    '  2. Use existing model',
    'Use ↑/↓ to move, press enter to confirm',
  ].join('\n');
  assert.equal(classifyCodexManualEnterFrame(migrationFrame).kind, 'model-migration');

  const rewindFrame = [
    '──────── T R A N S C R I P T ────────',
    '› selected message',
    'esc / ← to edit prev    enter to edit message',
  ].join('\n');
  assert.equal(classifyCodexManualEnterFrame(rewindFrame).kind, 'native-rewind');
});

test('manual Enter on Resume paused goal remains a UI control, not a prompt submit', () => {
  const resumeGoalFrame = [
    'Resume paused goal?',
    'Goal: Finish the lifecycle repair',
    '',
    '› 1. Resume goal  Mark it active and continue when idle',
    '  2. Leave paused Keep it paused; use /goal resume later',
    '',
    'Press enter to confirm or esc to go back',
  ].join('\n');
  assert.deepEqual(classifyCodexManualEnterFrame(resumeGoalFrame), {
    action: 'picker-control',
    kind: 'resume-goal',
    reason: 'resume-goal-picker',
  });
});

test('optional quick-auto gate accepts selected All models without inventing a row from wrapped current model', () => {
  const frame = [
    'Select Model',
    'Pick a quick auto mode or browse all models.',
    '',
    '  1. codex-auto-review     Balanced agentic coding model for everyday work.',
    '› 2. All models (current)  Choose a specific model and reasoning level (current: gpt-',
    '5.6-sol)',
    '',
    'Press enter to confirm or esc to go back',
  ].join('\n');

  const picker = parseCodexTopModelPicker(frame);
  assert.deepEqual(
    picker.items.map(item => item.value),
    ['codex-auto-review', CODEX_ALL_MODELS_VALUE],
  );
  assert.equal(picker.selectedIndex, 1);
  assert.equal(inspectCodexModelPickerFrame(frame, 'gpt-5.6-sol').ready, true);
  assert.deepEqual(planCodexModelSelection('gpt-5.6-sol', {
    topPicker: picker,
    allModelPicker: null,
  }), {
    available: true,
    complete: false,
    reason: null,
    target: 'gpt-5.6-sol',
    route: 'all-models-nested',
    steps: [
      { picker: 'top-model', target: CODEX_ALL_MODELS_VALUE },
      { picker: 'all-model', target: 'gpt-5.6-sol' },
    ],
    missingPicker: 'all-model',
  });
});

test('model picker readiness waits for the semantic next row instead of the first partial row', () => {
  const partialQuickGate = [
    'Select Model',
    'Pick a quick auto mode or browse all models.',
    '› 1. codex-auto-review Balanced agentic coding model.',
  ].join('\n');
  const completeQuickGate = [
    partialQuickGate.replace('› 1.', '  1.'),
    '› 2. All models (current) Choose a specific model and reasoning level',
  ].join('\n');
  const partialDirectList = [
    'Select Model and Effort',
    '› 1. gpt-5.6-sol Latest frontier agentic coding model.',
  ].join('\n');
  const completeDirectList = [
    partialDirectList,
    '  2. gpt-5.6-terra Balanced agentic coding model.',
  ].join('\n');

  assert.equal(
    inspectCodexModelPickerFrame(partialQuickGate, 'gpt-5.6-sol').ready,
    false,
  );
  assert.equal(
    inspectCodexModelPickerFrame(completeQuickGate, 'gpt-5.6-sol').ready,
    true,
  );
  assert.equal(
    inspectCodexModelPickerFrame(partialQuickGate, 'codex-auto-review').ready,
    true,
  );
  assert.equal(
    inspectCodexModelPickerFrame(partialDirectList, 'gpt-5.6-terra').ready,
    false,
  );
  const direct = inspectCodexModelPickerFrame(
    completeDirectList,
    'gpt-5.6-terra',
  );
  assert.equal(direct.ready, true);
  assert.equal(
    isCodexPickerStateReady(direct.allModelPicker, 'gpt-5.6-terra'),
    true,
  );
});

test('all-model parser ignores stale numbered rows above its latest header', () => {
  const frame = [
    'Select Model and Effort',
    '› 1. gpt-5.4 (current) Old screen',
    '  2. gpt-5.5',
    '',
    'Select Model and Effort',
    '  1. gpt-5.6-sol (default) Latest frontier agentic coding model.',
    '› 2. gpt-5.6-terra (current) Balanced agentic coding model.',
    '  3. gpt-5.6-luna Fast and affordable agentic coding model.',
  ].join('\n');

  const picker = parseCodexAllModelPicker(frame);
  assert.deepEqual(picker.items.map(item => item.value), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ]);
  assert.equal(picker.selectedIndex, 1);
  assert.deepEqual(planCodexModelSelection('gpt-5.6-sol', {
    allModelPicker: picker,
  }), {
    available: true,
    complete: true,
    target: 'gpt-5.6-sol',
    route: 'all-model-direct',
    steps: [{ picker: 'all-model', target: 'gpt-5.6-sol' }],
  });
});

test('Codex 0.145 headerless concrete-model picker is parsed from the visible clipped frame', () => {
  const frame = [
    '[… 2 lines] ctrl + a view all',
    '1. gpt-5.6-sol (default) Latest frontier agentic coding model.',
    '2. gpt-5.6-terra Balanced agentic coding model for everyday',
    'work.',
    '3. gpt-5.6-luna Fast and affordable agentic coding model.',
    '4. gpt-5.5 Frontier model for complex coding, research,',
    'and real-world work.',
    '5. gpt-5.4 Strong model for everyday coding.',
    '› 6. gpt-5.4-mini Small, fast, and cost-efficient model for',
    'simpler coding tasks.',
    '7. gpt-5.3-codex-spark (current) Ultra-fast coding model.',
    '',
    'Press enter to confirm or esc to go back',
  ].join('\n');

  const picker = parseCodexAllModelPicker(frame);
  assert.deepEqual(picker.items.map(item => item.value), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
  ]);
  assert.equal(picker.selectedIndex, 5);
  assert.equal(parseCodexTopModelPicker(frame).items.length, 0);
  assert.equal(isCodexActivePickerFrame(frame), true);
  assert.equal(isCodexPickerFrameComposer(frame), false);
});

test('headerless concrete-model picker needs no clipping hint when the complete footer block is visible', () => {
  const frame = [
    '1. gpt-5.6-sol (default) Latest frontier agentic coding model.',
    '2. gpt-5.6-terra Balanced agentic coding model.',
    '› 3. gpt-5.6-luna Fast agentic coding model.',
    '',
    'Press enter to confirm or esc to go back',
    '',
  ].join('\n');

  const picker = parseCodexAllModelPicker(frame);
  assert.deepEqual(
    picker.items.map(item => item.value),
    ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  );
  assert.equal(picker.selectedIndex, 2);
  assert.equal(isCodexActivePickerFrame(frame), true);
  assert.equal(isCodexPickerFrameComposer(frame), false);
});

test('a strong headerless model block after a completed stale picker owns the newest footer', () => {
  const frame = [
    'Select Reasoning Level for stale-model',
    '› 1. Medium',
    '  2. High',
    '',
    'Press enter to confirm or esc to go back',
    '',
    '› 1. gpt-5.6-sol (default) Latest frontier agentic coding model.',
    '  2. gpt-5.6-terra Balanced agentic coding model.',
    '',
    'Press enter to confirm or esc to go back',
  ].join('\n');

  assert.deepEqual(
    parseCodexAllModelPicker(frame).items.map(item => item.value),
    ['gpt-5.6-sol', 'gpt-5.6-terra'],
  );
  assert.equal(parseCodexStandardEffortPicker(frame).items.length, 0);
});

test('one concrete row cannot turn a generic headerless confirmation into a model picker', () => {
  const frame = [
    '› 1. gpt-5.6-sol',
    '',
    'Press enter to confirm or esc to go back',
  ].join('\n');

  assert.equal(parseCodexAllModelPicker(frame).items.length, 0);
  assert.equal(isCodexActivePickerFrame(frame), false);
});

test('a clipped current model picker wins over a stale explicit picker header above it', () => {
  const frame = [
    'Select Reasoning Level for stale-model',
    '› 1. Medium',
    '  2. High',
    '',
    '[… 2 lines] ctrl + a view all',
    '› 1. gpt-5.6-sol (default) Latest frontier agentic coding model.',
    '2. gpt-5.6-terra Balanced agentic coding model.',
    '',
    'Press enter to confirm or esc to go back',
  ].join('\n');

  assert.deepEqual(
    parseCodexAllModelPicker(frame).items.map(item => item.value),
    ['gpt-5.6-sol', 'gpt-5.6-terra'],
  );
  assert.equal(parseCodexStandardEffortPicker(frame).items.length, 0);
});

test('latest explicit picker kind prevents stale model rows from leaking into effort parsing', () => {
  const frame = [
    'Select Model and Effort',
    '› 1. gpt-5.6-sol',
    '  2. gpt-5.6-terra',
    '',
    'Select Reasoning Level for gpt-5.6-sol',
    '  1. Medium',
    '› 2. High',
    '  3. More reasoning…',
    '',
    'Press enter to confirm or esc to go back',
  ].join('\n');

  assert.equal(parseCodexAllModelPicker(frame).items.length, 0);
  assert.deepEqual(
    parseCodexStandardEffortPicker(frame).items.map(item => item.value),
    ['medium', 'high', CODEX_MORE_REASONING_VALUE],
  );
});

test('model plan enters All models before selecting a non-auto model', () => {
  const topPicker = parseCodexTopModelPicker([
    'Select Model',
    '› 1. codex-auto-review (current) Balanced review',
    '  2. All models Choose a specific model and reasoning level',
  ].join('\n'));
  const allModelPicker = parseCodexAllModelPicker([
    'Select Model and Effort',
    '› 1. gpt-5.6-sol (current) Latest frontier model',
    '  2. gpt-5.6-terra Balanced model',
  ].join('\n'));

  assert.deepEqual(planCodexModelSelection('gpt-5.6-sol', {
    topPicker,
    allModelPicker,
  }), {
    available: true,
    complete: true,
    reason: null,
    target: 'gpt-5.6-sol',
    route: 'all-models-nested',
    steps: [
      { picker: 'top-model', target: CODEX_ALL_MODELS_VALUE },
      { picker: 'all-model', target: 'gpt-5.6-sol' },
    ],
    missingPicker: null,
  });
});

test('xhigh remains a direct standard-effort selection', () => {
  const standardPicker = parseCodexStandardEffortPicker([
    'Select Reasoning Level for gpt-5.6-sol',
    '  1. Low Fast responses',
    '  2. Medium Balanced',
    '  3. High Greater reasoning depth',
    '› 4. Extra high (current) Extra high reasoning depth',
    '  5. More reasoning… Max and Ultra consume usage limits faster',
  ].join('\n'));

  assert.deepEqual(standardPicker.items.map(item => item.value), [
    'low',
    'medium',
    'high',
    'xhigh',
    CODEX_MORE_REASONING_VALUE,
  ]);
  assert.equal(standardPicker.selectedIndex, 3);
  assert.deepEqual(planCodexEffortSelection('xhigh', { standardPicker }), {
    available: true,
    complete: true,
    reason: null,
    target: 'xhigh',
    route: 'standard-direct',
    steps: [{ picker: 'standard-effort', target: 'xhigh' }],
    options: ['low', 'medium', 'high', 'xhigh'],
  });
});

test('max and ultra use the nested Advanced Reasoning picker', () => {
  const standardPicker = parseCodexStandardEffortPicker([
    '1. stale-model-row',
    'Select Reasoning Level for gpt-5.6-sol',
    '  1. Low Fast responses',
    '› 2. Extra high (current) Extra high reasoning depth',
    '  3. More reasoning… Max and Ultra consume usage limits faster',
  ].join('\n'));
  const advancedPicker = parseCodexAdvancedEffortPicker([
    '2. stale-standard-row',
    'Advanced Reasoning',
    '⚠ Consumes usage limits faster',
    '  1. Max For difficult problems when quality matters more than speed',
    '› 2. Ultra (current) For demanding work using multiple agents',
  ].join('\n'));

  for (const target of ['max', 'ultra']) {
    assert.deepEqual(planCodexEffortSelection(target, {
      standardPicker,
      advancedPicker,
    }), {
      available: true,
      complete: true,
      reason: null,
      target,
      route: 'advanced-nested',
      steps: [
        { picker: 'standard-effort', target: CODEX_MORE_REASONING_VALUE },
        { picker: 'advanced-effort', target },
      ],
      missingPicker: null,
      options: ['low', 'xhigh', 'max', 'ultra'],
    });
  }
});

test('Max-only model keeps the explicit More reasoning step', () => {
  const standardPicker = parseCodexStandardEffortPicker([
    'Select Reasoning Level for gpt-5.6-luna',
    '› 1. More reasoning… Max consumes usage limits faster',
  ].join('\n'));
  const advancedPicker = parseCodexAdvancedEffortPicker([
    'Advanced Reasoning',
    '⚠ Consumes usage limits faster',
    '› 1. Max (current) For difficult problems',
  ].join('\n'));

  assert.deepEqual(standardPicker.items.map(item => item.value), [
    CODEX_MORE_REASONING_VALUE,
  ]);
  assert.deepEqual(advancedPicker.items.map(item => item.value), ['max']);
  assert.deepEqual(planCodexEffortSelection('max', {
    standardPicker,
    advancedPicker,
  }).steps, [
    { picker: 'standard-effort', target: CODEX_MORE_REASONING_VALUE },
    { picker: 'advanced-effort', target: 'max' },
  ]);
  assert.equal(planCodexEffortSelection('ultra', {
    standardPicker,
    advancedPicker,
  }).available, false);
});

test('filtered picker options keep their physical row indexes', () => {
  const picker = parseCodexStandardEffortPicker([
    'Select Reasoning Level for gpt-5.6-sol',
    '  1. Low Fast responses',
    '  2. Adaptive New upstream option unknown to this client',
    '› 3. High Greater reasoning depth',
    '  4. More reasoning… Max and Ultra consume usage limits faster',
  ].join('\n'));

  assert.deepEqual(
    picker.items.map(item => ({ value: item.value, index: item.index })),
    [
      { value: 'low', index: 0 },
      { value: 'high', index: 2 },
      { value: CODEX_MORE_REASONING_VALUE, index: 3 },
    ]
  );
  assert.equal(picker.selectedIndex, 2);
});

test('selected physical row survives even when its value is unknown', () => {
  const picker = parseCodexStandardEffortPicker([
    'Select Reasoning Level for gpt-5.6-sol',
    '  1. Low Fast responses',
    '› 2. Adaptive New upstream option unknown to this client',
    '  3. High Greater reasoning depth',
  ].join('\n'));

  assert.deepEqual(
    picker.items.map(item => ({ value: item.value, index: item.index })),
    [
      { value: 'low', index: 0 },
      { value: 'high', index: 2 },
    ]
  );
  assert.equal(picker.selectedIndex, 1);
});

test('effort option union is stable, unique, and excludes navigation rows', () => {
  const standardPicker = {
    items: [
      { value: 'low' },
      { value: 'xhigh' },
      { value: CODEX_MORE_REASONING_VALUE },
    ],
  };
  const advancedPicker = {
    items: [
      { value: 'max' },
      { value: 'ultra' },
      { value: 'max' },
    ],
  };

  assert.deepEqual(
    unionCodexEffortOptions(
      standardPicker,
      advancedPicker,
      ['medium', CODEX_MORE_REASONING_VALUE, 'unknown']
    ),
    ['low', 'xhigh', 'max', 'ultra', 'medium']
  );
});

test('Plan mode scope parser selects the persistent ControlBar meaning', () => {
  const parsed = parseCodexPlanReasoningScopePicker(`
Apply reasoning change
Choose where to apply max reasoning.
› 1. Apply to Plan mode override
  2. Apply to global default and Plan mode override
`);
  assert.deepEqual(parsed.items.map((item) => item.value), [
    CODEX_PLAN_SCOPE_PLAN_ONLY_VALUE,
    CODEX_PLAN_SCOPE_ALL_MODES_VALUE,
  ]);
  assert.equal(parsed.selectedIndex, 0);
  assert.equal(parsed.items[1].ordinal, 2);
  assert.equal(parsed.reasoningValue, 'max');
});

test('Ultra never routes through the Plan scope picker', () => {
  const planScopePicker = parseCodexPlanReasoningScopePicker(`
Apply reasoning change
Choose where to apply Ultra reasoning.
› 1. Apply to Plan mode override
  2. Apply to global default and Plan mode override
`);

  assert.deepEqual(planCodexEffortSelection('ultra', {
    planScopePicker,
  }), {
    available: false,
    complete: false,
    reason: 'conversation-effort-does-not-use-plan-scope',
    target: 'ultra',
    route: 'plan-scope-direct',
    steps: [{
      picker: 'plan-scope',
      target: CODEX_PLAN_SCOPE_ALL_MODES_VALUE,
    }],
    observedEffort: 'ultra',
    effortImplicit: true,
    options: ['ultra'],
  });

  const mismatch = planCodexEffortSelection('max', { planScopePicker });
  assert.equal(mismatch.available, false);
  assert.equal(mismatch.reason, 'direct-effort-mismatch');
  assert.equal(mismatch.observedEffort, 'ultra');
});

test('Max persists while Ultra is acknowledged only for the current conversation', () => {
  assert.equal(
    codexEffortApplicationMode('max'),
    CODEX_EFFORT_APPLICATION_PERSISTENT,
  );
  assert.equal(codexEffortCanUsePlanScope('max'), true);
  assert.equal(
    codexEffortApplicationMode('ultra'),
    CODEX_EFFORT_APPLICATION_CONVERSATION,
  );
  assert.equal(codexEffortCanUsePlanScope('ultra'), false);

  const oldUltraMessage = 'Model changed to gpt-5.6-sol ultra';
  const currentUltraMessage = '• Model changed to gpt-5.6-sol ultra for this conversation';
  assert.equal(
    isCodexModelEffortAppliedMessage(oldUltraMessage, 'gpt-5.6-sol', 'ultra'),
    false,
    'the generic prefix is not enough to prove ApplyAdvancedReasoning',
  );
  assert.equal(
    isCodexModelEffortAppliedMessage(currentUltraMessage, 'gpt-5.6-sol', 'ultra'),
    true,
  );
  assert.equal(
    codexModelEffortAppliedMessageCount(
      `${currentUltraMessage}\n${currentUltraMessage}`,
      'gpt-5.6-sol',
      'ultra',
    ),
    2,
  );
  assert.equal(
    isCodexModelEffortAppliedMessage(
      'Model changed to codex-auto-review',
      'codex-auto-review',
      'max',
    ),
    true,
    'auto presets keep their documented effort-label omission',
  );
  assert.equal(
    codexModelEffortAppliedMessageCount(
      'Model changed to codex-auto-review',
      'codex-auto-review',
      'max',
    ),
    1,
  );
  assert.equal(
    isCodexModelEffortAppliedMessage(
      'Model changed to codex-auto-review',
      'codex-auto-review',
      'ultra',
    ),
    false,
    'Ultra never falls back to an effort-less acknowledgement',
  );
});

test('direct Plan scope is not effort proof when the prompt omits the effort', () => {
  const planScopePicker = parseCodexPlanReasoningScopePicker(`
Apply reasoning change
Choose where to apply this reasoning change.
  1. Apply to Plan mode override
› 2. Apply to global default and Plan mode override
`);

  const plan = planCodexEffortSelection('max', { planScopePicker });
  assert.equal(plan.available, false);
  assert.equal(plan.complete, false);
  assert.equal(plan.reason, 'direct-effort-unconfirmed');
  assert.equal(plan.observedEffort, null);
});

test('selected picker chevron is not mistaken for the composer', () => {
  const effortFrame = [
    'Select Reasoning Level for gpt-5.6-sol',
    '  1. High',
    '› 2. Max',
  ].join('\n');
  const scopeFrame = [
    'Apply reasoning change',
    '› 1. Apply to Plan mode override',
    '  2. Apply to global default and Plan mode override',
  ].join('\n');

  assert.equal(isCodexPickerFrameComposer(effortFrame), false);
  assert.equal(parseCodexStandardEffortPicker(effortFrame).items.length > 0, true);
  assert.equal(isCodexPickerFrameComposer(scopeFrame), false);
  assert.equal(parseCodexPlanReasoningScopePicker(scopeFrame).items.length > 0, true);
  assert.equal(isCodexPickerFrameComposer('› Explain this codebase\nContext 68%'), true);
});

test('native Rewind selected chevron is not mistaken for the composer', () => {
  const frame = [
    'T R A N S C R I P T',
    '› Reply exactly E2E_HIDDEN_HISTORY_OK_2359.',
    'q to quit  esc/← to edit prev  → to edit next  enter to edit message',
    'gpt-5.6-sol ultra · Full Access · Context 68%',
  ].join('\n');

  assert.equal(isCodexNativeRewindFrameText(frame), true);
  assert.equal(isCodexPickerFrameComposer(frame), false);
});

test('Ultra confirmation accepts post-Enter acknowledgement and current composer from separate renders', () => {
  const postEnterDelta = [
    '• Model changed to gpt-5.6-sol ultra for this conversation',
  ].join('\n');
  const currentComposer = [
    '› Summarize recent commits',
    'gpt-5.6-sol ultra · Full Access · Context 68%',
  ].join('\n');

  assert.equal(
    isCodexModelEffortConfirmationObserved(
      postEnterDelta,
      currentComposer,
      'gpt-5.6-sol',
      'ultra',
    ),
    true,
  );
  assert.equal(
    isCodexModelEffortConfirmationObserved(
      postEnterDelta,
      'Advanced Reasoning\n› 2. Ultra',
      'gpt-5.6-sol',
      'ultra',
    ),
    false,
  );
  assert.equal(
    isCodexModelEffortConfirmationObserved(
      '',
      currentComposer,
      'gpt-5.6-sol',
      'ultra',
    ),
    false,
  );
});

test('picker cleanup only writes Esc for an authoritatively proven active picker', () => {
  assert.deepEqual(decideCodexPickerCleanupFrame({
    screenAvailable: true,
    composerProven: true,
  }), {
    action: 'done',
    success: true,
    reason: 'already-composer',
  });
  assert.deepEqual(decideCodexPickerCleanupFrame({
    screenAvailable: true,
    activePicker: true,
  }), {
    action: 'escape-picker',
    success: false,
    reason: 'active-picker',
  });
  assert.deepEqual(decideCodexPickerCleanupFrame({
    screenAvailable: true,
    nativeRewindProven: true,
    composerProven: true,
  }), {
    action: 'stop',
    success: false,
    reason: 'native-rewind-overlay',
  });
  assert.equal(decideCodexPickerCleanupFrame({
    screenAvailable: true,
  }).action, 'stop');
  assert.equal(decideCodexPickerCleanupFrame({
    screenAvailable: false,
    activePicker: true,
  }).action, 'stop');
});

test('picker words in transcript do not hide a live composer', () => {
  const frame = [
    '• The previous command opened Select Model and Effort.',
    '  It then entered Advanced Reasoning.',
    '',
    '› explain what happened',
    'Context 68%',
  ].join('\n');

  assert.equal(isCodexActivePickerFrame(frame), false);
  assert.equal(isCodexPickerFrameComposer(frame), true);
});

test('generic headerless confirmation is not mistaken for a model picker', () => {
  const frame = [
    '› 1. Yes',
    '  2. No',
    'Press enter to confirm or esc to go back',
  ].join('\n');

  assert.equal(parseCodexAllModelPicker(frame).items.length, 0);
  assert.equal(parseCodexTopModelPicker(frame).items.length, 0);
  assert.equal(isCodexActivePickerFrame(frame), false);
});

test('top-level Codex config parser ignores profile values and comments', () => {
  const config = [
    '# active defaults',
    'model = "gpt-5.6-sol" # selected in /model',
    "model_reasoning_effort = 'max'",
    'plan_mode_reasoning_effort = "ultra"',
    '',
    '[profiles.fast]',
    'model = "gpt-5.6-terra"',
    'model_reasoning_effort = "low"',
    'plan_mode_reasoning_effort = "medium"',
  ].join('\n');

  assert.deepEqual(parseCodexTopLevelConfig(config), {
    model: 'gpt-5.6-sol',
    model_reasoning_effort: 'max',
    plan_mode_reasoning_effort: 'ultra',
  });
});

test('duplicate root Codex config keys never become persistence proof', () => {
  assert.deepEqual(parseCodexTopLevelConfig([
    'model = "gpt-5.4-mini"',
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "medium"',
    'model_reasoning_effort = "max"',
  ].join('\n')), {
    model: null,
    model_reasoning_effort: null,
    plan_mode_reasoning_effort: null,
  });
});

test('config verifier proves all requested model and reasoning values', () => {
  const config = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "max"',
    'plan_mode_reasoning_effort = "max"',
  ].join('\n');
  const expected = {
    model: 'gpt-5.6-sol',
    model_reasoning_effort: 'max',
    plan_mode_reasoning_effort: 'max',
  };

  assert.deepEqual(verifyCodexTopLevelConfig(config, expected), {
    matches: true,
    expected,
    actual: expected,
    mismatches: [],
  });
});

test('config verifier reports the incomplete second Plan/global write', () => {
  const result = verifyCodexTopLevelConfig([
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "max"',
    'plan_mode_reasoning_effort = "xhigh"',
  ].join('\n'), {
    model: 'gpt-5.6-sol',
    model_reasoning_effort: 'max',
    plan_mode_reasoning_effort: 'max',
  });

  assert.equal(result.matches, false);
  assert.deepEqual(result.mismatches, [{
    key: 'plan_mode_reasoning_effort',
    expected: 'max',
    actual: 'xhigh',
  }]);
});

test('model migration config proof binds source, target, and applied effort in one active file', () => {
  const config = [
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "medium"',
    '',
    '[notice.model_migrations]',
    '"gpt-5.4-mini" = "gpt-5.6-luna"',
  ].join('\n');
  assert.deepEqual(parseCodexModelMigrationsConfig(config), {
    'gpt-5.4-mini': 'gpt-5.6-luna',
  });
  assert.deepEqual(verifyCodexModelMigrationConfig(config, {
    sourceModel: 'GPT-5.4 Mini',
    targetModel: 'GPT-5.6 Luna',
    effort: 'medium',
  }), {
    matches: true,
    expected: {
      model: 'gpt-5.6-luna',
      model_reasoning_effort: 'medium',
      migration_target: 'gpt-5.6-luna',
    },
    actual: {
      model: 'gpt-5.6-luna',
      model_reasoning_effort: 'medium',
      migration_target: 'gpt-5.6-luna',
    },
    mismatches: [],
  });
});

test('assistant-looking acknowledgement text cannot prove migration without matching config', () => {
  const staleConfig = [
    'model = "gpt-5.4-mini"',
    'model_reasoning_effort = "max"',
    '',
    '[notice.model_migrations]',
    '"gpt-5.3-codex" = "gpt-5.4"',
  ].join('\n');
  assert.ok(parseCodexModelMigrationAcknowledgement(
    '• Model changed to gpt-5.6-luna medium',
  ));
  const proof = verifyCodexModelMigrationConfig(staleConfig, {
    sourceModel: 'GPT-5.4 Mini',
    targetModel: 'GPT-5.6 Luna',
    effort: 'medium',
  });
  assert.equal(proof.matches, false);
  assert.deepEqual(
    proof.mismatches.map(item => item.key),
    ['model', 'model_reasoning_effort', 'migration_target'],
  );
});
