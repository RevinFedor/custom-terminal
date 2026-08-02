import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(here, '../components/Workspace');
const overlaySource = fs.readFileSync(path.join(workspaceDir, 'PromptQueueOverlay.tsx'), 'utf8');
const historySource = fs.readFileSync(path.join(workspaceDir, 'HistoryPanel.tsx'), 'utf8');
const floatingFrameSource = fs.readFileSync(path.join(workspaceDir, 'FloatingTerminalFrame.tsx'), 'utf8');

test('portal clicks do not switch the active input surface to terminal', () => {
  const start = floatingFrameSource.indexOf('onPointerDownCapture={(event) => {');
  const end = floatingFrameSource.indexOf('\n        }}', start);
  assert.ok(start >= 0 && end > start);
  const handler = floatingFrameSource.slice(start, end);
  assert.match(handler, /frameRef\.current\?\.contains\(target\)/);
  assert.match(handler, /setPromptQueueInputSurface\(tabId, 'terminal'\)/);
});

test('History Replay appends and restores the CodeMirror caret through its owner', () => {
  const start = overlaySource.indexOf("if (!submitNow && replaySurface === 'history')");
  const end = overlaySource.indexOf("if (replaySurface === 'terminal')", start);
  assert.ok(start >= 0 && end > start);
  const branch = overlaySource.slice(start, end);
  assert.match(branch, /const caretStart = currentText\.length/);
  assert.match(branch, /const caretEnd = currentText\.length/);
  assert.doesNotMatch(branch, /querySelector<.*HTMLTextAreaElement/);
  assert.match(
    branch,
    /focusHistoryComposer\('replay-after-history-transfer', \{\s*start: caretAfterInsert,\s*end: caretAfterInsert/,
  );

  const focusStart = historySource.indexOf('const focusComposer = (event: Event) => {');
  const focusEnd = historySource.indexOf("window.addEventListener('history-panel:focus-composer'", focusStart);
  assert.ok(focusStart >= 0 && focusEnd > focusStart);
  const focusHandler = historySource.slice(focusStart, focusEnd);
  assert.match(focusHandler, /editor\.setSelectionRange\(start, end\)/);
  assert.match(focusHandler, /promptCaretRef\.current = \{ start, end \}/);
});
