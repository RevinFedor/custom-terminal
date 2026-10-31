'use strict';

// Fixed-size synchronous execution witnesses, shared by Main and renderer.
// No stack capture, timers, IPC, result inspection, DOM or per-call logging.
const WIDTH = 16, MAX_RECORDS = 2048, MAX_IDS = 128, MAX_DEPTH = 64;
const scalar = (v, k) => { try { return Object.getOwnPropertyDescriptor(v || {}, k)?.value; } catch { return undefined; } };
const tokenText = v => typeof v === 'string' && /^[\w.:=/-]{1,192}$/.test(v) ? v : null;
const numeric = v => typeof v === 'number' && Number.isFinite(v) ? v : -1;
const relations = ['none', 'direct', 'inherited', 'temporal-only'];

function createSyncWorkRing({ now = () => performance.now(), timeOrigin = performance.timeOrigin,
  sourceBoot = 'unknown', role = 'unknown', capacity = MAX_RECORDS, cpu = null } = {}) {
  capacity = Math.max(8, Math.min(MAX_RECORDS, Number.isInteger(capacity) ? capacity : MAX_RECORDS));
  const bank = () => ({ rows: new Float64Array(capacity * WIDTH), count: 0, ids: [''], index: new Map(), evictions: 0 });
  const banks = [bank(), bank()], stack = [];
  let enabled = false, active = 0, frozen = null, sequence = 0, freezeSeq = 0;
  const losses = { ids: 0, invalidSites: 0, overwrittenOpen: 0, depth: 0, clock: 0, freezeBusy: 0, output: 0 };
  const intern = (b, v) => {
    const text = tokenText(v); if (!text) return 0;
    if (b.index.has(text)) return b.index.get(text);
    if (b.ids.length > MAX_IDS) { losses.ids++; return 0; }
    const id = b.ids.length; b.ids.push(text); b.index.set(text, id); return id;
  };
  const readCpu = () => { try { const n = cpu?.(); return Number.isFinite(n) && n >= 0 ? n : -1; } catch { return -1; } };
  function enter(site, context) {
    if (!enabled) return null;
    if (typeof site !== 'string' || !/^[\w.:-]{1,96}$/.test(site)) { losses.invalidSites++; return null; }
    if (stack.length >= MAX_DEPTH || sequence >= Number.MAX_SAFE_INTEGER - 1) { losses.depth++; return null; }
    let start; try { start = now(); } catch { losses.clock++; return null; }
    if (!Number.isFinite(start)) { losses.clock++; return null; }
    const b = banks[active], i = (b.count++ % capacity) * WIDTH;
    if (b.count > capacity) b.evictions++;
    const seq = ++sequence, row = b.rows;
    row.fill(0, i, i + WIDTH);
    row[i] = seq; row[i + 1] = stack.at(-1)?.sequence || 0;
    row[i + 2] = intern(b, site); row[i + 3] = start; row[i + 4] = -1; row[i + 5] = -1;
    row[i + 6] = intern(b, scalar(context, 'owner'));
    row[i + 7] = intern(b, scalar(context, 'readId'));
    row[i + 8] = intern(b, scalar(context, 'actionId'));
    row[i + 9] = numeric(scalar(context, 'generation')); row[i + 10] = numeric(scalar(context, 'visit'));
    const presented = scalar(context, 'presented'); row[i + 11] = typeof presented === 'boolean' ? Number(presented) : -1;
    row[i + 12] = scalar(context, 'origin') === 'observer' ? 1 : 0;
    row[i + 13] = Math.max(0, relations.indexOf(scalar(context, 'relation')));
    row[i + 14] = 0; row[i + 15] = enabled ? 1 : 0;
    const t = { bank: active, index: i, sequence: seq, start, cpu: readCpu() };
    stack.push(t); return t;
  }
  function close(t, threw) {
    if (!t) return;
    if (stack.at(-1) === t) stack.pop(); else { losses.depth++; return; }
    const row = banks[t.bank].rows, i = t.index;
    if (row[i] !== t.sequence) { losses.overwrittenOpen++; return; }
    let end; try { end = now(); } catch { losses.clock++; return; }
    if (!Number.isFinite(end) || end < t.start) { losses.clock++; return; }
    const endCpu = readCpu();
    row[i + 4] = end; row[i + 5] = t.cpu >= 0 && endCpu >= t.cpu ? (endCpu - t.cpu) / 1000 : -1;
    row[i + 14] = threw ? 2 : 1;
  }
  function run(site, context, callback) {
    let t = null, failed = false;
    try { t = enter(site, context); } catch { losses.clock++; }
    try { return callback(); } catch (error) { failed = true; throw error; }
    finally { try { close(t, failed); } catch { losses.clock++; } }
  }
  const health = () => ({ enabled, sequence, activeBank: active, frozen: frozen !== null,
    typedBufferBytes: banks.reduce((n, b) => n + b.rows.byteLength, 0),
    dictionaryLimitPerBank: MAX_IDS, stringCodeUnitsLimit: 192, depthLimit: MAX_DEPTH,
    dictionaryEntries: banks.map(b => b.ids.length - 1), openScopes: stack.length,
    evictions: banks.map(b => b.evictions), losses: { ...losses } });
  function snapshot({ from = -Infinity, to = Infinity, limit = 128 } = {}) {
    limit = Math.max(1, Math.min(256, Number.isInteger(limit) ? limit : 128));
    const b = banks[frozen === null ? active : frozen], rows = [];
    const count = Math.min(capacity, b.count);
    for (let n = 0; n < count; n++) {
      const i = ((b.count - count + n) % capacity) * WIDTH, r = b.rows;
      if (r[i + 3] > to || r[i + 4] >= 0 && r[i + 4] < from) continue;
      rows.push({ sequence: r[i], parentWork: r[i + 1] || null, site: b.ids[r[i + 2]] || null,
        startMono: r[i + 3], endMono: r[i + 4] < 0 ? null : r[i + 4],
        wallMs: r[i + 4] < 0 ? null : r[i + 4] - r[i + 3], threadCpuMs: r[i + 5] < 0 ? null : r[i + 5],
        owner: b.ids[r[i + 6]] || null, readId: b.ids[r[i + 7]] || null, actionId: b.ids[r[i + 8]] || null,
        generation: r[i + 9] < 0 ? null : r[i + 9], visit: r[i + 10] < 0 ? null : r[i + 10],
        presented: r[i + 11] < 0 ? null : !!r[i + 11], origin: r[i + 12] ? 'observer' : 'product',
        relation: relations[r[i + 13]], outcome: ['open', 'returned', 'threw'][r[i + 14]] });
    }
    // A bounded report prioritizes long work, then retains order of the kept
    // scopes. Omitted scopes stay explicit; this is not exhaustive attribution.
    const omitted = Math.max(0, rows.length - limit);
    if (omitted) rows.sort((a, b) => (b.wallMs ?? Infinity) - (a.wallMs ?? Infinity)).length = limit;
    rows.sort((a, b) => a.sequence - b.sequence);
    return { schema: 'sync-work-v1', sourceBoot, role, timeOrigin, clockDomain: 'performance-monotonic',
      from, to, rows, omitted, health: health(), coverage: 'explicit-sync-sites; no-await-lifetime; not-exclusive-cpu' };
  }
  return { run, enter, close, snapshot, health,
    configure({ enabled: value } = {}) { enabled = value === true; },
    freeze() {
      if (frozen !== null) { losses.freezeBusy++; return null; }
      // A scope spanning freeze remains explicitly open; refuse to rotate a
      // bank that still contains a live call from a prior generation.
      const next = 1 - active;
      if (stack.some(t => t.bank === next)) { losses.freezeBusy++; return null; }
      frozen = active; active = next;
      const b = banks[active]; b.count = 0; b.ids = ['']; b.index.clear(); b.evictions = 0;
      return ++freezeSeq;
    },
    release(id) { if (id !== freezeSeq || frozen === null) return false; frozen = null; return true; },
  };
}

module.exports = { createSyncWorkRing };
