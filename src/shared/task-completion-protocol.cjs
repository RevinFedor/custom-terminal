'use strict';

const TASK_COMPLETION_PROTOCOL_OPEN = '<terminal_task_completion_protocol>';
const TASK_COMPLETION_PROTOCOL_CLOSE = '</terminal_task_completion_protocol>';
const LOOP_TASK_COMPLETION_PROTOCOL = [
  TASK_COMPLETION_PROTOCOL_OPEN,
  'Это автоматическая проверка завершения.',
  'Если задача полностью готова и нет незавершённых дочерних Terminal MCP-run, вызови Terminal MCP complete_task ровно один раз ближе к концу этого ответа, затем верни финальный итог.',
  'Если работа продолжается, есть ошибка или ожидание, complete_task не вызывай.',
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
