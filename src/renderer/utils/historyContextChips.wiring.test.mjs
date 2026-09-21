import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const history = readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const contextChip = readFileSync(new URL('../components/Workspace/TabContextUpdates.tsx', import.meta.url), 'utf8');

test('the context-chip fixture opts into the real History composer', () => {
  const fixture = readFileSync(new URL('../../../scripts/fixtures/history-context-chips.tsx', import.meta.url), 'utf8');
  const historyFixture = readFileSync(new URL('../../../scripts/fixtures/history-preview-reading.tsx', import.meta.url), 'utf8');
  assert.match(fixture, /mountHistoryPreviewFixture\(\{ composer: true \}\)/);
  assert.match(historyFixture, /enableClaudePtyControls=\{composer\}/);
});

test('pending context updates precede saved prompts without sorting or mutating either collection', () => {
  const band = history.slice(history.indexOf('const historyComposerPromptBand ='), history.indexOf('const historySlashCommandMenu ='));
  assert.ok(band.indexOf('{contextUpdates.map(') >= 0);
  assert.ok(band.indexOf('{contextUpdates.map(') < band.indexOf('{composerPromptChips.map('));
  assert.doesNotMatch(band, /\.sort\(/);
});

test('the prompt band caps cards at 168px and keeps labels ellipsized without inline actions', () => {
  const label = history.match(/\[data-history-composer-prompt-band\] \.cb-composer-chip-label\s*\{([^}]+)\}/)?.[1];
  assert.ok(label);
  assert.match(label, /flex-shrink:\s*1/);
  assert.match(label, /min-width:\s*0/);
  assert.match(label, /overflow:\s*hidden/);
  assert.match(label, /text-overflow:\s*ellipsis/);
  assert.match(history, /max-width: var\(--history-composer-prompt-chip-max-width, 168px\)/);
  assert.match(contextChip, /data-context-update-id=\{update\.id\}/);
  assert.match(contextChip, /title=\{\[update\.title, update\.path\]/);
  const collapsed = contextChip.slice(
    contextChip.indexOf('<ComposerChip kind="prompt"'),
    contextChip.indexOf('{open && rect && createPortal'),
  );
  assert.doesNotMatch(collapsed, /trailing=/);
  assert.doesNotMatch(collapsed, /ArrowDownToLine|<X/);
  assert.match(contextChip, /onAuxClick=/);
});

test('context update details render source tabs as real navigation targets', () => {
  assert.match(contextChip, /data-context-update-summary/);
  assert.match(contextChip, /data-context-update-sources/);
  assert.match(contextChip, /data-context-source-tab=\{source\.tabId\}/);
  assert.match(contextChip, /activateCenterTab\(projectId, source\.tabId\)/);
  assert.match(contextChip, /requestTabPrimaryInputFocus\(source\.tabId/);
  assert.match(contextChip, /data-context-source-external/);
  assert.match(contextChip, /data-context-update-section-list/);
  assert.match(contextChip, /data-context-update-section-heading/);
  assert.match(contextChip, /<AttachmentPreviewBar/);
  assert.match(contextChip, /<AttachmentPreviewToolbar/);
  assert.match(contextChip, /navigation=\{navigation\}/);
  assert.match(contextChip, /onMoveToInput=\{moveToInput\}/);
  assert.match(contextChip, /onDelete=\{\(\) => \{ void deleteUpdate\(\); \}\}/);
  assert.match(contextChip, /onClose=\{\(\) => setOpen\(false\)\}/);
  assert.match(contextChip, /data-context-update-preview-body/);
  assert.doesNotMatch(contextChip, /Sure\?/);
  assert.doesNotMatch(contextChip, /setArmed/);
});

test('History owns one left-to-right preview sequence for orange and purple chips', () => {
  assert.match(history, /contextUpdates\.map\(\(update\) => historyContextUpdatePreviewId\(update\.id\)\)/);
  assert.match(history, /composerPromptChips\.map\(\(chip\) => chip\.id\)/);
  assert.match(history, /resolveOrderedPreviewNavigation\(composerPromptBandPreviewIds, previewChipId\)/);
  assert.match(history, /open=\{previewChipId === updatePreviewId\}/);
  assert.match(history, /navigation=\{composerPromptBandPreviewNavigation\}/);
});

test('context-chip dismissal participates in the composer Undo payload', () => {
  assert.match(history, /dismissedContextUpdates\?: ContextDismissalHistoryEntry\[\]/);
  assert.match(history, /memberIds: update\.memberIds\?\.length \? update\.memberIds : \[update\.id\]/);
  assert.match(history, /dismissTabContextUpdate\(tabId, entry\.id, entry\.memberIds\)/);
  assert.match(history, /restoreDismissedTabContextUpdate\(tabId, operation\.entry\.id, operation\.entry\.memberIds\)/);
  assert.match(history, /restoreDismissedTabContextUpdate/);
  assert.match(history, /history: 'add',[\s\S]{0,120}userEvent: 'delete'/);
  assert.match(history, /onDismiss=\{discardContextUpdate\}/);
  assert.match(history, /onDelete=\{deleteContextUpdate\}/);
  assert.match(history, /deleteTabContextUpdate\(tabId, update\.id, memberIds\)/);
});

test('standalone slash commands serialize without composer or context chips', () => {
  assert.match(history, /const systemCommand = isTerminalOnlyComposerDraft\(rawDraftSnapshot\)/);
  assert.match(history, /const sendDraftChips = systemCommand \? \[\] : sourceDraftChips/);
  assert.match(history, /chips: systemCommand \? sourceDraftChips : \[\]/);
});
