'use strict';

// Persist this logical input at capture. Old operations keep their old bytes;
// a later wording change must never mutate an accepted/UNKNOWN handoff.
const RESTART_PROMPT = 'Продолжай работу над задачей, прерванной обновлением приложения. '
  + 'Если были незавершённые дочерние субагенты, вызванные внутренними инструментами модели, '
  + 'возобнови их по сохранённым идентификаторам; если эти агенты больше недоступны, запусти их заново '
  + 'по сохранённым заданиям и продолжи основную работу. Не ожидай ответ от утраченного внутреннего агента '
  + 'и не дублируй уже работающего или завершённого. Terminal MCP и внешний Research (включая Astra) '
  + 'сохраняют свои операции: используй исходные квитанции и результаты, не запускай их повторно '
  + 'из-за перезапуска приложения или неизвестного исхода отправки.';
const continuationPrompt = target => target?.continuationPrompt || 'continue';
function restartPromptForView(view) {
  const work = view?.ownBackground;
  const children = work?.known === true ? (work.items || []).filter(item => item.kind === 'agent') : [];
  const ids = children.slice(0, 24).map(item => item.sessionId || item.id)
    .filter(id => typeof id === 'string' && /^[\w:.-]{1,240}$/.test(id));
  return RESTART_PROMPT + (ids.length ? '\nВ снимке перед обновлением были активны внутренние агенты: '
    + ids.join(', ') + '. Это прежние идентификаторы для восстановления, не подтверждение их текущего исполнения.' : '');
}
module.exports = { RESTART_PROMPT, continuationPrompt, restartPromptForView };
