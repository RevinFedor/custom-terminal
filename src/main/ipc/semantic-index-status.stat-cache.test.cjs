const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// Actual module + registered IPC handlers; real tiny files, inert external ports.
const filename = path.join(__dirname, 'semantic-index-status.js');
const source = fs.readFileSync(filename, 'utf8');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const dto = (fresh, stale = 0, neu = 0, removed = 0, indexedTotal = fresh + stale + removed, indexExists = true) =>
  ({ fresh, stale, new: neu, removed, indexExists, docsTotal: fresh + stale + neu, indexedTotal });

function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/noted-index-status-fixture-');
  const handlers = new Map(), timers = new Map(), watchers = [], processes = [], sent = [];
  const fds = new Map(), reads = [], indexReads = [], exit = new EventEmitter();
  const hook = {}, observations = [];
  let nextTimer = 0, bytesWritten = 0;
  const check = p => {
    if (typeof p === 'number') { assert.ok(fds.has(p), 'owned fd only'); return fds.get(p); }
    assert.ok(p === root || p.startsWith(root + path.sep), `private filesystem only: ${p}`);
    return p;
  };
  const io = {};
  for (const name of ['existsSync', 'readdirSync', 'statSync', 'fstatSync', 'openSync', 'closeSync', 'readFileSync']) {
    io[name] = (p, ...args) => {
      const full = check(p);
      if (name === 'readFileSync') {
        if (full.endsWith('.md')) reads.push(full);
        if (path.basename(full) === '.semantic-index.json') indexReads.push(full);
      }
      hook.before?.(name, full, args);
      const value = fs[name](p, ...args);
      if (name === 'openSync') fds.set(value, full);
      if (name === 'closeSync') fds.delete(p);
      hook.after?.(name, full, value);
      return value;
    };
  }
  io.watch = (p, options, callback) => {
    check(p);
    const w = { path: p, closed: false, callback, close() { this.closed = true; } };
    watchers.push(w);
    return w;
  };
  const write = (p, text) => {
    check(p);
    bytesWritten += Buffer.byteLength(text);
    assert.ok(bytesWritten < 256 * 1024, 'tiny fixture budget');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const server = path.join(root, 'inert-knowledge-port');
  write(server, '');
  const spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.requests = []; proc.killed = false;
    proc.stdin = { write: line => proc.requests.push(JSON.parse(line)), end() {} };
    proc.kill = () => { proc.killed = true; return true; };
    proc.finish = result => proc.stdout.emit('data', Buffer.from(JSON.stringify({ id: 2,
      result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }) + '\n'));
    processes.push(proc);
    return proc;
  };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports,
    require(name) {
      if (name === 'electron') return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
      if (name === 'fs') return io;
      if (name === 'os') return { homedir: () => root };
      if (name === 'path') return path;
      if (name === 'crypto') return crypto;
      if (name === 'child_process') return { spawn };
      if (name === '../child-process-env') return { buildChildProcessEnv: overrides => overrides };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env: { KNOWLEDGE_MCP_SERVER: server }, on: (...args) => exit.on(...args) },
    console: { log() {}, error() {} },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source, context, { filename });
  module.exports.register({ getMainWindow: () => ({ isDestroyed: () => false,
    webContents: { send: (channel, data) => sent.push({ channel, data: plain(data) }) } }) });
  const states = vm.runInContext('watchedProjects', context);
  const call = (name, args = {}) => plain(handlers.get(`semantic-index:${name}`)(null, { projectId: 'P', ...args }));
  const project = (name = 'project', docs = { 'docs/a.md': 'AAAA', 'docs/b.md': 'BBBB' }) => {
    const p = path.join(root, name);
    for (const [rel, body] of Object.entries(docs)) write(path.join(p, rel), body);
    write(path.join(p, '.semantic-index.json'), JSON.stringify(Object.entries(docs).map(([rel, body]) => ({ path: rel, hash: hash(body) }))));
    return p;
  };
  const observe = label => {
    const start = reads.length;
    const response = call('get-status');
    const entry = { label, bodyReads: reads.length - start, ...response };
    observations.push(entry);
    return entry;
  };
  t.after(() => {
    exit.emit('exit');
    for (const proc of processes) proc.emit('exit', 0, null);
    try {
      assert.equal(states.size, 0);
      assert.ok(watchers.every(w => w.closed), 'all inert watchers closed');
      assert.equal(timers.size, 0, 'no pending timers');
      assert.equal(fds.size, 0, 'no open files');
      t.diagnostic(JSON.stringify({ observations, totalBodyReads: reads.length, indexReads: indexReads.length, bytesWritten }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  return { root, hook, reads, sent, states, watchers, processes, call, project, write, observe,
    watch: p => call('watch', { projectPath: p }),
    flush() { for (const [id, timer] of [...timers]) if (timer.ms === 300) { timers.delete(id); timer.fn(); } },
  };
}

test('unchanged watch/get-status/debounce/rebuild share hashes; index is always current', async t => {
  const h = fixture(t), p = h.project();
  assert.deepEqual(h.watch(p), { success: true });
  assert.deepEqual(h.sent.at(-1).data, { projectId: 'P', ...dto(2) });
  assert.equal(h.reads.length, 2);
  const warm = h.observe('unchanged');
  assert.deepEqual(warm.status, dto(2));
  assert.equal(warm.bodyReads, 0, 'unchanged get-status must remove both doc body reads');
  h.watchers.find(w => w.path === path.join(p, 'docs')).callback('change', 'a.md');
  h.flush();
  assert.deepEqual(h.sent.at(-1).data, { projectId: 'P', ...dto(2) });
  assert.equal(h.reads.length, 2, 'unchanged watch push uses stat proof');
  h.write(path.join(p, '.semantic-index.json'), '[]');
  assert.deepEqual(h.observe('empty index').status, dto(0, 0, 2, 0, 0));
  h.write(path.join(p, '.semantic-index.json'), 'broken json');
  assert.deepEqual(h.observe('corrupt index').status, dto(0, 0, 2, 0, 0));
  fs.unlinkSync(path.join(p, '.semantic-index.json'));
  assert.deepEqual(h.observe('missing index').status, dto(0, 0, 2, 0, 0, false));
  assert.deepEqual(h.call('rebuild'), { success: true });
  assert.equal(h.observe('rebuild running').isRebuilding, true);
  assert.equal(h.reads.length, 2, 'rebuild pre-status does not reread unchanged docs');
  assert.equal(h.processes[0].requests[1].params.arguments.projectPath, p);
  h.write(path.join(p, '.semantic-index.json'), JSON.stringify([{ path: 'docs/a.md', hash: hash('AAAA') }]));
  h.processes[0].finish({ success: true, summary: 'Files indexed: 1/2 (cached: 1, skip: 0, warn: 0, err: 0)' });
  await Promise.resolve();
  h.flush();
  assert.deepEqual(h.observe('rebuild completed').status, dto(1, 0, 1, 0, 1));
  assert.equal(h.call('get-status').isRebuilding, false);
  assert.equal(h.reads.length, 2);
});

test('same-size/restored-mtime writes, inode replacement, additions and removals stay current', t => {
  const h = fixture(t), p = h.project(), a = path.join(p, 'docs/a.md');
  // Integer timestamp makes exact mtime restoration independent of Date precision.
  fs.utimesSync(a, 1000000000, 1000000000);
  h.watch(p);
  const before = fs.statSync(a, { bigint: true });
  h.write(a, 'CCCC'); fs.utimesSync(a, 1000000000, 1000000000);
  const after = fs.statSync(a, { bigint: true });
  assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  const changed = h.observe('same-size restored-mtime');
  assert.deepEqual(changed.status, dto(1, 1));
  assert.equal(changed.bodyReads, 1, 'only the changed doc is read');
  assert.equal(h.observe('unchanged stale doc').bodyReads, 0);
  const replacement = path.join(p, 'replacement');
  h.write(replacement, 'AAAA'); fs.utimesSync(replacement, 1000000000, 1000000000);
  fs.renameSync(replacement, a);
  assert.notEqual(fs.statSync(a, { bigint: true }).ino, after.ino);
  const replaced = h.observe('new inode');
  assert.deepEqual(replaced.status, dto(2)); assert.equal(replaced.bodyReads, 1);
  fs.unlinkSync(a);
  h.write(path.join(p, 'docs/nested/new.md'), 'NEW');
  const added = h.observe('removed and new');
  assert.deepEqual(added.status, dto(1, 0, 1, 1, 2)); assert.equal(added.bodyReads, 1);
  assert.equal(h.states.get('P').docHashes.size, 2, 'removed hashes are pruned');
  for (const entry of h.states.get('P').docHashes.values()) {
    assert.deepEqual(Object.keys(entry).sort(), ['hash', 'version']);
    assert.equal(entry.hash.length, 64, 'retain only digest and stat identity');
  }
  fs.rmSync(path.join(p, 'docs'), { recursive: true });
  assert.deepEqual(h.observe('docs directory gone').status, dto(0, 0, 0, 2, 2));
  assert.equal(h.states.get('P').docHashes.size, 0);
});

test('stat/read failures never reuse a cached hash and recover on the next status', t => {
  const h = fixture(t), p = h.project(), a = path.join(p, 'docs/a.md');
  h.watch(p);
  h.hook.before = (name, full) => {
    if (full === a && (name === 'statSync' || name === 'fstatSync')) throw new Error('synthetic stat failure');
  };
  const statError = h.observe('stat failure, readable doc');
  assert.deepEqual(statError.status, dto(2)); assert.equal(statError.bodyReads, 1);
  h.hook.before = undefined;
  assert.equal(h.observe('stat recovery rereads').bodyReads, 1);
  h.write(a, 'CCCC');
  h.hook.before = (name, full) => { if (name === 'readFileSync' && full === a) throw new Error('synthetic read failure'); };
  assert.deepEqual(h.observe('read failure').status, { ...dto(1, 0, 0, 0, 2), docsTotal: 2 });
  h.hook.before = undefined;
  const recovered = h.observe('read recovery');
  assert.deepEqual(recovered.status, dto(1, 1)); assert.equal(recovered.bodyReads, 1);
  assert.equal(h.observe('recovered warm').bodyReads, 0);
});

test('close failure discards the hash before publication and recovers without a leaked fd', t => {
  const h = fixture(t), p = h.project(), a = path.join(p, 'docs/a.md');
  h.watch(p);
  h.write(a, 'CCCC');
  let closeFailures = 0, cachedAtClose;
  h.hook.after = (name, full) => {
    if (name === 'closeSync' && full === a) {
      // The wrapper has already closed the real fd and removed it from fds.
      closeFailures += 1;
      cachedAtClose = h.states.get('P').docHashes.has(a);
      throw new Error('synthetic error after actual close');
    }
  };
  const failed = h.observe('close failure');
  h.hook.after = undefined;
  assert.equal(closeFailures, 1, 'do not retry close on a potentially reused fd');
  assert.equal(failed.bodyReads, 1);
  assert.deepEqual({ cachedAtClose, cachedAfter: h.states.get('P').docHashes.has(a), status: failed.status }, {
    cachedAtClose: false, cachedAfter: false, status: { ...dto(1, 0, 0, 0, 2), docsTotal: 2 },
  });
  const recovered = h.observe('close recovery');
  assert.deepEqual(recovered.status, dto(1, 1)); assert.equal(recovered.bodyReads, 1);
  assert.equal(h.observe('warm after close recovery').bodyReads, 0);
});

test('read/stat races cannot bind a hash to different file bytes', t => {
  const h = fixture(t), p = h.project(), a = path.join(p, 'docs/a.md');
  let once = true;
  h.hook.after = (name, full) => {
    if (once && name === 'readFileSync' && full === a) { once = false; h.write(a, 'CCCC'); }
  };
  h.watch(p); // A valid read snapshot, but changed before the post-read stat.
  h.hook.after = undefined;
  const changed = h.observe('write during hash');
  assert.deepEqual(changed.status, dto(1, 1)); assert.equal(changed.bodyReads, 1);
  assert.equal(h.observe('warm after race').bodyReads, 0);
  h.call('unwatch');
  const swapped = path.join(p, 'swap'); h.write(swapped, 'AAAA');
  once = true;
  h.hook.after = (name, full) => {
    if (once && name === 'readFileSync' && full === a) { once = false; fs.renameSync(swapped, a); }
  };
  h.watch(p); h.hook.after = undefined;
  const replaced = h.observe('rename during hash');
  assert.deepEqual(replaced.status, dto(2)); assert.equal(replaced.bodyReads, 1);
  assert.equal(h.observe('warm after replacement').bodyReads, 0);
});

test('repeated watch is ignored; explicit unwatch/rewatch discards hashes and retired publications', async t => {
  const h = fixture(t), p = h.project(), q = h.project('other', { 'docs/a.md': 'OTHER' });
  h.watch(p);
  const firstState = h.states.get('P');
  const firstWatchers = [...h.watchers];
  h.watch(p); assert.equal(h.reads.length, 2, 'same watch is idempotent');
  assert.deepEqual(h.call('rebuild'), { success: true });
  const sentBeforeRepeat = h.sent.length;
  h.watch(q);
  const ignored = h.observe('different path repeated watch ignored');
  assert.deepEqual(ignored.status, dto(2)); assert.equal(ignored.bodyReads, 0);
  assert.equal(ignored.isRebuilding, true);
  assert.equal(h.processes[0].killed, false, 'repeated watch must not kill the rebuild');
  assert.equal(h.states.get('P'), firstState);
  assert.equal(h.watchers.length, firstWatchers.length);
  assert.equal(h.sent.length, sentBeforeRepeat);
  h.call('unwatch');
  assert.deepEqual(h.call('get-status'), { success: false, error: 'Not watching' });
  assert.ok(firstWatchers.every(w => w.closed));
  assert.equal(h.processes[0].killed, true);
  h.watch(p); assert.equal(h.reads.length, 4, 'rewatch must build its own hashes');
  h.call('unwatch');
  h.watch(q);
  const switched = h.observe('explicit unwatch then watch different path');
  assert.deepEqual(switched.status, dto(1)); assert.equal(switched.bodyReads, 0);
  assert.equal(h.reads.length, 5);
  const sentCount = h.sent.length;
  h.processes[0].finish({ success: true });
  await Promise.resolve(); h.flush();
  assert.equal(h.sent.length, sentCount, 'late completion from old lifetime must not publish');
  firstWatchers[0].callback('change', '.semantic-index.json'); h.flush();
  assert.equal(h.sent.length, sentCount, 'retired watch callback must not publish');
});
