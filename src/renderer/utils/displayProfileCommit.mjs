import { flushSync } from 'react-dom';
import { beginHistoryResize } from './historyResizeAnchor.mjs';

let commitDepth = 0;

// The existing History owner captures text anchors, cancels competing writers
// and restores after commit. This boundary only batches the UI/workspace
// geometry writes; it never reads or writes scroll positions itself.
export function commitDisplayProfileChange(update, reason = 'display-profile', options = {}) {
  const scope = options.scope ?? (typeof document !== 'undefined' ? document.body : null);
  if (!scope || commitDepth > 0) return update();
  const commit = options.commit ?? flushSync;
  let finish = null;
  let changed = false;
  let result;
  commitDepth += 1;
  try {
    finish = beginHistoryResize(scope, reason);
    commit(() => {
      changed = true;
      result = update();
    });
    return result;
  } finally {
    commitDepth -= 1;
    finish?.(changed);
  }
}
