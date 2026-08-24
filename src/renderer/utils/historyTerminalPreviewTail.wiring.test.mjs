import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const source = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

const sliceFrom = (startText, endText) => {
  const start = source.indexOf(startText);
  assert.ok(start >= 0, `missing source boundary: ${startText}`);
  const end = source.indexOf(endText, start);
  assert.ok(end > start, `missing source boundary: ${endText}`);
  return source.slice(start, end);
};

test('the Footer contains only real preview/timing content, never synthetic reserve', () => {
  const footer = sliceFrom('const HistoryTerminalPreviewFooter =', '// Cheap stand-in row');
  assert.match(footer, /context\?\.terminalPreview/);
  assert.match(footer, /context\?\.responseTiming/);
  assert.doesNotMatch(footer, /tailSpacer|data-history-tail-spacer|aria-hidden="true"/);
});

test('preview revisions have one owner-bound tail pin only for a tail reader', () => {
  const effect = sliceFrom(
    'if (!terminalPreview || !isAtBottomRef.current) return;',
    '// Both PTY agents expose canonical incremental transcript records.',
  );
  assert.match(effect, /historyTailPinScheduler\.schedule\(/);
  assert.match(effect, /delayFrames: 2/);
  assert.equal(
    (effect.match(/historyTailPinScheduler\.schedule\(/g) || []).length,
    1,
    'one preview revision must have one scroll writer',
  );
  assert.doesNotMatch(effect, /\.scrollTop\s*=/, 'the effect delegates to the owner-bound scheduler');
});

test('canonical preview clear waits for the exact row and preserves its viewport anchor', () => {
  const handler = sliceFrom(
    'const onTerminalPreview =',
    "ipcRenderer.on('agent-transcript:terminal-preview'",
  );
  assert.match(handler, /detail\.action === 'clear'/);
  assert.match(handler, /detail\.reason === 'canonical-materialized'/);
  assert.match(handler, /canonicalIdentity/);
  assert.match(handler, /setTerminalPreviewClearHandoff\(handoff\)/);

  const handoff = sliceFrom(
    '// Exact live-preview → canonical-row handoff.',
    'useEffect(() => {\n    const onTerminalPreviewDiagnosticResult',
  );
  assert.match(handoff, /historyLivePresentationIdentities\(entry\)\.includes/);
  assert.match(handoff, /data-uuid/);
  assert.match(handoff, /historyTerminalPreviewHandoffScrollTop\(\{/);
  assert.match(handoff, /phase: 'clearing-preview'/);
  assert.match(handoff, /TERMINAL_PREVIEW_HANDOFF_DONE/);
  assert.doesNotMatch(handoff, /tailSpacer|holdHistoryShrinkFrame/);
});

test('the removed second-bottom subsystem cannot be wired back accidentally', () => {
  assert.doesNotMatch(
    source,
    /historyTailSpacerRef|data-history-tail-spacer|holdHistoryShrinkFrame|armTailReserve/,
  );
});
