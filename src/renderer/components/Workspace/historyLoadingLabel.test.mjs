// Pins the single loader sentence. Source contracts only: the component is
// three lines of JSX around one derived string, so running React here would
// test the renderer, not the contract.
//
// Why: opening a tab used to show up to three different messages —
// "Loading...", "Чтение истории · 77% · 192/248 МБ", "Подготовка
// отображения…" — and below a one-second threshold none of them at all. The
// user read that as three separate mechanisms and asked for one. Cold opens
// take 1-3s, so the label is the normal case; the percent and the stage are
// extra detail about the same operation, not replacements for it.
//
// Run: node --experimental-strip-types --test \
//   src/renderer/components/Workspace/historyLoadingLabel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const status = readFileSync(resolve(HERE, 'HistoryLoadingStatus.tsx'), 'utf8');
const panel = readFileSync(resolve(HERE, 'HistoryPanel.tsx'), 'utf8');

const STEM = 'Читаю историю';

test('every loader state starts with the same sentence', () => {
  // Both quote forms: the percent variant is a template literal.
  const labels = [
    ...[...status.matchAll(/'(Читаю историю[^']*)'/g)].map(match => match[1]),
    ...[...status.matchAll(/`(Читаю историю[^`]*)`/g)].map(match => match[1]),
  ];
  assert.ok(labels.length >= 3, 'the three states must all be present');
  for (const label of labels) {
    assert.ok(label.startsWith(STEM), `"${label}" must extend the shared sentence`);
  }
  // The detail is appended, never substituted.
  assert.ok(labels.some(label => label === STEM), 'the bare state exists');
  assert.ok(labels.some(label => label.includes('%')), 'the byte-progress state exists');
  assert.ok(labels.some(label => label.includes('строю карточки')), 'the build state exists');
});

test('the old competing wordings are gone from every surface', () => {
  for (const [name, source] of [['HistoryLoadingStatus', status], ['HistoryPanel', panel]]) {
    assert.ok(!source.includes('Подготовка отображения'), `${name} must not keep the old second message`);
    assert.ok(!/['"]Loading\.\.\.['"]/.test(source), `${name} must not fall back to "Loading..."`);
  }
});

test('the stale-owner curtain uses the same sentence', () => {
  // A different word here would reintroduce the exact confusion: the curtain
  // and the loader can appear back to back during a tab switch.
  const index = panel.indexOf('data-history-stale-curtain');
  assert.ok(index > 0, 'the curtain must exist');
  assert.ok(panel.slice(index, index + 900).includes(STEM),
    'the curtain must show the shared sentence');
});

test('the threshold is 200ms, and the label is not gated behind it', () => {
  assert.match(status, /setTimeout\(\(\) => setSlowOwner\(owner\), 200\)/,
    'a whole second of silence is what made the states look unrelated');
  assert.match(status, /startedAt >= 200/, 'the already-running case uses the same threshold');
  // Crucially the stem renders immediately; only the DETAIL waits for 200ms.
  assert.match(status, /const label = !detailed \? 'Читаю историю'/,
    'the sentence must not wait for the detail threshold');
});

test('byte progress stays attached to the same operation', () => {
  // The MB readout is the one place that states a size, and it must keep
  // saying what it measures: the journal being read, not the cache.
  assert.match(status, /completedBytes \/ 1048576/);
  assert.match(status, /totalBytes \/ 1048576/);
  assert.match(status, /МБ/);
});
