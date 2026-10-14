import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendHistoryDraftInsertion,
  buildProjectScriptRows,
  buildPromptFilePathText,
  captureHistoryMenuAnchor,
  chooseContextMenuOpenLeft,
  clampFloatingPanelTop,
  isCurrentPickerGeneration,
  joinPromptInsertionText,
  placePointAnchoredMenu,
  protectLeadingMacUsersPath,
  promptHasFileReferences,
  resolveCascadingMenuDirection,
  resolveHistoryScriptCwd,
} from './promptInsertMenuModel.mjs';

test('buildProjectScriptRows returns inert command text without Enter', () => {
  const rows = buildProjectScriptRows(
    JSON.stringify({ scripts: { dev: 'vite', _private: 'noop', test: 'vitest' } }),
    ['deploy.sh', '.hidden.sh', 'deploy.sh', 'notes.txt'],
  );

  assert.deepEqual(rows, [
    { id: 'npm:dev', label: 'npm run dev', text: 'npm run dev' },
    { id: 'npm:test', label: 'npm run test', text: 'npm run test' },
    { id: 'sh:deploy.sh', label: './deploy.sh', text: './deploy.sh' },
  ]);
  assert.equal(rows.some((row) => row.text.includes('\r')), false);
});

test('joinPromptInsertionText keeps prompt and file order with readable gaps', () => {
  assert.equal(
    joinPromptInsertionText('Review this', ['first file', '', 'second file']),
    'Review this\n\nfirst file\n\nsecond file',
  );
});

test('Cmd insertion keeps a path with spaces as plain editable text', () => {
  const spaced = '/Users/example/Global-Templates/🧩 Code-Patterns/docs-rules.prompt.md';
  assert.equal(buildPromptFilePathText([spaced]), spaced);
});

test('Cmd insertion contains only file paths, never prompt text or Claude syntax', () => {
  const text = buildPromptFilePathText(['/tmp/a.md', '/tmp/b.md']);
  assert.equal(text, '/tmp/a.md\n/tmp/b.md');
  assert.equal(text.includes('@"'), false);
  assert.equal(text.includes('Review this'), false);
});

test('empty file entries do not create blank path rows', () => {
  assert.equal(buildPromptFilePathText(['', '   ', '/tmp/a.md']), '/tmp/a.md');
  assert.equal(buildPromptFilePathText([]), '');
});

test('a prompt without files has nothing to reference', () => {
  assert.equal(promptHasFileReferences({ file_paths: [] }), false);
  assert.equal(promptHasFileReferences({ file_paths: ['  '] }), false);
  assert.equal(promptHasFileReferences({}), false);
  assert.equal(promptHasFileReferences({ file_paths: ['/tmp/a.md'] }), true);
  assert.equal(buildPromptFilePathText([]), '');
});

test('a leading macOS Users path gets a tilde only at the first visible position', () => {
  const path = '/Users/example/Desktop/example.md';
  assert.equal(protectLeadingMacUsersPath(path), `~${path}`);
  assert.equal(protectLeadingMacUsersPath(path, '  \n'), `~${path}`);
  assert.equal(protectLeadingMacUsersPath(path, 'before '), path);
});

test('leading Users path protection is case-sensitive and requires the directory boundary', () => {
  assert.equal(protectLeadingMacUsersPath('/users/fedor/file.md'), '/users/fedor/file.md');
  assert.equal(protectLeadingMacUsersPath('/User/fedor/file.md'), '/User/fedor/file.md');
  assert.equal(protectLeadingMacUsersPath('/Users'), '/Users');
});

test('malformed package json does not hide shell scripts', () => {
  assert.deepEqual(buildProjectScriptRows('{bad', ['deploy.sh']), [
    { id: 'sh:deploy.sh', label: './deploy.sh', text: './deploy.sh' },
  ]);
});

test('history fallback inserts exact text without clearing the existing draft', () => {
  assert.equal(
    appendHistoryDraftInsertion('before\n', 'npm run dev'),
    'before\nnpm run dev',
  );
});

test('scripts prefer live PTY cwd and fall back to the captured History cwd', () => {
  assert.equal(resolveHistoryScriptCwd('/tmp/live ', '/tmp/captured'), '/tmp/live ');
  assert.equal(resolveHistoryScriptCwd('', '/tmp/captured '), '/tmp/captured ');
  assert.equal(resolveHistoryScriptCwd(null, undefined), '');
});

test('async picker completion only owns the generation it started in', () => {
  assert.equal(isCurrentPickerGeneration(3, 3), true);
  assert.equal(isCurrentPickerGeneration(3, 4), false);
  assert.equal(isCurrentPickerGeneration(0, 0), false);
});

test('a tall submenu clamps itself without changing its parent anchor', () => {
  const rootTop = 700;
  const childTop = clampFloatingPanelTop(rootTop, 460, 900, 8);

  assert.equal(rootTop, 700);
  assert.equal(childTop, 432);
  assert.equal(clampFloatingPanelTop(20, 200, 900, 8), 20);
  assert.equal(clampFloatingPanelTop(4, 1200, 900, 8), 8);
});

test('history context anchor preserves the exact pointer position', () => {
  const anchor = captureHistoryMenuAnchor({
    pointerX: 420,
    pointerY: 780,
    composerTop: 710,
  });

  assert.deepEqual(anchor, {
    mode: 'point',
    x: 420,
    y: 780,
  });
  assert.deepEqual(
    captureHistoryMenuAnchor({ pointerX: 420, pointerY: 780 }),
    { mode: 'point', x: 420, y: 780 },
  );
});

test('point menu keeps one edge beside the pointer at every viewport edge', () => {
  assert.deepEqual(placePointAnchoredMenu({
    anchorX: 100,
    anchorY: 100,
    panelWidth: 390,
    panelHeight: 196,
    viewportWidth: 1447,
    viewportHeight: 913,
  }), {
    left: 102,
    top: 102,
    openUp: false,
    availableHeight: 803,
  });

  const bottom = placePointAnchoredMenu({
    anchorX: 800,
    anchorY: 800,
    panelWidth: 390,
    panelHeight: 196,
    viewportWidth: 1447,
    viewportHeight: 913,
  });
  assert.deepEqual(bottom, {
    left: 802,
    top: 602,
    openUp: true,
    availableHeight: 790,
  });
  assert.equal(bottom.top + 196, 798);

  const right = placePointAnchoredMenu({
    anchorX: 1400,
    anchorY: 200,
    panelWidth: 390,
    panelHeight: 196,
    viewportWidth: 1447,
    viewportHeight: 913,
    openLeft: true,
  });
  assert.equal(right.left, 1008);
  assert.equal(right.left + 390, 1398);
});

test('oversized point menu uses the larger side and reports its height limit', () => {
  assert.deepEqual(placePointAnchoredMenu({
    anchorX: 700,
    anchorY: 800,
    panelWidth: 300,
    panelHeight: 1200,
    viewportWidth: 1447,
    viewportHeight: 913,
  }), {
    left: 702,
    top: 8,
    openUp: true,
    availableHeight: 790,
  });
});

test('context menu chooses one side from maximum chain width', () => {
  const nearRightEdge = chooseContextMenuOpenLeft({
    anchorX: 940,
    viewportWidth: 1000,
    rootWidth: 130,
    descendantWidth: 360,
  });
  const nearLeftEdge = chooseContextMenuOpenLeft({
    anchorX: 20,
    viewportWidth: 1000,
    rootWidth: 130,
    descendantWidth: 360,
  });

  assert.equal(nearRightEdge, true);
  assert.equal(nearLeftEdge, false);
  // The result is intentionally independent of whichever child/group is
  // currently hovered: callers pass the maximum chain width once on open.
  assert.equal(chooseContextMenuOpenLeft({
    anchorX: 500,
    viewportWidth: 1000,
    rootWidth: 130,
    descendantWidth: 360,
  }), false);
});

test('cascading menu navigation mirrors with its real opening side', () => {
  assert.deepEqual(resolveCascadingMenuDirection(false), {
    forwardKey: 'ArrowRight',
    backKey: 'ArrowLeft',
    chevron: 'right',
  });
  assert.deepEqual(resolveCascadingMenuDirection(true), {
    forwardKey: 'ArrowLeft',
    backKey: 'ArrowRight',
    chevron: 'left',
  });
});
