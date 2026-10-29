// One finite hover feedback token for linked-file chips and group counters.
// Their finite scale endpoint opens the existing popup/group. Workflow drag
// navigation keeps its separate dwell; neither is a readiness timeout.
export const CHIP_HOVER_MS=60;
export const CHIP_HOVER_SCALE=1.1;
export const CHIP_HOVER_STYLE=Object.freeze({
  '--noted-chip-hover-ms':`${CHIP_HOVER_MS}ms`,
  '--noted-chip-hover-scale':CHIP_HOVER_SCALE,
});
