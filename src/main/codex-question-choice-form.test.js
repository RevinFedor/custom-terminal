'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { inspectCodexNativeQuestions, createCodexNativeQuestionMirror } = require('./codex-native-question-mirror');

const title = 'В эпизоде 14:15 ты копировал выделенный текст через Cmd+C/пункт «Копировать» или нажимал кнопку копирования целого сообщения?';
const options = ['Выделенный текст — Cmd+C/меню', 'Кнопка копирования сообщения'];
const normalize = text => text.replace(/\s+/g, ' ').trim();
async function nativeChoiceFrame(t, { ctrl = '^]', marker = '>', selected = 0, seq = 10,
  committed = true, mainPrompt = false, free = false, dimTitle = false } = {}) {
  const term = new Terminal({ cols: 86, rows: 24, allowProposedApi: true });
  t.after(() => term.dispose());
  const rows = [
    'Working (24m 15s • esc to interrupt)', '', '• Queued follow-up inputs', '',
    '  \x1b[1;38;2;99;168;248m' + title + '\x1b[0m', '',
    ...(free ? ['  \x1b[2mType your answer\x1b[0m'] : [...options, 'Other'].map((label, index) =>
      (selected === index ? '\x1b[1;30;47m' : '') + '  ' + (selected === index ? marker : ' ')
      + ' ' + (index + 1) + '. ' + label + '\x1b[0m')),
    '', '  enter submit   ' + ctrl + ' skip   ⇧→ main prompt',
    ...(mainPrompt ? ['', '› actual main composer'] : []),
  ];
  if (dimTitle) rows[4] = '  \x1b[2m' + title + '\x1b[0m';
  await new Promise(resolve => term.write(rows.join('\r\n'), resolve));
  const b = term.buffer.active;
  const lines = Array.from({ length: 24 }, (_, i) => {
    const line = b.getLine(b.baseY + i);
    const cells = [];
    for (let x = 0; x < line.length; x++) { const cell = line.getCell(x);
      if (cell.getWidth() && cell.getChars().trim()) cells.push(cell); }
    const first = cells[0];
    return { row: b.baseY + i, text: line.translateToString(true), wrapped: line.isWrapped,
      hasNonDefaultBg: cells.some(c => c.getBgColorMode() !== 0),
      hasNonDefaultFg: cells.some(c => c.getFgColorMode() !== 0),
      hasDim: cells.some(c => !!c.isDim()), allTextDim: !!cells.length && cells.every(c => !!c.isDim()),
      firstTextStyle: first ? `fg=${first.getFgColorMode()}:${first.getFgColor()},bg=${first.getBgColorMode()}:${first.getBgColor()}`
        + (first.isBold() ? ',bold' : '') + (first.isDim() ? ',dim' : '') : 'none' };
  });
  const editor = lines.findIndex(row => row.text.includes('Type your answer'));
  return { success: true, source: 'headless-main', authoritativeFrameCommitted: committed,
    baseY: b.baseY, cursorY: free ? editor : b.cursorY, lines, writeSeq: seq, flushedSeq: seq };
}

for (const ctrl of ['^]', '⌃]', 'ctrl+]']) test('actual headless: wrapped FG-only title and selected native choice / ' + ctrl, async t => {
  const frame = await nativeChoiceFrame(t, { ctrl });
  const r = inspectCodexNativeQuestions(frame);
  assert.equal(r.kind, 'expanded');
  assert.equal(normalize(r.title), title);
  assert.equal(r.optionIndex, 0); assert.equal(r.optionCount, 3);
  assert.deepEqual(r.choices.map(c => c.label), [...options, 'Other']);
});

test('uncommitted/cropped/quoted or non-accent panels remain non-actionable', async t => {
  assert.equal(inspectCodexNativeQuestions(await nativeChoiceFrame(t, { committed: false })).kind, 'unknown');
  assert.equal(inspectCodexNativeQuestions(await nativeChoiceFrame(t, { mainPrompt: true })).kind, 'none');
  assert.equal(inspectCodexNativeQuestions(await nativeChoiceFrame(t, { dimTitle: true })).kind, 'unknown');
  const f = await nativeChoiceFrame(t); f.lines = f.lines.filter(row => !row.text.includes('skip'));
  assert.notEqual(inspectCodexNativeQuestions(f).kind, 'expanded');
});

test('native choice answer moves selection and presses Enter, without writing Other or pasted text', async t => {
  let frame = await nativeChoiceFrame(t);
  const first = frame, second = await nativeChoiceFrame(t, { selected: 1, seq: 11 });
  const none = await nativeChoiceFrame(t, { mainPrompt: true, seq: 12 });
  const callbacks = new Set(), writes = [];
  const emit = next => { frame = next; for (const cb of callbacks) cb(); };
  const mirror = createCodexNativeQuestionMirror({ readFrame: () => frame,
    readOwner: () => ({ key: 'exact-T', sessionId: 'SID', lifecycleGeneration: 'L' }),
    subscribeFrames: (_id, cb) => { callbacks.add(cb); return () => callbacks.delete(cb); },
    withWriter: (_id, work) => work({ abortReason: () => null, write(bytes) {
      writes.push(bytes);
      if (bytes === '\x1b[B') emit(second);
      else if (bytes === '\r') emit(none);
      else { emit(first); throw new Error('unexpected native input'); }
    } }), publish() {}, log() {} });
  mirror.observeRecord('T', { type: 'event_msg', payload: { type: 'agent_message', delivery: 'async',
    id: 'native-call', questions: [{ title, options }] } });
  const q = mirror.get('T'); assert.ok(q?.expanded);
  const result = await mirror.control('T', { action: 'answer', requestId: 'choice-R', targetId: q.targetId,
    answer: options[1], optionIndex: 1, baseDraft: '' });
  assert.equal(result.success, true); assert.deepEqual(writes, ['\x1b[B', '\r']);
  assert.equal(callbacks.size, 0);
});

test('chosen item must match its exact known question definition before any write', async t => {
  const frame = await nativeChoiceFrame(t), writes = [];
  const mirror = createCodexNativeQuestionMirror({ readFrame: () => frame,
    readOwner: () => ({ key: 'exact-T', sessionId: 'SID', lifecycleGeneration: 'L' }),
    subscribeFrames: () => () => {}, withWriter: (_id, work) => work({ abortReason: () => null, write: x => writes.push(x) }),
    publish() {}, log() {} });
  mirror.observeRecord('T', { type: 'event_msg', payload: { type: 'agent_message', delivery: 'async',
    id: 'native-call', questions: [{ title, options }] } });
  const q = mirror.get('T'); assert.ok(q?.expanded);
  const r = await mirror.control('T', { action: 'answer', requestId: 'wrong-choice', targetId: q.targetId,
    answer: 'not this option', optionIndex: 1, baseDraft: '' });
  assert.equal(r.success, false); assert.equal(r.error, 'question_option_changed'); assert.deepEqual(writes, []);
});

test('real headless free editor keeps its wrapped accent title and empty draft', async t => {
  const r = inspectCodexNativeQuestions(await nativeChoiceFrame(t, { free: true, ctrl: '⌃]' }));
  assert.equal(r.kind, 'expanded'); assert.equal(normalize(r.title), title);
  assert.equal(r.draft, ''); assert.deepEqual(r.choices, []);
});
