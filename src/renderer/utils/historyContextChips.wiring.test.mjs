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

test('the prompt band overrides the shared fixed label width, preserving trailing actions', () => {
  const label = history.match(/\[data-history-composer-prompt-band\] \.cb-composer-chip-label\s*\{([^}]+)\}/)?.[1];
  assert.ok(label);
  assert.match(label, /flex-shrink:\s*1/);
  assert.match(label, /min-width:\s*0/);
  assert.match(label, /overflow:\s*hidden/);
  assert.match(label, /text-overflow:\s*ellipsis/);
  assert.match(contextChip, /data-context-update-id=\{update\.id\}/);
  assert.match(contextChip, /aria-label="Перенести обновление в input"/);
  assert.match(contextChip, /aria-label="Убрать обновление"/);
});
