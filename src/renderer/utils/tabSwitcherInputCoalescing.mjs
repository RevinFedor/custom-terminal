// Pure timing policy for Ctrl+Tab when native keyboard events arrive after an
// Electron/main stall. Product semantics live in TabSwitcherOverlay; this file
// only answers whether delivery was stale enough to require one feedback frame
// before commit and whether a second physical gesture is a pre-paint retry.

export const CTRL_SWITCHER_STALE_INPUT_MS = 180;

export function inputEventAbsoluteTime(eventTimeStamp, timeOrigin) {
  const stamp = Number(eventTimeStamp);
  if (!Number.isFinite(stamp) || stamp < 0) return Number(timeOrigin) || 0;
  // Chromium uses a time-origin-relative DOMHighResTimeStamp. Keep epoch-style
  // timestamps compatible with synthetic/native bridges that forward one.
  return stamp > 1e12 ? stamp : (Number(timeOrigin) || 0) + stamp;
}

export function inputEventDelayMs({ eventTimeStamp, timeOrigin, receivedAbs }) {
  return Math.max(0, (Number(receivedAbs) || 0) - inputEventAbsoluteTime(eventTimeStamp, timeOrigin));
}

export function shouldDeferCtrlSwitcherCommit({ inputDelayMs, feedbackPainted }) {
  return feedbackPainted !== true && Number(inputDelayMs) >= CTRL_SWITCHER_STALE_INPUT_MS;
}

export function shouldCoalesceCtrlSwitcherRetry({ commitPending, feedbackPainted }) {
  return commitPending === true && feedbackPainted !== true;
}
