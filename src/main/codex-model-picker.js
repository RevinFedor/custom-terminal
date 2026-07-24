'use strict';

const { hasCodexComposerPromptGlyph } = require('./codex-tui-readiness');

const CODEX_ALL_MODELS_VALUE = 'all-models';
const CODEX_MORE_REASONING_VALUE = 'more-reasoning';
const CODEX_PLAN_SCOPE_PLAN_ONLY_VALUE = 'plan-scope-plan-only';
const CODEX_PLAN_SCOPE_ALL_MODES_VALUE = 'plan-scope-all-modes';

const STANDARD_EFFORT_VALUES = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);
const ADVANCED_EFFORT_VALUES = new Set(['max', 'ultra']);
const CODEX_EFFORT_APPLICATION_PERSISTENT = 'persistent-default';
const CODEX_EFFORT_APPLICATION_CONVERSATION = 'conversation-only';
const CODEX_PICKER_FOOTER_RE = /Press enter to confirm or esc to go back/i;
const CODEX_CLIPPED_HEADER_HINT_RE = /\[…\s*\d+\s+lines?\]\s*ctrl\s*\+\s*a\s+view all/i;

function normalizeCodexPickerValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(current\)/g, '')
    .replace(/\(default\)/g, '')
    .replace(/[^\w.-]+/g, ' ')
    .trim();
}

function normalizeCodexMigrationModelLabel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function inspectCodexModelMigrationPrompt(cleanText) {
  const text = String(cleanText || '').replace(/\u00a0/g, ' ');
  const chooserPattern = /Choose\s+how\s+you(?:'|’)?d\s+like\s+Codex\s+to\s+proceed/gi;
  const chooserMatches = Array.from(text.matchAll(chooserPattern));
  const chooserStart = chooserMatches.length > 0
    ? (chooserMatches[chooserMatches.length - 1].index || 0)
    : -1;
  const beforeChooser = chooserStart >= 0 ? text.slice(0, chooserStart) : text;
  const introPattern = /Codex\s+now\s+uses\s+(.+?)\s+in\s+place\s+of\s+(.+?)\.\s*Switch\s+to\s+(.+?)\s+to\s+continue\.?/gi;
  const introMatches = Array.from(
    beforeChooser.replace(/\s+/g, ' ').trim().matchAll(introPattern),
  );
  const intro = introMatches[introMatches.length - 1] || null;
  const targetModel = intro ? intro[1].trim() : null;
  const existingModel = intro ? intro[2].trim() : null;
  const switchTargetModel = intro ? intro[3].trim() : null;
  const modelMetadataValid = !!targetModel
    && !!existingModel
    && normalizeCodexMigrationModelLabel(targetModel)
      === normalizeCodexMigrationModelLabel(switchTargetModel);
  // Only the latest chooser can own Enter. A complete old chooser can remain
  // in the viewport above a newer composer after a redraw; parsing the whole
  // buffer would then submit the user's draft instead of confirming migration.
  const section = chooserStart >= 0 ? text.slice(chooserStart) : '';
  const compact = section.replace(/\s+/g, ' ').trim();
  const firstOptionSelected = /(?:^|\n)[\t ]*[›❯»>]\s*1\.?\s*Try\s+new\s+model\b/im.test(section);
  const secondOptionSelected = /(?:^|\n)[\t ]*[›❯»>]\s*2\.?\s*Use\s+existing\s+model\b/im.test(section);
  const checks = {
    chooserTitle: chooserStart >= 0,
    tryNewModel: /\b1\.?\s*Try\s+new\s+model\b/i.test(compact),
    useExistingModel: /\b2\.?\s*Use\s+existing\s+model\b/i.test(compact),
    confirmHint: /press\s+enter\s+to\s+confirm/i.test(compact),
  };
  const footerMatch = section.match(/press\s+enter\s+to\s+confirm/i);
  const trailingText = footerMatch
    ? section.slice((footerMatch.index || 0) + footerMatch[0].length)
    : '';
  const newerInteractiveSurface = !!footerMatch && hasCodexComposerPromptGlyph(trailingText);
  const missing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  // The explanatory paragraph is server-owned copy and has already changed
  // between "is no longer available" and "will be deprecated soon". The
  // chooser title, both actions and footer are TUI-owned stable anchors.
  const visible = checks.chooserTitle
    && checks.tryNewModel
    && checks.useExistingModel
    && !newerInteractiveSurface;
  let skipReason = null;
  if (newerInteractiveSurface) skipReason = 'newer-interactive-surface';
  else if (visible && secondOptionSelected) skipReason = 'existing-model-selected';
  else if (visible && !firstOptionSelected) skipReason = 'new-model-not-selected';
  else if (visible && !modelMetadataValid) skipReason = intro
    ? 'migration-model-metadata-inconsistent'
    : 'migration-model-metadata-missing';
  else if (visible && !checks.confirmHint) skipReason = 'missing:confirmHint';
  else if (!visible && missing.length > 0) skipReason = 'missing:' + missing.join(',');
  return {
    visible,
    canAutoEnter: visible
      && checks.confirmHint
      && firstOptionSelected
      && !secondOptionSelected
      && modelMetadataValid,
    targetModel,
    existingModel,
    switchTargetModel,
    modelMetadataValid,
    firstOptionSelected,
    secondOptionSelected,
    missing,
    skipReason,
  };
}

function decideCodexModelMigrationAutoEnter({
  sameTerminal = false,
  sameRunSeq = false,
  sameInputRevision = false,
  screenAvailable = false,
  cleanText = '',
  expectedSourceModel = null,
  expectedTargetModel = null,
} = {}) {
  if (!sameTerminal) return { allowed: false, reason: 'terminal-generation-changed' };
  if (!sameRunSeq) return { allowed: false, reason: 'command-generation-changed' };
  if (!sameInputRevision) return { allowed: false, reason: 'input-revision-changed' };
  if (!screenAvailable) return { allowed: false, reason: 'current-screen-unavailable' };
  const prompt = inspectCodexModelMigrationPrompt(cleanText);
  const fallbackMetadataValid = !!normalizeCodexMigrationModelLabel(expectedSourceModel)
    && !!normalizeCodexMigrationModelLabel(expectedTargetModel);
  const selectionStillCurrent = prompt.visible
    && prompt.firstOptionSelected
    && !prompt.secondOptionSelected
    && /press\s+enter\s+to\s+confirm/i.test(String(cleanText || ''));
  if (!selectionStillCurrent || (!prompt.modelMetadataValid && !fallbackMetadataValid)) {
    return {
      allowed: false,
      reason: prompt.skipReason || 'migration-picker-changed',
      prompt,
    };
  }
  return {
    allowed: true,
    reason: 'selected-new-model',
    prompt: {
      ...prompt,
      existingModel: prompt.modelMetadataValid ? prompt.existingModel : expectedSourceModel,
      targetModel: prompt.modelMetadataValid ? prompt.targetModel : expectedTargetModel,
      modelMetadataValid: true,
    },
  };
}

function parseCodexModelMigrationAcknowledgement(output) {
  const clean = String(output || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[(\d*)C/g, (_match, count) => (
      ' '.repeat(Math.min(512, Math.max(1, Number(count) || 1)))
    ))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\u00a0/g, ' ');
  // PersistSelection emits this dedicated info-cell only after its config
  // write succeeds. Resume transcript can replay a user line with identical
  // words as `› Model changed...`; anchoring to the bullet prevents that text
  // from becoming false persistence proof.
  const pattern = /^[\t ]*•[\t ]+Model[\t ]+changed[\t ]+to[\t ]+([a-z0-9][a-z0-9_.-]*)[\t ]+(none|minimal|low|medium|high|xhigh|max|ultra)([\t ]+for[\t ]+this[\t ]+conversation)?[\t ]*[.!]?[\t ]*$/gim;
  let latest = null;
  for (const match of clean.matchAll(pattern)) {
    // The startup migration writes the persistent Codex default. A
    // conversation-only acknowledgement belongs to the separate Ultra flow
    // and cannot settle this startup contract.
    if (match[3]) continue;
    latest = {
      model: String(match[1] || '').trim(),
      effort: String(match[2] || '').trim().toLowerCase(),
      applicationMode: CODEX_EFFORT_APPLICATION_PERSISTENT,
      proof: 'startup-model-migration-ack',
    };
  }
  return latest;
}

function decideCodexModelMigrationAcknowledgement({
  sameTerminal = false,
  sameRunSeq = false,
  sameLaunchId = false,
  sameInputRevision = false,
  expectedTargetModel = null,
  output = '',
} = {}) {
  if (!sameTerminal) return { allowed: false, settled: true, reason: 'terminal-generation-changed' };
  if (!sameRunSeq) return { allowed: false, settled: true, reason: 'command-generation-changed' };
  if (!sameLaunchId) return { allowed: false, settled: true, reason: 'launch-generation-changed' };
  // The acknowledgement belongs to the exact Enter already made durable above.
  // Later typing is not evidence that a different chooser accepted that Enter;
  // only terminal/run/launch generations can make the retained output stale.
  const applied = parseCodexModelMigrationAcknowledgement(output);
  if (!applied) return { allowed: false, settled: false, reason: 'migration-ack-not-observed' };
  const normalizedTarget = normalizeCodexMigrationModelLabel(expectedTargetModel);
  if (normalizedTarget
    && normalizeCodexMigrationModelLabel(applied.model) !== normalizedTarget) {
    return { allowed: false, settled: false, reason: 'migration-ack-target-mismatch', applied };
  }
  return { allowed: true, settled: true, reason: 'migration-ack-observed', applied };
}

function latestCodexPickerSection(cleanText) {
  const text = String(cleanText || '').trimEnd();
  const headerKinds = [
    ['all-model', /Select Model and Effort[^\r\n]*/gi],
    ['top-model', /Select Model(?!\s+and\s+Effort)[^\r\n]*/gi],
    ['standard-effort', /Select Reasoning Level[^\r\n]*/gi],
    ['advanced-effort', /Advanced Reasoning[^\r\n]*/gi],
    ['plan-scope', /Apply reasoning change[^\r\n]*/gi],
  ];
  let latest = null;
  for (const [kind, pattern] of headerKinds) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index || 0;
      if (!latest || index > latest.index) latest = { kind, index };
    }
  }
  const footerMatches = Array.from(text.matchAll(new RegExp(CODEX_PICKER_FOOTER_RE.source, 'gi')));
  const footer = footerMatches[footerMatches.length - 1] || null;
  const beforeFooter = footer
    ? text.slice(0, footer.index || text.length)
    : '';
  const hintMatches = footer
    ? Array.from(beforeFooter.matchAll(new RegExp(CODEX_CLIPPED_HEADER_HINT_RE.source, 'gi')))
    : [];
  const latestHintIndex = hintMatches.length > 0
    ? (hintMatches[hintMatches.length - 1].index || 0)
    : -1;
  const withoutTrailingBlankLines = beforeFooter.trimEnd();
  const blankBoundaries = Array.from(
    withoutTrailingBlankLines.matchAll(/\r?\n[ \t]*\r?\n/g),
  );
  const latestBlankBoundary = blankBoundaries[blankBoundaries.length - 1] || null;
  const modelBlockStart = latestBlankBoundary
    ? (latestBlankBoundary.index || 0) + latestBlankBoundary[0].length
    : 0;
  const modelBlockSection = footer
    ? text.slice(
      modelBlockStart,
      (footer.index || 0) + footer[0].length,
    )
    : '';
  const modelBlockRows = parseCodexNumberedPicker(modelBlockSection);
  const modelBlockValues = modelBlockRows.map(item => parseModelValue(item));
  const strongHeaderlessModelBlock = !!footer
    && modelBlockRows.length >= 2
    && modelBlockRows.some(item => item.selected)
    && modelBlockValues.every(isConcreteCodexModelValue);
  const olderFooterSeparatesHeader = !!latest && footerMatches.some((match) => {
    const index = match.index || 0;
    return index > latest.index && index < modelBlockStart;
  });
  const clippedHintAfterHeader = latestHintIndex >= 0
    && (!latest || latestHintIndex > latest.index);

  // A narrow terminal can clip the current picker header while an older
  // picker header remains in the captured scrollback above it. The clipping
  // hint is one proof. Newer Codex versions can omit that hint too, so a
  // complete block immediately above the exact footer is also proof when it
  // contains 2+ concrete model rows and one physical selection. An explicit
  // header still wins unless an older footer proves that header belongs to a
  // previous picker.
  if (latest
    && !clippedHintAfterHeader
    && !(strongHeaderlessModelBlock && olderFooterSeparatesHeader)) {
    return {
      kind: latest.kind,
      section: text.slice(latest.index),
      headerless: false,
    };
  }

  if (!footer) return null;
  // Headerless recognition is deliberately narrow. Generic confirmations can
  // share the footer, but they do not contain a selected block of concrete
  // Codex model identifiers.
  if (!clippedHintAfterHeader && !strongHeaderlessModelBlock) return null;
  const start = clippedHintAfterHeader
    ? (hintMatches[hintMatches.length - 1].index || 0)
    : modelBlockStart;
  const section = text.slice(start);
  const numbered = parseCodexNumberedPicker(section);
  if (numbered.length < 2 || !numbered.some(item => item.selected)) return null;
  return {
    kind: 'headerless',
    section,
    headerless: true,
  };
}

function parseCodexNumberedPicker(cleanText) {
  const lines = String(cleanText || '')
    .split(/[\r\n]+/)
    .map(line => line.trim())
    .filter(Boolean);
  const items = [];
  const stripSelectionMarker = value => String(value || '')
    .replace(/^[›❯»>]\s*/, '')
    .trim();
  const isNumberedPickerLine = value => /^\d+\.\s*/.test(stripSelectionMarker(value));

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const selected = /^[›❯»>]\s*/.test(line);
    const bare = stripSelectionMarker(line);
    const match = bare.match(/^(\d+)\.\s*(.*)$/);
    if (!match) continue;

    let firstLabel = match[2].trim();
    if (!firstLabel && index + 1 < lines.length && !isNumberedPickerLine(lines[index + 1])) {
      firstLabel = stripSelectionMarker(lines[index + 1]);
    }
    if (!firstLabel) continue;

    const labelParts = [firstLabel];
    for (let next = index + 1; next < lines.length && labelParts.length < 5; next++) {
      if (isNumberedPickerLine(lines[next])) break;
      const part = stripSelectionMarker(lines[next]);
      if (part && part !== firstLabel) labelParts.push(part);
    }

    items.push({
      ordinal: Number(match[1]),
      index: items.length,
      selected,
      value: null,
      label: labelParts.join(' '),
      firstLabel,
      line,
    });
  }

  return items;
}

function finalizePickerItems(items, resolveValue) {
  const resolvedItems = [];
  for (const item of items) {
    const value = resolveValue(item);
    if (!value) continue;
    resolvedItems.push({
      ...item,
      value,
    });
  }
  const selectedItem = items.find(item => item.selected);
  return {
    items: resolvedItems,
    // Navigation is performed by physical arrow-key distance, not by the
    // filtered array position. Keep the selected row even when that row is a
    // new upstream option this version does not understand yet.
    selectedIndex: selectedItem?.index ?? -1,
  };
}

function parseModelValue(item, { allowAllModels = false } = {}) {
  const label = normalizeCodexPickerValue(item.label);
  if (allowAllModels && /^all models(?:\s|$)/.test(label)) {
    return CODEX_ALL_MODELS_VALUE;
  }
  const firstLabel = normalizeCodexPickerValue(item.firstLabel);
  const match = firstLabel.match(/^([a-z0-9][a-z0-9_.-]*)/);
  return match ? match[1] : null;
}

function isConcreteCodexModelValue(value) {
  return /^(?:gpt-|codex-|chatgpt-|o\d)/i.test(String(value || ''));
}

function parseCodexTopModelPicker(cleanText) {
  const active = latestCodexPickerSection(cleanText);
  if (!active || !['top-model', 'headerless'].includes(active.kind)) {
    return { items: [], selectedIndex: -1 };
  }
  const numbered = parseCodexNumberedPicker(active.section);
  if (active.headerless) {
    const looksLikeTopMenu = numbered.some((item) => {
      const value = parseModelValue(item, { allowAllModels: true });
      return value === CODEX_ALL_MODELS_VALUE || String(value || '').startsWith('codex-auto-');
    });
    if (!looksLikeTopMenu) return { items: [], selectedIndex: -1 };
  }
  return finalizePickerItems(
    numbered,
    item => parseModelValue(item, { allowAllModels: true })
  );
}

function parseCodexAllModelPicker(cleanText) {
  const active = latestCodexPickerSection(cleanText);
  if (!active || !['all-model', 'headerless'].includes(active.kind)) {
    return { items: [], selectedIndex: -1 };
  }
  const numbered = parseCodexNumberedPicker(active.section);
  if (active.headerless) {
    const modelValues = numbered.map((item) => {
      const value = parseModelValue(item);
      return value;
    });
    if (modelValues.length < 2 || !modelValues.every(isConcreteCodexModelValue)) {
      return { items: [], selectedIndex: -1 };
    }
  }
  return finalizePickerItems(
    numbered,
    item => parseModelValue(item)
  );
}

function parseStandardEffortValue(item) {
  const label = normalizeCodexPickerValue(item.label);
  if (/^more reasoning(?:\s|$)/.test(label)) return CODEX_MORE_REASONING_VALUE;
  if (/(^|\s)extra[\s-]+high(?:\s|$)/.test(label)) return 'xhigh';

  let value = normalizeCodexPickerValue(item.firstLabel).split(/\s+/)[0] || '';
  if (value === 'med') value = 'medium';
  if (value === 'minimum') value = 'minimal';
  return STANDARD_EFFORT_VALUES.has(value) ? value : null;
}

function parseCodexStandardEffortPicker(cleanText) {
  const active = latestCodexPickerSection(cleanText);
  if (!active || active.kind !== 'standard-effort') {
    return { items: [], selectedIndex: -1 };
  }
  return finalizePickerItems(
    parseCodexNumberedPicker(active.section),
    parseStandardEffortValue
  );
}

function parseCodexAdvancedEffortPicker(cleanText) {
  const active = latestCodexPickerSection(cleanText);
  if (!active || active.kind !== 'advanced-effort') {
    return { items: [], selectedIndex: -1 };
  }
  return finalizePickerItems(
    parseCodexNumberedPicker(active.section),
    (item) => {
      const value = normalizeCodexPickerValue(item.firstLabel).split(/\s+/)[0] || '';
      return ADVANCED_EFFORT_VALUES.has(value) ? value : null;
    }
  );
}

function parseCodexPlanReasoningScopePicker(cleanText) {
  const active = latestCodexPickerSection(cleanText);
  if (!active || active.kind !== 'plan-scope') {
    return { items: [], selectedIndex: -1 };
  }
  const section = active.section;
  const picker = finalizePickerItems(
    parseCodexNumberedPicker(section),
    (item) => {
      const label = normalizeCodexPickerValue(item.label);
      if (/^apply to plan mode override(?:\s|$)/.test(label)) {
        return CODEX_PLAN_SCOPE_PLAN_ONLY_VALUE;
      }
      if (/^apply to global default and plan mode override(?:\s|$)/.test(label)) {
        return CODEX_PLAN_SCOPE_ALL_MODES_VALUE;
      }
      return null;
    }
  );
  const reasoningMatch = section.match(
    /(?:where|how)\s+to\s+apply\s+(none|minimal|minimum|low|med|medium|high|x[\s-]?high|extra[\s-]+high|max|ultra)\s+reasoning/i
  );
  let reasoningValue = normalizeCodexPickerValue(reasoningMatch?.[1] || '');
  if (reasoningValue === 'minimum') reasoningValue = 'minimal';
  if (reasoningValue === 'med') reasoningValue = 'medium';
  if (reasoningValue === 'x high'
    || reasoningValue === 'x-high'
    || reasoningValue === 'extra high'
    || reasoningValue === 'extra-high') {
    reasoningValue = 'xhigh';
  }
  return {
    ...picker,
    reasoningValue: STANDARD_EFFORT_VALUES.has(reasoningValue)
      || ADVANCED_EFFORT_VALUES.has(reasoningValue)
      ? reasoningValue
      : null,
  };
}

function isCodexActivePickerFrame(cleanText) {
  if (inspectCodexModelMigrationPrompt(cleanText).visible) return true;
  const active = latestCodexPickerSection(cleanText);
  if (!active) return false;
  const numbered = parseCodexNumberedPicker(active.section);
  if (!numbered.some(item => item.selected)) return false;
  if (active.headerless) return numbered.length >= 2;
  // An explicit, parser-owned picker header is enough to type a single
  // selected row. Narrow terminals can clip every sibling row and the footer;
  // requiring two rows would reinterpret `Advanced Reasoning\n› 2. Ultra` as
  // the composer. Headerless screens remain deliberately stricter above.
  return numbered.length >= 1;
}

function isCodexNativeRewindFrameText(cleanText) {
  const lines = String(cleanText || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[▌█]/g, '')
    .split(/[\r\n]+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const hasTranscriptTitle = lines.some(line => (
    /^[\s/\\|─━_-]*T\s+R\s+A\s+N\s+S\s+C\s+R\s+I\s+P\s+T[\s/\\|─━_-]*$/i.test(line)
  ));
  const hasTranscriptFooter = lines.some(line => (
    /\besc\s*\/\s*←\s+to\s+edit\s+prev\b.*\benter\s+to\s+edit\s+message\b/i.test(line)
  ));
  return hasTranscriptTitle && hasTranscriptFooter;
}

function isCodexPickerFrameComposer(cleanText) {
  const text = String(cleanText || '');
  // `›` is shared by the composer, the selected picker row, and native
  // Rewind's selected transcript row. Those proven interactive surfaces
  // therefore have priority over the generic prompt-glyph test.
  if (isCodexNativeRewindFrameText(text)) return false;
  if (isCodexActivePickerFrame(text)) return false;
  return hasCodexComposerPromptGlyph(text)
    || /Context\s+\d+%/i.test(text);
}

function isCodexModelEffortConfirmationObserved(
  postEnterText,
  currentFrameText,
  model,
  effort,
) {
  // Ink may paint the acknowledgement and the restored composer in separate
  // synchronized renders. The acknowledgement must come from the accumulated
  // post-Enter delta, while composer proof may come from the independently
  // flushed current screen. Requiring both in one render loses a real Ultra
  // acknowledgement and turns successful selection into a timeout.
  return isCodexModelEffortAppliedMessage(postEnterText, model, effort)
    && isCodexPickerFrameComposer(currentFrameText);
}

function decideCodexPickerCleanupFrame({
  screenAvailable = false,
  nativeRewindProven = false,
  activePicker = false,
  composerProven = false,
} = {}) {
  if (!screenAvailable) {
    return { action: 'stop', success: false, reason: 'authoritative-screen-unavailable' };
  }
  if (nativeRewindProven) {
    return { action: 'stop', success: false, reason: 'native-rewind-overlay' };
  }
  if (composerProven) {
    return { action: 'done', success: true, reason: 'already-composer' };
  }
  if (activePicker) {
    return { action: 'escape-picker', success: false, reason: 'active-picker' };
  }
  return { action: 'stop', success: false, reason: 'interactive-surface-unproven' };
}

function valuesFromPicker(source) {
  const values = Array.isArray(source)
    ? source
    : Array.isArray(source?.items)
      ? source.items
      : [];
  return values.map(item => (
    typeof item === 'string'
      ? normalizeCodexPickerValue(item)
      : normalizeCodexPickerValue(item?.value)
  ));
}

function unionCodexEffortOptions(...sources) {
  const result = [];
  const seen = new Set();
  for (const source of sources) {
    for (const value of valuesFromPicker(source)) {
      if (!value || value === CODEX_MORE_REASONING_VALUE) continue;
      if (!STANDARD_EFFORT_VALUES.has(value) && !ADVANCED_EFFORT_VALUES.has(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function isCodexAdvancedEffort(value) {
  return ADVANCED_EFFORT_VALUES.has(normalizeCodexPickerValue(value));
}

function codexEffortApplicationMode(value) {
  return normalizeCodexPickerValue(value) === 'ultra'
    ? CODEX_EFFORT_APPLICATION_CONVERSATION
    : CODEX_EFFORT_APPLICATION_PERSISTENT;
}

function codexEffortCanUsePlanScope(value) {
  return normalizeCodexPickerValue(value) !== 'ultra';
}

function codexModelEffortAppliedMessageCount(cleanText, model, effort) {
  const normalizedModel = normalizeCodexPickerValue(model);
  const normalizedEffort = normalizeCodexPickerValue(effort);
  if (!normalizedModel || !normalizedEffort) return 0;

  const escapedModel = normalizedModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEffort = normalizedEffort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (normalizedEffort === 'ultra') {
    const exactUltraCell = new RegExp(
      '^[\\t ]*•[\\t ]+Model[\\t ]+changed[\\t ]+to[\\t ]+'
        + escapedModel
        + '[\\t ]+'
        + escapedEffort
        + '[\\t ]+for[\\t ]+this[\\t ]+conversation[\\t ]*[.!]?[\\t ]*$',
      'gim',
    );
    return Array.from(
      String(cleanText || '').replace(/\u00a0/g, ' ').matchAll(exactUltraCell),
    ).length;
  }

  const normalized = String(cleanText || '').toLowerCase().replace(/\s+/g, ' ');
  const suffix = normalizedEffort === 'ultra'
    ? '\\s+for\\s+this\\s+conversation'
    : '';
  const pattern = new RegExp(
    'model\\s+changed\\s+to\\s+' + escapedModel + '\\s+' + escapedEffort + suffix + '(?=\\s|$)',
    'gi',
  );
  const exactCount = Array.from(normalized.matchAll(pattern)).length;
  if (exactCount > 0
    || normalizedEffort === 'ultra'
    || !normalizedModel.startsWith('codex-auto-')) {
    return exactCount;
  }
  // Auto presets may intentionally omit the effort label in their success
  // cell. Count that exact model-only form so callers can still require a new
  // post-Enter acknowledgement instead of reusing an old visible cell.
  const modelOnlyPattern = new RegExp(
    'model\\s+changed\\s+to\\s+' + escapedModel + '(?=\\s|$)',
    'gi',
  );
  return Array.from(normalized.matchAll(modelOnlyPattern)).length;
}

function isCodexModelEffortAppliedMessage(cleanText, model, effort) {
  if (codexModelEffortAppliedMessageCount(cleanText, model, effort) > 0) {
    return true;
  }
  const normalizedModel = normalizeCodexPickerValue(model);
  const normalizedEffort = normalizeCodexPickerValue(effort);
  // Codex 0.145 intentionally omits the effort label from success messages
  // for codex-auto-* presets. Ultra is never allowed through this fallback:
  // its explicit "for this conversation" acknowledgement is the only proof
  // that the separate ApplyAdvancedReasoning action completed.
  if (normalizedEffort === 'ultra' || !normalizedModel.startsWith('codex-auto-')) {
    return false;
  }
  const normalized = String(cleanText || '').toLowerCase().replace(/\s+/g, ' ');
  const escaped = normalizedModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('model\\s+changed\\s+to\\s+' + escaped + '(?=\\s|$)', 'i').test(normalized);
}

function findPickerItem(picker, value) {
  const target = normalizeCodexPickerValue(value);
  return picker?.items?.find(item => normalizeCodexPickerValue(item.value) === target) || null;
}

function planCodexModelSelection(targetModel, {
  topPicker = null,
  allModelPicker = null,
} = {}) {
  const target = normalizeCodexPickerValue(targetModel);
  if (!target) {
    return { available: false, reason: 'missing-model', target, route: null, steps: [] };
  }

  if (findPickerItem(topPicker, target)) {
    return {
      available: true,
      complete: true,
      target,
      route: 'top-model-direct',
      steps: [{ picker: 'top-model', target }],
    };
  }

  const targetInAllModels = findPickerItem(allModelPicker, target);
  const hasAllModelsNavigation = !!findPickerItem(topPicker, CODEX_ALL_MODELS_VALUE);
  if (targetInAllModels && !hasAllModelsNavigation) {
    return {
      available: true,
      complete: true,
      target,
      route: 'all-model-direct',
      steps: [{ picker: 'all-model', target }],
    };
  }
  if (hasAllModelsNavigation) {
    return {
      available: allModelPicker === null || !!targetInAllModels,
      complete: !!targetInAllModels,
      reason: allModelPicker !== null && !targetInAllModels ? 'model-not-found' : null,
      target,
      route: 'all-models-nested',
      steps: [
        { picker: 'top-model', target: CODEX_ALL_MODELS_VALUE },
        { picker: 'all-model', target },
      ],
      missingPicker: allModelPicker === null ? 'all-model' : null,
    };
  }

  return {
    available: false,
    complete: false,
    reason: 'model-not-found',
    target,
    route: null,
    steps: [],
  };
}

function planCodexEffortSelection(targetEffort, {
  standardPicker = null,
  advancedPicker = null,
  planScopePicker = null,
} = {}) {
  const target = normalizeCodexPickerValue(targetEffort);
  const options = unionCodexEffortOptions(standardPicker, advancedPicker);
  if (!STANDARD_EFFORT_VALUES.has(target) && !ADVANCED_EFFORT_VALUES.has(target)) {
    return {
      available: false,
      complete: false,
      reason: 'unsupported-effort',
      target,
      route: null,
      steps: [],
      options,
    };
  }

  // Some Codex models expose exactly one reasoning level. Selecting the model
  // then skips both effort menus and opens the Plan-mode scope prompt directly.
  // The prompt itself must name the requested effort; otherwise its presence is
  // not sufficient proof that Codex applied the requested value.
  const hasDirectPlanScope = !!planScopePicker?.items?.length
    && !standardPicker?.items?.length
    && !advancedPicker?.items?.length;
  if (hasDirectPlanScope) {
    const observedEffort = normalizeCodexPickerValue(
      planScopePicker.reasoningValue
    );
    const hasPersistentScope = !!findPickerItem(
      planScopePicker,
      CODEX_PLAN_SCOPE_ALL_MODES_VALUE
    );
    const effortConfirmed = observedEffort === target;
    const scopeAllowed = codexEffortCanUsePlanScope(target);
    return {
      available: scopeAllowed && effortConfirmed && hasPersistentScope,
      complete: scopeAllowed && effortConfirmed && hasPersistentScope,
      reason: !scopeAllowed
        ? 'conversation-effort-does-not-use-plan-scope'
        : !effortConfirmed
        ? observedEffort
          ? 'direct-effort-mismatch'
          : 'direct-effort-unconfirmed'
        : !hasPersistentScope
          ? 'plan-scope-not-found'
          : null,
      target,
      route: 'plan-scope-direct',
      steps: [{
        picker: 'plan-scope',
        target: CODEX_PLAN_SCOPE_ALL_MODES_VALUE,
      }],
      observedEffort: observedEffort || null,
      effortImplicit: true,
      options: effortConfirmed ? [target] : [],
    };
  }

  if (!isCodexAdvancedEffort(target)) {
    const available = !!findPickerItem(standardPicker, target);
    return {
      available,
      complete: available,
      reason: available ? null : 'effort-not-found',
      target,
      route: 'standard-direct',
      steps: [{ picker: 'standard-effort', target }],
      options,
    };
  }

  const hasAdvancedNavigation = !!findPickerItem(
    standardPicker,
    CODEX_MORE_REASONING_VALUE
  );
  const targetInAdvanced = findPickerItem(advancedPicker, target);
  const advancedPickerObserved = advancedPicker !== null;
  const available = hasAdvancedNavigation
    && (!advancedPickerObserved || !!targetInAdvanced);

  return {
    available,
    complete: hasAdvancedNavigation && !!targetInAdvanced,
    reason: !hasAdvancedNavigation
      ? 'advanced-navigation-not-found'
      : advancedPickerObserved && !targetInAdvanced
        ? 'effort-not-found'
        : null,
    target,
    route: 'advanced-nested',
    steps: [
      { picker: 'standard-effort', target: CODEX_MORE_REASONING_VALUE },
      { picker: 'advanced-effort', target },
    ],
    missingPicker: !advancedPickerObserved ? 'advanced-effort' : null,
    options,
  };
}

const CODEX_CONFIG_STATE_KEYS = Object.freeze([
  'model',
  'model_reasoning_effort',
  'plan_mode_reasoning_effort',
]);

function parseCodexTomlString(rawValue) {
  const raw = String(rawValue || '').trim();
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  if (!raw.startsWith('"') || !raw.endsWith('"')) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read only the three root-level values that prove a /model change. Values
 * under profiles or other TOML tables intentionally do not count.
 */
function parseCodexTopLevelConfig(configText) {
  const result = Object.fromEntries(
    CODEX_CONFIG_STATE_KEYS.map(key => [key, null])
  );
  const wanted = new Set(CODEX_CONFIG_STATE_KEYS);
  const seen = new Set();
  const duplicated = new Set();
  let insideTable = false;

  for (const sourceLine of String(configText || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line)) {
      insideTable = true;
      continue;
    }
    if (insideTable) continue;

    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*((?:"(?:\\.|[^"\\])*")|(?:'[^']*'))\s*(?:#.*)?$/);
    if (!match || !wanted.has(match[1])) continue;
    if (seen.has(match[1])) {
      duplicated.add(match[1]);
      result[match[1]] = null;
      continue;
    }
    seen.add(match[1]);
    if (duplicated.has(match[1])) continue;
    result[match[1]] = parseCodexTomlString(match[2]);
  }

  return result;
}

function parseCodexModelMigrationsConfig(configText) {
  const migrations = {};
  let activeTable = null;

  for (const sourceLine of String(configText || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const table = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) {
      activeTable = table[1].trim().toLowerCase();
      continue;
    }
    if (activeTable !== 'notice.model_migrations') continue;
    const match = line.match(/^((?:"(?:\\.|[^"\\])*")|(?:'[^']*')|(?:[A-Za-z0-9_.-]+))\s*=\s*((?:"(?:\\.|[^"\\])*")|(?:'[^']*'))\s*(?:#.*)?$/);
    if (!match) continue;
    const rawKey = match[1];
    const key = rawKey.startsWith('"') || rawKey.startsWith("'")
      ? parseCodexTomlString(rawKey)
      : rawKey;
    const value = parseCodexTomlString(match[2]);
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    const normalizedKey = normalizeCodexMigrationModelLabel(key);
    if (!normalizedKey || Object.prototype.hasOwnProperty.call(migrations, normalizedKey)) {
      migrations[normalizedKey || key] = null;
      continue;
    }
    migrations[normalizedKey] = normalizeCodexMigrationModelLabel(value);
  }
  return migrations;
}

function normalizeCodexExpectedConfigValue(key, value) {
  if (value === null || value === undefined) return value;
  if (key === 'model') return normalizeCodexPickerValue(value);
  const normalized = normalizeCodexPickerValue(value);
  if (normalized === 'minimum') return 'minimal';
  if (normalized === 'med') return 'medium';
  if (normalized === 'x high'
    || normalized === 'x-high'
    || normalized === 'extra high'
    || normalized === 'extra-high') {
    return 'xhigh';
  }
  return normalized;
}

/**
 * Compare an on-disk config snapshot with an explicit expected state. Callers
 * may omit a key to leave it unchecked, but model changes should normally pass
 * all three keys so the two asynchronous Plan/global writes are both proven.
 */
function verifyCodexTopLevelConfig(configText, expectedState = {}) {
  const parsed = parseCodexTopLevelConfig(configText);
  const actual = {};
  const expected = {};
  const mismatches = [];

  for (const key of CODEX_CONFIG_STATE_KEYS) {
    actual[key] = normalizeCodexExpectedConfigValue(key, parsed[key]);
    if (!Object.prototype.hasOwnProperty.call(expectedState, key)) continue;
    expected[key] = normalizeCodexExpectedConfigValue(key, expectedState[key]);
    if (actual[key] !== expected[key]) {
      mismatches.push({
        key,
        expected: expected[key],
        actual: actual[key],
      });
    }
  }

  return {
    matches: mismatches.length === 0,
    expected,
    actual,
    mismatches,
  };
}

function verifyCodexModelMigrationConfig(configText, {
  sourceModel,
  targetModel,
  effort,
} = {}) {
  const normalizedSource = normalizeCodexMigrationModelLabel(sourceModel);
  const normalizedTarget = normalizeCodexMigrationModelLabel(targetModel);
  const normalizedEffort = normalizeCodexExpectedConfigValue(
    'model_reasoning_effort',
    effort,
  );
  const topLevel = parseCodexTopLevelConfig(configText);
  const migrations = parseCodexModelMigrationsConfig(configText);
  const actual = {
    model: normalizeCodexMigrationModelLabel(topLevel.model),
    model_reasoning_effort: normalizeCodexExpectedConfigValue(
      'model_reasoning_effort',
      topLevel.model_reasoning_effort,
    ),
    migration_target: normalizedSource ? (migrations[normalizedSource] || null) : null,
  };
  const expected = {
    model: normalizedTarget || null,
    model_reasoning_effort: normalizedEffort || null,
    migration_target: normalizedTarget || null,
  };
  const mismatches = [];
  for (const key of Object.keys(expected)) {
    if (!expected[key] || actual[key] !== expected[key]) {
      mismatches.push({ key, expected: expected[key], actual: actual[key] });
    }
  }
  return {
    matches: mismatches.length === 0,
    expected,
    actual,
    mismatches,
  };
}

module.exports = {
  CODEX_ALL_MODELS_VALUE,
  CODEX_EFFORT_APPLICATION_CONVERSATION,
  CODEX_EFFORT_APPLICATION_PERSISTENT,
  CODEX_MORE_REASONING_VALUE,
  CODEX_PLAN_SCOPE_PLAN_ONLY_VALUE,
  CODEX_PLAN_SCOPE_ALL_MODES_VALUE,
  codexEffortApplicationMode,
  codexEffortCanUsePlanScope,
  codexModelEffortAppliedMessageCount,
  decideCodexModelMigrationAcknowledgement,
  decideCodexModelMigrationAutoEnter,
  decideCodexPickerCleanupFrame,
  isCodexAdvancedEffort,
  isCodexActivePickerFrame,
  isCodexModelEffortConfirmationObserved,
  isCodexModelEffortAppliedMessage,
  isCodexNativeRewindFrameText,
  inspectCodexModelMigrationPrompt,
  normalizeCodexPickerValue,
  normalizeCodexMigrationModelLabel,
  parseCodexAdvancedEffortPicker,
  parseCodexModelMigrationAcknowledgement,
  parseCodexModelMigrationsConfig,
  parseCodexPlanReasoningScopePicker,
  isCodexPickerFrameComposer,
  parseCodexAllModelPicker,
  parseCodexStandardEffortPicker,
  parseCodexTopLevelConfig,
  parseCodexTopModelPicker,
  planCodexEffortSelection,
  planCodexModelSelection,
  unionCodexEffortOptions,
  verifyCodexModelMigrationConfig,
  verifyCodexTopLevelConfig,
};
