// Сворачивание сообщения, в котором кроме текста есть непрозрачные части —
// чипы промптов, вставки, картинки.
//
// Раньше такое сообщение сворачивалось ПО КУСКАМ: каждый текстовый фрагмент нёс
// свою кнопку «Раскрыть полностью» прямо в потоке, `display: inline-block`. На
// экране это выглядело так, что кнопка стоит посреди строки между словами, а в
// сообщении с тремя вставками таких кнопок было три (пользователь: «почему
// кнопка „раскрыть“ и „свернуть“ отображается внутри текста? такого никогда быть
// не должно»).
//
// Правило: единица сворачивания — СООБЩЕНИЕ. Порог считается по всей его
// текстовой длине, обрезка делается один раз, а кнопка сидит на рамке пузыря,
// как у обычного длинного сообщения.

/** Сколько текста в частях (непрозрачные части считаются своей подписью). */
export function measureMixedMessageText(parts) {
  if (!Array.isArray(parts)) return 0;
  let total = 0;
  for (const part of parts) {
    if (part?.kind === 'text') total += String(part.text || '').length;
  }
  return total;
}

/**
 * Обрезать список частей до `limit` символов ТЕКСТА.
 *
 * Непрозрачные части (чип, вставка, картинка) не режутся и не считаются в лимит:
 * это атомарные объекты, «половина чипа» смысла не имеет. Но они и не
 * выбрасываются, пока лимит не исчерпан — иначе в свёрнутом виде исчезли бы
 * вложения, то есть самое заметное в сообщении.
 *
 * Возвращает `{ parts, truncated }`. `truncated` = было ли что-то отброшено;
 * по нему решается, показывать ли многоточие и кнопку.
 */
export function truncateMixedMessageParts(parts, limit) {
  const list = Array.isArray(parts) ? parts : [];
  const max = Number.isFinite(limit) ? Math.max(0, Number(limit)) : 0;
  const out = [];
  let used = 0;
  let truncated = false;

  for (let i = 0; i < list.length; i += 1) {
    const part = list[i];
    if (part?.kind !== 'text') {
      // Атомарная часть проходит целиком, пока бюджет текста не исчерпан.
      if (used >= max) {
        truncated = true;
        break;
      }
      out.push(part);
      continue;
    }
    const text = String(part.text || '');
    const room = max - used;
    if (text.length <= room) {
      out.push(part);
      used += text.length;
      continue;
    }
    const head = text.slice(0, room).trimEnd();
    if (head) out.push({ ...part, text: head });
    truncated = true;
    break;
  }

  if (out.length < list.length) truncated = true;
  return { parts: out, truncated };
}

/**
 * Нужно ли вообще сворачивать это сообщение.
 *
 * Считается по суммарной длине текста, а НЕ по количеству частей: сообщение из
 * пяти чипов и трёх слов короткое, его сворачивать нечего.
 */
export function mixedMessageNeedsCollapse(parts, threshold) {
  const total = measureMixedMessageText(parts);
  const limit = Number.isFinite(threshold) ? Number(threshold) : 0;
  return total > limit;
}
