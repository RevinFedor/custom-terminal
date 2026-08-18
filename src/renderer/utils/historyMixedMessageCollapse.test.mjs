import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  measureMixedMessageText,
  mixedMessageNeedsCollapse,
  truncateMixedMessageParts,
} from './historyMixedMessageCollapse.mjs';

const repoRoot = path.join(import.meta.dirname, '../..');
const panel = fs.readFileSync(
  path.join(repoRoot, 'renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

const text = (value) => ({ kind: 'text', text: value });
const chip = (label) => ({ kind: 'prompt', chip: { id: label, label, text: 'body' } });
const paste = (value) => ({ kind: 'paste', text: value });

/**
 * Сообщение со вставками сворачивается КАК СООБЩЕНИЕ, а не по кускам.
 *
 * Прежняя версия давала каждому текстовому фрагменту свою кнопку прямо в потоке
 * (`display: inline-block`): она стояла посреди строки между словами, и в
 * сообщении с тремя вставками кнопок было три.
 */

test('длина считается по тексту, а не по числу частей', () => {
  // Сообщение из пяти чипов и трёх слов — короткое, сворачивать нечего.
  const parts = [chip('A'), chip('B'), text('три слова тут'), chip('C')];
  assert.equal(measureMixedMessageText(parts), 'три слова тут'.length);
  assert.equal(mixedMessageNeedsCollapse(parts, 600), false);
  assert.equal(mixedMessageNeedsCollapse([text('x'.repeat(601))], 600), true);
});

test('обрезка режет только текст, чип остаётся целым', () => {
  // «Половина чипа» смысла не имеет: это атомарный объект.
  const parts = [text('x'.repeat(10)), chip('Ревью'), text('y'.repeat(10))];
  const { parts: out, truncated } = truncateMixedMessageParts(parts, 12);
  assert.equal(truncated, true);
  assert.deepEqual(out.map((p) => p.kind), ['text', 'prompt', 'text']);
  assert.equal(out[1], parts[1], 'чип передан той же ссылкой, не пересобран');
  assert.equal(measureMixedMessageText(out), 12);
});

test('вложения не исчезают из свёрнутого вида, пока бюджет не исчерпан', () => {
  // Иначе в свёрнутом сообщении пропадало бы самое заметное — сами вложения.
  const parts = [chip('A'), paste('p'.repeat(50)), text('короткий хвост')];
  const { parts: out, truncated } = truncateMixedMessageParts(parts, 400);
  assert.equal(truncated, false);
  assert.deepEqual(out.map((p) => p.kind), ['prompt', 'paste', 'text']);
  // Порядок сохранён: части идут так же, как в сообщении.
  assert.deepEqual(out, parts);
});

test('усечение отмечается ровно тогда, когда что-то отброшено', () => {
  const short = [text('abc'), chip('A')];
  assert.equal(truncateMixedMessageParts(short, 400).truncated, false);
  assert.equal(truncateMixedMessageParts([text('x'.repeat(500))], 400).truncated, true);
  // Бюджет исчерпан ровно на границе — чип за ним уже не проходит, и это усечение.
  const edge = truncateMixedMessageParts([text('x'.repeat(400)), chip('A')], 400);
  assert.equal(edge.truncated, true);
  assert.deepEqual(edge.parts.map((p) => p.kind), ['text']);
});

test('нулевой лимит не роняет и не пропускает атомарные части', () => {
  const { parts: out, truncated } = truncateMixedMessageParts([chip('A'), text('x')], 0);
  assert.deepEqual(out, []);
  assert.equal(truncated, true);
  assert.equal(measureMixedMessageText(null), 0);
  assert.deepEqual(truncateMixedMessageParts(null, 10).parts, []);
});

test('в потоке текста кнопки раскрытия больше нет', () => {
  // Главное требование: «внутри текста такого никогда быть не должно».
  // Срез от объявления компонента до СЛЕДУЮЩЕГО за ним (`HistoryChipPopover`
  // объявлен выше, поэтому как правая граница он давал пустой срез — и тест
  // честно упал на проверке непустоты).
  const inline = panel.slice(
    panel.indexOf('const HistoryInlineTextPart'),
    panel.indexOf('const HistoryImageTokenThumbnail'),
  );
  assert.ok(inline.length > 0);
  assert.doesNotMatch(inline, /cb-collapse-btn/);
  assert.doesNotMatch(inline, /display: 'inline-block'/);
  assert.match(inline, /const HistoryInlineTextPart = \(\{ text \}: \{ text: string \}\) => <>\{text\}<\/>/);
});

test('кнопка сообщения со вставками сидит на рамке, как у обычного сообщения', () => {
  // Те же классы, что у длинного текстового сообщения: одно место для одного
  // жеста, иначе две реализации разъедутся по виду и положению.
  const flow = panel.slice(
    panel.indexOf('const needsCollapse = mixedMessageNeedsCollapse'),
    panel.indexOf('const HistoryUserEntry = memo'),
  );
  assert.ok(flow.length > 0);
  assert.match(flow, /className="cb-collapse-top"/);
  assert.match(flow, /className="cb-collapse-bottom"/);
  // Верхняя — только у раскрытого, как и в текстовом пути.
  assert.match(flow, /\{open && collapseToggle && <div className="cb-collapse-top">/);
  // Многоточие одно на сообщение.
  assert.match(flow, /\{visible\.truncated && '…'\}/);
});

test('раскрытие сообщения и раскрытие одной части — разные состояния', () => {
  // «Показать тело вставки» не должно разворачивать сообщение целиком.
  assert.match(panel, /const \[mixedExpanded, setMixedExpanded\] = useState\(false\)/);
  assert.match(panel, /const \[expandedPart, setExpandedPart\] = useState<string \| null>\(null\)/);
  // Компенсация прокрутки та же, что у обычного длинного сообщения.
  assert.match(panel, /useHistoryRevealToggle\(mixedAnchorRef, mixedExpanded, setMixedExpanded\)/);
});
