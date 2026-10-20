// PREPARATION ONLY. Never quits, swaps or launches an installed application.
// Preserve every installed renderer/runtime byte except these five Main files.
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAppBundle } from './build-install-noted-terminal.mjs';
const require = createRequire(import.meta.url), asar = require('@electron/asar'), exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = '/Applications/Noted Terminal.app';
const files = ['src/main/orchestration-runs.js', 'src/main/web-server.js', 'src/main/external-research-operational.js',
  'src/main/external-research-operational-delivery.js', 'src/main/external-research-maintenance.js'];
const sha = value => createHash('sha256').update(value).digest('hex');
async function fileSha(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function entries(header, prefix = '', result = new Map()) {
  for (const [name, node] of Object.entries(header.files || {})) {
    const key = prefix ? prefix + '/' + name : name;
    if (node.files) entries(node, key, result); else result.set(key, node);
  }
  return result;
}
async function finalize(result, root) {
  if (path.resolve(path.dirname(result.candidateApp || '')) !== path.resolve(root)
    || path.basename(result.candidateApp || '') !== 'Noted Terminal.app') throw Error('candidate must belong to its exact prepared root');
  const archive = path.join(installed, 'Contents/Resources/app.asar');
  if (await fileSha(archive) !== result.baselineAsarSha256) throw Error('installed baseline changed before finalization');
  const candidateArchive = path.join(result.candidateApp, 'Contents/Resources/app.asar');
  if (await fileSha(candidateArchive) !== result.expectedAsarSha256) throw Error('prepared candidate changed before finalization');
  // Electron authenticates the ASAR HEADER through Info.plist as well as the
  // ordinary macOS signature. Repacking must update both, never disable fuses.
  const { computeData } = require('app-builder-lib/out/asar/integrity');
  const integrity = await computeData({ resourcesPath: path.join(result.candidateApp, 'Contents/Resources'), resourcesRelativePath: 'Resources' });
  const headerHash = integrity['Resources/app.asar']?.hash;
  if (!/^[a-f0-9]{64}$/.test(headerHash || '')) throw Error('ASAR header integrity unavailable');
  const plist = path.join(result.candidateApp, 'Contents/Info.plist');
  await exec('/usr/libexec/PlistBuddy', ['-c', 'Set :ElectronAsarIntegrity:Resources/app.asar:hash ' + headerHash, plist]);
  await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', 'Noted Terminal Dev', '--timestamp=none', result.candidateApp]);
  await validateAppBundle(result.candidateApp);
  const actual = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :ElectronAsarIntegrity:Resources/app.asar:hash', plist])).stdout.trim();
  if (actual !== headerHash) throw Error('Electron ASAR header identity mismatch');
  for (const pin of result.sourcePins) if (await fileSha(path.join(project, pin.path)) !== pin.sha256) throw Error('Source changed before finalization: ' + pin.path);
  result.electronAsarHeaderSha256 = headerHash;
  result.signatureVerified = true;
  await fs.writeFile(path.join(root, 'PREPARED.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log('[NotedQuietCandidate] READY ' + JSON.stringify({ root, asar: result.expectedAsarSha256, changed: result.changed.length, unchanged: result.unchangedEntries, headerVerified: true }));
}
async function main() {
  if (process.argv[2] === '--finalize') {
    const file = process.argv[3];
    if (!path.isAbsolute(file || '') || path.basename(file) !== 'PREPARED.json') throw Error('exact PREPARED.json required');
    return finalize(JSON.parse(await fs.readFile(file, 'utf8')), path.dirname(file));
  }
  const [parent, expectedBaseline] = process.argv.slice(2);
  if (!path.isAbsolute(parent || '') || !/^[a-f0-9]{64}$/.test(expectedBaseline || '')) throw Error('Usage: prepare-noted-maintenance-candidate.mjs <absolute-artifact-parent> <exact-installed-ASAR-SHA>');
  const archive = path.join(installed, 'Contents/Resources/app.asar');
  if (await fileSha(archive) !== expectedBaseline) throw Error('installed ASAR changed before preparation');
  const root = await fs.mkdtemp(path.join(parent, 'noted-quiet-candidate-'));
  const candidateApp = path.join(root, 'Noted Terminal.app'), snapshot = path.join(root, 'snapshot');
  const oldEntries = entries(asar.getRawHeader(archive).header);
  const sourcePins = await Promise.all(files.map(async file => ({ path: file, sha256: await fileSha(path.join(project, file)) })));
  console.log('[NotedQuietCandidate] preparing installed baseline at ' + root);
  await exec('/usr/bin/ditto', [installed, candidateApp]);
  await fs.mkdir(snapshot);
  asar.extractAll(archive, snapshot);
  // Verbatim bulk copy of already tested Source postimages into the frozen
  // build input; no compilation of unrelated CURRENT renderer/Source work.
  for (const file of files) await fs.copyFile(path.join(project, file), path.join(snapshot, file));
  const unpacked = [...oldEntries].filter(([, node]) => node.unpacked).map(([file]) => path.join(snapshot, file));
  const repacked = path.join(root, 'prepared.asar');
  await asar.createPackageWithOptions(snapshot, repacked, { unpack: unpacked.length ? '{' + unpacked.join(',') + '}' : undefined });
  const newEntries = entries(asar.getRawHeader(repacked).header), changed = [], unexpected = [];
  for (const key of new Set([...oldEntries.keys(), ...newEntries.keys()])) {
    const before = oldEntries.get(key), after = newEntries.get(key);
    const same = before && after && before.size === after.size && before.integrity?.hash === after.integrity?.hash
      && before.link === after.link && !!before.unpacked === !!after.unpacked;
    if (same) continue;
    if (!files.includes(key) || !after || after.unpacked || after.link) unexpected.push(key);
    else changed.push({ path: key, preimage: before?.integrity?.hash || null, postimage: after.integrity.hash, bytes: after.size });
  }
  if (unexpected.length || changed.length !== files.length) throw Error('non-maintenance ASAR differences: ' + JSON.stringify({ unexpected, changed }));
  // All unpacked leaves are unchanged, so retain the installed app's exact
  // unpacked tree. validateAppBundle independently hashes it again below.
  await fs.rename(repacked, path.join(candidateApp, 'Contents/Resources/app.asar'));
  for (const pin of sourcePins) if (await fileSha(path.join(project, pin.path)) !== pin.sha256) throw Error('Source changed during preparation: ' + pin.path);
  if (await fileSha(archive) !== expectedBaseline) throw Error('installed baseline changed during preparation');
  const result = { version: 1, state: 'pending', candidateApp, baselineAsarSha256: expectedBaseline,
    expectedAsarSha256: await fileSha(path.join(candidateApp, 'Contents/Resources/app.asar')), sourcePins,
    changed, unchangedEntries: oldEntries.size - changed.filter(x => x.preimage).length,
    originalEntries: oldEntries.size, candidateEntries: newEntries.size, rendererUnchanged: true,
    sourceGraph: 'installed ASAR plus exactly five operational-maintenance Main postimages', snapshot,
    installPerformed: false, retainedReason: 'pending external same-cut installer and frozen Source acceptance' };
  await finalize(result, root);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('[NotedQuietCandidate] ' + error.stack); process.exitCode = 1; });
