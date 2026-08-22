import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  setWorkspaceOverlayHost,
  releaseWorkspaceOverlayHost,
  getWorkspaceOverlayHost,
  subscribeWorkspaceOverlayHost,
  workspaceOverlayPortalTarget,
} from './workspaceOverlayHost.mjs';

const repoRoot = path.join(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const app = read('renderer/App.tsx');
const bar = read('renderer/components/Workspace/ClaudeControlBar.tsx');

/**
 * Всплывающие меню рабочей области не должны оставаться поверх Home.
 *
 * Инцидент 2026-08-18: при переходе на Home меню выбора модели, effort и отката
 * продолжали висеть поверх страницы проектов. Причина не в слоях и не в
 * z-index: рабочая область при переходе на Home НЕ размонтируется, её прячут
 * невидимостью, а меню рисуются порталом в корень страницы — то есть вне
 * спрятанного поддерева, и прятание их просто не касается.
 *
 * Лечение выбрано МЕСТОМ, а не условием: узел-слой лежит внутри рабочей
 * области. Условие «а не Home ли сейчас» пришлось бы повторять в каждом новом
 * меню, и однажды его забудут; место работает само.
 *
 * Замерено в Chromium: меню в корне страницы остаётся видимым и перехватывает
 * точку экрана поверх Home; меню в слое внутри рабочей области получает
 * visibility:hidden, а сверху оказывается Home. При видимой рабочей области
 * меню по-прежнему сверху — обычный случай не сломан.
 */

test('слой публикуется и снимается только своим узлом', () => {
  const first = { nodeName: 'DIV', id: 'first' };
  const second = { nodeName: 'DIV', id: 'second' };

  setWorkspaceOverlayHost(first);
  assert.equal(getWorkspaceOverlayHost(), first);

  // Ловушка порядка: при перестроении разметки новый узел монтируется РАНЬШЕ,
  // чем размонтируется старый. Снятие «по факту размонтирования» стёрло бы
  // только что опубликованный слой, и меню молча вернулись бы в корень страницы.
  setWorkspaceOverlayHost(second);
  releaseWorkspaceOverlayHost(first);
  assert.equal(getWorkspaceOverlayHost(), second, 'чужой узел не имеет права снять слой');

  releaseWorkspaceOverlayHost(second);
  assert.equal(getWorkspaceOverlayHost(), null);
});

test('подписчикам сообщают о появлении и снятии слоя', () => {
  const seen = [];
  const stop = subscribeWorkspaceOverlayHost((node) => seen.push(node));
  const node = { nodeName: 'DIV' };
  setWorkspaceOverlayHost(node);
  releaseWorkspaceOverlayHost(node);
  stop();
  setWorkspaceOverlayHost({ nodeName: 'DIV' });
  assert.deepEqual(seen, [node, null], 'после отписки события приходить не должны');
  releaseWorkspaceOverlayHost(getWorkspaceOverlayHost());
});

test('пока слоя нет, меню рисуется в корень страницы, а не пропадает', () => {
  // Запасной путь, а не равноправный: меню не должно исчезнуть только потому,
  // что владелец слоя ещё не смонтирован.
  releaseWorkspaceOverlayHost(getWorkspaceOverlayHost());
  const fakeDoc = { body: { nodeName: 'BODY' } };
  assert.equal(workspaceOverlayPortalTarget(fakeDoc), fakeDoc.body);

  const node = { nodeName: 'DIV' };
  setWorkspaceOverlayHost(node);
  assert.equal(workspaceOverlayPortalTarget(fakeDoc), node);
  releaseWorkspaceOverlayHost(node);
});

test('слой смонтирован ВНУТРИ прячущегося поддерева рабочей области', () => {
  // Вся защита держится на этом: узел снаружи поддерева не спрячется вместе с
  // ним, сколько бы условий ни добавили внутрь самих меню.
  const wrapperStart = app.indexOf("visibility: view === 'workspace' ? 'visible' : 'hidden',");
  assert.ok(wrapperStart > 0, 'обёртка рабочей области должна прятаться невидимостью');
  const wrapperEnd = app.indexOf('<Workspace', wrapperStart);
  assert.ok(wrapperEnd > wrapperStart, 'слой обязан стоять до самой рабочей области');
  const inside = app.slice(wrapperStart, wrapperEnd);
  assert.match(inside, /data-workspace-overlay-host/);
  assert.match(inside, /ref=\{workspaceOverlayHostRef\}/);
});

test('меню панели управления больше не уезжают в корень страницы', () => {
  assert.doesNotMatch(
    bar,
    /createPortal\([\s\S]{0,400}?\n\s*document\.body,/,
    'портал в корень страницы возвращает баг «меню поверх Home»',
  );
  assert.match(bar, /import \{[\s\S]{0,160}workspaceOverlayPortalTarget,?[\s\S]{0,80}\} from '\.\.\/\.\.\/utils\/workspaceOverlayHost\.mjs'/);
  // Подписка, а не разовое чтение: слой публикуется при монтировании рабочей
  // области и может появиться позже первого рендера панели.
  assert.match(bar, /return subscribeWorkspaceOverlayHost\(setWorkspaceOverlayHostNode\)/);
  const targets = bar.match(/overlayPortalTarget,/g) || [];
  assert.equal(targets.length, 3, 'все три меню панели рисуются в общий слой');
});
