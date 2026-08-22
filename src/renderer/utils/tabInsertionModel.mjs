/**
 * Все вкладки, которые в боковом списке нарисованы ВНУТРИ карточки этой —
 * дети, дети детей и так далее.
 *
 * @param {Record<string,string|undefined>} parentOf  вкладка → её визуальный родитель
 */
export function visualSubtreeIds(parentOf = {}, rootId) {
  const out = new Set();
  if (!rootId) return out;
  out.add(rootId);
  const children = new Map();
  Object.entries(parentOf || {}).forEach(([id, parentId]) => {
    if (!parentId || parentId === id) return;
    const list = children.get(parentId) || [];
    list.push(id);
    children.set(parentId, list);
  });
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop();
    for (const childId of children.get(id) || []) {
      if (out.has(childId)) continue;
      out.add(childId);
      pending.push(childId);
    }
  }
  return out;
}

/**
 * Куда встаёт новая вкладка, созданная жестом «дай мне ещё одну ЗДЕСЬ»
 * (`Cmd+T`, двойной клик по пустому месту полосы окна).
 *
 * Она — СОСЕД текущей вкладки, а не её ребёнок, и встаёт ПОСЛЕ неё вместе со
 * всем, что нарисовано внутри её карточки. Простое «после текущей»
 * (`resolveTabInsertionIndex`) вклинивало новую строку между родителем и его
 * детьми: в списке она выглядела оторванной от жеста, а карточка родителя
 * визуально разрывалась пополам.
 *
 * Ссылки нет или её уже закрыли — в конец, как и раньше.
 */
export function resolveSiblingInsertionIndex({
  tabIds = [],
  referenceTabId,
  parentOf = {},
} = {}) {
  if (!referenceTabId) return tabIds.length;
  const referenceIndex = tabIds.indexOf(referenceTabId);
  if (referenceIndex < 0) return tabIds.length;
  const subtree = visualSubtreeIds(parentOf, referenceTabId);
  let last = referenceIndex;
  // По ФАКТИЧЕСКОМУ порядку списка, а не по обходу дерева: потомок может лежать
  // где угодно, и «после поддерева» честно значит «после самого дальнего из
  // тех, кто в него входит».
  tabIds.forEach((id, index) => { if (subtree.has(id) && index > last) last = index; });
  return last + 1;
}

export function resolveTabInsertionIndex({
  tabIds = [],
  appendToEnd = false,
  referenceTabId,
  groupAnchorTabId,
} = {}) {
  if (appendToEnd) return tabIds.length;

  if (!referenceTabId && groupAnchorTabId) {
    const anchorIndex = tabIds.indexOf(groupAnchorTabId);
    if (anchorIndex >= 0) return anchorIndex;
  }

  if (referenceTabId) {
    const referenceIndex = tabIds.indexOf(referenceTabId);
    if (referenceIndex >= 0) return referenceIndex + 1;
  }

  return tabIds.length;
}
