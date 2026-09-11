export const HISTORY_COMPOSER_PROMPT_BAND_MAX_ROWS = 3;
export const HISTORY_COMPOSER_PROMPT_BAND_GAP_PX = 5;
export const HISTORY_COMPOSER_PROMPT_CHIP_MAX_WIDTH_PX = 168;

const compactNumber = (value) => String(Number(value.toFixed(6)));

/**
 * Flex-wrap keeps the user's row-major left-to-right order. Limiting every
 * item to one `columns` share guarantees that all items fit in at most three
 * rows, while naturally short chips can still let more neighbours share a row.
 */
export function resolveHistoryComposerPromptBandLayout(rawCount) {
  const itemCount = Math.max(0, Math.floor(Number(rawCount) || 0));
  const columns = Math.max(
    1,
    Math.ceil(itemCount / HISTORY_COMPOSER_PROMPT_BAND_MAX_ROWS),
  );
  const widthPercent = 100 / columns;
  const gapSharePx = HISTORY_COMPOSER_PROMPT_BAND_GAP_PX * (columns - 1) / columns;

  return {
    itemCount,
    columns,
    gapPx: HISTORY_COMPOSER_PROMPT_BAND_GAP_PX,
    maxRows: HISTORY_COMPOSER_PROMPT_BAND_MAX_ROWS,
    itemMaxWidth: `min(${HISTORY_COMPOSER_PROMPT_CHIP_MAX_WIDTH_PX}px, calc(${compactNumber(widthPercent)}% - ${compactNumber(gapSharePx)}px))`,
    maxHeight: `calc(${compactNumber(HISTORY_COMPOSER_PROMPT_BAND_MAX_ROWS * 1.2)}em + ${HISTORY_COMPOSER_PROMPT_BAND_MAX_ROWS * 4 + (HISTORY_COMPOSER_PROMPT_BAND_MAX_ROWS - 1) * HISTORY_COMPOSER_PROMPT_BAND_GAP_PX}px)`,
  };
}

