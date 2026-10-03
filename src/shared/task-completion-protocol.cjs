'use strict';

const TASK_COMPLETION_PROTOCOL_OPEN = '<terminal_task_completion_protocol>';
const TASK_COMPLETION_PROTOCOL_CLOSE = '</terminal_task_completion_protocol>';
const LOOP_TASK_COMPLETION_PROTOCOL = [
  TASK_COMPLETION_PROTOCOL_OPEN,
  'Это автоматическая проверка завершения.',
  'Если задача полностью готова и нет незавершённых дочерних Terminal MCP-run, вызови Terminal MCP complete_task ровно один раз ближе к концу этого ответа, затем верни финальный итог.',
  'Если продолжение невозможно без внешнего действия (например, разблокировать экран, дать доступ, ответить на вопрос или восстановить недоступный сервис), не повторяй одну и ту же проверку: вызови complete_task({status:"blocked", reason:"конкретная причина и необходимое действие"}) один раз и в финальном ответе объясни, что осталось невыполненным и что нужно для продолжения. Это останавливает Loop, но не объявляет задачу выполненной.',
  'Если можешь самостоятельно продолжить работу или ждёшь уже запущенную операцию/дочерний Terminal MCP-run, complete_task не вызывай. Отсутствие правок файлов само по себе не является блокировкой.',
  TASK_COMPLETION_PROTOCOL_CLOSE,
].join('\n');

function hasTaskCompletionProtocol(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  return text.includes(TASK_COMPLETION_PROTOCOL_OPEN)
    && text.includes(TASK_COMPLETION_PROTOCOL_CLOSE);
}

module.exports = {
  TASK_COMPLETION_PROTOCOL_OPEN,
  TASK_COMPLETION_PROTOCOL_CLOSE,
  LOOP_TASK_COMPLETION_PROTOCOL,
  hasTaskCompletionProtocol,
};
