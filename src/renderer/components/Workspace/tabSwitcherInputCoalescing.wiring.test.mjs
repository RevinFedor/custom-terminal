import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(workspaceDir, 'TabSwitcherOverlay.tsx'), 'utf8');

test('stale Ctrl+Tab paints once before committing and coalesces only a released retry', () => {
  assert.match(source, /shouldCoalesceCtrlSwitcherRetry\(\{[\s\S]{0,180}commitPending: pendingBatch\.commitPending/);
  assert.match(source, /pendingBatch\.coalescedRetries \+= 1/);
  assert.match(source, /suppressedControlUpsRef\.current \+= 1/);
  assert.match(source, /phase=\$\{phase\}/);

  const paint = source.slice(
    source.indexOf('// A stale native gesture must visibly acknowledge itself'),
    source.indexOf('// ── global key handling', source.indexOf('// A stale native gesture')),
  );
  assert.match(paint, /requestAnimationFrame\(\(\) => \{[\s\S]*requestAnimationFrame\(\(\) => \{/);
  assert.match(paint, /current\.feedbackPainted = true/);
  assert.match(paint, /if \(current\.commitPending\) commitCtrlSelection\('stale-after-feedback'/);
});

test('fresh fast taps retain immediate commit while delayed release waits', () => {
  const keyup = source.slice(source.indexOf('const onKeyUp ='), source.indexOf('const onBlur ='));
  assert.match(keyup, /shouldDeferCtrlSwitcherCommit/);
  assert.match(keyup, /batch\.commitPending = true/);
  assert.match(keyup, /commitCtrlSelection\('control-release', inputDelay\)/);
  assert.match(keyup, /retry-release-suppressed/);
});

test('diagnostics separate native delivery, feedback paint and placement commit', () => {
  for (const phase of ['open', 'release-waiting-for-feedback', 'retry-coalesced', 'feedback-painted', 'commit']) {
    assert.match(source, new RegExp(`logCtrlGesture\\('${phase}'`));
  }
  assert.match(source, /eventToPaintMs/);
  assert.match(source, /receivedToPaintMs/);
  assert.match(source, /eventToCommitMs/);
  assert.match(source, /target: row\?\.kind === 'tab'/);
});
