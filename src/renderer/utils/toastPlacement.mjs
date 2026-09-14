// ГДЕ появляется уведомление, и что делать, когда его вкладки не видно.
//
// Два вопроса, у каждого был один ответ — и оба неверные, как только рабочая
// область научилась показывать несколько вкладок сразу:
//
//  • МЕСТО. Коробка приклеена к правому верху ОКНА ПРИЛОЖЕНИЯ, поэтому
//    сообщение про ЛЕВОЕ окно появлялось над правым. С одной видимой вкладкой
//    это не читалось как ошибка; с несколькими — указывает на чужую работу.
//
//  • ВИДИМОСТЬ. Уведомление вкладки рисовалось, только пока она была
//    ДЕЙСТВУЮЩЕЙ активной. Клик в соседнее окно — и оно пропадало, хотя его
//    вкладка тут же на экране. Юзер: *«если я делаю фокус под рукой вкладки, то
//    они почему-то пропадают»*.
//
// Оба ответа теперь следуют из одного факта: какие вкладки ВИДНЫ, а не какая
// держит фокус.
//
// ТРЕТИЙ вопрос появился вместе с полосами чипов: вкладка может лежать в окне,
// но не показываться — её чип есть, содержимого нет. Раньше её уведомление
// уходило в угол приложения «чтобы не потерялось». Это оказалось хуже, чем
// потеря: сообщение про невидимую работу вставало поверх окна, к которому не
// относится, и человек шёл искать проблему не там. Теперь такое уведомление НЕ
// показывается как текст вовсе — про него говорит САМ ЧИП: красная рамка и
// число ошибок, а в счётчике скрытых чипов (`×N`) — красная сумма. Покажут
// вкладку — то же самое уведомление появится в правом верху ЕЁ окна, вторым
// экземпляром нигде не всплывая.

/**
 * Вкладки, занимающие поверхность на экране.
 *
 * @param {object} args
 * @param {Array<{tabId?: string}>} args.panes  окна раскладки (в одиночном режиме пусто)
 * @param {string|null} args.effectiveTabId     вкладка центра
 * @returns {string[]} id вкладок в порядке окон; одиночный режим → одна вкладка центра
 */
export function visibleToastTabIds({ panes, effectiveTabId }) {
  const list = Array.isArray(panes) ? panes : [];
  const fromPanes = list
    .filter(pane => !pane?.displayHidden)
    .map((pane) => (pane && typeof pane.tabId === 'string' ? pane.tabId : ''))
    .filter(Boolean);
  if (fromPanes.length > 0) return fromPanes;
  return effectiveTabId ? [effectiveTabId] : [];
}

/**
 * Какая поверхность показывает это уведомление?
 *
 * Возвращает id вкладки, в окне которой оно появится, или `null` — «окно
 * приложения». В угол приложения попадают ТОЛЬКО уведомления без вкладки
 * (общие события). Уведомление вкладки, которой не видно, не показывается
 * нигде — см. `hiddenToastOwnerCounts`.
 */
export function resolveToastHostTabId(toast, visibleTabIds) {
  const tabId = toast && typeof toast.tabId === 'string' ? toast.tabId : '';
  if (!tabId) return null;
  const visible = Array.isArray(visibleTabIds) ? visibleTabIds : [];
  return visible.includes(tabId) ? tabId : null;
}

/**
 * Показывать ли это уведомление ТЕКСТОМ прямо сейчас.
 *
 * Общее — да, всегда. Уведомление вкладки — только пока её видно: иначе про
 * него говорит чип, а плашка в чужом окне вводила бы в заблуждение.
 */
export function isToastVisible(toast, visibleTabIds) {
  const tabId = toast && typeof toast.tabId === 'string' ? toast.tabId : '';
  if (!tabId) return true;
  const visible = Array.isArray(visibleTabIds) ? visibleTabIds : [];
  return visible.includes(tabId);
}

/** Уведомление сообщает об ОШИБКЕ — только такие красят чип. */
export function isErrorToast(toast) {
  return !!toast && (toast.type === 'error' || toast.type === 'warning');
}

/**
 * Сколько ошибок ждёт в НЕВИДИМЫХ вкладках, по вкладкам.
 *
 * Это источник и красной рамки на чипе, и красного числа в счётчике скрытых:
 * один ответ, два места показа — иначе рамка и сумма разошлись бы.
 *
 * @returns {Map<string, number>} вкладка → сколько её ошибок сейчас не видно
 */
export function hiddenToastOwnerCounts(toasts, visibleTabIds) {
  const visible = new Set(Array.isArray(visibleTabIds) ? visibleTabIds : []);
  const counts = new Map();
  (Array.isArray(toasts) ? toasts : []).forEach((toast) => {
    const tabId = toast && typeof toast.tabId === 'string' ? toast.tabId : '';
    if (!tabId || visible.has(tabId) || !isErrorToast(toast)) return;
    counts.set(tabId, (counts.get(tabId) || 0) + 1);
  });
  return counts;
}

/**
 * Красная сумма для счётчика `×N` — сколько ошибок в чипах, ушедших за край.
 *
 * Чип за краем виден не больше, чем невидимая вкладка, поэтому спрашивают одно
 * и то же: сумма считается по тем же счётчикам.
 */
export function hiddenToastCountForChips(counts, chipTabIds) {
  const map = counts instanceof Map ? counts : new Map();
  return (Array.isArray(chipTabIds) ? chipTabIds : [])
    .reduce((sum, tabId) => sum + (map.get(tabId) || 0), 0);
}
