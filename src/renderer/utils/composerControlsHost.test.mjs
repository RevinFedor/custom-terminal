import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setComposerControlsHost,
  releaseComposerControlsHost,
  getComposerControlsHost,
  subscribeComposerControlsHost,
} from './composerControlsHost.mjs';

const fakeNode = (name) => ({ name });

test('подписчик узнаёт о месте отрисовки, опубликованном ПОСЛЕ подписки', () => {
  // Порядок монтирования не гарантирован: панель управления может подписаться
  // раньше, чем композер успел показать своё место. Молчание в этом случае
  // означало бы, что кнопки навсегда остались в старом месте.
  const seen = [];
  const off = subscribeComposerControlsHost('tab-a', (node) => seen.push(node));
  const node = fakeNode('composer-a');
  setComposerControlsHost('tab-a', node);
  assert.deepEqual(seen, [node]);
  off();
  setComposerControlsHost('tab-a', null);
});

test('повторная публикация того же узла не будит подписчиков', () => {
  const seen = [];
  const node = fakeNode('composer-b');
  setComposerControlsHost('tab-b', node);
  const off = subscribeComposerControlsHost('tab-b', (value) => seen.push(value));
  setComposerControlsHost('tab-b', node);
  assert.deepEqual(seen, [], 'один и тот же узел — не изменение');
  off();
  setComposerControlsHost('tab-b', null);
});

test('снятие места сообщается как null, а не молчанием', () => {
  // Это и есть причина существования реестра: когда композер уходит с экрана,
  // его узел отсоединяется от документа. Если бы об этом не сообщали, кнопки
  // продолжили бы рисоваться в невидимый узел — пользователь увидел бы, что
  // управление просто исчезло.
  const seen = [];
  const node = fakeNode('composer-c');
  setComposerControlsHost('tab-c', node);
  const off = subscribeComposerControlsHost('tab-c', (value) => seen.push(value));
  setComposerControlsHost('tab-c', null);
  assert.deepEqual(seen, [null]);
  assert.equal(getComposerControlsHost('tab-c'), null);
  off();
});

test('вкладки не видят места друг друга', () => {
  const a = fakeNode('composer-d1');
  const b = fakeNode('composer-d2');
  const seenA = [];
  const offA = subscribeComposerControlsHost('tab-d1', (value) => seenA.push(value));
  setComposerControlsHost('tab-d2', b);
  assert.deepEqual(seenA, [], 'чужая публикация не касается этой вкладки');
  setComposerControlsHost('tab-d1', a);
  assert.deepEqual(seenA, [a]);
  assert.equal(getComposerControlsHost('tab-d2'), b);
  offA();
  setComposerControlsHost('tab-d1', null);
  setComposerControlsHost('tab-d2', null);
});

test('отписка действительно отключает', () => {
  const seen = [];
  const off = subscribeComposerControlsHost('tab-e', (value) => seen.push(value));
  off();
  setComposerControlsHost('tab-e', fakeNode('composer-e'));
  assert.deepEqual(seen, []);
  setComposerControlsHost('tab-e', null);
});

test('чтение места без публикации возвращает null, а не падает', () => {
  assert.equal(getComposerControlsHost('tab-never'), null);
  assert.equal(getComposerControlsHost(''), null);
});

test('уходящий композер не стирает место, которое уже занял пришедший', () => {
  // Ровно тот баг, который был пойман живьём при переходе в разделённый режим:
  // React сначала показывает новый композер, и только потом убирает старый.
  // Уборка «по имени вкладки» стирала только что опубликованное место, и кнопки
  // навсегда оставались в старой полосе — публиковать второй раз уже некому.
  const oldNode = fakeNode('composer-old');
  const newNode = fakeNode('composer-new');
  setComposerControlsHost('tab-f', oldNode);
  setComposerControlsHost('tab-f', newNode);
  releaseComposerControlsHost('tab-f', oldNode);
  assert.equal(getComposerControlsHost('tab-f'), newNode, 'место нового композера должно уцелеть');
  releaseComposerControlsHost('tab-f', newNode);
  assert.equal(getComposerControlsHost('tab-f'), null);
});

test('уход последнего композера всё-таки освобождает место', () => {
  const node = fakeNode('composer-g');
  const seen = [];
  setComposerControlsHost('tab-g', node);
  const off = subscribeComposerControlsHost('tab-g', (value) => seen.push(value));
  releaseComposerControlsHost('tab-g', node);
  assert.deepEqual(seen, [null]);
  off();
});
