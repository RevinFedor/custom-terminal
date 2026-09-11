import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDictationMarker,
  isDictationChipId,
  dictationChipTs,
  getDictationMarkerRanges,
  resolveDictationMarker,
  reconcileDictationEntries,
  dictationTokenLabel,
  dictationBlocksSend,
} from './dictationChips.mjs';
import {
  __resetDictationChips,
  armDictationChip,
  armDictationChipsForTab,
  beginDictationChip,
  disarmDictationChipsForTab,
  getDictationChip,
  getDictationChipsSnapshot,
  listDictationChipsForTab,
  reconcileDictationChipsForTab,
  setDictationChipStatus,
} from './dictationChipRegistry.mjs';

// ─── Marker grammar ───────────────────────────────────────────────────────

test('marker id carries the Voice Record history timestamp — the retry key', () => {
  const marker = buildDictationMarker('vr-1757500000000');
  assert.equal(marker, '[Dictating vr-1757500000000]');
  assert.ok(isDictationChipId('vr-1757500000000'));
  assert.equal(dictationChipTs('vr-1757500000000'), 1757500000000);
  assert.equal(dictationChipTs('not-a-chip'), null);
});

test('markers are found at their exact positions among user prose', () => {
  const text = 'до ' + buildDictationMarker('vr-1') + ' после ' + buildDictationMarker('vr-2');
  const ranges = getDictationMarkerRanges(text);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].id, 'vr-1');
  assert.equal(text.slice(ranges[0].start, ranges[0].end), '[Dictating vr-1]');
  assert.equal(ranges[1].id, 'vr-2');
});

test('user prose with brackets never parses as a dictation marker', () => {
  assert.equal(getDictationMarkerRanges('см. [Dictating manual] и [Pasted Content 1 692 chars]').length, 0);
  assert.equal(dictationBlocksSend('обычный текст [Image #1]'), false);
});

// ─── Resolution: text replaces the marker where it sits ──────────────────

test('resolved text lands at the marker position with spacing healed', () => {
  const text = 'начало' + buildDictationMarker('vr-5') + 'конец';
  const out = resolveDictationMarker({ text, chipId: 'vr-5', replacement: 'середина' });
  assert.equal(out.text, 'начало середина конец');
  assert.equal(out.text.slice(0, out.caret).endsWith('середина '), true);
});

test('spacing is not doubled when the user already left spaces around the chip', () => {
  const text = 'начало ' + buildDictationMarker('vr-5') + ' конец';
  const out = resolveDictationMarker({ text, chipId: 'vr-5', replacement: 'середина' });
  assert.equal(out.text, 'начало середина конец');
});

test('an empty take removes the marker and returns the draft to its prior shape', () => {
  const before = 'текст был таким';
  const withChip = 'текст был ' + buildDictationMarker('vr-9') + ' таким';
  const out = resolveDictationMarker({ text: withChip, chipId: 'vr-9', replacement: '' });
  assert.equal(out.text, before);
});

test('a deleted marker makes late resolution a no-op — deletion is the cancel gesture', () => {
  const out = resolveDictationMarker({ text: 'юзер стёр чип', chipId: 'vr-5', replacement: 'поздний текст' });
  assert.equal(out, null);
});

test('two equal takes resolve independently by id, not by position', () => {
  const text = buildDictationMarker('vr-1') + ' и ' + buildDictationMarker('vr-2');
  const first = resolveDictationMarker({ text, chipId: 'vr-2', replacement: 'второй' });
  assert.ok(first.text.includes('[Dictating vr-1]'));
  assert.ok(first.text.includes('второй'));
  assert.ok(!first.text.includes('[Dictating vr-2]'));
});

// ─── Send gate ────────────────────────────────────────────────────────────

test('any dictation marker in the draft blocks send', () => {
  assert.equal(dictationBlocksSend('готовый текст'), false);
  assert.equal(dictationBlocksSend('жду ' + buildDictationMarker('vr-3')), true);
});

// ─── Labels ───────────────────────────────────────────────────────────────

test('token label shows recognised words, armed ⏎, and retryable states', () => {
  assert.equal(dictationTokenLabel({ status: 'pending', label: '' }), 'диктовка…');
  assert.equal(dictationTokenLabel({ status: 'pending', label: 'привет мир' }, { armed: true }), '⏎ привет мир');
  assert.equal(dictationTokenLabel({ status: 'error', label: 'привет' }), '⚠ привет — повторить');
  assert.equal(dictationTokenLabel({ status: 'stale', label: '' }), '⏸ диктовка — повторить');
});

// ─── Reconcile: text is the source of truth ──────────────────────────────

test('restart orphan markers are adopted as stale (retryable), deleted markers drop entries', () => {
  const text = buildDictationMarker('vr-1') + ' ' + buildDictationMarker('vr-2');
  const { entries } = reconcileDictationEntries(text, [
    { id: 'vr-1', status: 'pending', label: 'жив' },
    { id: 'vr-404', status: 'pending', label: 'его маркер стёрт' },
  ]);
  assert.deepEqual(entries.map((e) => e.id), ['vr-1', 'vr-2']);
  assert.equal(entries[0].status, 'pending', 'live entry preserved');
  assert.equal(entries[1].status, 'stale', 'orphan adopted as retryable');
});

// ─── Registry ────────────────────────────────────────────────────────────

test('registry lifecycle: begin → arm → resolve/drop; typing disarms', () => {
  __resetDictationChips();
  beginDictationChip({ id: 'vr-1', tabId: 'tab-A', label: 'первые слова', autoSend: true });
  beginDictationChip({ id: 'vr-2', tabId: 'tab-B', label: '' });
  assert.equal(getDictationChip('vr-1').autoSend, true);

  disarmDictationChipsForTab('tab-A');
  assert.equal(getDictationChip('vr-1').autoSend, false, 'typing in the draft disarms auto-send');
  assert.equal(getDictationChip('vr-2').autoSend, false, 'other tab untouched');

  armDictationChipsForTab('tab-B');
  assert.equal(getDictationChip('vr-2').autoSend, true, 'Enter arms the pending chip of its tab');

  setDictationChipStatus('vr-2', 'error', { error: 'network' });
  assert.equal(getDictationChip('vr-2').status, 'error');

  armDictationChip('vr-2', false);
  assert.equal(getDictationChip('vr-2').autoSend, false);
});

test('reconcileDictationChipsForTab adopts orphans and drops deleted ones', () => {
  __resetDictationChips();
  beginDictationChip({ id: 'vr-10', tabId: 'tab-A', label: 'останется' });
  beginDictationChip({ id: 'vr-11', tabId: 'tab-A', label: 'юзер удалил чип' });
  const text = buildDictationMarker('vr-10') + ' и осиротевший ' + buildDictationMarker('vr-77');
  reconcileDictationChipsForTab('tab-A', text);
  const ids = listDictationChipsForTab('tab-A').map((e) => e.id).sort();
  assert.deepEqual(ids, ['vr-10', 'vr-77']);
  assert.equal(getDictationChip('vr-77').status, 'stale');
  assert.equal(getDictationChip('vr-11'), null, 'deleted chip entry is gone');
});

test('snapshot rev advances on every mutation (useSyncExternalStore contract)', () => {
  __resetDictationChips();
  const r0 = getDictationChipsSnapshot().rev;
  beginDictationChip({ id: 'vr-1', tabId: 't', label: '' });
  const r1 = getDictationChipsSnapshot().rev;
  assert.ok(r1 > r0);
  setDictationChipStatus('vr-1', 'error');
  assert.ok(getDictationChipsSnapshot().rev > r1);
});
