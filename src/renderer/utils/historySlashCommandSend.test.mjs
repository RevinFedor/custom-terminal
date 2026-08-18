import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const panel = read('renderer/components/Workspace/HistoryPanel.tsx');
const receipt = read('main/agent-history-send-receipt.js');

/**
 * Slash-команда отправляется из History как обычное сообщение.
 *
 * Раньше общий submit-path её глотал: Enter не делал ничего, а рядом висела
 * подсказка «← Terminal only» — команду предлагалось вводить в живой терминал.
 * Пользователь принял продуктовое решение, которое старый шрам
 * (`fix-compact-logic.md`) оставлял открытым: «пускай можно будет отправлять
 * команды слэш».
 *
 * Результата у локальных команд может не быть — это принято сознательно.
 * Отображается само сообщение, потому что оно и есть user message.
 */

test('отправку slash больше ничто не глотает', () => {
  // Ни отдельной ветки-выхода в действии...
  assert.doesNotMatch(panel, /reason=terminal-only-slash/);
  // ...ни запрета в условии доступности отправки.
  assert.doesNotMatch(panel, /&& !terminalOnlySlashDraft/);
  assert.doesNotMatch(panel, /isTerminalOnlyComposerDraft/);
});

test('подсказка «Terminal only» удалена вместе со всей своей обвязкой', () => {
  // Подсказка обещала запрет, которого больше нет. Удалять надо и её саму, и
  // всё, что на неё ссылалось, иначе `aria-describedby` укажет в пустоту.
  assert.doesNotMatch(panel, /Terminal only<\/span>/);
  assert.doesNotMatch(panel, /data-history-terminal-only-hint/);
  assert.doesNotMatch(panel, /history-terminal-only-hint-/);
});

test('локальная slash-команда не порождает расписку, ждущую audit', () => {
  // У неё нет записи `user_message`, поэтому обычная расписка висела бы вечно и
  // сообщение осталось бы UNCONFIRMED.
  assert.match(receipt, /function isLocalSlashCommandPrompt\(rawPrompt\)/);
  assert.match(receipt, /rawPrompt\.trimStart\(\)\.startsWith\('\/'\)/);
  assert.match(receipt, /&& !isLocalSlashCommandPrompt\(rawPrompt\)/);
});

test('правило покрывает ВСЕ источники History, а не только автоматику', () => {
  // Прежнее сужение до очереди/цикла было верным, пока из композера slash
  // отправить было нельзя. Теперь можно — и ручной `/compact` обязан попадать
  // под то же правило.
  assert.doesNotMatch(receipt, /DESKTOP_AUTOMATION_SEND_SOURCES\.has\(source\) && rawPrompt/);
  const fn = receipt.slice(
    receipt.indexOf('function isDesktopHistorySendReceiptEligible'),
    receipt.indexOf('function buildDesktopHistorySendIdentity'),
  );
  assert.ok(fn.length > 0);
  assert.match(fn, /isOwnedDesktopHistorySendSource\(source\)/);
  assert.match(fn, /!isLocalSlashCommandPrompt\(rawPrompt\)/);
});
