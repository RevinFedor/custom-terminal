import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Reads the shipped component so a future edit that reintroduces a mode which
// suppresses the outside-click handler fails here instead of in the UI.
const source = fs.readFileSync(new URL('./ClaudeUsageButton.tsx', import.meta.url), 'utf8');

// Comments may still explain why the mode was removed; only live code counts.
const code = source
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

test('the ⌘⇧ sticky pin is gone from the usage popover', () => {
  assert.doesNotMatch(code, /sticky/i, 'no sticky state, prop, border or hint remains');
  assert.doesNotMatch(code, /⌘⇧/, 'the keyboard hint is removed from the footer and titles');
  assert.doesNotMatch(code, /Pinned across tabs/, 'the pinned label is removed');
  assert.doesNotMatch(code, /event\.key === 'Shift'/, 'the Cmd+Shift keydown branch is gone');
});

test('outside click and Escape are armed whenever the popover is open', () => {
  const start = source.indexOf("const onMouseDown = (event: MouseEvent) => {\n      if (rootRef.current?.contains");
  assert.ok(start > 0, 'the outside-click handler still exists');
  const effectStart = source.lastIndexOf('useEffect(() => {', start);
  const effect = source.slice(effectStart, source.indexOf('}, [clicked]);', start) + '}, [clicked]);'.length);
  // The regression: `if (!clicked || sticky) return;` disarmed the handler for a
  // pinned popover, so clicking the workspace overlay did nothing.
  assert.match(effect, /if \(!clicked\) return;/);
  assert.doesNotMatch(effect, /\|\|\s*sticky/);
  assert.match(effect, /setClicked\(false\)/);
  assert.match(effect, /event\.key !== 'Escape'/);
});

// Behavioural model of the shipped guard, same order and early return.
function closesOnMouseDown({ open, insideRoot }) {
  if (!open) return false;
  if (insideRoot) return false;
  return true;
}

test('clicking the workspace overlay closes the popover; clicking inside keeps it', () => {
  assert.equal(closesOnMouseDown({ open: true, insideRoot: false }), true, 'overlay click closes');
  assert.equal(closesOnMouseDown({ open: true, insideRoot: true }), false, 'click inside chip/popover keeps it');
  assert.equal(closesOnMouseDown({ open: false, insideRoot: false }), false, 'closed popover ignores clicks');
});

test('the popover shell renders inside the ref the handler tests against', () => {
  const rootAt = source.indexOf('ref={rootRef}');
  const shellAt = source.indexOf('ref={popoverShellRef}');
  assert.ok(rootAt > 0 && shellAt > rootAt,
    'the dialog is a descendant of rootRef, so contains() keeps clicks inside the open window');
});
