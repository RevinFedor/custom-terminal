// Насколько заполнено контекстное окно — ОДНО правило цвета и формата на все
// поверхности.
//
// Число живёт в панели управления, а такое же — в углу карточки вкладки. Если бы
// у каждой был свой порог, они рано или поздно показали бы один и тот же
// контекст разными цветами: в панели ещё зелёный, на карточке уже жёлтый. Это
// хуже, чем отсутствие цвета, — пользователь перестаёт верить обоим.

/** Порог, с которого контекст считается тревожным (красный). */
export const CONTEXT_USAGE_DANGER_PCT = 80;
/** Порог, с которого контекст считается заметно заполненным (янтарный). */
export const CONTEXT_USAGE_WARN_PCT = 50;

export const CONTEXT_USAGE_COLORS = {
  danger: '#ef4444',
  warn: '#f59e0b',
  ok: '#4ade80',
};

/** Цвет для доли заполнения. Единственный источник этого решения. */
export function contextUsageColor(pct) {
  const value = Number(pct);
  if (!Number.isFinite(value)) return CONTEXT_USAGE_COLORS.ok;
  if (value > CONTEXT_USAGE_DANGER_PCT) return CONTEXT_USAGE_COLORS.danger;
  if (value > CONTEXT_USAGE_WARN_PCT) return CONTEXT_USAGE_COLORS.warn;
  return CONTEXT_USAGE_COLORS.ok;
}

/**
 * Целое число процентов для показа, или `null`, если показывать нечего.
 *
 * `null`, а не `0`: ноль означал бы «контекст пуст», тогда как настоящий смысл —
 * «данных ещё нет» (сессия не сделала ни одного хода). Показать «0» там, где
 * измерения не было, — соврать.
 *
 * Ограничение сверху 999 защищает верстку: значение приходит извне, и трёхзначным
 * оно обязано остаться, иначе вылезет за край карточки.
 */
export function contextUsageDisplayValue(pct) {
  const value = Number(pct);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(999, Math.round(value));
}
