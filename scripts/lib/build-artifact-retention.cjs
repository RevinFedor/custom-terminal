'use strict';

// Developer artifacts only. Never enumerate transcripts, databases, media,
// user profiles or the installed applications as cleanup candidates.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { StorageDeletionAudit } = require('../../src/main/storage-deletion-audit');
const exec = promisify(execFile);
const DAY = 86400000;
const MARKER = '.build-artifact-state.json';
const SKIP = new Set(['src', 'source', 'source-snapshot', 'snapshots', 'home', 'profile', 'storage', 'logs', 'node_modules', '.git']);

function allowedRoot(root) {
  return /\/(?:Library\/Application Support\/(?:sc-desktop|voice-record)|Desktop\/voice-record)\/test-artifacts\/[^/]+(?:\/.*)?$/.test(root) ||
    /\/Library\/Application Support\/sc-desktop\/(?:vocabulary-[^/]+|app-backups|study-[^/]*deploy-[^/]+)(?:\/.*)?$/.test(root);
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function identity(target) {
  const s = await fs.promises.lstat(target);
  if (s.isSymbolicLink() || !s.isDirectory() || await fs.promises.realpath(target) !== target) {
    throw new Error('Artifact must be an exact non-symlink directory: ' + target);
  }
  return { dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs };
}
async function exists(target) {
  try { await fs.promises.lstat(target); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function readMarker(root) {
  try {
    const file = path.join(root, MARKER);
    const s = await fs.promises.lstat(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 65536) throw new Error('Invalid artifact marker');
    const value = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (value.version !== 1 || value.type !== 'generated-build-artifacts') throw new Error('Unknown artifact marker');
    return value;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function markerToken(value) { return value ? crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') : null; }
async function bundleStamp(file) {
  const s = await fs.promises.stat(path.join(file, 'Contents/Resources/app.asar'));
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
}
async function writeMarker(root, value) {
  const temporary = path.join(root, MARKER + '.' + crypto.randomUUID() + '.tmp');
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporary, path.join(root, MARKER));
  } finally { await fs.promises.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function completionReceipt(dir) {
  const file = path.join(dir, 'installed.json');
  try {
    const s = await fs.promises.lstat(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 65536) return false;
    const r = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    const hashes = [r.asar, r.sha, ...Object.values(r.apps || {}).map(app => app?.sha || app?.asar)];
    return Number.isFinite(r.installedAt) && r.installedAt > 0 && hashes.some(h => /^[a-f0-9]{64}$/.test(h || ''));
  } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function deploymentParent(root, file) {
  let dir = path.dirname(file);
  if (/^(candidate|backup|retired|backup-.+|retired-.+|installed-before-.+|installed-retired-.+)$/.test(path.basename(dir))) dir = path.dirname(dir);
  return dir === root || within(root, dir) ? dir : root;
}
async function markPrepared(root, source) {
  root = path.resolve(root);
  if (!allowedRoot(root)) throw new Error('Not a configured developer artifact root');
  await identity(root);
  const old = await readMarker(root);
  const value = { version: 1, type: 'generated-build-artifacts', status: 'prepared', source,
    createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() };
  await writeMarker(root, value);
  return value;
}
function namedDate(name) {
  const match = name.match(/(?:^|[^\d])(20\d{2})-?(\d{2})-?(\d{2})(?:[^\d]|$)/);
  if (!match) return null;
  const value = Date.parse(match[1] + '-' + match[2] + '-' + match[3] + 'T23:59:59.999Z');
  return Number.isFinite(value) ? value : null;
}
function auditFor(home = os.homedir()) {
  return new StorageDeletionAudit({ filePath: path.join(home, 'Library/Application Support/noted-terminal/storage-deletion-audit.jsonl') });
}
async function references() {
  const [ps, lsof] = await Promise.all([
    exec('/bin/ps', ['-axo', 'pid,ppid,command'], { maxBuffer: 16 * 1024 * 1024, timeout: 12000 }),
    exec('/usr/sbin/lsof', ['-nP', '-F', 'pn'], { maxBuffer: 64 * 1024 * 1024, timeout: 12000 }),
  ]);
  const own = new Set([process.pid, process.ppid]);
  const commands = ps.stdout.split('\n').flatMap(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return m && !own.has(Number(m[1])) ? [m[3]] : [];
  });
  return { commands, paths: lsof.stdout.split('\n').filter(line => line[0] === 'n').map(line => line.slice(1)) };
}
function inUse(target, refs) {
  return refs.paths.some(p => p === target || p.startsWith(target + path.sep)) ||
    refs.commands.some(command => command.includes(target));
}
async function applyTargets(targets, { audit = auditFor(), probe = references, operationId = 'build-artifacts-' + crypto.randomUUID(), source = 'automatic-build-cleanup' } = {}) {
  let refs = await probe(); // A broken probe is a refusal, never "nothing is running".
  const removed = [], skipped = [];
  let referenceRoot = null, consultations = 0;
  for (const target of targets) {
    const root = path.resolve(target.root), file = path.resolve(target.path);
    if (!allowedRoot(root) || !within(root, file) || !['app-bundle', 'unpacked-app', 'private-build'].includes(target.kind)) {
      throw new Error('Forbidden cleanup scope: ' + file);
    }
    await identity(root);
    if (referenceRoot !== root || consultations >= 10) {
      refs = await probe(); referenceRoot = root; consultations = 0;
    }
    consultations++;
    const state = await readMarker(root);
    if (target.kind !== 'private-build' && state && state.status !== 'verified') {
      skipped.push({ path: file, reason: 'prepared-or-unverified' }); continue;
    }
    if (Object.prototype.hasOwnProperty.call(target, 'markerToken') && markerToken(state) !== target.markerToken) {
      throw new Error('Artifact generation changed: ' + root);
    }
    if (inUse(file, refs) || inUse(root, refs)) { skipped.push({ path: file, reason: 'in-use' }); continue; }
    const current = await identity(file);
    if (current.dev !== target.dev || current.ino !== target.ino) throw new Error('Artifact identity changed: ' + file);
    if (target.kind === 'app-bundle' && (!file.endsWith('.app') || !await exists(path.join(file, 'Contents/Info.plist')) || !await exists(path.join(file, 'Contents/Resources/app.asar')))) {
      throw new Error('Unproven application bundle: ' + file);
    }
    if (target.bundleStamp && JSON.stringify(await bundleStamp(file)) !== JSON.stringify(target.bundleStamp)) throw new Error('Package contents changed: ' + file);
    if (target.kind === 'unpacked-app' && (path.basename(file) !== 'contents' || !await exists(path.join(file, 'package.json')))) {
      throw new Error('Unproven unpacked application: ' + file);
    }
    if (target.kind === 'private-build' && (path.basename(file) !== 'dist' || (await readMarker(root))?.source !== 'translator-private-build')) {
      throw new Error('Unproven private build: ' + file);
    }
    const event = { operationId, source, kind: target.kind, path: file, provider: null, sessionId: null };
    await audit.record({ ...event, status: 'attempt' });
    // Repeat after the awaited audit write; a concurrent replacement must survive.
    const before = await identity(file);
    if (before.dev !== target.dev || before.ino !== target.ino) throw new Error('Artifact replaced before deletion: ' + file);
    const stateBefore = await readMarker(root);
    if (markerToken(stateBefore) !== markerToken(state)) throw new Error('Artifact generation changed during audit');
    if (target.bundleStamp && JSON.stringify(await bundleStamp(file)) !== JSON.stringify(target.bundleStamp)) throw new Error('Package changed during audit');
    await fs.promises.rm(file, { recursive: true, force: false });
    await audit.record({ ...event, status: 'removed' });
    removed.push(file);
  }
  return { operationId, removed, skipped };
}

async function configuredGroups(home = os.homedir()) {
  const support = path.join(home, 'Library/Application Support');
  const sc = path.join(support, 'sc-desktop');
  const parents = [path.join(sc, 'test-artifacts'), path.join(support, 'voice-record/test-artifacts'), path.join(home, 'Desktop/voice-record/test-artifacts')];
  const groups = [];
  for (const parent of parents) {
    if (!await exists(parent)) continue;
    await identity(parent);
    for (const e of await fs.promises.readdir(parent, { withFileTypes: true })) {
      if (e.isDirectory() && !e.isSymbolicLink()) groups.push(path.join(parent, e.name));
    }
  }
  if (await exists(sc)) {
    await identity(sc);
    for (const e of await fs.promises.readdir(sc, { withFileTypes: true })) {
      if (e.isDirectory() && !e.isSymbolicLink() &&
        (/^vocabulary-(?:app-backup-|controls-|russian-editorial-|refresh-|personalization-)/.test(e.name) || e.name === 'app-backups' || /^study-.*deploy-/.test(e.name))) {
        groups.push(path.join(sc, e.name));
      }
    }
  }
  return groups;
}
async function planOldArtifacts({ home = os.homedir(), now = Date.now(), minAgeMs = 2 * DAY, beforeDate, preserve = [], keepRoots = [] } = {}) {
  const groups = await configuredGroups(home), targets = [], skipped = [];
  const cutoff = beforeDate ? Date.parse(beforeDate + 'T00:00:00Z') : now - minAgeMs;
  if (!Number.isFinite(cutoff)) throw new Error('Invalid cleanup cutoff');
  const protectedPaths = preserve.map(p => path.resolve(p));
  const rollbacks = new Map();
  // Keep two newest rollback bundles per product across roots, not one in
  // every historical deployment. Folder timestamps are not app identity.
  async function rollbackWalk(root, dir, generation, depth = 0) {
    if (depth > 8) return;
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const file = path.join(dir, e.name);
      if (e.name.endsWith('.app')) {
        if (!/backup|retired|before/i.test(path.relative(root, file)) || !await exists(path.join(file, 'Contents/Resources/app.asar'))) continue;
        let product;
        try { product = (await exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(file, 'Contents/Info.plist')])).stdout.trim(); }
        catch { protectedPaths.push(file); continue; }
        if (!product) { protectedPaths.push(file); continue; }
        const id = await identity(file);
        const stamp = namedDate(path.relative(root, file)) || generation;
        const list = rollbacks.get(product) || [];
        list.push({ path: file, stamp, birthtime: id.birthtimeMs });
        rollbacks.set(product, list);
      } else if (!SKIP.has(e.name) && e.name !== 'contents') await rollbackWalk(root, file, generation, depth + 1);
    }
  }
  for (const root of groups) {
    const marker = await readMarker(root);
    const id = await identity(root);
    await rollbackWalk(root, root, marker?.updatedAt || namedDate(path.basename(root)) || id.birthtimeMs);
  }
  for (const list of rollbacks.values()) {
    list.sort((a, b) => b.stamp - a.stamp || b.birthtime - a.birthtime);
    protectedPaths.push(...list.slice(0, 2).map(item => item.path));
  }
  for (const root of groups) {
    if (keepRoots.some(p => path.resolve(p) === root)) continue;
    const marker = await readMarker(root);
    // Prepared packages remain resumable; an old directory name is not expiry.
    if (marker && marker.status !== 'verified') { skipped.push({ path: root, reason: 'prepared-or-unverified' }); continue; }
    const id = await identity(root);
    const createdAt = marker?.updatedAt || namedDate(path.basename(root)) || id.birthtimeMs;
    if (!createdAt || createdAt >= cutoff) continue;
    async function walk(dir, depth, ownerRoot = root, token = markerToken(marker)) {
      if (depth > 8) return;
      if (dir !== root) {
        const nested = await readMarker(dir);
        if (nested) {
          if (nested.status !== 'verified' || nested.updatedAt >= cutoff) { skipped.push({ path: dir, reason: 'prepared-or-recent-generation' }); return; }
          ownerRoot = dir; token = markerToken(nested);
        }
      }
      for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink() || !e.isDirectory()) continue;
        const file = path.join(dir, e.name);
        if (protectedPaths.some(p => file === p || within(file, p))) continue;
        if (e.name.endsWith('.app')) {
          if (await exists(path.join(file, 'Contents/Info.plist')) && await exists(path.join(file, 'Contents/Resources/app.asar'))) {
            // Automatic expiry needs completion proof. Manual --before is the
            // explicitly authorized legacy migration, not a heuristic for a
            // newly prepared package that lacks installed.json.
            if (!beforeDate && !token && !await completionReceipt(deploymentParent(root, file))) continue;
            const item = await identity(file);
            targets.push({ root: ownerRoot, path: file, kind: 'app-bundle', dev: item.dev, ino: item.ino,
              markerToken: token, bundleStamp: await bundleStamp(file) });
          }
          continue;
        }
        if (e.name === 'contents' && await exists(path.join(file, 'package.json')) &&
          (await exists(path.join(dir, 'candidate.json')) || await exists(path.join(dir, 'installed.json')))) {
          if (!beforeDate && !token && !await completionReceipt(dir)) continue;
          const item = await identity(file);
          targets.push({ root: ownerRoot, path: file, kind: 'unpacked-app', dev: item.dev, ino: item.ino, markerToken: token });
          continue;
        }
        if (!SKIP.has(e.name)) await walk(file, depth + 1, ownerRoot, token);
      }
    }
    await walk(root, 0);
  }
  return { version: 1, cutoff: new Date(cutoff).toISOString(), targets, skipped };
}

async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function cleanupVerifiedDeployment({ root, candidate, contents, retired, backup, installedApp, expectedAsar, audit, probe }) {
  root = path.resolve(root);
  if (!allowedRoot(root)) throw new Error('Not a configured developer artifact root');
  const asar = path.join(installedApp, 'Contents/Resources/app.asar');
  if (!/^[a-f0-9]{64}$/.test(expectedAsar || '') || await fileHash(asar) !== expectedAsar) throw new Error('Installed package proof changed; keep all artifacts');
  if (!backup || !within(root, path.resolve(backup))) throw new Error('A proven rollback must remain in this deployment');
  await identity(path.resolve(backup));
  const value = { version: 1, type: 'generated-build-artifacts', status: 'verified', updatedAt: Date.now(), installedAsar: expectedAsar, rollback: backup };
  await writeMarker(root, value);
  const targets = [];
  for (const [kind, file] of [['app-bundle', candidate], ['unpacked-app', contents], ['app-bundle', retired]]) {
    if (!file || !await exists(file)) continue;
    if (!within(root, path.resolve(file)) || path.resolve(file) === path.resolve(backup)) throw new Error('Invalid completed deployment artifact');
    const id = await identity(path.resolve(file));
    targets.push({ root, path: path.resolve(file), kind, dev: id.dev, ino: id.ino, markerToken: markerToken(value),
      ...(kind === 'app-bundle' ? { bundleStamp: await bundleStamp(file) } : {}) });
  }
  const result = await applyTargets(targets, { audit, probe, source: 'verified-deployment-cleanup' });
  return result;
}
async function cleanupPrivateBuild(root, { audit, probe } = {}) {
  root = path.resolve(root);
  const marker = await readMarker(root);
  if (!marker || marker.source !== 'translator-private-build') return { removed: [], skipped: [{ path: root, reason: 'unproven-private-build' }] };
  const dir = path.join(root, 'dist');
  if (!await exists(dir)) return { removed: [], skipped: [] };
  const id = await identity(dir);
  return applyTargets([{ root, path: dir, kind: 'private-build', dev: id.dev, ino: id.ino }], { audit, probe, source: 'closed-private-test-cleanup' });
}

module.exports = { DAY, MARKER, within, allowedRoot, namedDate, identity, references, auditFor, applyTargets,
  configuredGroups, planOldArtifacts, markPrepared, cleanupVerifiedDeployment, cleanupPrivateBuild };
