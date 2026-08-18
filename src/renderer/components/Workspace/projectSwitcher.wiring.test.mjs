// Ctrl+Q — the project switcher, pinned where the pure model cannot reach.
//
// Two of these are about a key that is NOT ours by default: Ctrl+Q is XOFF, so
// leaking it into a PTY freezes the terminal's output until Ctrl+S — a hang with
// no visible cause, which reads as "the app broke". Every xterm key handler must
// swallow it, and there are two of them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const overlay = fs.readFileSync(path.join(here, 'ProjectSwitcherOverlay.tsx'), 'utf8');
const terminal = fs.readFileSync(path.join(here, 'Terminal.tsx'), 'utf8');
const app = fs.readFileSync(path.join(here, '..', '..', 'App.tsx'), 'utf8');

test('Ctrl+Q never reaches the PTY — both xterm handlers swallow it', () => {
  const swallows = terminal.match(
    /event\.ctrlKey && !event\.metaKey && !event\.altKey\s*\n?\s*&& event\.type === 'keydown' && event\.code === 'KeyQ'/g,
  ) || [];
  assert.equal(swallows.length, 2, 'both handlers must swallow Ctrl+Q');
});

test('the gesture is layout-agnostic', () => {
  // e.code, not e.key: on a RU layout Ctrl+Q is Ctrl+Й, and a switcher that
  // stops working when you type Russian is worse than no switcher.
  assert.match(overlay, /e\.code === 'KeyQ'/);
  assert.doesNotMatch(overlay, /e\.key === 'q'/i);
});

test('the panel is a singleton mounted once, like the tab switcher', () => {
  // Its key listeners are on window; a second mounted copy would answer the
  // same press twice.
  const mounts = app.match(/<ProjectSwitcherOverlay\s*\/>/g) || [];
  assert.equal(mounts.length, 1);
  assert.match(app, /import ProjectSwitcherOverlay from/);
});

test('releasing Ctrl commits, and a fast tap rebuilds from the stores', () => {
  // Ctrl can be released before React renders the first frame; without the
  // fallback the classic one-tap "go back" would do nothing.
  assert.match(overlay, /e\.key !== 'Control'/);
  const keyUp = overlay.slice(overlay.indexOf('const onKeyUp'), overlay.indexOf('const onBlur'));
  assert.match(keyUp, /computeProjectRows\(\)/);
  assert.match(keyUp, /initialProjectIndex\(effectiveRows\)/);
});

test('committing the row you are already on does nothing', () => {
  // Row 1 is an anchor, not a destination. Re-navigating to it is not a no-op
  // downstream — showWorkspace reshuffles the project history.
  const commit = overlay.slice(overlay.indexOf('const commitRow'), overlay.indexOf('// Resolve the initial highlight'));
  assert.match(commit, /if \(!row \|\| row\.current\) return;/);
  assert.match(commit, /showDashboard\(\)/);
  assert.match(commit, /showWorkspace\(row\.id\)/);
});

test('the anchor row does not look like a target', () => {
  // Same visual language as Ctrl+Tab: a left rail for "you are here", the
  // selection ring only for the row the keyboard is on.
  assert.match(overlay, /row\.current \? 'inset 2px 0 0 0 #6e6e76' : 'none'/);
});

test('выбранная строка подсвечивает карточку проекта в титлбаре', () => {
  // Юзер: «если ты подсветишь проект, это равносильно тому, что я навёлся на
  // него мышью». Поэтому переключатель не рисует своё украшение наверху, а
  // только сообщает, на каком проекте стоит; вид наведения принадлежит
  // карточке — разойтись с мышиным он не может, потому что это он и есть.
  assert.match(overlay, /emitProjectHoverPreview\(row && row\.kind === 'project' \? row\.id : null\)/);
  // Закрытие и размонтирование обязаны гасить: иначе карточка остаётся
  // подсвеченной после перехода, и человек видит «наведение» без курсора.
  assert.match(overlay, /if \(!open\) \{ emitProjectHoverPreview\(null\); return; \}/);
  assert.match(overlay, /useEffect\(\(\) => \(\) => emitProjectHoverPreview\(null\), \[\]\)/);
});

test('карточка проекта показывает наведение состоянием, а не только CSS-классом', () => {
  // hover:text-white отвечал лишь курсору — клавиатура физически не могла его
  // вызвать. Один источник вида, два входа: мышь и Ctrl+Q.
  assert.match(app, /const hovered = isHovered \|\| isPreviewHovered;/);
  assert.doesNotMatch(app, /'text-gray-400 hover:text-white'/);
  assert.match(app, /onMouseEnter=\{\(\) => setIsHovered\(true\)\}/);
  assert.match(app, /\{!isActive && hovered && \(/);
});
