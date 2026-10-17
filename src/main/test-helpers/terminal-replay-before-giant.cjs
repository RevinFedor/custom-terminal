'use strict';

// Bounded raw replay windows. Unlike composer-change sampling, these retain
// every PTY chunk, including chunks which do not change the input verdict.
function createTerminalReplayJournal({ maxChars = 256 * 1024, maxEvents = 2048 } = {}) {
  let current = { baseline: null, events: [], chars: 0, complete: false };
  let previous = null;
  return {
    output(data, seq) {
      const text = String(data);
      current.events.push({ kind: 'output', seq, at: Date.now(), data: text });
      current.chars += text.length;
      // A stalled parser must not grow memory without bounds. An incomplete
      // window is explicitly marked, never passed off as a complete replay.
      if (current.chars > maxChars * 2 || current.events.length > maxEvents * 2) {
        current.complete = false;
        current.gapReason = 'output-exceeded-retention-before-flush';
        while ((current.chars > maxChars || current.events.length > maxEvents) && current.events.length) {
          const removed = current.events.shift();
          current.chars -= removed.data?.length || 0;
        }
      }
    },
    resize(cols, rows, pendingWrites) {
      current.events.push({ kind: 'resize', cols, rows, at: Date.now(), pendingWrites });
      if (pendingWrites) {
        current.complete = false;
        current.gapReason = 'resize-overlapped-pending-xterm-write';
      }
      if (current.events.length > maxEvents * 2) {
        current.events = current.events.slice(-maxEvents);
        current.chars = current.events.reduce((sum, event) => sum + (event.data?.length || 0), 0);
        current.complete = false;
        current.gapReason = 'resize-events-exceeded-retention';
      }
    },
    checkpoint(readBaseline) {
      if (current.baseline && current.complete && current.chars < maxChars && current.events.length < maxEvents) return;
      const baseline = readBaseline();
      if (!baseline) return;
      if (current.baseline) previous = current;
      current = { baseline, events: [], chars: 0, complete: true };
    },
    snapshot() { return JSON.parse(JSON.stringify({ source: 'headless-input-stream', previous, current })); },
  };
}

module.exports = { createTerminalReplayJournal };
