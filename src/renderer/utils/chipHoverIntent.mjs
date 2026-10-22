// One finite hover feedback token for linked-file chips and group counters.
// The longer group-open progress is the workflow navigation dwell, not this
// small scale animation. Neither token is a polling/readiness timeout.
export const CHIP_HOVER_MS=60;
export const CHIP_HOVER_SCALE=1.04;
export const CHIP_HOVER_STYLE=Object.freeze({
  '--noted-chip-hover-ms':`${CHIP_HOVER_MS}ms`,
  '--noted-chip-hover-scale':CHIP_HOVER_SCALE,
});
