'use strict';

// Приложение падало при закрытии даже с защитой внутри обработчика выхода
// терминала. Отчёты macOS (19.08, 04:44 и 04:53 местного времени) обрывались
// в РАЗБОРЕ окружения JavaScript (`node::FreeEnvironment`), а не в нашем коде:
//
//   pty.node  Napi::ThreadSafeFunction::CallJS
//   Electron  node::FreeEnvironment
//
// Читается так: приложение уже завершается, окружение разбирается, а модуль
// терминала в этот момент ещё пытается позвать наш обработчик через мост между
// потоками. Вызвать функцию в разбираемом окружении нельзя; мост получает
// отказ, пытается превратить его в обычную ошибку JavaScript, выбросить её уже
// некуда — аварийное завершение всего процесса.
//
// Поэтому защита ВНУТРИ обработчика бессильна: он даже не начинает
// выполняться. Единственный настоящий ремонт — к моменту разбора окружения
// звать должно быть НЕКОГО.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function willQuitBody() {
  const at = mainSource.indexOf("app.on('will-quit'");
  assert.ok(at > 0, 'обработчик выхода приложения не найден');
  const next = mainSource.indexOf("app.on('window-all-closed'", at);
  assert.ok(next > at);
  return mainSource.slice(at, next);
}

test('terminal listeners are detached before the environment is torn down', () => {
  const body = willQuitBody();
  for (const call of [
    "removeAllListeners('exit')",
    "removeAllListeners('data')",
    "removeAllListeners('error')",
  ]) {
    assert.ok(body.includes(call), 'при выходе не снимается обработчик: ' + call);
  }
});

test('detaching is the LAST thing done, after state is already saved', () => {
  const body = willQuitBody();
  const markAt = body.indexOf('persistShutdownInterruptedAgentSnapshot');
  const detachAt = body.indexOf("removeAllListeners('exit')");
  assert.ok(markAt > 0 && detachAt > markAt,
    'отвязка обязана идти ПОСЛЕ сохранения состояния: иначе оборванные сессии '
    + 'не будут отмечены и пользователь потеряет кнопку «Продолжить»');
});

test('the terminal map survives a cancelled quit', () => {
  const body = willQuitBody();
  assert.ok(!/\bterminals\.clear\(\)/.test(body),
    'карту терминалов очищать нельзя: если выход отменят, живые вкладки '
    + 'окажутся потерянными');
});

test('detaching really breaks the chain to our handler (live module)', async () => {
  // Проверка на ЖИВОМ модуле, а не на предположении: после снятия обработчиков
  // выход терминала до нас не доходит.
  const pty = require('node-pty');
  const term = pty.spawn('/bin/sh', ['-c', 'sleep 0.3'], { cols: 20, rows: 5 });
  let called = 0;
  term.onExit(() => { called += 1; });
  term.removeAllListeners('exit');
  term.removeAllListeners('data');
  term.removeAllListeners('error');
  assert.equal(term.listeners('exit').length, 0);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(called, 0, 'обработчик всё ещё вызывается — цепочка не разорвана');
  try { term.kill(); } catch {}
});
