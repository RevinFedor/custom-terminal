'use strict';
const { performance } = require('node:perf_hooks');

// Observation only. The existing redraw grammar supplies begin/end; this module
// never parses ANSI, writes input, wakes readiness, or owns a timer/file/PTY.
// Volumes are WHOLE delivered chunks touching a span, including boundary chunks.
// Two spans sharing a boundary chunk overlap; their volumes must not be summed.
const CLOCK = 'performance.timeOrigin+performance.now';
const UNIT = 'UTF-16 code units; utf8Bytes is SUM of per-chunk UTF-8 re-encodings, not kernel bytes';
const nowDefault = () => performance.timeOrigin + performance.now();
const emptyStream = () => ({ chunks: 0, chars: 0, utf8Bytes: 0,
  firstAt: null, lastAt: null, firstSeq: null, lastSeq: null,
  missingSeqs: 0, nonIncreasingSeqs: 0, unknownSeqs: 0, maxGapMs: 0,
  maxGapFromSeq: null, maxGapToSeq: null });
const sums = s => ({ chunks: s.chunks, chars: s.chars, utf8Bytes: s.utf8Bytes });
const delta = (a, b) => ({ chunks: a.chunks - b.chunks,
  chars: a.chars - b.chars, utf8Bytes: a.utf8Bytes - b.utf8Bytes });

function createTerminalIoProgress({ now = nowDefault, log = null, identity = {} } = {}) {
  const raw = emptyStream(), mirror = emptyStream();
  let open = null, lastClosed = null, frameId = 0, outputContext = null;
  let lastFlush = null, lastCommit = null, ended = null;
  let errors = 0, unmatchedEnds = 0, reports = 0, reportsDropped = 0, clockRegressions = 0;
  let progressReportsOmitted = 0;
  let lastTime = null, reportWindowStart = null, reportWindowCount = 0;
  let owner = {};
  const safe = (work, fallback = null) => { try { return work(); } catch { errors++; return fallback; } };
  const at = () => {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError('diagnostic clock');
    if (lastTime !== null && value < lastTime) clockRegressions++;
    lastTime = value; return value;
  };
  const spanSnapshot = (span, time) => span && ({
    id: span.id, beginAt: span.beginAt, beginSeq: span.beginSeq,
    endAt: span.endAt, endSeq: span.endSeq,
    ageMs: Math.max(0, (span.endAt ?? time) - span.beginAt),
    silenceMs: Math.max(0, (span.endAt ?? time) - span.lastAt),
    chunks: span.volume.chunks, chars: span.volume.chars, utf8Bytes: span.volume.utf8Bytes,
    lastAt: span.lastAt, lastSeq: span.lastSeq, repeatedBegins: span.repeatedBegins,
    maxGapMs: span.maxGapMs, maxGapFromSeq: span.maxGapFromSeq, maxGapToSeq: span.maxGapToSeq,
    onset: 'existing-redraw-grammar-observed-begin',
    counting: 'inclusive whole mirror chunks; spans sharing a chunk overlap',
  });
  const report = (kind, span, time) => {
    if (typeof log !== 'function') return;
    // Event-driven rate limit, no background timer. Missing reports remain counted.
    if (reportWindowStart === null || time - reportWindowStart >= 60000) {
      reportWindowStart = time; reportWindowCount = 0;
    }
    if (reportWindowCount >= 8) { reportsDropped++; return; }
    reportWindowCount++; reports++;
    safe(() => log({ version: 1, kind, clock: CLOCK, units: UNIT, owner: { ...owner }, at: time,
      span: spanSnapshot(span, time), raw: { ...raw }, mirror: { ...mirror },
      lastFlush: lastFlush && { ...lastFlush }, lastCommit: lastCommit && { ...lastCommit },
      reportsDropped, diagnosticErrors: errors }));
  };
  const update = (stream, text, seq, time) => {
    const validSeq = Number.isSafeInteger(seq) && seq >= 0;
    if (validSeq && stream.lastSeq !== null) {
      if (seq > stream.lastSeq + 1) stream.missingSeqs += seq - stream.lastSeq - 1;
      else if (seq <= stream.lastSeq) stream.nonIncreasingSeqs++;
    } else if (!validSeq) stream.unknownSeqs++;
    if (stream.lastAt !== null && time - stream.lastAt > stream.maxGapMs) {
      stream.maxGapMs = time - stream.lastAt;
      stream.maxGapFromSeq = stream.lastSeq; stream.maxGapToSeq = validSeq ? seq : null;
    }
    stream.chunks++; stream.chars += text.length;
    stream.utf8Bytes += Buffer.byteLength(text, 'utf8');
    stream.firstAt ??= time; stream.lastAt = time;
    if (validSeq) { stream.firstSeq ??= seq; stream.lastSeq = seq; }
  };
  const api = {
    identify(value) { safe(() => {
      const out = {};
      for (const key of ['tabId', 'mirrorGeneration']) {
        if (typeof value?.[key] === 'string') out[key] = value[key].slice(0, 256);
      }
      owner = out;
    }); },
    raw(data) { safe(() => { if (!ended && typeof data === 'string' && data) update(raw, data, raw.chunks + 1, at()); }); },
    output(data, seq) { return safe(() => {
      if (ended || typeof data !== 'string' || !data) return null;
      const time = at(), before = sums(mirror);
      update(mirror, data, seq, time);
      outputContext = { time, seq, before, after: sums(mirror) };
      if (open) {
        if (time - open.lastAt > open.maxGapMs) {
          open.maxGapMs = time - open.lastAt; open.maxGapFromSeq = open.lastSeq; open.maxGapToSeq = seq;
        }
        open.lastAt = time; open.lastSeq = seq;
        open.volume = delta(outputContext.after, open.before);
        if (time - open.beginAt >= open.nextReportMs) {
          open.nextReportMs *= 4; // 2.5s, 10s, 40s, 160s, then no more progress lines.
          if (open.progressReports++ < 4) report('sync-open-progress', open, time);
          else progressReportsOmitted++;
        }
      }
      return outputContext;
    }); },
    control(kind, context) { safe(() => {
      if (ended || !context || context !== outputContext) return;
      if (kind === 'synchronized-output-begin') {
        if (open) { open.repeatedBegins++; return; }
        open = { id: ++frameId, beginAt: context.time, beginSeq: context.seq,
          before: context.before, volume: delta(context.after, context.before),
          lastAt: context.time, lastSeq: context.seq, endAt: null, endSeq: null,
          repeatedBegins: 0, maxGapMs: 0, maxGapFromSeq: null, maxGapToSeq: null,
          nextReportMs: 2500, progressReports: 0 };
      } else if (kind === 'synchronized-output-end') {
        if (!open) { unmatchedEnds++; return; }
        open.endAt = context.time; open.endSeq = context.seq;
        open.volume = delta(context.after, open.before);
        lastClosed = open; open = null;
        if (context.time - lastClosed.beginAt >= 2500) report('sync-close-observed', lastClosed, context.time);
      }
    }); },
    flush(seq) { safe(() => { if (!ended) lastFlush = { seq, at: at() }; }); },
    commit(seq) { safe(() => { if (!ended) lastCommit = { seq, at: at() }; }); },
    end(reason) { safe(() => {
      if (ended) return;
      const time = at();
      ended = { at: time, reason: ['mirror-disposed', 'mirror-failed', 'mirror-replaced'].includes(reason) ? reason : 'observer-ended' };
      if (open) report('sync-unclosed-at-observer-end', open, time);
    }); },
    snapshot() { return safe(() => {
      const time = at();
      return { version: 1, clock: CLOCK, units: UNIT, capturedAt: time, owner: { ...owner },
        raw: { ...raw, sequenceScope: 'local callback ordinal; zero holes does not prove upstream completeness', silenceMs: raw.lastAt === null ? null : Math.max(0, time - raw.lastAt) },
        mirror: { ...mirror, sequenceScope: 'headless reserved write sequence; may include synthetic fanout', silenceMs: mirror.lastAt === null ? null : Math.max(0, time - mirror.lastAt) },
        open: spanSnapshot(open, ended?.at ?? time), lastClosed: spanSnapshot(lastClosed, time),
        lastFlush: lastFlush && { ...lastFlush }, lastCommit: lastCommit && { ...lastCommit },
        ended: ended && { ...ended }, unmatchedEnds, clockRegressions,
        diagnosticErrors: errors, reports, reportsDropped, progressReportsOmitted,
        limits: { retainedSpans: 2, progressReportsPerSpan: 4, reportsPerMinute: 8 },
        coverage: 'app-callback and mirror-input observations; not CLI CPU/stdin or kernel-byte proof' };
    }); },
  };
  api.identify(identity);
  return api;
}
module.exports = { createTerminalIoProgress };

// Call-site firewall: even a broken/replaced diagnostic method must not escape
// into Main's write setup catch and mark a healthy mirror failed.
function observeTerminalIo(trace, method, ...args) {
  try { return trace?.ioProgress?.[method]?.(...args) ?? null; }
  catch { try { trace.progressHookErrors = Number(trace.progressHookErrors || 0) + 1; } catch {} return null; }
}
module.exports.observeTerminalIo = observeTerminalIo;
