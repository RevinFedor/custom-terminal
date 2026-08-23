// ГДЕ показать вкладку, когда её активируют — ОДИН ответ на всё приложение.
//
// Четыре поверхности задают этот вопрос: боковой список, `Ctrl+Tab`/`Cmd+P`,
// меню оркестрации («открыть связанную вкладку») и чипы в шапке окна. Каждая
// отвечала на него сама, и ответы разошлись: список ДОБАВЛЯЛ вкладку в конец
// текущего окна, переключатель — тоже, меню оркестрации звало активацию
// напрямую, а чип полагался на правило внутри неё. Итог, который видит человек:
// вкладка, уже разложенная в другом окне (и даже в другом рабочем
// пространстве), появлялась второй раз там, где он стоял, — то есть переезжала
// из раскладки, которую он сам собрал.
//
// Правило здесь одно и читается словами:
//
//   • ОБЫЧНЫЙ переход = «покажи мне её ТАМ, ГДЕ ОНА ЛЕЖИТ». Если у вкладки уже
//     есть место — своё окно, пусть даже в другом пространстве, — идём туда:
//     сначала в пространство, потом в окно. В текущее окно её не переносим
//     никогда: живой терминал существует в одном экземпляре, и «перенести» —
//     это разобрать чужую раскладку молча.
//
//   • ЕСЛИ МЕСТА НЕТ — тогда и только тогда её показывает текущее окно
//     (в одиночном режиме — центр). Это единственный случай, когда обычный
//     переход что-то меняет в раскладке.
//
//   • SHIFT (и средний клик по строке переключателя, который его зеркалит) =
//     «ДОБАВЬ СЮДА», явный жест. Вкладка снимается со старого места — в том
//     числе из окна другого пространства — и становится ПОСЛЕДНИМ чипом
//     текущего окна. Показанная вкладка остаётся чипом рядом, а входящая
//     становится показанной. Это Shift и средний клик в переключателе.
//
// Модуль ЧИСТЫЙ: он получает описание мира и возвращает намерение. Ни стора, ни
// DOM — поэтому одни и те же случаи проверяются тестами, а не кликами.

/** Обычная активация: показать вкладку там, где она уже лежит. */
export const PLACEMENT_DEFAULT = 'default';
/** Явное добавление: снять со старого места и дописать в текущее окно. */
export const PLACEMENT_ADD_HERE = 'add-here';

/** «Окна нет» — цель одиночного центра, а не панель с номером. */
export const CENTER_PANE_INDEX = -1;

const stripOf = (pane) => {
  if (!pane) return [];
  if (Array.isArray(pane.tabs) && pane.tabs.length > 0) return pane.tabs;
  return pane.tabId ? [{ projectId: pane.projectId, tabId: pane.tabId }] : [];
};

const paneHolding = (panes, tabId) => {
  const list = Array.isArray(panes) ? panes : [];
  return list.findIndex((pane) => stripOf(pane).some((entry) => entry && entry.tabId === tabId));
};

const stripsHolding = (centerStrips, tabId) => Object.entries(centerStrips || {}).some(
  ([, raw]) => (Array.isArray(raw) ? raw : []).some((entry) => entry && entry.tabId === tabId),
);

const worldHoldsTab = (world, tabId) => {
  const panes = Array.isArray(world?.splitPanes) ? world.splitPanes : [];
  if (panes.some((pane) => stripOf(pane).some((entry) => entry?.tabId === tabId))) return true;
  if (panes.length > 0) return false;
  return stripsHolding(world?.centerStrips, tabId) || world?.activeSpaceTab?.tabId === tabId;
};

/**
 * Где вкладка лежит СЕЙЧАС — в живой раскладке или в снимке другого
 * пространства.
 *
 * Живая раскладка проверяется первой и всегда выигрывает: снимок текущего
 * пространства отстаёт на одно переключение, и решать видимость по нему значит
 * уводить человека из пространства, в котором он стоит.
 *
 * @returns {{ scope: 'active'|'dormant', spaceId: string|null, paneIndex: number, shown: boolean }|null}
 */
export function findTabPlacement({ tabId, active, dormantSpaces = [] }) {
  if (!tabId) return null;
  const panes = Array.isArray(active?.splitPanes) ? active.splitPanes : [];
  const at = paneHolding(panes, tabId);
  if (at >= 0) {
    return {
      scope: 'active',
      spaceId: active?.spaceId || null,
      paneIndex: at,
      shown: panes[at]?.tabId === tabId,
    };
  }
  if (panes.length === 0 && (
    stripsHolding(active?.centerStrips, tabId)
      || active?.activeSpaceTab?.tabId === tabId
  )) {
    return {
      scope: 'active',
      spaceId: active?.spaceId || null,
      paneIndex: CENTER_PANE_INDEX,
      shown: active?.centerShownTabId === tabId,
    };
  }
  for (const space of Array.isArray(dormantSpaces) ? dormantSpaces : []) {
    if (!space || space.id === active?.spaceId) continue;
    const dormantPanes = Array.isArray(space.splitPanes) ? space.splitPanes : [];
    const dormantAt = paneHolding(dormantPanes, tabId);
    if (dormantAt >= 0) {
      return {
        scope: 'dormant',
        spaceId: space.id || null,
        paneIndex: dormantAt,
        shown: dormantPanes[dormantAt]?.tabId === tabId,
      };
    }
    if (dormantPanes.length === 0 && (
      stripsHolding(space.centerStrips, tabId)
        || space.activeSpaceTab?.tabId === tabId
    )) {
      return { scope: 'dormant', spaceId: space.id || null, paneIndex: CENTER_PANE_INDEX, shown: false };
    }
  }
  return null;
}

/** Куда смотрит человек прямо сейчас: номер окна или центр. */
export function focusedTarget(active) {
  const panes = Array.isArray(active?.splitPanes) ? active.splitPanes : [];
  if (panes.length === 0) return CENTER_PANE_INDEX;
  const at = Number.isInteger(active?.splitFocusedIndex) ? active.splitFocusedIndex : 0;
  return Math.max(0, Math.min(panes.length - 1, at));
}

/**
 * Что произойдёт при активации этой вкладки.
 *
 * @returns {{ kind: 'noop' }
 *          | { kind: 'reveal', spaceId: string|null, paneIndex: number, crossSpace: boolean }
 *          | { kind: 'move', paneIndex: number, detach: boolean }
 *          | { kind: 'append', paneIndex: number, detach: boolean }}
 *
 * `reveal` — «она уже где-то лежит, идём туда» (может потребовать перехода в
 * другое пространство: `crossSpace`).
 * `move`   — «показать её вместо текущей вкладки».
 * `append` — «добавить последним чипом текущего окна»; `detach` говорит, надо ли сперва
 * снять её со старого места (у обычного перехода такого случая нет: он до
 * `move` доходит только когда места не было).
 * `noop`   — она уже показана там, куда бы её отправил жест.
 */
export function resolveTabPlacement({
  tabId,
  mode = PLACEMENT_DEFAULT,
  active,
  dormantSpaces = [],
}) {
  if (!tabId) return { kind: 'noop' };
  const placement = findTabPlacement({ tabId, active, dormantSpaces });
  const target = focusedTarget(active);

  if (mode === PLACEMENT_ADD_HERE) {
    const activePanes = Array.isArray(active?.splitPanes) ? active.splitPanes : [];
    const duplicateInOtherActivePane = activePanes.some((pane, index) => (
      index !== target && stripOf(pane).some((entry) => entry?.tabId === tabId)
    ));
    const duplicateInDormantSpace = (Array.isArray(dormantSpaces) ? dormantSpaces : [])
      .some((space) => space?.id !== active?.spaceId && worldHoldsTab(space, tabId));
    const duplicateElsewhere = duplicateInOtherActivePane || duplicateInDormantSpace;
    // Уже показана ЗДЕСЬ — переносить нечего. Лежит здесь же чипом, но показана
    // соседняя, — это не «noop»: жест обязан её показать.
    // Legacy-дубликат в другом workflow/pane обязан быть снят даже когда
    // целевой экземпляр уже показан здесь.
    if (placement && placement.scope === 'active' && placement.paneIndex === target
      && placement.shown && !duplicateElsewhere) {
      return { kind: 'noop' };
    }
    return { kind: 'append', paneIndex: target, detach: !!placement || duplicateElsewhere };
  }

  if (placement) {
    const crossSpace = placement.scope === 'dormant';
    if (!crossSpace && placement.shown && placement.paneIndex === target) return { kind: 'noop' };
    return { kind: 'reveal', spaceId: placement.spaceId, paneIndex: placement.paneIndex, crossSpace };
  }
  return { kind: 'move', paneIndex: target, detach: false };
}

/**
 * Снимок мира из стора — ОДИН на всех, кто спрашивает резолвер.
 *
 * Живая раскладка и снимки пространств разведены намеренно: снимок ТЕКУЩЕГО
 * пространства отстаёт на одно переключение, и решать по нему значило бы уводить
 * человека из пространства, в котором он стоит.
 *
 * Работает и на живом сторе, и на подписке компонента — читает только простые
 * поля, никаких Map целиком (Fingerprint Pattern соблюдают вызывающие).
 */
export function placementWorldFromState(state) {
  return {
    active: {
      spaceId: state.activeSpaceId || null,
      splitPanes: state.splitPanes || [],
      splitFocusedIndex: state.splitFocusedIndex || 0,
      centerStrips: state.centerStrips || {},
      activeSpaceTab: state.activeSpaceTab || null,
      centerShownTabId: state.activeProjectId
        ? state.openProjects.get(state.activeProjectId)?.activeTabId || null
        : null,
    },
    dormantSpaces: (state.spaces || []).map((space) => ({
      id: space.id,
      splitPanes: space.layout?.splitPanes || [],
      centerStrips: space.layout?.centerStrips || {},
      activeSpaceTab: space.layout?.activeSpaceTab || null,
    })),
  };
}

/**
 * Подпись жеста для плашки на карточке — тем же резолвером, что и само
 * действие, чтобы обещание и результат не разошлись.
 *
 * `null` означает «жест ничего не изменит», и плашку рисовать не надо.
 */
export function describeTabPlacement(plan) {
  if (!plan || plan.kind === 'noop') return null;
  if (plan.kind === 'reveal') {
    return plan.crossSpace ? 'перейти в её пространство' : 'показать в её окне';
  }
  if (plan.kind === 'append') return 'добавить в это окно';
  return plan.detach ? 'перенести в это окно' : 'показать в этом окне';
}
