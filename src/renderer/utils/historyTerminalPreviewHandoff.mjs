const finiteOrNull = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * Preserve one semantic row's viewport offset while a provisional Footer is
 * replaced by its canonical data row. The DOM writer still applies the result;
 * this rule is pure so the two pre-paint phases cannot drift apart.
 */
export function historyTerminalPreviewHandoffScrollTop({
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
  targetOffsetPx = null,
  anchorOffsetPx = null,
  bottomGapPx = null,
} = {}) {
  const currentTop = Math.max(0, finiteOrNull(scrollTop) ?? 0);
  const maxTop = Math.max(
    0,
    (finiteOrNull(scrollHeight) ?? 0) - (finiteOrNull(clientHeight) ?? 0),
  );
  const targetOffset = finiteOrNull(targetOffsetPx);
  const anchorOffset = finiteOrNull(anchorOffsetPx);
  if (targetOffset !== null && anchorOffset !== null) {
    return Math.min(maxTop, Math.max(0, currentTop + targetOffset - anchorOffset));
  }
  const bottomGap = finiteOrNull(bottomGapPx);
  if (bottomGap !== null) {
    return Math.min(maxTop, Math.max(0, maxTop - Math.max(0, bottomGap)));
  }
  return Math.min(maxTop, currentTop);
}
