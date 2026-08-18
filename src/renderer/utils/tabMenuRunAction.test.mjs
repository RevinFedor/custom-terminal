import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTabMenuRunState,
  resolveTabRunTarget,
  tabMenuRunLabel,
} from './tabMenuRunAction.mjs';

const tab = (over = {}) => ({ id: 't1', commandType: 'claude', ...over });

test('незапущенная сессия предлагает запуск, а не серую надпись «Стоп»', () => {
  // Раньше в этом слоте стояла кнопка «Stop», которую нельзя нажать: место
  // занимало сообщение о том, что сделать нельзя ничего, ровно тогда, когда
  // сделать нужно ровно одно.
  const state = resolveTabMenuRunState([tab()], new Set());
  assert.equal(state.kind, 'run');
  assert.equal(state.count, 1);
});

test('живой процесс вытесняет запуск', () => {
  // Остановить лишнюю вкладку — потеря секунды; запустить агента там, где уже
  // кто-то работает, — потеря контекста.
  const state = resolveTabMenuRunState([tab()], new Set(['t1']));
  assert.equal(state.kind, 'stop');
  assert.equal(state.count, 1);
});

test('смешанный набор тоже решается в пользу «Стоп»', () => {
  const state = resolveTabMenuRunState(
    [tab({ id: 'a' }), tab({ id: 'b' })],
    new Set(['a']),
  );
  assert.equal(state.kind, 'stop');
});

test('сохранённая сессия продолжается, а не начинается заново', () => {
  // Это тот же выбор, который делает кнопка состояния в переписке; здесь он
  // только назван вслух, чтобы подпись могла его показать.
  const resume = resolveTabRunTarget(tab({ claudeSessionId: 'sess-1' }));
  assert.equal(resume.mode, 'resume');
  assert.equal(resume.sessionId, 'sess-1');
  const fresh = resolveTabRunTarget(tab());
  assert.equal(fresh.mode, 'fresh');
  assert.equal(fresh.sessionId, null);
});

test('Codex опознаётся по своему полю сессии', () => {
  const target = resolveTabRunTarget(tab({ commandType: 'codex', codexSessionId: 'cx' }));
  assert.equal(target.toolType, 'codex');
  assert.equal(target.mode, 'resume');
});

test('вкладке без агента запускать нечего', () => {
  // Обычный терминал, файл и SDK-вкладка: у последней своя кнопка запуска
  // внутри неё самой, PTY у неё нет вовсе.
  assert.equal(resolveTabRunTarget(tab({ commandType: 'devServer' })), null);
  assert.equal(resolveTabRunTarget(tab({ tabType: 'file' })), null);
  assert.equal(resolveTabRunTarget(tab({ tabType: 'claude-sdk' })), null);
  assert.equal(resolveTabMenuRunState([tab({ commandType: 'bash' })], new Set()).kind, 'none');
});

test('подпись говорит, что именно произойдёт', () => {
  assert.equal(tabMenuRunLabel(resolveTabMenuRunState([tab()], new Set())), 'Запустить');
  assert.equal(
    tabMenuRunLabel(resolveTabMenuRunState([tab({ claudeSessionId: 's' })], new Set())),
    'Продолжить',
  );
  // Для набора «продолжить или начать» — уже не одно утверждение, поэтому
  // остаётся только число.
  const many = resolveTabMenuRunState([tab({ id: 'a' }), tab({ id: 'b', claudeSessionId: 's' })], new Set());
  assert.equal(tabMenuRunLabel(many), 'Запустить 2');
  assert.equal(many.mode, null);
});
