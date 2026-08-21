// Рабочие пространства — чистые правила.
//
// Пространство это ВИД на раскладку окон: свои окна, свои полосы вкладок, свои
// перегородки, свой фокус. Вкладки ему НЕ принадлежат — они живут в списке
// проекта, а пространство помнит только, как они разложены. Отсюда всё
// остальное: удалить пространство дёшево (исчезает раскладка, вкладки и
// процессы целы), а одна вкладка может быть разложена сразу в нескольких
// пространствах.
//
// Почему последнее не противоречит правилу «одна вкладка — ровно одно окно»:
// правило существует потому, что живой терминал один и всю разметку окна рисует
// его вкладка. Окна разных пространств никогда не на экране одновременно —
// спорить нечему. Правило продолжает действовать ВНУТРИ пространства и не
// действует между ними.
//
// Здесь только арифметика списка пространств. Что лежит внутри одного из них —
// дело splitPanesModel.mjs; этот модуль про него ничего не знает, поэтому его
// можно держать тестами без DOM и без стора.

/** Имя первого пространства. Оно же — имя того, что было до этой фичи. */
export const DEFAULT_SPACE_NAME = 'main';

/**
 * Содержимое пространства — ровно те поля раскладки, которые до сих пор лежали
 * в сторе по одному экземпляру на всё приложение.
 *
 * Список полей ЗДЕСЬ, а не у каждого вызывающего: поле, забытое в одном из
 * переключений, теряется молча — точно так же, как когда-то терялась раскладка
 * при закрытии приложения (см. sessionSnapshot.mjs).
 */
export const SPACE_LAYOUT_FIELDS = Object.freeze([
  'splitPanes',
  'splitFocusedIndex',
  'splitSizes',
  'centerStrips',
  // Проект, на котором стоит боковой список, и вкладка, которую показывает
  // центр: пространство это рабочий контекст целиком, и возврат в него без них
  // означал бы «окна те, а смотрю не туда».
  'activeProjectId',
  'focusedProjectId',
  // Вкладка, на которой человек стоял, когда уходил отсюда.
  //
  // Лежит ОТДЕЛЬНО от списка вкладок проекта: активная вкладка проекта — одна
  // на приложение, и пространство, вернувшее свои окна, но не свою вкладку,
  // показывало бы центр от соседнего пространства. Юзер: *«должна быть
  // последняя активная вкладка, которая у меня там была до переключения»*.
  // Хранится парой (проект, вкладка) — вкладки межпроектные, и одного id
  // недостаточно, чтобы понять, чей список активировать.
  'activeSpaceTab',
]);

/** Пустая раскладка — то, что видно в только что созданном пространстве. */
export function emptySpaceLayout() {
  return {
    splitPanes: [],
    splitFocusedIndex: 0,
    splitSizes: null,
    centerStrips: {},
    activeProjectId: null,
    focusedProjectId: null,
    activeSpaceTab: null,
  };
}

/** Снять раскладку с состояния — те и только те поля, что перечислены выше. */
export function captureSpaceLayout(state) {
  const out = {};
  SPACE_LAYOUT_FIELDS.forEach((field) => {
    out[field] = state ? state[field] : undefined;
  });
  // Нормализуем отсутствующее: пространство, записанное до появления поля,
  // не должно возвращать `undefined` в стор и делать вид, что поля нет вообще.
  const blank = emptySpaceLayout();
  SPACE_LAYOUT_FIELDS.forEach((field) => {
    if (out[field] === undefined) out[field] = blank[field];
  });
  return out;
}

const nextName = (spaces, base) => {
  const taken = new Set((Array.isArray(spaces) ? spaces : []).map((s) => s && s.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
};

/**
 * Список пространств из сохранённого состояния — включая случай «сохранено до
 * появления фичи».
 *
 * Раскладка, лежавшая в сессии одна на всё приложение, СТАНОВИТСЯ первым
 * пространством. Не «создаётся пустое, а старая теряется»: человек закрыл
 * приложение с разложенными окнами и должен увидеть их же.
 */
export function restoreSpaces(saved, fallbackLayout) {
  const list = (Array.isArray(saved && saved.spaces) ? saved.spaces : [])
    .filter((s) => s && typeof s.id === 'string' && s.id)
    .map((s) => ({
      id: s.id,
      name: typeof s.name === 'string' && s.name.trim() ? s.name : DEFAULT_SPACE_NAME,
      layout: { ...emptySpaceLayout(), ...(s.layout && typeof s.layout === 'object' ? s.layout : {}) },
    }));
  if (list.length > 0) {
    const activeId = list.some((s) => s.id === (saved && saved.activeSpaceId))
      ? saved.activeSpaceId
      : list[0].id;
    return { spaces: list, activeSpaceId: activeId };
  }
  const first = {
    id: 'space-1',
    name: DEFAULT_SPACE_NAME,
    layout: { ...emptySpaceLayout(), ...(fallbackLayout || {}) },
  };
  return { spaces: [first], activeSpaceId: first.id };
}

/**
 * Создать пространство. Оно пустое: ни одного окна, ни одной вкладки.
 *
 * Ничего не создаётся само — то же, что видно у пустого окна сейчас: кнопки
 * запуска и двойной клик. Пространство, заводящее себе вкладку, плодило бы её в
 * списке проекта и тогда, когда его создали ради уже существующих.
 *
 * `id` приходит СНАРУЖИ: модель обязана оставаться чистой, а генератор
 * идентификаторов — это как раз то, что делает функцию нечистой.
 */
export function addSpace(spaces, activeSpaceId, id, name) {
  const list = Array.isArray(spaces) ? spaces : [];
  if (!id || list.some((s) => s.id === id)) return null;
  const created = {
    id,
    name: nextName(list, (name && String(name).trim()) || 'Пространство'),
    layout: emptySpaceLayout(),
  };
  return { spaces: list.concat([created]), activeSpaceId: id, createdId: id };
}

/**
 * Удалить пространство. Исчезает РАСКЛАДКА: вкладки остаются в списке проекта,
 * процессы живут — поэтому спрашивать подтверждение не о чем.
 *
 * Последнее не удаляется. Одно пространство есть всегда, значит состояния «ни
 * одного» не существует, и приложению не нужен экран, которого больше нигде
 * нет.
 */
export function removeSpace(spaces, activeSpaceId, id) {
  const list = Array.isArray(spaces) ? spaces : [];
  if (list.length <= 1) return null;
  const at = list.findIndex((s) => s.id === id);
  if (at === -1) return null;
  const next = list.slice();
  next.splice(at, 1);
  // Наследник — сосед справа, а при его отсутствии слева: то же правило, что у
  // закрытой вкладки, и по той же причине — взгляд уже стоит на этом месте.
  const activeNext = activeSpaceId === id
    ? next[Math.min(at, next.length - 1)].id
    : activeSpaceId;
  return { spaces: next, activeSpaceId: activeNext };
}

/** Переименовать. Пустое имя — не имя, поэтому такая правка отбрасывается. */
export function renameSpace(spaces, id, name) {
  const list = Array.isArray(spaces) ? spaces : [];
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const at = list.findIndex((s) => s.id === id);
  if (at === -1 || list[at].name === trimmed) return null;
  const next = list.slice();
  next[at] = { ...next[at], name: trimmed };
  return { spaces: next };
}

/**
 * Переключиться: снять раскладку с текущего состояния в СВОЁ пространство и
 * отдать раскладку целевого.
 *
 * Записывать уходящее обязательно здесь, а не «когда-нибудь потом»: раскладка
 * живёт в общем состоянии, и без снимка переключение просто затрёт её.
 */
export function switchSpace(spaces, activeSpaceId, targetId, currentLayout) {
  const list = Array.isArray(spaces) ? spaces : [];
  const target = list.find((s) => s.id === targetId);
  if (!target || targetId === activeSpaceId) return null;
  const saved = list.map((s) => (
    s.id === activeSpaceId ? { ...s, layout: { ...currentLayout } } : s
  ));
  return { spaces: saved, activeSpaceId: targetId, layout: { ...emptySpaceLayout(), ...target.layout } };
}

/**
 * Сколько вкладок разложено в пространстве — число рядом с именем.
 *
 * Считаются РАЗНЫЕ вкладки во всех его окнах: одна вкладка, показанная в одном
 * окне и лежащая чипом в другом, — это одна вкладка, а не две.
 *
 * `tabIdsOfPanes` передаётся снаружи (splitPanesModel::allPaneTabIds): этот
 * модуль про устройство окон ничего не знает, и знать не должен.
 */
export function spaceTabCount(space, tabIdsOfPanes) {
  return spaceTabIds(space, tabIdsOfPanes).size;
}

/**
 * ИДЕНТИФИКАТОРЫ вкладок пространства — то же множество, что считает
 * `spaceTabCount`, но списком.
 *
 * Существует отдельно, потому что «сколько всего» и «сколько из них сейчас
 * работает» обязаны считаться по ОДНОМУ множеству: два независимых обхода
 * разошлись бы на первом же различии (чип в двух окнах, полоса центра), и
 * человек увидел бы «работает 3 из 2».
 */
export function spaceTabIds(space, tabIdsOfPanes) {
  const layout = (space && space.layout) || {};
  const ids = new Set(tabIdsOfPanes(layout.splitPanes || []));
  Object.values(layout.centerStrips || {}).forEach((strip) => {
    (Array.isArray(strip) ? strip : []).forEach((e) => { if (e && e.tabId) ids.add(e.tabId); });
  });
  if (ids.size === 0 && layout.activeProjectId && layout.activeTabId) ids.add(layout.activeTabId);
  return ids;
}

/**
 * Сколько вкладок пространства СЕЙЧАС ЗАНЯТЫ — второе число рядом с именем.
 *
 * `isBusy(tabId)` спрашивается снаружи: что считать занятостью, знает слой
 * вкладок (агент отвечает, идёт вставка, есть фоновая работа), а не этот
 * модуль.
 */
export function spaceBusyTabCount(space, tabIdsOfPanes, isBusy) {
  if (typeof isBusy !== 'function') return 0;
  let busy = 0;
  spaceTabIds(space, tabIdsOfPanes).forEach((tabId) => { if (isBusy(tabId)) busy += 1; });
  return busy;
}

/**
 * В КАКОМ пространстве лежит вкладка — ответ для карточки в боковом списке.
 *
 * Возвращает индекс (номер, который человек видит в полосе) или -1. Ищем в
 * порядке полосы: если вкладка разложена в нескольких, называем первое —
 * номер должен быть один и тот же при каждом взгляде, а не зависеть от того,
 * куда её положили последней.
 */
export function spaceIndexHoldingTab(spaces, tabId, tabIdsOfPanes) {
  const list = Array.isArray(spaces) ? spaces : [];
  if (!tabId) return -1;
  return list.findIndex((space) => {
    const layout = (space && space.layout) || {};
    if (tabIdsOfPanes(layout.splitPanes || []).includes(tabId)) return true;
    return Object.values(layout.centerStrips || {})
      .some((strip) => (Array.isArray(strip) ? strip : []).some((e) => e && e.tabId === tabId));
  });
}

/**
 * Убрать вкладки из окон ВСЕХ пространств, кроме текущего.
 *
 * Текущее чистят обычные пути (`splitPanes` и полосы центра лежат на верхнем
 * уровне стора и правятся там). Но окна остальных пространств те же пути не
 * видят вовсе — и чип, указывающий на закрытую вкладку, дожил бы до момента,
 * когда в это пространство вернутся. Симптом был бы не «лишний чип», а пустое
 * окно или окно без разметки: чип, который ничего не рисует.
 *
 * Работает по СПИСКУ вкладок, а не по одной: закрытие проекта убирает их
 * пачкой, и вызывать это по разу на вкладку значило бы переписать все снимки
 * столько раз, сколько вкладок было.
 *
 * `dropFromPanes` приходит снаружи (splitPanesModel::dropTabFromAllPaneStrips):
 * устройство окон — не дело этого модуля.
 */
export function dropTabsFromOtherSpaces(spaces, activeSpaceId, tabIds, dropFromPanes) {
  const list = Array.isArray(spaces) ? spaces : [];
  const doomed = new Set((Array.isArray(tabIds) ? tabIds : []).filter(Boolean));
  if (doomed.size === 0) return null;
  let changed = false;
  const next = list.map((space) => {
    if (!space || space.id === activeSpaceId) return space;
    const layout = space.layout || {};
    let panes = layout.splitPanes || [];
    let touched = false;
    doomed.forEach((tabId) => {
      const res = dropFromPanes(panes, tabId);
      if (res) { panes = res.panes; touched = true; }
    });
    const strips = {};
    let stripsTouched = false;
    Object.entries(layout.centerStrips || {}).forEach(([pid, raw]) => {
      const before = Array.isArray(raw) ? raw : [];
      const kept = before.filter((e) => e && e.tabId && !doomed.has(e.tabId));
      if (kept.length !== before.length) stripsTouched = true;
      // Один чип — это не полоса: проект возвращается к поведению «как было до».
      if (kept.length > 1) strips[pid] = kept;
      else if (kept.length !== before.length || before.length > 1) stripsTouched = true;
    });
    if (!touched && !stripsTouched) return space;
    changed = true;
    return { ...space, layout: { ...layout, splitPanes: panes, centerStrips: strips } };
  });
  return changed ? { spaces: next } : null;
}
