#!/usr/bin/env node

import fs from 'node:fs';

const numeric = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round = (value, digits = 1) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const latestBootId = (lines) => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const boot = lines[index].match(/\bboot=([^ ]+)/)?.[1];
    if (boot) return boot;
  }
  return null;
};

const maxConcurrentIntervals = (intervals) => {
  const events = intervals.flatMap((interval) => [
    { at: interval.startAbs, delta: 1 },
    { at: interval.endAbs, delta: -1 },
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let max = 0;
  let maxAtAbs = null;
  for (const event of events) {
    active += event.delta;
    if (active > max) {
      max = active;
      maxAtAbs = event.at;
    }
  }
  return { max, maxAtAbs };
};

export function analyzeHistoryPrewarmLog(text, {
  bootId = null,
  tabSuffix = 'tab-3951',
  from = null,
  to = null,
} = {}) {
  const allLines = String(text || '').split(/\r?\n/);
  const selectedBootId = bootId || latestBootId(allLines);
  const lines = allLines.filter((line) => {
    if (selectedBootId && !line.includes(`boot=${selectedBootId}`)) return false;
    const timestamp = line.slice(0, 12);
    if (from && timestamp < from) return false;
    if (to && timestamp > to) return false;
    return true;
  });

  const historyIntervals = [];
  const coldLoadStarts = [];
  const wheelBegins = [];
  const wheelInputs = [];
  const seekEnters = [];
  const placeholderFrames = [];
  const bridgeWrites = [];
  const longTasks = [];
  const prewarmEvents = [];
  const prewarmAdmissionTransitions = [];

  for (const line of lines) {
    const slowHistory = line.match(
      /\[Perf:IpcSlow\] channel=agent-transcript:get-history durMs=([0-9.]+) endAbs=([0-9.]+).*?\btab=([^ ]+)/,
    );
    if (slowHistory) {
      const durationMs = Number(slowHistory[1]);
      const endAbs = Number(slowHistory[2]);
      historyIntervals.push({
        tab: slowHistory[3],
        durationMs,
        startAbs: endAbs - durationMs,
        endAbs,
      });
    }

    const coldStart = line.match(
      /\[HistoryHandoff\] LOAD_START tab=([^ ]+).*? seq=([0-9]+).*? refresh=0\b/,
    );
    if (coldStart) coldLoadStarts.push({ tab: coldStart[1], seq: Number(coldStart[2]) });

    if (line.includes(`tab=${tabSuffix}`) || line.includes(`tab=mFs-${tabSuffix}`)) {
      const begin = line.match(
        /SCROLL_GESTURE_BEGIN .*?gid=([0-9]+).*?inputDelayMs=([0-9.]+).*?deltaY=(-?[0-9.]+)/,
      );
      if (begin) {
        wheelBegins.push({
          gid: Number(begin[1]),
          inputDelayMs: Number(begin[2]),
          deltaY: Number(begin[3]),
        });
      }
      const input = line.match(
        /SCROLL_GESTURE_INPUT .*?gid=([0-9]+).*?seq=([0-9]+).*?deltaY=(-?[0-9.]+)/,
      );
      if (input) {
        wheelInputs.push({
          gid: Number(input[1]),
          seq: Number(input[2]),
          deltaY: Number(input[3]),
        });
      }
      const seekEnter = line.match(
        /SCROLL_SEEK_ENTER .*?velocity=(-?[0-9.]+).*?burst=([01]).*?wheelGesture=([01])/,
      );
      if (seekEnter) {
        seekEnters.push({
          velocity: Number(seekEnter[1]),
          burst: seekEnter[2] === '1',
          wheelGesture: seekEnter[3] === '1',
        });
      }
      const frame = line.match(
        /SCROLL_GESTURE_FRAME .*?gid=([0-9]+).*?phase=([^ ]+).*?domRows=([0-9]+).*?seek=([01])\b/,
      );
      if (frame && frame[4] === '1' && Number(frame[3]) === 0) {
        placeholderFrames.push({
          gid: Number(frame[1]),
          phase: frame[2],
        });
      }
      const bridge = line.match(
        /WHEEL_GEOMETRY_BRIDGE_WRITE .*?path=([^ ]+).*?offset=(-?[0-9.]+)/,
      );
      if (bridge) bridgeWrites.push({ path: bridge[1], offset: Number(bridge[2]) });
    }

    const longTask = line.match(
      /\[Perf:LongTask\].*?durationMs=([0-9.]+).*?during=([^ ]+).*?activeTab=([^ ]+)/,
    );
    if (longTask) {
      longTasks.push({
        durationMs: Number(longTask[1]),
        during: longTask[2],
        activeTab: longTask[3],
      });
    }

    const admission = line.match(
      /\[Perf:PanePrewarmAdmission\] phase=([^ ]+) tab=([^ ]*) token=([0-9]+) pending=([0-9]+)(?: reason=([^ ]+))?/,
    );
    if (admission) {
      prewarmAdmissionTransitions.push({
        phase: admission[1],
        tab: admission[2],
        token: Number(admission[3]),
        pending: Number(admission[4]),
        reason: admission[5] || null,
      });
    }
    if (/\[(?:Perf:)?(?:HistoryPrewarm|PanePrewarm(?:Admission)?)\]/.test(line)) {
      prewarmEvents.push(line.slice(line.indexOf('[')));
    }
  }

  const concurrency = maxConcurrentIntervals(historyIntervals);
  const longestHistory = [...historyIntervals]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 10)
    .map((interval) => ({ tab: interval.tab, durationMs: round(interval.durationMs) }));
  const maxWheelInputDelayMs = wheelBegins.length > 0
    ? Math.max(...wheelBegins.map((entry) => entry.inputDelayMs))
    : null;
  const maxAbsWheelDelta = wheelInputs.length > 0
    ? Math.max(...wheelInputs.map((entry) => Math.abs(entry.deltaY)))
    : null;
  const maxAbsBridgeOffset = bridgeWrites.length > 0
    ? Math.max(...bridgeWrites.map((entry) => Math.abs(entry.offset)))
    : null;
  const maxLongTaskMs = longTasks.length > 0
    ? Math.max(...longTasks.map((entry) => entry.durationMs))
    : null;
  const activeAdmissionTokens = new Set();
  let maxHiddenPrewarmConcurrent = 0;
  for (const transition of prewarmAdmissionTransitions) {
    const identity = `${transition.tab}:${transition.token}`;
    if (transition.phase === 'start') activeAdmissionTokens.add(identity);
    if (transition.phase === 'complete' || transition.phase === 'start-error') {
      activeAdmissionTokens.delete(identity);
    }
    maxHiddenPrewarmConcurrent = Math.max(
      maxHiddenPrewarmConcurrent,
      activeAdmissionTokens.size,
    );
  }

  return {
    bootId: selectedBootId,
    lineWindow: { from, to },
    tabSuffix,
    history: {
      slowRequests: historyIntervals.length,
      coldStarts: coldLoadStarts.length,
      maxConcurrent: concurrency.max,
      maxConcurrentAtAbs: concurrency.maxAtAbs,
      longest: longestHistory,
    },
    scroll: {
      gestures: wheelBegins.length,
      wheelEvents: wheelInputs.length,
      maxInputDelayMs: round(maxWheelInputDelayMs),
      maxAbsWheelDelta: round(maxAbsWheelDelta),
      maxAbsBridgeOffset: round(maxAbsBridgeOffset),
      seekEnters: seekEnters.length,
      placeholderFrames: placeholderFrames.length,
      seekTransitions: seekEnters,
      begins: wheelBegins,
    },
    renderer: {
      longTasks: longTasks.length,
      maxLongTaskMs: round(maxLongTaskMs),
    },
    prewarm: {
      admissionStarts: prewarmAdmissionTransitions.filter((entry) => entry.phase === 'start').length,
      admissionCompletes: prewarmAdmissionTransitions.filter((entry) => entry.phase === 'complete').length,
      maxHiddenConcurrent: maxHiddenPrewarmConcurrent,
      maxPending: prewarmAdmissionTransitions.length > 0
        ? Math.max(...prewarmAdmissionTransitions.map((entry) => entry.pending))
        : 0,
      transitions: prewarmAdmissionTransitions,
      events: prewarmEvents,
    },
  };
}

const parseArgs = (argv) => {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const logPath = args.log || '/Users/fedor/Library/Logs/noted-terminal/production.log';
  const analysis = analyzeHistoryPrewarmLog(fs.readFileSync(logPath, 'utf8'), {
    bootId: args.boot || null,
    tabSuffix: args.tab || 'tab-3951',
    from: args.from || null,
    to: args.to || null,
  });
  const failures = [];
  const maxConcurrency = numeric(args['max-history-concurrency']);
  const maxWheelDelay = numeric(args['max-wheel-delay']);
  const maxWheelDelta = numeric(args['max-wheel-delta']);
  const maxSeekEnters = numeric(args['max-seek-enters']);
  const maxPlaceholderFrames = numeric(args['max-placeholder-frames']);
  const maxHiddenPrewarm = numeric(args['max-hidden-prewarm-concurrency']);
  if (maxConcurrency !== null && analysis.history.maxConcurrent > maxConcurrency) {
    failures.push(`history.maxConcurrent=${analysis.history.maxConcurrent} > ${maxConcurrency}`);
  }
  if (maxWheelDelay !== null
    && analysis.scroll.maxInputDelayMs !== null
    && analysis.scroll.maxInputDelayMs > maxWheelDelay) {
    failures.push(`scroll.maxInputDelayMs=${analysis.scroll.maxInputDelayMs} > ${maxWheelDelay}`);
  }
  if (maxWheelDelta !== null
    && analysis.scroll.maxAbsWheelDelta !== null
    && analysis.scroll.maxAbsWheelDelta > maxWheelDelta) {
    failures.push(`scroll.maxAbsWheelDelta=${analysis.scroll.maxAbsWheelDelta} > ${maxWheelDelta}`);
  }
  if (maxSeekEnters !== null && analysis.scroll.seekEnters > maxSeekEnters) {
    failures.push(`scroll.seekEnters=${analysis.scroll.seekEnters} > ${maxSeekEnters}`);
  }
  if (maxPlaceholderFrames !== null
    && analysis.scroll.placeholderFrames > maxPlaceholderFrames) {
    failures.push(
      `scroll.placeholderFrames=${analysis.scroll.placeholderFrames} > ${maxPlaceholderFrames}`,
    );
  }
  if (maxHiddenPrewarm !== null
    && analysis.prewarm.maxHiddenConcurrent > maxHiddenPrewarm) {
    failures.push(`prewarm.maxHiddenConcurrent=${analysis.prewarm.maxHiddenConcurrent} > ${maxHiddenPrewarm}`);
  }
  console.log(JSON.stringify({ ...analysis, pass: failures.length === 0, failures }, null, 2));
  if (failures.length > 0) process.exitCode = 2;
}
