/**
 * Мост между блоками, по которым ведут курсор.
 *
 * Всплывающее окно, которое живёт «пока курсор здесь», всегда состоит из
 * нескольких кусков: кнопка, панель, открывшийся из неё список. Между кусками
 * есть визуальный зазор — те самые несколько пикселей, ради которых блоки не
 * слипаются. Для глаза это одно целое, для страницы — пустота, где курсор не
 * находится ни на чём, и окно закрывается ровно посреди движения к нему.
 *
 * Лечится не задержкой, а геометрией: зазор объявляется частью того же целого.
 * Задержка («подожди 150 мс, вдруг вернётся») отвечает на вопрос «сколько
 * ждать», хотя вопрос был «где курсор» — поэтому она либо мала для медленного
 * движения, либо держит окно открытым уже после ухода.
 *
 * Форма — звезда, а не цепочка: есть главный блок (панель) и то, что
 * открывается ОТ него. Курсор ходит между панелью и каждым из них, но не между
 * ними напрямую, поэтому и мосты строятся только к панели.
 */

/** Курсор внутри прямоугольника (с небольшим допуском по краю). */
export function pointInRect(rect, x, y, pad = 2) {
  if (!rect) return false;
  return (
    x >= rect.left - pad
    && x <= rect.right + pad
    && y >= rect.top - pad
    && y <= rect.bottom + pad
  );
}

/**
 * Курсор в зазоре между двумя прямоугольниками.
 *
 * Сторона не задаётся снаружи: если блоки разошлись по горизонтали, зазор
 * вертикальный полосой, если по вертикали — горизонтальный. Сообщать стороны
 * вызывающему коду означало бы держать в двух местах одно и то же знание о
 * раскладке, которая к тому же меняется при нехватке места у края экрана.
 *
 * Блоки, которые перекрываются по обеим осям, соприкасаются — мостить нечего,
 * иначе «зазором» стал бы весь охватывающий их прямоугольник.
 */
export function pointInGap(a, b, x, y, pad = 2) {
  if (!a || !b) return false;

  const xGapFrom = Math.min(a.right, b.right);
  const xGapTo = Math.max(a.left, b.left);
  const separatedX = xGapTo > xGapFrom;

  const yGapFrom = Math.min(a.bottom, b.bottom);
  const yGapTo = Math.max(a.top, b.top);
  const separatedY = yGapTo > yGapFrom;

  if (!separatedX && !separatedY) return false;

  const left = separatedX ? xGapFrom : Math.min(a.left, b.left);
  const right = separatedX ? xGapTo : Math.max(a.right, b.right);
  const top = separatedY ? yGapFrom : Math.min(a.top, b.top);
  const bottom = separatedY ? yGapTo : Math.max(a.bottom, b.bottom);

  return x >= left - pad && x <= right + pad && y >= top - pad && y <= bottom + pad;
}

/**
 * Курсор всё ещё «здесь»: на панели, на любом из открытых от неё блоков или в
 * зазоре между панелью и таким блоком.
 *
 * `satellites` может содержать null — блока может не быть на экране, и это
 * нормальный случай, а не ошибка вызывающего кода.
 */
export function pointInHoverCluster({ hub, satellites = [], x, y, pad = 2 }) {
  if (!hub) return false;
  if (pointInRect(hub, x, y, pad)) return true;
  for (const satellite of satellites) {
    if (!satellite) continue;
    if (pointInRect(satellite, x, y, pad)) return true;
    if (pointInGap(hub, satellite, x, y, pad)) return true;
  }
  return false;
}
