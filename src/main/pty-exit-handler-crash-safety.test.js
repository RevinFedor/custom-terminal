'use strict';

// Смерть терминала приходит из фонового потока модуля терминала. Наш обработчик
// вызывается через мост между потоками, и исключение, вылетевшее из него
// наружу, уже некому поймать: оно становится аварийным завершением ВСЕГО
// приложения без единой строки в логе.
//
// Пять падений 18.08 (18:10, 19:28, 20:28, 20:39 и 03:32 по местному времени)
// пришлись ровно на закрытие приложения — момент, когда выход десятков
// терминалов приходит одновременно, а половина состояния уже убрана соседними
// обработчиками. Отчёты macOS обрывались в этом мосте.
//
// Этот тест защищает саму обёртку: тело обработчика обязано быть внутри
// try/catch, а отказ обязан попадать в лог.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function readExitHandler() {
  const start = mainSource.indexOf('ptyProcess.onExit((exitCode) => {');
  assert.ok(start > 0, 'обработчик выхода терминала не найден');
  let depth = 0;
  let i = mainSource.indexOf('{', start);
  const bodyStart = i;
  for (; i < mainSource.length; i += 1) {
    const ch = mainSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return mainSource.slice(bodyStart, i + 1);
    }
  }
  throw new Error('не удалось найти конец обработчика');
}

test('the terminal-exit handler cannot take the whole app down', () => {
  const handler = readExitHandler();
  const firstStatement = handler
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))[1];
  assert.equal(
    firstStatement, 'try {',
    'тело обработчика обязано начинаться с try: ошибка уборки одной вкладки не '
    + 'имеет права уронить приложение',
  );
  assert.match(
    handler, /\} catch \(err\) \{/,
    'у обработчика обязан быть перехват ошибки',
  );
});

test('a failed cleanup is visible in the log, not silent', () => {
  const handler = readExitHandler();
  const catchAt = handler.lastIndexOf('} catch (err) {');
  const tail = handler.slice(catchAt);
  assert.match(
    tail, /console\.error\(/,
    'отказ обязан писаться через console.error — только он попадает в файл лога '
    + 'всегда, даже без тега',
  );
  assert.match(tail, /PTY:EXIT_HANDLER_FAILED/, 'у записи об отказе обязан быть опознаваемый тег');
});

test('every statement of the cleanup is inside the guard', () => {
  // Защита от «обернули начало, а хвост остался снаружи»: последняя уборка
  // (очистка подсказок автоматического режима) обязана оказаться внутри try.
  const handler = readExitHandler();
  const catchAt = handler.lastIndexOf('} catch (err) {');
  const guarded = handler.slice(0, catchAt);
  for (const marker of [
    'claudeAutoModeDefaultPromptHintBuffers.delete(tabId)',
    "_webBroadcast(tabId, { type: 'busy', busy: false })",
    'recordActivity(tabId, false)',
  ]) {
    assert.ok(
      guarded.includes(marker),
      'шаг уборки остался вне защиты: ' + marker,
    );
  }
});
