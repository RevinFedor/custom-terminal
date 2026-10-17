'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const MANIFEST = 'noted-test-run.v1.json';
const inside = (root, target) => target !== root && target.startsWith(root + path.sep);
const id = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 28);
const realDirectory = async value => {
  const stat = await fs.promises.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('test_run_not_physical_directory');
  return fs.promises.realpath(value);
};

// This is an accounting receipt, NOT a deletion lease or permission. It lives
// only inside the instance's own private tree; E2E never writes canonical data.
async function publishTestRun({ runRoot, userDataDir, codexHome, claudeHome, title = null }) {
  const root = await realDirectory(path.resolve(runRoot));
  const data = await realDirectory(path.resolve(userDataDir));
  const forbidden = await Promise.all([path.parse(root).root, os.homedir(), os.tmpdir(), '/private/tmp', '/tmp',
    path.join(os.homedir(), 'Desktop')].map(value => fs.promises.realpath(value).catch(() => path.resolve(value))));
  if (forbidden.includes(root) || !inside(root, data)) throw new Error('test_run_scope_not_private');
  const privatePath = async value => {
    if (!value) return null;
    try { const actual = await realDirectory(path.resolve(value)); return inside(root, actual) ? actual : null; }
    catch { return null; }
  };
  const receipt = { version: 1, kind: 'noted-test-run', root,
    title: title || path.basename(root), userDataDir: data,
    codexHome: await privatePath(codexHome), claudeHome: await privatePath(claudeHome) };
  const target = path.join(root, MANIFEST);
  let previous = null;
  try { previous = JSON.parse(await fs.promises.readFile(target, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && (previous.root !== root || previous.userDataDir !== data)) throw new Error('test_run_receipt_conflict');
  const scratch = target + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fs.promises.writeFile(scratch, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(scratch, target);
  } finally { await fs.promises.unlink(scratch).catch(() => {}); }
  return receipt;
}

async function publishCurrentTestRun({ userDataDir, canonicalUserDataDir, env = process.env }) {
  if (env.NOTED_E2E_TEST !== 'true' || !env.NOTED_E2E_CLI_ISOLATION_ROOT
    || path.resolve(userDataDir) === path.resolve(canonicalUserDataDir)) return null;
  const isolation = await realDirectory(path.resolve(env.NOTED_E2E_CLI_ISOLATION_ROOT));
  const data = await realDirectory(path.resolve(userDataDir));
  if (!inside(isolation, data)) return null;
  // Existing launchers use <run>/data/{user-data,codex-profile,...}. Do not
  // change launch flags, require per-tab marks, or inherit real CLI homes.
  const runRoot = /^(?:data|isolated-data)$/.test(path.basename(isolation)) || isolation === data ? path.dirname(isolation) : isolation;
  return publishTestRun({ runRoot, userDataDir: data, codexHome: env.CODEX_HOME,
    claudeHome: env.CLAUDE_CONFIG_DIR });
}

function ownsPrivateTestProfile({ profile, userDataDir, codexHome, claudeHome, e2e }) {
  if (e2e !== true || !profile?.codexHome || !profile?.claudeHome) return false;
  try {
    const root = fs.realpathSync(profile.root);
    const privateDirectory = (base, name) => {
      const target = path.join(base, name);
      try { return fs.realpathSync(target).startsWith(base + path.sep); }
      catch (error) { return error.code === 'ENOENT'; }
    };
    // A private directory with a symlinked state.sqlite is not a private
    // provider. It could mutate the original catalog even if rollouts copied.
    for (const base of [profile.userDataDir, profile.codexHome]) {
      for (const entry of fs.readdirSync(base, {withFileTypes:true})) {
        if (!/\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/.test(entry.name)) continue;
        const file = path.join(base, entry.name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !fs.realpathSync(file).startsWith(root + path.sep)) return false;
      }
    }
    return fs.realpathSync(userDataDir) === profile.userDataDir
      && fs.realpathSync(codexHome) === profile.codexHome
      && fs.realpathSync(claudeHome) === profile.claudeHome
      && [profile.userDataDir, profile.codexHome, profile.claudeHome]
        .every(value => value.startsWith(root + path.sep))
      && privateDirectory(profile.codexHome, 'sessions') && privateDirectory(profile.codexHome, 'archived_sessions')
      && privateDirectory(profile.claudeHome, 'projects');
  } catch { return false; }
}

async function discoverTestRuns({ roots = ['/private/tmp', os.tmpdir()], maxEntries = 8000 } = {}) {
  const runs = [], seen = new Set(), queue = [];
  for (const root of roots.filter(Boolean)) {
    try { queue.push({ dir: await fs.promises.realpath(root), depth: 0 }); } catch {}
  }
  let examined = 0, directories = 0;
  // The OS temp directory can contain >10k ordinary files. Counting those
  // against the traversal budget before visiting ANY child hid every run.
  // Bound visited directories instead; readdir names are not payload reads.
  while (queue.length && directories < maxEntries) {
    const { dir, depth } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    directories += 1;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    examined += entries.length;
    const manifest = entries.find(entry => entry.name === MANIFEST && entry.isFile());
    if (manifest) {
      try {
        const file = path.join(dir, MANIFEST), stat = await fs.promises.stat(file);
        if (stat.size > 16_384) continue;
        const value = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        if (value.version === 1 && value.kind === 'noted-test-run' && value.root === dir
          && inside(dir, value.userDataDir) && await realDirectory(value.userDataDir) === value.userDataDir) {
          runs.push(value); continue;
        }
      } catch { /* Unknown or stale receipt is not authority. */ }
    }
    if (depth >= 4) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      // Bounded discovery, never walk source/dependencies/browser profiles or
      // infer a test run merely because its directory happens to say "test".
      if (!/^(?:noted-|custom-terminal|startup\d|runtime\d|retake\d|data$|isolated-data$|user-data$|test-artifacts$)/.test(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return { runs, complete: queue.length === 0, examined, directories };
}

function usage(root) {
  return new Promise((resolve, reject) => execFile('/usr/bin/du', ['-Psk', root],
    { timeout: 30_000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(Number(stdout.trim().split(/\s+/)[0]) * 1024);
    }));
}

async function scanTestRuns(options = {}) {
  const discovery = await discoverTestRuns(options), items = [], warnings = [];
  for (const run of discovery.runs.slice(0, 32)) {
    try {
      const total = await usage(run.root);
      const buckets = { database: 0, conversations: 0, application: 0 };
      const pending = [run.root]; let visited = 0;
      while (pending.length) {
        const dir = pending.pop();
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (++visited > 100_000) throw new Error('test_run_accounting_entry_limit');
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (entry.name.endsWith('.app')) buckets.application += await usage(full);
            else if (!['node_modules', '.git'].includes(entry.name)) pending.push(full);
          } else if (entry.isFile()) {
            const stat = await fs.promises.stat(full);
            const allocated = Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
            if (/\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/.test(entry.name)) buckets.database += allocated;
            else if (entry.name.endsWith('.jsonl') && /\/(?:sessions|archived_sessions|projects)\//.test(full)) buckets.conversations += allocated;
          }
        }
      }
      const counted = Object.values(buckets).reduce((a, b) => a + b, 0);
      buckets.other = Math.max(0, total - counted);
      if (counted > total) warnings.push({ root: run.root, reason: 'concurrent-accounting-change' });
      const labels = { database: 'Databases', conversations: 'Conversations', application: 'Application builds', other: 'Cache, sources & evidence' };
      for (const [component, sizeBytes] of Object.entries(buckets)) {
        if (!sizeBytes) continue;
        const stat = await fs.promises.stat(run.root);
        items.push({ id: id(run.root + ':' + component), section: 'test-runs', group: 'test-run',
          title: run.title + ' · ' + labels[component], project: run.title, cwd: run.root, path: run.root,
          testRunRoot: run.root, component, sizeBytes, modifiedAt: stat.mtimeMs, createdAt: stat.birthtimeMs,
          provider: null, sessionId: null, notedTerminal: true, protected: true, deletable: false,
          protectedReason: 'Test profile accounting. A stopped instance can still be needed for unfinished work; no whole-profile delete.',
          eligible: false, deleteAfter: null });
      }
    } catch (error) { warnings.push({ root: run.root, reason: error.message }); }
  }
  return { items, complete: discovery.complete && discovery.runs.length <= 32 && warnings.length === 0, warnings };
}

module.exports = { MANIFEST, publishTestRun, publishCurrentTestRun, ownsPrivateTestProfile, discoverTestRuns, scanTestRuns };
