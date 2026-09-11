// «Новая вкладка» — правила МЕСТА в окне, у которого ещё нет вкладки.
//
// Здесь только арифметика и адресация: как назвать новое место, как найти его
// снова после ожидания и что означает каждый ответ страницы выбора. Как это
// выглядит — дело шапки окна; как создаётся вкладка — дело стора. Разделение
// то же, что у `splitPanesModel.mjs`: правила держатся тестами без DOM.
//
// ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА — АДРЕС ОПЕРАЦИИ.
//
// Между «человек нажал Claude» и «вкладка создана» проходит настоящее время:
// создаётся запись, поднимается PTY, пишется SQLite. За это время он может
// кликнуть в соседнее окно, уйти в другой workflow или переключить проект в
// боковом меню. Если бы результат приземлялся по «текущему сфокусированному
// окну», он приезжал бы туда, куда человек ушёл, — то есть в чужое место.
//
// Поэтому адрес — это ID ЗАГОТОВКИ, а не индекс окна: индекс меняется, когда
// окна переставляют или удаляют, а id остаётся тем же местом в полосе. Найти
// его можно в любой раскладке, включая спящий workflow, — этим и занимается
// `locateChooserSlot`.

/** Что может выбрать человек на странице выбора. */
export const WINDOW_CHOOSER_ACTIONS = Object.freeze([
  'terminal',
  'claude',
  'claude-fork',
  'sdk',
  'sdk-fork',
  'codex',
  'codex-fork',
]);

/**
 * Имя нового места.
 *
 * Просто уникальная строка, и намеренно НЕ похожая на id вкладки
 * (`<projectId>-tab-<n>`): если такой id по ошибке дойдёт до вкладочного
 * читателя, он не должен найти совпадение — он должен не найти ничего.
 */
export function nextChooserSlotId(taken = []) {
  const used = new Set(Array.isArray(taken) ? taken : []);
  const stamp = Date.now().toString(36);
  for (let i = 0; i < 1000; i += 1) {
    const candidate = `newtab-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `newtab-${stamp}-${used.size}`;
}

const panesOf = (layout) => (
  Array.isArray(layout?.splitPanes) ? layout.splitPanes : []
);

const holdsSlot = (pane, slotId) => (
  Array.isArray(pane?.tabs)
  && pane.tabs.some((entry) => entry && !entry.tabId && entry.slotId === slotId)
);

/**
 * Где сейчас лежит это место — в живой раскладке или в снимке спящего
 * workflow.
 *
 * Живая раскладка проверяется первой и всегда выигрывает, по той же причине,
 * что и у `findTabPlacement`: снимок текущего workflow отстаёт на одно
 * переключение, и решать по нему значит промахиваться мимо того, что человек
 * видит прямо сейчас.
 *
 * @returns {{scope:'active'|'dormant', spaceId:string|null, paneIndex:number}|null}
 */
export function locateChooserSlot({ slotId, active, dormantSpaces = [] }) {
  if (!slotId) return null;
  const activePanes = panesOf(active);
  const activeIndex = activePanes.findIndex((pane) => holdsSlot(pane, slotId));
  if (activeIndex >= 0) {
    return { scope: 'active', spaceId: active?.spaceId || null, paneIndex: activeIndex };
  }
  for (const space of Array.isArray(dormantSpaces) ? dormantSpaces : []) {
    if (!space || space.id === active?.spaceId) continue;
    const panes = panesOf(space);
    const at = panes.findIndex((pane) => holdsSlot(pane, slotId));
    if (at >= 0) return { scope: 'dormant', spaceId: space.id || null, paneIndex: at };
  }
  return null;
}

/**
 * КОНТЕКСТ конкретной заготовки: чей это проект и от какой вкладки брать папку.
 *
 * Раньше проект брался как «первый чип окна, у которого он есть», и это молча
 * промахивалось в самом обычном кросс-проектном случае: в полосе `[B, A]`,
 * где показана A, заготовка рядом с A запускалась в проекте B — просто потому,
 * что чип B стоит левее. Проект окна («что оно показывает») и проект МЕСТА —
 * разные вопросы, и второй никто не задавал.
 *
 * Порядок ответа, от самого точного к самому общему:
 *   1. проект, записанный НА самой заготовке при её открытии;
 *   2. проект вкладки, которую окно показывает (или показывало последней —
 *      её чип остаётся в полосе рядом);
 *   3. ближайший по полосе чип — сосед слева, затем справа;
 *   4. явный fallback вызывающего (боковое меню), как у пустого окна.
 *
 * `null` в `projectId` — законный ответ «проекта у этого места больше нет»
 * (например, его закрыли). Вызывающий обязан сказать об этом человеку, а не
 * молча ничего не сделать.
 */
export function resolveChooserSlotContext(pane, slotId, options = {}) {
  const slots = Array.isArray(pane?.tabs) ? pane.tabs : [];
  const at = slots.findIndex((entry) => entry && !entry.tabId && entry.slotId === slotId);
  const own = at >= 0 ? String(slots[at].projectId || '') : '';
  const ownCwd = at >= 0 ? String(slots[at].cwd || '').trim() : '';
  const shown = String(pane?.projectId || '');

  const neighbours = [];
  if (at >= 0) {
    for (let i = at - 1; i >= 0; i -= 1) neighbours.push(slots[i]);
    for (let i = at + 1; i < slots.length; i += 1) neighbours.push(slots[i]);
  }
  const neighbourEntry = neighbours.find((entry) => entry && entry.tabId && entry.projectId);

  const exists = typeof options.projectExists === 'function'
    ? options.projectExists
    : () => true;
  const candidates = [own, shown, neighbourEntry?.projectId || '', options.fallbackProjectId || ''];
  const projectId = candidates.find((id) => id && exists(id)) || null;

  // Папка — от вкладки, ближайшей к ЭТОМУ месту в том же проекте. Иначе новая
  // вкладка наследовала бы каталог случайного соседа из другого проекта.
  const sameProject = (entry) => entry && entry.tabId && entry.projectId === projectId;
  const cwdTabId = (pane?.tabId && shown === projectId ? pane.tabId : '')
    || (neighbours.find(sameProject)?.tabId || '')
    || '';

  return {
    projectId,
    cwdTabId,
    ownProjectId: own || null,
    // A stale path from a closed project cannot leak into a fallback project.
    cwd: own && own === projectId ? ownCwd : '',
  };
}

/**
 * Как создавать вкладку для выбранного ответа.
 *
 * Один разбор на все входы: кнопки страницы выбора и три команды меню окна.
 * Возвращается ОПИСАНИЕ, а не действие, — стор выполняет его существующими
 * путями создания, и второго лаунчера не появляется. Поэтому здесь нет ни
 * `createTab`, ни IPC: только «какая это вкладка».
 *
 * Явный «Терминал» записывает роль `generic` без всяких условий: до этой
 * функции доходит только названный ответ. Жест, который оставляет выбор
 * открытым, — двойной клик — создаёт МЕСТО и запуска не начинает.
 */
export function resolveChooserLaunchPlan(action) {
  switch (action) {
    case 'terminal':
      return {
        kind: 'terminal',
        // Имя описывает этап, а не тип поверхности: строка уже есть, агент ещё
        // не выбран. Это тот же контракт, что у прежнего двойного клика.
        useEmptyName: true,
        // ВСЕГДА `generic`. Раньше здесь стоял opt-in флаг, и он был лишним и
        // опасным одновременно: сюда попадает только УЖЕ НАЗВАННЫЙ ответ
        // «Терминал», и если вызывающий забывал флаг, вкладка оставалась
        // «пустой» — то есть по-прежнему принимала запуск агента, хотя человек
        // выбрал не его. Двойной клик, который действительно оставляет выбор
        // открытым, сюда не приходит вовсе: он открывает страницу выбора.
        commandType: 'generic',
      };
    case 'sdk':
      return { kind: 'sdk' };
    case 'claude':
      return { kind: 'agent', color: 'claude', pendingAction: { type: 'claude-new' } };
    case 'codex':
      return { kind: 'agent', color: 'codex', pendingAction: { type: 'codex-new' } };
    case 'sdk-fork':
      return { kind: 'sdk-fork' };
    case 'claude-fork':
      return { kind: 'agent-fork', color: 'claude', pendingType: 'claude-fork', suffix: 'fork' };
    case 'codex-fork':
      return { kind: 'agent-fork', color: 'codex', pendingType: 'codex-fork', suffix: 'codex' };
    default:
      return null;
  }
}

/** Требует ли этот ответ UUID сессии в буфере обмена. */
export const chooserActionNeedsClipboardSession = (action) => (
  action === 'claude-fork' || action === 'codex-fork' || action === 'sdk-fork'
);
