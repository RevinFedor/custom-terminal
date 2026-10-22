'use strict';

const TASK_COMPLETION_PROTOCOL_OPEN = '<terminal_task_completion_protocol>';
const TASK_COMPLETION_PROTOCOL_CLOSE = '</terminal_task_completion_protocol>';
const LOOP_TASK_COMPLETION_COMMON = [
  TASK_COMPLETION_PROTOCOL_OPEN,
  'Это автоматическое сообщение Loop в тот же чат. Проверь весь исходный план, поздние указания и свои обещания; незавершённые дочерние задачи не освобождают от независимой работы.',
  'Если задача полностью готова и нет незавершённых дочерних Terminal MCP-run, вызови Terminal MCP complete_task ровно один раз ближе к концу этого ответа, затем верни финальный итог.',
  'Если продолжение невозможно без внешнего действия (например, разблокировать экран, дать доступ, ответить на вопрос или восстановить недоступный сервис), не повторяй одну и ту же проверку: вызови complete_task({status:"blocked", reason:"конкретная причина и необходимое действие"}) один раз и в финальном ответе объясни, что осталось невыполненным и что нужно для продолжения. Это останавливает Loop, но не объявляет задачу выполненной.',
];
const LOOP_TASK_COMPLETION_PROTOCOL = [
  ...LOOP_TASK_COMPLETION_COMMON,
  'Если можешь самостоятельно продолжить работу, выполняй её сейчас. Обычный Loop ждёт завершения связанных задач перед следующей проверкой. Отсутствие правок файлов само по себе не является блокировкой.',
  TASK_COMPLETION_PROTOCOL_CLOSE,
].join('\n');
const LOOP_AWAIT_TASK_COMPLETION_PROTOCOL = [
  ...LOOP_TASK_COMPLETION_COMMON,
  'Включён Loop после собственного ответа: внешние задачи могут ещё выполняться. Если можешь самостоятельно продолжить работу, выполняй её сейчас. Если независимой работы нет и нужен результат уже запущенного Terminal MCP-run/SC Research, вызови await_dependencies({dependencies:[{kind:"run",id:"точный runId"}],reason:"что требуется для продолжения"}) один раз ближе к концу ответа. Для ответа на отправленный вопрос используй kind:"message" и точный question messageId. Можно указать несколько зависимостей. Это сохраняет Loop ON и незавершённую задачу до нужного события. После вызова закончи текущий ответ; не опрашивай ожидание и не создавай замену неизвестному Send.',
  'В await_dependencies также передай reviewToken — точное значение loop_review_token из ЭТОГО сообщения. Токен прошлого сообщения не подходит. Штатное ожидание зависимости не является completed/blocked. Отсутствие правок файлов само по себе не является блокировкой.',
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
  LOOP_AWAIT_TASK_COMPLETION_PROTOCOL,
  hasTaskCompletionProtocol,
};
