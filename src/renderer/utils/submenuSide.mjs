/**
 * С какой стороны раскрывать вложенное меню.
 *
 * Корневое меню открывается у курсора и уже умеет вжиматься в окно
 * (`menuViewportClamp.mjs`). Вложенное так не умеет: оно живёт правее строки,
 * которая его открыла, и у правого края окна просто уезжает за границу — то,
 * что корневое меню поместилось, о вложенном не говорит ничего.
 *
 * Сторона выбирается ОДНА на всё меню, а не отдельно для каждой строки. Меню —
 * один предмет: если соседние строки раскрываются в разные стороны, курсор
 * каждый раз идёт наугад, и «где появится список» перестаёт быть свойством
 * меню. Поэтому решение принимается один раз, по самому широкому из вложенных
 * списков: узкий, поместившийся справа, всё равно уходит налево вместе со
 * всеми.
 *
 * Стрелка на строке — часть того же ответа: она обещает направление, и обещание
 * должно совпадать с тем, что произойдёт.
 */

/** Самый широкий вложенный список меню вкладки (история команд — 280px). */
export const WIDEST_SUBMENU_WIDTH = 280;

/**
 * @param {object} args
 * @param {number} args.menuLeft        левый край корневого меню
 * @param {number} args.menuRight       правый край корневого меню
 * @param {number} args.submenuWidth    ширина самого широкого вложенного списка
 * @param {number} args.viewportWidth
 * @param {number} [args.pad]           отступ от края окна
 * @returns {'left' | 'right'}
 */
export function resolveSubmenuSide({
  menuLeft,
  menuRight,
  submenuWidth,
  viewportWidth,
  pad = 8,
}) {
  const width = Number.isFinite(submenuWidth) ? submenuWidth : 0;
  const vw = Number.isFinite(viewportWidth) ? viewportWidth : 0;
  const right = Number.isFinite(menuRight) ? menuRight : 0;
  const left = Number.isFinite(menuLeft) ? menuLeft : 0;

  const roomRight = vw - right - pad;
  const roomLeft = left - pad;

  // Справа — сторона по умолчанию: так меню читается слева направо, и при
  // достаточном месте разворачивать его иначе незачем.
  if (roomRight >= width) return 'right';
  if (roomLeft >= width) return 'left';
  // Не помещается нигде: выбираем, где обрежется меньше. Обрезанный справа
  // список теряет конец строки, обрезанный слева — начало, то есть название.
  return roomLeft > roomRight ? 'left' : 'right';
}

/** Стрелка строки, открывающей вложенный список. */
export function submenuArrow(side) {
  return side === 'left' ? '‹' : '›';
}
