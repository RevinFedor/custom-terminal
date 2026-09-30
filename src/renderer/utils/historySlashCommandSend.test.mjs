import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const panel = read('renderer/components/Workspace/HistoryPanel.tsx');
const receipt = read('main/agent-history-send-receipt.js');
const runtime = read('renderer/utils/historyAgentRuntimes.ts');
const claudeRuntime = read('renderer/utils/claudePtyActions.ts');
const main = read('main/main.js');
const dismissal = read('renderer/utils/historyPromptPresentationDismissal.mjs');

/**
 * Slash-команда видна в History как пользовательская команда, но физически
 * отправляется специализированной TUI-транзакцией.
 *
 * Раньше общий submit-path её глотал: Enter не делал ничего, а рядом висела
 * подсказка «← Terminal only» — команду предлагалось вводить в живой терминал.
 * Пользователь принял продуктовое решение, которое старый шрам
 * (`fix-compact-logic.md`) оставлял открытым: «пускай можно будет отправлять
 * команды слэш».
 *
 * В rollout `user_message` её нет, поэтому обычный prompt audit здесь запрещён.
 */

test('отправку slash больше ничто не глотает', () => {
  // Ни отдельной ветки-выхода в действии...
  assert.doesNotMatch(panel, /reason=terminal-only-slash/);
  // ...ни запрета в условии доступности отправки.
  assert.doesNotMatch(panel, /&& !terminalOnlySlashDraft/);
  assert.match(panel, /const systemCommand = isTerminalOnlyComposerDraft\(rawDraftSnapshot\)/,
    'the classifier may select chips but must not reject the send');
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
  assert.match(receipt, /normalizeAgentLocalCommand\(rawPrompt\) !== null/);
  assert.match(receipt, /hasStructuredPayload/);
  assert.match(receipt, /isLocalSlashCommandPrompt\(rawPrompt\) && !hasStructuredPayload/);
  assert.match(dismissal, /requiresAuditIdentity === false && !hasAnyDurableIdentity/);
  assert.match(dismissal, /mode: 'local-only'/,
    'receiptless local command must remain dismissible without a receipt lookup');
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
  assert.match(fn, /isLocalSlashCommandPrompt\(rawPrompt\) && !hasStructuredPayload/);
});

test('History routes standalone Claude/Codex slash through local TUI ingestion instead of user_message audit', () => {
  assert.match(runtime, /isStandaloneCodexLocalSlashCommand\(\{/);
  assert.match(runtime, /ipcRenderer\.invoke\('codex:send-live-slash-command'/);
  assert.match(claudeRuntime, /isStandaloneAgentLocalCommand\(\{/);
  assert.match(claudeRuntime, /ipcRenderer\.invoke\('claude:send-command'/);
  assert.match(main, /localCommandProof = 'codex-tui-input-frame-and-enter'/);
  assert.match(panel, /projectAgentLocalCommandSendResult\(\{/);
  assert.match(panel, /requiresAuditIdentity: !localSlashReceipt\.handled/);
  const localPayload = runtime.slice(runtime.indexOf("? ipcRenderer.invoke('codex:send-live-slash-command'"),
    runtime.indexOf(": ipcRenderer.invoke('codex:send-command'"));
  assert.match(localPayload, /sendOperationKey: options\.sendOperationKey/);
  assert.match(localPayload, /sendAttemptId: options\.sendAttemptId/);
});

test('provider-busy slash is admitted only for an owned History queue source', () => {
  assert.match(main, /queuedHistoryCommand = queue === true[\s\S]{0,120}isOwnedDesktopHistorySendSource/);
  assert.match(main, /codexSlashCommandAllowsTurnBusy\(\{/);
});
