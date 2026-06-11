// Claude usage limits IPC.
//
// Reads the OAuth access token from the macOS Keychain entry
// "Claude Code-credentials" (created by claude CLI when the user signs in),
// then queries https://api.anthropic.com/api/oauth/usage — same endpoint the
// Blimp-Labs claude-usage-bar app uses. Returns weekly + 5-hour utilization +
// extra-credits usage. Response is cached in-process for 5 minutes to avoid
// rate-limiting (server polls every 30m by default).
//
// Schema (relevant fields):
//   five_hour:  { utilization: %, resets_at: ISO }
//   seven_day:  { utilization: %, resets_at: ISO }
//   seven_day_opus / seven_day_sonnet: same shape
//   extra_usage: { is_enabled, utilization, used_credits, monthly_limit, currency }

const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const https = require('https');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Polling cadence — renderer ticks every 3 min, cache TTL чуть меньше, чтобы
// каждый плановый poll реально дёргал сеть, а не сидел на кэше. Anthropic
// `/oauth/usage` rate-limit раздаёт 429 даже при 1 запросе/мин — 3 мин
// заметно реже триггерит окно. См. fact-claude-usage-chip.md::Polling cadence.
const CACHE_TTL_MS = 170 * 1000;

// `lastErrorAt` — when the most recent live fetch failed. While the last
// network attempt is still recent we refuse to make another live request even
// on cache miss, to avoid hammering Anthropic during a 429 window. Force-
// refresh from the UI ignores this gate. Cooldown = ~polling interval so
// ретрай совпадает со следующим плановым тиком.
let cache = { at: 0, data: null, error: null, lastErrorAt: 0, lastAttemptAt: 0 };
const ERROR_COOLDOWN_MS = 180 * 1000;

// Reconstruct minimal /oauth/usage-shaped object from the last persisted
// snapshot. Used as fallback when the in-memory cache is empty (cold start)
// AND the live fetch is unavailable (429, network drop, etc) — without this
// the chip falls back to '—' even though we have a recent reading on disk.
// Missing fields (extra_usage, opus / sonnet breakdown) — we only persist the
// scalars, so the popover's optional rows disappear; this is acceptable
// degradation vs a completely blank chip.
function snapshotToUsageData(snap) {
  if (!snap) return null;
  const utilOrNull = (v) => (v == null ? null : Number(v));
  const opus = utilOrNull(snap.weekly_opus_pct);
  const sonnet = utilOrNull(snap.weekly_sonnet_pct);
  return {
    five_hour: snap.five_hour_pct != null
      ? { utilization: Number(snap.five_hour_pct), resets_at: snap.five_hour_resets_at || null }
      : null,
    seven_day: snap.weekly_pct != null
      ? { utilization: Number(snap.weekly_pct), resets_at: snap.weekly_resets_at || null }
      : null,
    seven_day_opus: opus != null
      ? { utilization: opus, resets_at: snap.weekly_resets_at || null }
      : null,
    seven_day_sonnet: sonnet != null
      ? { utilization: sonnet, resets_at: snap.weekly_resets_at || null }
      : null,
  };
}

function loadFallbackFromSnapshot() {
  if (!_projectManager?.db) return null;
  try {
    const snap = _projectManager.db.getLatestClaudeUsageSnapshot?.();
    if (!snap) return null;
    return { data: snapshotToUsageData(snap), at: snap.ts * 1000 };
  } catch (e) {
    console.error('[ClaudeUsage] snapshot fallback failed:', e.message);
    return null;
  }
}
let _projectManager = null;

function readKeychainToken() {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], (err, stdout) => {
      if (err) return reject(new Error('Keychain entry "Claude Code-credentials" not found. Sign in via claude CLI.'));
      try {
        const j = JSON.parse(stdout.toString().trim());
        const token = j?.claudeAiOauth?.accessToken;
        if (!token) return reject(new Error('No accessToken in keychain payload.'));
        resolve(token);
      } catch (e) {
        reject(new Error('Failed to parse keychain payload: ' + e.message));
      }
    });
  });
}

function fetchUsage(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'noted-terminal/1.0',
      },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('Bad JSON: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

async function getUsage(force = false) {
  const now = Date.now();
  // Cache hit — explicitly clear the previous error in cache so callers know
  // the world is fine again (previous behaviour left a stale `cache.error`
  // pointing at a long-passed 429, and the renderer's banner survived even
  // through successful polling cycles).
  if (!force && cache.data && (now - cache.at) < CACHE_TTL_MS) {
    return {
      ok: true,
      data: cache.data,
      cachedMsAgo: now - cache.at,
      error: null,
      lastAttemptAt: cache.lastAttemptAt,
    };
  }
  // Background polling honours an error-cooldown to avoid pummeling Anthropic
  // while a 429 window is active. Force refresh (user pressed the refresh
  // button) bypasses this — they explicitly want a live attempt.
  if (!force && cache.lastErrorAt && (now - cache.lastErrorAt) < ERROR_COOLDOWN_MS) {
    // Cold-start case: cooldown active but no in-memory data yet — seed from
    // last persisted snapshot so the chip isn't blank during the wait.
    if (!cache.data) {
      const fb = loadFallbackFromSnapshot();
      if (fb) { cache.data = fb.data; cache.at = fb.at; }
    }
    return {
      ok: !!cache.data && !cache.error,
      data: cache.data || null,
      error: cache.error || null,
      cachedMsAgo: cache.at ? now - cache.at : null,
      cooldownMsLeft: ERROR_COOLDOWN_MS - (now - cache.lastErrorAt),
      lastAttemptAt: cache.lastAttemptAt,
    };
  }
  cache.lastAttemptAt = now;
  try {
    const token = await readKeychainToken();
    const data = await fetchUsage(token);
    cache = { at: now, data, error: null, lastErrorAt: 0, lastAttemptAt: now };
    console.log('[ClaudeUsage] fetched: 5h=' + (data?.five_hour?.utilization ?? '?') + '% 7d=' + (data?.seven_day?.utilization ?? '?') + '%');
    // Persist snapshot for daily-history aggregation. Run on every real
    // network fetch (not on cache hits) — gives ~1 snapshot/min when chip is
    // visible. Failed network fetches don't reach here, so we don't store
    // bogus rows.
    if (_projectManager?.db) {
      try {
        _projectManager.db.saveClaudeUsageSnapshot({
          ts: Math.floor(now / 1000),
          weekly_pct: data?.seven_day?.utilization ?? null,
          five_hour_pct: data?.five_hour?.utilization ?? null,
          weekly_opus_pct: data?.seven_day_opus?.utilization ?? null,
          weekly_sonnet_pct: data?.seven_day_sonnet?.utilization ?? null,
          weekly_resets_at: data?.seven_day?.resets_at ?? null,
          five_hour_resets_at: data?.five_hour?.resets_at ?? null,
        });
      } catch (e) {
        console.error('[ClaudeUsage] snapshot save failed:', e.message);
      }
    }
    return { ok: true, data, cachedMsAgo: 0, error: null, lastAttemptAt: now };
  } catch (e) {
    console.error('[ClaudeUsage] fetch failed:', e.message);
    cache.error = e.message;
    cache.lastErrorAt = now;
    cache.lastAttemptAt = now;
    // Cold-start: live fetch failed AND no in-memory data — seed from
    // persisted snapshot so renderer still gets real numbers. `error` поле
    // remains set so banner is visible, but chip shows %, не прочерк.
    if (!cache.data) {
      const fb = loadFallbackFromSnapshot();
      if (fb) { cache.data = fb.data; cache.at = fb.at; }
    }
    return { ok: false, error: e.message, data: cache.data || null, lastAttemptAt: now };
  }
}

// Aggregate snapshots into per-day buckets. Day boundary = local midnight
// (user-perceived "today" is local-time-based, not UTC). Returns descending
// array of { date: 'YYYY-MM-DD', delta, max, was_reset } for the last N days.
//
// Reset detection — TWO signals, ANY of which fires marks the boundary:
//
//  1. `resets_at` rotation by CALENDAR DAY. Anthropic weekly buckets rotate
//     once a week, ~7 days apart. Each snapshot carries the bucket's planned
//     reset moment in `weekly_resets_at` (string with microsecond jitter, do
//     NOT compare raw). Slicing just the date portion (YYYY-MM-DD) is the
//     correct resolution: real rotations cross days, jitter never does.
//
//     Example from production:
//       2026-05-20 22:00 → 22% (resets_at = "2026-05-26T00:00:00Z")
//       2026-05-21 07:57 → 21% (resets_at = "2026-05-27T01:00:00.xxx+00:00")
//       Different reset DAYS → bucket rotated overnight → today's 21% is
//       NOT a continuation of yesterday's 22%; the 22→21 transition is NOT
//       new activity, it's a fresh weekly bucket.
//
//  2. Hard drop > 10pp between consecutive snapshots in the SAME bucket. Used
//     when resets_at happens to be missing (NULL) or to catch the rare case
//     where Anthropic ratejitters a bucket day boundary itself by minutes —
//     a sane fallback that almost never fires.
function resetsAtDay(s) {
  if (!s) return null;
  return String(s).slice(0, 10); // YYYY-MM-DD
}

function computeDailyHistory(days = 7) {
  if (!_projectManager?.db) return [];
  const now = Math.floor(Date.now() / 1000);
  const fromTs = now - (days * 24 * 60 * 60) - (24 * 60 * 60); // +1 day buffer for cross-midnight last sample
  const rows = _projectManager.db.getClaudeUsageSnapshots(fromTs, now);
  if (rows.length === 0) return [];

  // Bucket by local date (YYYY-MM-DD)
  const byDay = new Map();
  for (const row of rows) {
    const d = new Date(row.ts * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }

  // For each day: detect reset, compute usage from day-start to day-end.
  // Day-start baseline = the previous day's last snapshot weekly_pct (or 0
  // if no data). Day-delta = max during the day - day-start baseline,
  // unless reset happened — then = post-reset max.
  const sortedDays = Array.from(byDay.keys()).sort();
  const out = [];
  let prevDayLastWeekly = null;
  let prevDayLastResetDay = null;
  for (const day of sortedDays) {
    const snapshots = byDay.get(day);
    let dayMax = 0;
    let dayMaxFiveHour = 0;
    let wasReset = false;
    let postResetStart = null;

    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i];
      const w = s.weekly_pct ?? 0;
      const fh = s.five_hour_pct ?? 0;
      if (fh > dayMaxFiveHour) dayMaxFiveHour = fh;

      const curResetDay = resetsAtDay(s.weekly_resets_at);

      if (i === 0) {
        // Boundary check between yesterday and today: either reset_day shifted
        // (bucket rotated) or weekly% fell hard (no resets_at info).
        const dayShifted = prevDayLastResetDay && curResetDay && curResetDay !== prevDayLastResetDay;
        const dropped = prevDayLastWeekly != null && (prevDayLastWeekly - w > 10);
        if (dayShifted || dropped) {
          wasReset = true;
          postResetStart = w;
        }
      } else {
        // Within the day: same signals.
        const prevSnap = snapshots[i - 1];
        const prevResetDay = resetsAtDay(prevSnap.weekly_resets_at);
        const prevW = prevSnap.weekly_pct ?? 0;
        const dayShifted = prevResetDay && curResetDay && curResetDay !== prevResetDay;
        const dropped = prevW - w > 10;
        if (dayShifted || dropped) {
          wasReset = true;
          postResetStart = w;
        }
      }

      if (w > dayMax) dayMax = w;
    }

    const lastInDay = snapshots[snapshots.length - 1];
    const baseline = wasReset
      ? (postResetStart ?? 0)
      : (prevDayLastWeekly ?? (snapshots[0].weekly_pct ?? 0));
    const delta = Math.max(0, dayMax - baseline);

    out.push({
      date: day,
      delta: Math.round(delta * 10) / 10,
      max: Math.round(dayMax * 10) / 10,
      fiveHourMax: Math.round(dayMaxFiveHour * 10) / 10,
      wasReset,
      sampleCount: snapshots.length,
    });

    prevDayLastWeekly = lastInDay.weekly_pct;
    prevDayLastResetDay = resetsAtDay(lastInDay.weekly_resets_at);
  }

  // Cap to requested window, descending (today first)
  return out.slice(-days).reverse();
}

// ========== AGENT ACTIVITY AGGREGATION ==========
//
// Raw rows are CLOSED intervals (start_ts/end_ts ms) with a denormalized
// identity snapshot. We aggregate three ways for the popover's "Activity"
// section: by local day, by project, by tab. "Active time" = summed interval
// duration — if two agents run in parallel that counts as 2× wall-clock, which
// is the honest answer to "how much agent work happened".
//
// Intervals can straddle local midnight, so by-day buckets split each interval
// at midnight boundaries (same local-date convention as the usage chart).

function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Next local-midnight strictly after `ms`, as an epoch-ms number.
function nextLocalMidnight(ms) {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0); // rolls into next day at 00:00:00.000 local
  return d.getTime();
}

function computeActivityStats(days = 14) {
  if (!_projectManager?.db) return { ok: true, totalMs: 0, byDay: [], byProject: [], byTab: [] };
  const now = Date.now();
  const fromTs = now - days * 24 * 60 * 60 * 1000;
  const rows = _projectManager.db.getActivityIntervals(fromTs, now);

  const ENGINES = ['claude', 'claude-sdk', 'gemini', 'codex'];
  const emptyEngineMap = () => ({ claude: 0, 'claude-sdk': 0, gemini: 0, codex: 0 });

  let totalMs = 0;
  const byDay = new Map();      // date → { ms, byEngine }
  const byProject = new Map();  // projectId|path → { projectName, projectPath, ms, tabs:Set }
  const byTab = new Map();      // tabId → { tabName, projectName, engine, ms }

  for (const r of rows) {
    // Clip to window
    const start = Math.max(r.start_ts, fromTs);
    const end = Math.min(r.end_ts, now);
    if (end <= start) continue;
    const dur = end - start;
    const engine = ENGINES.includes(r.engine) ? r.engine : 'claude';

    totalMs += dur;

    // By day — split across local-midnight boundaries.
    let cursor = start;
    while (cursor < end) {
      const boundary = Math.min(nextLocalMidnight(cursor), end);
      const slice = boundary - cursor;
      const key = localDayKey(cursor);
      if (!byDay.has(key)) byDay.set(key, { ms: 0, byEngine: emptyEngineMap() });
      const bucket = byDay.get(key);
      bucket.ms += slice;
      bucket.byEngine[engine] += slice;
      cursor = boundary;
    }

    // By project — key on id when present, else path, else '∅'.
    const pKey = r.project_id || r.project_path || '∅';
    if (!byProject.has(pKey)) {
      byProject.set(pKey, {
        projectId: r.project_id || null,
        projectName: r.project_name || null,
        projectPath: r.project_path || null,
        ms: 0,
        tabs: new Set(),
      });
    }
    const p = byProject.get(pKey);
    p.ms += dur;
    if (r.tab_id) p.tabs.add(r.tab_id);
    if (!p.projectName && r.project_name) p.projectName = r.project_name;

    // By tab.
    const tKey = r.tab_id || `${pKey}:${r.tab_name || '?'}`;
    if (!byTab.has(tKey)) {
      byTab.set(tKey, {
        tabId: r.tab_id || null,
        tabName: r.tab_name || null,
        projectName: r.project_name || null,
        engine,
        ms: 0,
      });
    }
    byTab.get(tKey).ms += dur;
  }

  const byDayArr = Array.from(byDay.entries())
    .map(([date, v]) => ({ date, ms: v.ms, byEngine: v.byEngine }))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // descending (today first)

  const byProjectArr = Array.from(byProject.values())
    .map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      projectPath: p.projectPath,
      ms: p.ms,
      tabCount: p.tabs.size,
    }))
    .sort((a, b) => b.ms - a.ms);

  const byTabArr = Array.from(byTab.values()).sort((a, b) => b.ms - a.ms);

  return { ok: true, totalMs, byDay: byDayArr, byProject: byProjectArr, byTab: byTabArr };
}

function register({ projectManager }) {
  _projectManager = projectManager;

  ipcMain.handle('claude-usage:get', async (_e, opts) => {
    return getUsage(!!(opts && opts.force));
  });

  ipcMain.handle('claude-usage:activity', async (_e, opts) => {
    try {
      const days = (opts && Number.isFinite(opts.days)) ? opts.days : 14;
      return computeActivityStats(days);
    } catch (e) {
      console.error('[ClaudeUsage] activity stats failed:', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('claude-usage:daily-history', async (_e, opts) => {
    try {
      const days = (opts && Number.isFinite(opts.days)) ? opts.days : 7;
      const history = computeDailyHistory(days);
      return { ok: true, history };
    } catch (e) {
      console.error('[ClaudeUsage] daily-history failed:', e.message);
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { register };
