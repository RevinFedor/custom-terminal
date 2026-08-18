'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

/**
 * Ответ о состоянии Claude — общий источник сразу для трёх поверхностей:
 * кнопки терминала в истории, плашки запуска/ошибки и значка действия сессии.
 *
 * Инцидент 2026-08-18: в нём обращались к несуществующей переменной `status`
 * вместо `runtimePresence.status`. Обработчик падал ЦЕЛИКОМ на каждом вызове —
 * 281 раз за одну сессию. Для пользователя это выглядело не как ошибка, а как
 * мёртвый интерфейс: наведение на кнопку терминала не показывало ни «запустить»,
 * ни «остановить», клик не делал ничего. Claude при этом был жив.
 *
 * Опечатка стоила так дорого именно потому, что ответ собирается одним куском:
 * упавшее поле уносит с собой все остальные. Поэтому проверяется не «нет
 * опечатки», а происхождение полей — они обязаны браться из того же снимка
 * состояния, который обработчик и возвращает.
 */

const presenceBlock = () => {
  const start = main.indexOf("ipcMain.handle('claude:get-presence'");
  assert.ok(start > 0, 'обработчик состояния Claude должен существовать');
  const end = main.indexOf('\n  return presence;\n});', start);
  assert.ok(end > start);
  return main.slice(start, end);
};

test('возможность возобновления считается от того же состояния, что и ответ', () => {
  const block = presenceBlock();
  assert.match(block, /status: runtimePresence\.status,/);
  assert.match(block, /canResume: runtimePresence\.status === 'inactive' && conversationMaterialized,/);
});

test('в обработчике нет обращения к несуществующему `status`', () => {
  const block = presenceBlock();
  // Голый идентификатор в позиции значения — ровно та форма, что уронила
  // обработчик. `runtimePresence.status` и `status:` (имя поля) законны.
  const lines = block.split('\n').filter((line) => !line.trim().startsWith('//'));
  for (const line of lines) {
    const bare = /(?<![.\w])status\s*===/.exec(line);
    assert.equal(bare, null, 'голое `status` в обработчике не определено: ' + line.trim());
  }
});

test('возможность скопировать id не зависит от состояния процесса', () => {
  // Разговор существует на диске независимо от того, запущен ли процесс, —
  // иначе id нельзя было бы скопировать у остановленной вкладки.
  const block = presenceBlock();
  assert.match(block, /canCopySessionId: conversationMaterialized,/);
});
