'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runner = fs.readFileSync(
  path.join(__dirname, '../renderer/hooks/usePromptQueueRunner.ts'),
  'utf8',
);
const receipt = fs.readFileSync(
  path.join(__dirname, 'agent-history-send-receipt.js'),
  'utf8',
);

test('Queue and Loop use stable durable identities instead of renderer attempt counters', () => {
  const handoffBuild = runner.indexOf('const handoffId = buildPromptQueueReceiptHandoffId({');
  const begin = runner.indexOf('beginHistoryPromptHandoff({', handoffBuild);
  const send = runner.indexOf('await sendQueueCommand(', begin);
  const replay = runner.indexOf('promptQueueReceiptReplayNeedsNoBusyStart(res)', send);
  const commit = runner.indexOf('commitSentHead(ownerTabId, head.id, triggerTabId)', replay);
  assert.ok(handoffBuild > 0 && begin > handoffBuild && send > begin && replay > send && commit > replay,
    'stable identity must be attached before send and durable replay must settle before queue commit');
  assert.doesNotMatch(
    runner.slice(handoffBuild, send),
    /queueSendAttemptSequence/,
    'in-memory attempt sequence must never form durable operation identity',
  );
  assert.match(runner, /kind === 'loop' && !causeKey/,
    'Loop cannot send without an exact causal outcome identity');
  assert.match(runner, /latestLoopCauseByOwner\.set\(tabId, key\)/,
    'the exact natural outcome must be carried into Loop identity');
});

test('normal Queue and Loop prompts share the desktop durable receipt contract', () => {
  assert.match(receipt, /'prompt-queue'/);
  assert.match(receipt, /'prompt-loop'/);
  // Slash-команды по-прежнему вне обычного доказательства через `user_message`.
  // Изменилось только ПОКРЫТИЕ правила: раньше оно относилось к automation
  // (очередь/цикл), потому что из композера slash отправить было нельзя вовсе.
  // Теперь можно, и правило обязано покрывать все источники History — иначе
  // ручной `/compact` порождает расписку, которая ждёт запись, никогда не
  // появляющуюся, и сообщение остаётся UNCONFIRMED.
  assert.match(
    receipt,
    /function isLocalSlashCommandPrompt\(rawPrompt\)[\s\S]*normalized\.includes\('\\n'\)[\s\S]*\^\\\/\[\^\\s\/\]\+/,
    'slash commands remain outside generic user_message proof until their command receipt exists',
  );
  assert.match(receipt, /isLocalSlashCommandPrompt\(rawPrompt\) && !hasStructuredPayload/);
  // И правило больше не сужено до automation-источников.
  assert.doesNotMatch(receipt, /DESKTOP_AUTOMATION_SEND_SOURCES\.has\(source\) && rawPrompt/);
});
