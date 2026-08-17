// Куда прокрутить боковой список, чтобы показать строку.
//
// Правило: строка СТРЕМИТСЯ в середину списка. Не «прижать к краю» — из
// середины видно соседей сверху и снизу, то есть окрестность вкладки, в
// которой человек сейчас работает; прижатая к краю строка показывает соседей
// только с одной стороны.
//
// Два ограничения, без которых «в середину» превращается в дёрганье:
//
//   • У КРАЁВ СПИСКА середина недостижима, и добиваться её нельзя. Первая
//     вкладка не может оказаться по центру, не открыв пустоту над собой, —
//     значение зажимается в [0, максимум прокрутки], и список просто упирается
//     в начало или конец. Пользователь: «если нет возможности, то скролл просто
//     в самый низ, лишний скролл делать не нужно».
//
//   • СТРОКА, КОТОРУЮ И ТАК ВИДНО ЦЕЛИКОМ, не двигается вообще. Иначе клик по
//     видимой строке центрировал бы список и уводил строки из-под курсора —
//     ровно то, на что уже жаловались («клик по видимой вкладке не должен
//     двигать список под курсором»). Заодно это и есть «лишнего скролла не
//     делать»: показывать то, что уже показано, незачем.

/**
 * @param {object} args
 * @param {number} args.rowTop        верх строки ОТНОСИТЕЛЬНО содержимого списка
 * @param {number} args.rowHeight     высота строки
 * @param {number} args.viewTop       текущий scrollTop
 * @param {number} args.viewHeight    видимая высота списка (clientHeight)
 * @param {number} args.contentHeight полная высота содержимого (scrollHeight)
 * @returns {number|null} новый scrollTop, либо null — двигать не нужно
 */
export function tabListRevealScrollTop({ rowTop, rowHeight, viewTop, viewHeight, contentHeight }) {
  const view = Number(viewHeight) || 0;
  const top = Number(rowTop) || 0;
  const height = Number(rowHeight) || 0;
  const current = Math.max(0, Number(viewTop) || 0);
  const maxScroll = Math.max(0, (Number(contentHeight) || 0) - view);
  // Список короче окна — прокручивать нечего.
  if (maxScroll <= 0) return null;
  // Видно целиком — не трогаем (см. правило выше).
  if (top >= current && top + height <= current + view) return null;
  // Середина: над строкой и под ней остаётся поровну.
  const centered = top - (view - height) / 2;
  const next = Math.round(Math.min(maxScroll, Math.max(0, centered)));
  return next === Math.round(current) ? null : next;
}
