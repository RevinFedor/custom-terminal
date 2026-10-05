import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { consumePromptQueueMiddleClick } from './promptQueueMiddleClick.mjs';
import { shouldDisarmAfterTriggerClear } from './runAfterTriggerClear.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/PromptQueueOverlay.tsx', import.meta.url), 'utf8');

function rowEvent(button = 1, inside = true) {
  const target = {};
  const calls = [];
  return {
    button,
    target,
    currentTarget: { contains: (node) => inside && node === target },
    preventDefault: () => calls.push('prevent'),
    stopPropagation: () => calls.push('stop'),
    calls,
  };
}

test('middle mousedown blocks native focus/paste/autoscroll without deleting', () => {
  const event = rowEvent();
  assert.equal(consumePromptQueueMiddleClick(event), true);
  assert.deepEqual(event.calls, ['prevent', 'stop']);
});

test('middle auxclick consumes the gesture and deletes once', () => {
  const event = rowEvent();
  let removed = 0;
  assert.equal(consumePromptQueueMiddleClick(event, () => removed++), true);
  assert.equal(removed, 1);
  assert.deepEqual(event.calls, ['prevent', 'stop']);
});

test('left and right clicks retain their existing actions', () => {
  for (const button of [0, 2]) {
    const event = rowEvent(button);
    assert.equal(consumePromptQueueMiddleClick(event, () => assert.fail('not a middle click')), false);
    assert.deepEqual(event.calls, []);
  }
});

test('portal picker events are not row deletions', () => {
  const event = rowEvent(1, false);
  assert.equal(consumePromptQueueMiddleClick(event, () => assert.fail('portal must keep its own action')), false);
  assert.deepEqual(event.calls, []);
});

test('the physical row, label, input, button and gaps share one delete target', () => {
  const row = {};
  const descendants = [row, {}, {}, {}];
  let removed = 0;
  for (const target of descendants) {
    const event = rowEvent();
    event.target = target;
    event.currentTarget = { contains: (node) => descendants.includes(node) };
    consumePromptQueueMiddleClick(event, () => removed++);
  }
  assert.equal(removed, descendants.length);
});

test('card deletion captures before replay/remove/edit and keeps the animated remove path', () => {
  const card = source.slice(source.indexOf('data-prompt-queue-item={it.id}'), source.indexOf('/* Replay (▶)'));
  assert.match(card, /onMouseDownCapture=\{\(e\) => \{\s*if \(consumePromptQueueMiddleClick\(e\)\) return;/);
  assert.match(card, /onAuxClickCapture=\{\(event\) => consumePromptQueueMiddleClick\(event, \(\) => animateRemovePrompt\(it\.id\)\)\}/);
  assert.match(source, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); animateRemovePrompt\(it\.id\); \}\}/);
  assert.match(source, /'pq-chip',\s*'pq-middle-delete-target'/);
});

test('all trigger types and context gate own their whole sub-row, not the iteration', () => {
  const trigger = source.slice(source.indexOf('{triggerRows.map('), source.indexOf('{showContextCondition &&'));
  const context = source.slice(source.indexOf('{showContextCondition &&'), source.indexOf('</ItemFrame>', source.indexOf('{showContextCondition &&')));
  for (const row of [trigger, context]) {
    assert.match(row, /className="pq-middle-delete-target"/);
    assert.match(row, /onMouseDownCapture=[\s\S]{0,300}consumePromptQueueMiddleClick\(event\)/);
    assert.doesNotMatch(row, /animateRemovePrompt|removePrompt\(/);
    assert.match(row, /backgroundColor:/);
    assert.match(row, /data-chip-action="remove-/);
  }
  assert.match(trigger, /onAuxClickCapture=[\s\S]{0,500}clearItemTrigger\(it\.id\)/);
  assert.match(trigger, /onClick=\{\(\) => \{[\s\S]{0,230}else clearItemTrigger\(it\.id\)/);
  assert.match(trigger, /overview && triggerKind === 'onTab' && \(event\.target as HTMLElement\)\.closest\('\[data-tab-card\]'\)/);
  assert.match(context, /onAuxClickCapture=.*setPromptCondition\(tabId, it\.id, null\)/);
  assert.match(context, /onClick=\{\(\) => setPromptCondition\(tabId, it\.id, null\)\}/);
});

test('hover highlights the entire row without replacing its state background', () => {
  assert.match(source, /\.pq-middle-delete-target:hover\s*\{\s*background-image: linear-gradient/);
  const card = source.slice(source.indexOf('data-prompt-queue-item={it.id}'), source.indexOf('/* Replay (▶)'));
  assert.match(card, /backgroundColor: isSendPending/);
  assert.doesNotMatch(card, /\bbackground:/);
});

// Execute the actual shared callback, not a test-only copy of its safety rules.
const clearBody = source.match(/const clearItemTrigger = useCallback\(\(id: string\) => \{([\s\S]*?)\n  \}, \[setPromptTrigger, setAutoRun, tabId\]\);/)?.[1];
assert.ok(clearBody, 'canonical trigger clear callback must exist');

function clearHarness({ items, autoRun = true, countdown = 100 }) {
  const queue = { items, autoRun, firstDelayCountdownAt: countdown };
  const calls = [];
  let tabDrafts = new Set(['item', 'other']);
  let timerDrafts = new Set(['item', 'other']);
  const clear = new Function('tabId', 'setPromptTrigger', 'usePromptQueueStore', 'isQueuedPromptEnabled', 'shouldDisarmAfterTriggerClear', 'setAutoRun', 'setOnTabTriggerDraftIds', 'setTimerTriggerDraftIds', `return (id) => {${clearBody}};`)(
    'owner',
    (...args) => calls.push(['clear', ...args]),
    { getState: () => ({ getQueue: () => queue, cancelFirstDelayCountdown: (tab) => calls.push(['cancel', tab]) }) },
    (item) => item.enabled !== false,
    shouldDisarmAfterTriggerClear,
    (...args) => calls.push(['arm', ...args]),
    (update) => { tabDrafts = update(tabDrafts); },
    (update) => { timerDrafts = update(timerDrafts); },
  );
  return { clear, calls, drafts: () => [Array.from(tabDrafts), Array.from(timerDrafts)] };
}

test('middle trigger removal preserves the single-runnable-item disarm rule and clears drafts', () => {
  const h = clearHarness({ items: [{ id: 'item' }, { id: 'disabled', enabled: false }] });
  consumePromptQueueMiddleClick(rowEvent(), () => h.clear('item'));
  assert.deepEqual(h.calls, [['clear', 'owner', 'item', null], ['cancel', 'owner'], ['arm', 'owner', false]]);
  assert.deepEqual(h.drafts(), [['other'], ['other']]);
});

test('removing a trigger with multiple runnable items or paused queue keeps Play untouched', () => {
  for (const options of [{ items: [{}, {}] }, { items: [{}], autoRun: false }]) {
    const h = clearHarness(options);
    h.clear('item');
    assert.deepEqual(h.calls, [['clear', 'owner', 'item', null]]);
  }
});
