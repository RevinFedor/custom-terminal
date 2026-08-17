import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cardsSource = fs.readFileSync(
  path.join(repoRoot, 'packages/claude-blocks/src/components/ToolCards.tsx'),
  'utf8',
);
const panelSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);
const cssSource = fs.readFileSync(
  path.join(repoRoot, 'packages/claude-blocks/src/blocks.css'),
  'utf8',
);

/**
 * Hover-copy on an expandable row: the affordance the user already knows from
 * a prompt row, applied to reasoning and tool cards. These lock the parts that
 * are easy to break silently — WHAT gets copied per kind, and that a
 * dehydrated row is fetched before copying instead of handing over its
 * preview.
 */

test('each row kind copies its own payload, not the rendering', () => {
  const fn = cardsSource.slice(cardsSource.indexOf('function toolCopyText('));
  assert.ok(fn.length > 0, 'copy-text builder must exist');
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // A read hands over the file text it shows when expanded.
  assert.match(body, /toolName === 'Read'[\s\S]{0,120}resultText/);
  // A run hands over BOTH halves — the command alone is not what happened.
  assert.match(body, /args\?\.command[\s\S]{0,200}resultText/);
  // An edit hands over the path plus the transcript's own diff.
  assert.match(body, /diffHunks[\s\S]{0,400}hunk\.entries/);
  // Anything else: arguments + result (the two halves of an exchange).
  assert.match(body, /JSON\.stringify\(args, null, 2\)/);
});

test('copy is lazy — a collapsed row builds no string until pressed', () => {
  // getCopyText is a THUNK: passing a prebuilt string here would materialise
  // every row's payload during render, which is what dehydration exists to
  // avoid.
  assert.match(cardsSource, /getCopyText: \(\) => toolCopyText\(/);
});

test('a dehydrated row fetches its full payload before copying', () => {
  const hook = panelSource.slice(panelSource.indexOf('const useRehydratedCopy ='));
  assert.ok(hook.length > 0, 'rehydration-aware copy hook must exist');
  const body = hook.slice(0, hook.indexOf('\n};\n'));
  // "Whole" means: no ref at all, or the presented text is no longer the
  // preview main shipped.
  assert.match(body, /!ref \|\| \(presented != null && presented !== preview\)/);
  // The deferred press completes in an effect — clipboard writes are side
  // effects and render may run twice per commit.
  assert.match(body, /useEffect\(\(\) => \{[\s\S]{0,200}clipboard\.writeText/);
  // Both readers share ONE fetch: the copy path only raises the same "wanted"
  // flag the expand path uses.
  assert.match(panelSource, /useRehydratedPayload\(text, payloadRef, open \|\| copyWanted\)/);
  assert.match(panelSource, /useRehydratedPayload\(result, resultRef, open \|\| copyWanted\)/);
});

test('the button is revealed by the row, never by its own hover alone', () => {
  // Hovering a 20px target you cannot see is not an affordance; the ROW
  // reveals it, exactly like a prompt row's copy.
  assert.match(cssSource, /\.cb-tool:hover \.cb-row-copy/);
  assert.match(cssSource, /\.cb-think:hover \.cb-row-copy/);
  // Keyboard users get it too — a Tab-reachable control must not be invisible.
  assert.match(cssSource, /\.cb-tool:focus-within \.cb-row-copy/);
  assert.match(cssSource, /\.cb-think:focus-within \.cb-row-copy/);
});

test('tool and thinking copy controls share one absolute right column; groups have none', () => {
  const copyCss = cssSource.slice(cssSource.indexOf('.cb-row-copy {'));
  assert.match(copyCss.slice(0, 420), /position: absolute/);
  assert.match(copyCss.slice(0, 420), /right: 0/);
  assert.match(copyCss.slice(0, 420), /top: 50%/);
  // The reserved 28px makes long text wrap BEFORE the control instead of
  // moving the control or painting underneath it.
  assert.match(cssSource, /\.cb-tool-head:has\(> \.cb-row-copy\)[\s\S]{0,100}padding-right: 28px/);
  assert.match(cssSource, /\.cb-think-head:has\(> \.cb-row-copy\)[\s\S]{0,60}padding-right: 28px/);
  assert.doesNotMatch(panelSource, /Скопировать весь блок/);
  assert.doesNotMatch(panelSource, /hp-history-group-head-inner:hover \.cb-row-copy/);
});
