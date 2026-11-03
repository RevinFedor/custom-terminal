// «Следующая отправка уходит в Run after, а не агенту».
//
// Правый клик по кнопке переноса (`data-prompt-queue-grab-trigger`) взводит
// ожидание для ОДНОЙ следующей отправки этой вкладки. Пока оно взведено, кнопка
// пульсирует; первая же отправка — Enter или автоотправка чипа диктовки —
// вместо агента кладёт текст в очередь, ровно как обычный клик по этой кнопке.
// После успеха ожидание снимается само, повторный правый клик снимает его
// вручную.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ФЛАГ В КОМПОНЕНТЕ. Взводит кнопка в
// `ClaudeControlBar`, исполняет композер в `HistoryPanel`, а снимает перенос,
// живущий в `PromptQueueOverlay`. Три разных поддерева, и состояние обязано
// пережить перемонтирование любого из них: диктовка по Option+1 может
// закончиться, когда пользователь уже переключил вкладку.
//
// ПОЧЕМУ НЕ В ZUSTAND. Это не часть черновика и не настройка: ожидание живёт
// один ход и не должно переживать перезапуск приложения. Подписка здесь
// адресная — на свою вкладку, чтобы взведение в одной не перерисовывало
// кнопки всех остальных.

/** @type {Map<string, true>} */
const armed = new Map();
/** @type {Set<(tabId: string, armed: boolean) => void>} */
const listeners = new Set();

function publish(tabId, value) {
  for (const listener of listeners) {
    try {
      listener(tabId, value);
    } catch (error) {
      console.warn('[RunAfterCaptureArm] listener failed: ' + String(error?.message || error));
    }
  }
}

/** Взведено ли ожидание для этой вкладки. */
export function isRunAfterCaptureArmed(tabId) {
  return armed.has(String(tabId || ''));
}

/**
 * Переключить ожидание. Возвращает новое состояние — вызывающая сторона
 * использует его для лога, а не вычисляет повторно.
 */
export function toggleRunAfterCaptureArm(tabId) {
  const key = String(tabId || '').trim();
  if (!key) return false;
  if (armed.has(key)) {
    armed.delete(key);
    publish(key, false);
    return false;
  }
  armed.set(key, true);
  publish(key, true);
  return true;
}

/**
 * Снять ожидание, если оно было. Отдельно от toggle: снятие после успешного
 * переноса обязано быть идемпотентным — иначе повторный вызов снова взвёл бы
 * ожидание, и следующая обычная отправка молча ушла бы в очередь.
 *
 * @returns {boolean} было ли ожидание снято
 */
export function clearRunAfterCaptureArm(tabId) {
  const key = String(tabId || '').trim();
  if (!key || !armed.has(key)) return false;
  armed.delete(key);
  publish(key, false);
  return true;
}

/**
 * Забрать ожидание под исполнение: проверяет и сразу снимает его.
 *
 * Одним действием намеренно. Между «проверил» и «снял» успевает пройти вторая
 * отправка (Enter во время автоотправки диктовки), и тогда в очередь ушли бы
 * оба текста вместо одного. Ожидание рассчитано ровно на одну отправку.
 */
export function consumeRunAfterCaptureArm(tabId) {
  return clearRunAfterCaptureArm(tabId);
}

/** Адресная подписка: будит только владельца этой вкладки. */
export function subscribeRunAfterCaptureArm(tabId, listener) {
  const key = String(tabId || '').trim();
  if (!key) return () => {};
  const wrapped = (changedTabId, value) => {
    if (changedTabId === key) listener(value);
  };
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}

/** Вкладка закрыта — её ожидание больше некому исполнить. */
export function forgetRunAfterCaptureArm(tabId) {
  clearRunAfterCaptureArm(tabId);
}

// Только для тестов: сброс состояния модуля между случаями.
export function resetRunAfterCaptureArmForTest() {
  armed.clear();
  listeners.clear();
}
