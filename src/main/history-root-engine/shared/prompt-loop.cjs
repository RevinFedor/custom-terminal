'use strict';

const RUN_AFTER_LOOP_PROMPT_ID = 'run-after-loop';
const LEGACY_DEFAULT_LOOP_PROMPT = 'Проверь, полностью ли выполнена исходная задача. Если осталась работа, продолжай её сейчас и не ограничивайся планом или обещанием.';
const DEFAULT_LOOP_PROMPT = [
  LEGACY_DEFAULT_LOOP_PROMPT,
  'Если без внешнего действия продолжить нельзя, останови Loop через complete_task со status:"blocked" и конкретной reason. В финальном ответе объясни блокировку, что осталось невыполненным и что нужно от пользователя. Не повторяй бесконечно проверку одного и того же препятствия.',
].join('\n\n');

function parsePersistedSharedLoopPrompt(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
  } catch { /* Legacy direct text. */ }
  return raw;
}

function migrateLoopPromptContent(rawShared, rawQueues) {
  let queues = rawQueues;
  if (typeof queues === 'string') {
    try { queues = JSON.parse(queues); } catch { queues = {}; }
  }
  const legacy = Object.values(queues && typeof queues === 'object' ? queues : {})
    .filter((queue) => typeof queue?.loopPromptText === 'string' && queue.loopPromptText.trim())
    .sort((a, b) => (b.loopPromptArmedAt ?? -1) - (a.loopPromptArmedAt ?? -1))[0]?.loopPromptText;
  const content = parsePersistedSharedLoopPrompt(rawShared) ?? legacy ?? DEFAULT_LOOP_PROMPT;
  // Whitespace-only changes to the old default are not a custom instruction.
  return content.trim() === LEGACY_DEFAULT_LOOP_PROMPT ? DEFAULT_LOOP_PROMPT : content;
}

module.exports = { RUN_AFTER_LOOP_PROMPT_ID, LEGACY_DEFAULT_LOOP_PROMPT, DEFAULT_LOOP_PROMPT, parsePersistedSharedLoopPrompt, migrateLoopPromptContent };
