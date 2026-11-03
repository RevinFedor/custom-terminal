// «Следующая отправка — в Run after»: правый клик по кнопке переноса взводит
// ожидание, первая отправка вкладки уходит в очередь вместо агента.
//
// Пользовательский сценарий, ради которого это сделано: правый клик → Option+1 →
// надиктовал → чип сам «отправился», но текст лёг в Run after, а не агенту.
// Поэтому ручной Enter и автоотправка чипа обязаны вести себя одинаково — оба
// приходят одним событием `history-panel:submit-composer`.
//
// Здесь исполняется НАСТОЯЩИЙ обработчик этого события, вырезанный из
// HistoryPanel.tsx, поверх настоящего модуля ожидания. Контролируемые порты —
// только store, диагностика и доставка событий.
//
// Запуск: node --test src/renderer/utils/runAfterCaptureArm.actual.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

import {
  clearRunAfterCaptureArm,
  consumeRunAfterCaptureArm,
  isRunAfterCaptureArmed,
  resetRunAfterCaptureArmForTest,
  subscribeRunAfterCaptureArm,
  toggleRunAfterCaptureArm,
} from './runAfterCaptureArm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const panelSource = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'HistoryPanel.tsx'), 'utf8');
const barSource = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'ClaudeControlBar.tsx'), 'utf8');

// The real listener body, sliced out of the effect that installs it.
function submitHandler({ draft = '', dictationPending = false, canArmDictation = false } = {}) {
  const from = panelSource.indexOf('    const submitComposer = (event: Event) => {');
  assert.ok(from > 0, 'submitComposer must exist');
  const to = panelSource.indexOf('\n    };', from);
  assert.ok(to > from, 'the listener must be sliceable');
  const code = ts.transpileModule(panelSource.slice(from, to + '\n    };'.length)
    .replace(/^\s*const submitComposer =/, 'globalThis.submitComposer ='), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sent = [], dispatched = [], diag = [], warnings = [];
  const context = vm.createContext({
    tabId: 'tab-a',
    consumeRunAfterCaptureArm,
    dictationBlocksSend: () => dictationPending,
    armDictationChipsForTab: () => canArmDictation,
    setDraftWarning: (message) => warnings.push(message),
    historyDiag: (line) => diag.push(line),
    runAction: (action, options) => { sent.push({ action, options }); return Promise.resolve(); },
    useUIStore: { getState: () => ({ historyPromptDrafts: { 'tab-a': draft } }) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    window: { dispatchEvent: (event) => dispatched.push({ type: event.type, detail: event.detail }) },
    console,
  });
  vm.runInContext(code, context);
  return {
    sent, dispatched, diag, warnings,
    submit: (detail) => context.submitComposer({ detail }),
  };
}

// The physical Enter keydown in the composer textarea is a SEPARATE listener
// from `submitComposer` above — it never dispatches `history-panel:submit-
// composer`, it calls `runAction('send', …)` directly. Шрам: правый клик
// взводил ожидание, но обычное ручное нажатие Enter (не Option+1, не кнопка
// ControlBar, не автоотправка диктовки) полностью его игнорировало и слало
// текст агенту. Эта функция вырезает ровно тот `onKeyDown`, короткозамыкая
// все более ранние ветки (word-motion, slash-menu, paste-shortcut, Ctrl+C,
// Option+1), чтобы дойти до plain-Enter веткой, которую чинит эта правка.
function plainEnterHandler({ canSend = true, dictationHoldsSend = false } = {}) {
  const from = panelSource.indexOf('                onKeyDown={(e) => {\n'
    + '                  const optionAutoEnter = isDictationAutoEnterShortcut(e);');
  assert.ok(from > 0, 'the plain composer onKeyDown must exist');
  const endMarker = "if (canSend) runAction('send', { uiActionId: currentUIActionId() });";
  const markerAt = panelSource.indexOf(endMarker, from);
  assert.ok(markerAt > from, 'the handler must end where it always has');
  const to = panelSource.indexOf('\n                }}', markerAt);
  assert.ok(to > markerAt, 'the handler must be sliceable');
  const code = ts.transpileModule(panelSource.slice(from, to + '\n                }}'.length)
    .replace(/^\s*onKeyDown=\{\(e\) => \{/, 'globalThis.onKeyDown = (e) => {'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sent = [], dispatched = [], diag = [], warnings = [];
  const context = vm.createContext({
    tabId: 'tab-a',
    dictationHoldsSend,
    canSend,
    consumeRunAfterCaptureArm,
    armDictationChipsForTab: () => false,
    listDictationChipsForTab: () => [],
    setDraftWarning: (message) => warnings.push(message),
    historyDiag: (line) => diag.push(line),
    runAction: (action, options) => { sent.push({ action, options }); return Promise.resolve(); },
    currentUIActionId: () => 'ui-1',
    // Earlier branches of the same handler — short-circuited to false/noop so
    // control reaches the plain-Enter branch under test, exactly as a real
    // keydown with no modifiers and a closed slash menu would.
    handleComposerWordMotion: () => false,
    isDictationAutoEnterShortcut: () => false,
    historySlashMenuOpen: false,
    isPlainTextPasteShortcut: () => false,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    window: { dispatchEvent: (event) => dispatched.push({ type: event.type, detail: event.detail }) },
    console,
  });
  vm.runInContext(code, context);
  const event = {
    key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, code: 'Enter',
    nativeEvent: { isComposing: false, stopImmediatePropagation: () => {} },
    preventDefault: () => {}, stopPropagation: () => {},
    currentTarget: { selectionStart: 0, selectionEnd: 0 },
  };
  return { sent, dispatched, diag, warnings, pressEnter: () => context.onKeyDown(event) };
}

test.beforeEach(() => resetRunAfterCaptureArmForTest());

test('a physical Enter keypress ALSO honours the arming, not just the submit event', () => {
  // This is the exact gap the user hit: right-click arms, then a plain manual
  // Enter (typed, no dictation, no Option+1) must go to Run after too.
  const h = plainEnterHandler();
  toggleRunAfterCaptureArm('tab-a');
  h.pressEnter();
  assert.deepEqual(h.sent, [], 'plain Enter must NOT reach the agent while armed');
  assert.deepEqual(h.dispatched.map((e) => e.type), ['prompt-queue:grab-current']);
  assert.equal(h.dispatched[0].detail.tabId, 'tab-a');
  assert.match(h.diag.join('\n'), /RUN_AFTER_CAPTURE_ARM_FIRE.*via=enter-key/);
  // Spent, not a mode: the very next physical Enter sends normally again.
  h.pressEnter();
  assert.equal(h.sent.length, 1);
  assert.equal(h.dispatched.length, 1);
});

test('a physical Enter without arming sends exactly as before', () => {
  const h = plainEnterHandler();
  h.pressEnter();
  assert.deepEqual(h.dispatched, []);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].action, 'send');
});

test('right-click arms, a second one disarms, and nothing else is armed', () => {
  assert.equal(isRunAfterCaptureArmed('tab-a'), false);
  assert.equal(toggleRunAfterCaptureArm('tab-a'), true);
  assert.equal(isRunAfterCaptureArmed('tab-a'), true);
  assert.equal(isRunAfterCaptureArmed('tab-b'), false, 'arming is per tab');
  assert.equal(toggleRunAfterCaptureArm('tab-a'), false, 'a second right-click cancels');
  assert.equal(isRunAfterCaptureArmed('tab-a'), false);
});

test('a manual Enter goes to the queue while armed, and to the agent after', () => {
  const h = submitHandler({ draft: 'готовый текст' });
  toggleRunAfterCaptureArm('tab-a');

  h.submit({ tabId: 'tab-a', source: 'enter' });
  assert.deepEqual(h.sent, [], 'the agent must NOT receive an armed submit');
  assert.deepEqual(h.dispatched.map((e) => e.type), ['prompt-queue:grab-current']);
  assert.equal(h.dispatched[0].detail.tabId, 'tab-a');
  assert.match(h.diag.join('\n'), /RUN_AFTER_CAPTURE_ARM_FIRE/);

  // One send, not a mode: the next Enter is an ordinary send again.
  h.submit({ tabId: 'tab-a', source: 'enter' });
  assert.equal(h.sent.length, 1, 'the arming is spent');
  assert.equal(h.dispatched.length, 1);
});

test('dictation auto-send takes the same path as Enter', () => {
  // The reported flow: right-click, Option+1, the chip finishes and "sends"
  // itself. That send arrives through the same event, so it must land in the
  // queue — otherwise the feature would work for typing but not for dictation,
  // which is the way the user actually uses it.
  const h = submitHandler({ draft: 'распознанный текст' });
  toggleRunAfterCaptureArm('tab-a');
  h.submit({ tabId: 'tab-a', source: 'dictation-chip-auto-send' });
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.dispatched.map((e) => e.type), ['prompt-queue:grab-current']);
  assert.match(h.diag.join('\n'), /via=dictation-chip-auto-send/);
});

test('a resolve that landed in a background tab also honours the arming', () => {
  // The deferred path fires on the panel's next mount with its own source.
  const h = submitHandler({ draft: 'фоновый текст' });
  toggleRunAfterCaptureArm('tab-a');
  h.submit({ tabId: 'tab-a', source: 'dictation-deferred-auto-send' });
  assert.deepEqual(h.sent, []);
  assert.equal(h.dispatched.length, 1);
});

test('an unresolved dictation is still not captured as a literal marker', () => {
  // Order matters: the dictation guard runs BEFORE the arming check, so Enter
  // during recognition arms the chip's auto-send as usual and the arming waits
  // for the real text instead of queueing `[Dictating vr-…]`.
  const h = submitHandler({ draft: '[Dictating vr-1]', dictationPending: true, canArmDictation: true });
  toggleRunAfterCaptureArm('tab-a');
  h.submit({ tabId: 'tab-a', source: 'enter' });
  assert.deepEqual(h.dispatched, [], 'nothing is queued yet');
  assert.deepEqual(h.sent, []);
  assert.equal(isRunAfterCaptureArmed('tab-a'), true, 'the arming survives until real text arrives');
  assert.match(h.diag.join('\n'), /DICTATION_ARM/);
});

test('a broken dictation refuses the send without spending the arming', () => {
  const h = submitHandler({ draft: '[Dictating vr-1]', dictationPending: true, canArmDictation: false });
  toggleRunAfterCaptureArm('tab-a');
  h.submit({ tabId: 'tab-a', source: 'enter' });
  assert.equal(h.warnings.length, 1);
  assert.equal(isRunAfterCaptureArmed('tab-a'), true);
});

test('a submit for another tab never consumes this tab arming', () => {
  const h = submitHandler({ draft: 'текст' });
  toggleRunAfterCaptureArm('tab-a');
  h.submit({ tabId: 'tab-b', source: 'enter' });
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.dispatched, []);
  assert.equal(isRunAfterCaptureArmed('tab-a'), true);
});

test('consume is atomic: two submits in one frame cannot both capture', () => {
  // Between a separate check and clear, a second submit fits (Enter during the
  // chip auto-send) and BOTH texts would be queued instead of one.
  toggleRunAfterCaptureArm('tab-a');
  assert.equal(consumeRunAfterCaptureArm('tab-a'), true);
  assert.equal(consumeRunAfterCaptureArm('tab-a'), false, 'the second caller gets nothing');
});

test('clearing is idempotent, so a repeat cannot re-arm by accident', () => {
  toggleRunAfterCaptureArm('tab-a');
  assert.equal(clearRunAfterCaptureArm('tab-a'), true);
  assert.equal(clearRunAfterCaptureArm('tab-a'), false);
  assert.equal(isRunAfterCaptureArmed('tab-a'), false, 'a second clear must not toggle it back on');
});

test('the button subscribes to its own tab only', () => {
  const seen = [];
  const stop = subscribeRunAfterCaptureArm('tab-a', (value) => seen.push(value));
  toggleRunAfterCaptureArm('tab-b');
  assert.deepEqual(seen, [], 'a neighbour tab must not re-render this button');
  toggleRunAfterCaptureArm('tab-a');
  toggleRunAfterCaptureArm('tab-a');
  assert.deepEqual(seen, [true, false]);
  stop();
  toggleRunAfterCaptureArm('tab-a');
  assert.deepEqual(seen, [true, false], 'unsubscribed listeners stop hearing');
});

test('the button is wired: right-click toggles, armed state pulses and is announced', () => {
  // Structural, because the button cannot be mounted under plain node. These
  // are exactly the parts that would silently rot: the handler, the visible
  // pulse and the accessible state.
  const from = barSource.indexOf('data-prompt-queue-grab-trigger={tabId}');
  assert.ok(from > 0);
  const end = barSource.indexOf('</button>', from);
  assert.ok(end > from, 'the button must be sliceable');
  const slice = barSource.slice(from, end);
  assert.match(slice, /onContextMenu=\{\(event\) => \{/, 'right-click must be handled');
  assert.match(slice, /event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);\s*\n\s*const armed = toggleRunAfterCaptureArm\(tabId\)/,
    'the native menu must be suppressed and the arming toggled');
  assert.match(slice, /aria-pressed=\{runAfterCaptureArmed\}/, 'the state must be announced');
  assert.match(slice, /cb-run-after-arm-pulse/, 'the armed state must be visible');
  assert.match(barSource, /subscribeRunAfterCaptureArm\(tabId, setRunAfterCaptureArmed\)/);
  // The pulse styling must exist, including the reduced-motion fallback: this
  // state changes where the next send goes and cannot be invisible.
  const css = fs.readFileSync(path.join(here, '..', 'styles', 'globals.css'), 'utf8');
  assert.match(css, /\.cb-run-after-arm-pulse \{/);
  assert.match(css, /prefers-reduced-motion[\s\S]{0,700}\.cb-run-after-arm-pulse \{ background-color/);
  // The pulse must stop in a hidden retained pane. It inherits that from the
  // base class, which is already listed — a private marker here would be a
  // second mechanism for the same job.
  const pauses = fs.readFileSync(path.join(here, '..', 'styles', 'presentationAnimations.css'), 'utf8');
  assert.match(pauses, /\.cb-run-after-hotkey-surface/);
  assert.doesNotMatch(slice, /noted-infinite-animation/,
    'no second pause marker: the base class already covers this node');
});

test('the capture runs through the existing grab pipeline, not a second copy', () => {
  // PromptQueueOverlay owns draft ownership, image materialisation and the
  // exact clear semantics. Re-implementing any of that in the panel is how the
  // two paths drift apart.
  assert.match(panelSource, /window\.dispatchEvent\(new CustomEvent\('prompt-queue:grab-current', \{\s*\n\s*detail: \{ tabId, source: 'capture-arm' \},/);
  const overlay = fs.readFileSync(
    path.join(here, '..', 'components', 'Workspace', 'PromptQueueOverlay.tsx'), 'utf8');
  assert.match(overlay, /window\.addEventListener\('prompt-queue:grab-current', onGrabCurrent\)/);
});
