'use strict';

// Bounded raw replay windows. Unlike composer-change sampling, these retain
// every PTY chunk, including chunks which do not change the input verdict.
function createTerminalReplayJournal({ maxChars = 256 * 1024, maxEvents = 2048 } = {}) {
  const window = (baseline = null) => ({ baseline, events: [], chars: 0, complete: !!baseline,
    loss: { outputEvents: 0, resizeEvents: 0, chars: 0, utf8ReencodedBytes: 0,
      firstOutputSeq: null, lastOutputSeq: null, utf8Complete: true, utf8UnavailableEvents: 0 }, gaps: [] });
  let current = window();
  const noteGap = reason => { if (!current.gaps.includes(reason)) current.gaps.push(reason); };
  const noteRemoved = event => {
    if (event.kind === 'output') {
      current.loss.outputEvents++;
      current.loss.chars += event.data.length;
      try { current.loss.utf8ReencodedBytes += Buffer.byteLength(event.data, 'utf8'); }
      catch { current.loss.utf8Complete = false; current.loss.utf8UnavailableEvents++; }
      current.loss.firstOutputSeq ??= event.seq;
      current.loss.lastOutputSeq = event.seq;
    } else current.loss.resizeEvents++;
  };
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
        noteGap(current.gapReason);
        while ((current.chars > maxChars || current.events.length > maxEvents) && current.events.length) {
          const removed = current.events.shift();
          noteRemoved(removed);
          current.chars -= removed.data?.length || 0;
        }
      }
    },
    resize(cols, rows, pendingWrites) {
      current.events.push({ kind: 'resize', cols, rows, at: Date.now(), pendingWrites });
      if (pendingWrites) {
        current.complete = false;
        current.gapReason = 'resize-overlapped-pending-xterm-write';
        noteGap(current.gapReason);
      }
      if (current.events.length > maxEvents * 2) {
        for (const event of current.events.slice(0, -maxEvents)) noteRemoved(event);
        current.events = current.events.slice(-maxEvents);
        current.chars = current.events.reduce((sum, event) => sum + (event.data?.length || 0), 0);
        current.complete = false;
        current.gapReason = 'resize-events-exceeded-retention';
        noteGap(current.gapReason);
      }
    },
    checkpoint(readBaseline) {
      if (current.baseline && current.complete && current.chars < maxChars && current.events.length < maxEvents) return;
      const baseline = readBaseline();
      if (!baseline) return;
      if (current.baseline) previous = current;
      current = window(baseline);
    },
    snapshot() { return JSON.parse(JSON.stringify({ source: 'headless-input-stream', units: 'chars=UTF-16; loss.utf8ReencodedBytes=sum per dropped chunk, not kernel bytes', previous, current })); },
  };
}

module.exports = { createTerminalReplayJournal };
