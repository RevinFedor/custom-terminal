import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ELECTRON_ABI, ELECTRON_VERSION, LOADER_SHA, PTY_MARKER, PTY_VERSION, inspectMachO, sha256 } from './node-pty-binary.mjs';

// ordinary-runtime/candidate, 2026-10-13: the exact two-file repair, plus a
// compile-time private marker. No runtime probes, TSFN rewrite or new JS API.
const originalGyp = '60087f9bc86f372a5ad49d15d7854140c29fac959aaa1fb2c8ffd0dc021595dd';
const candidateGyp = '911f13eb706ef6af9ac8f78c1e3558f17ce90e705d0ee17eb3a4d0e19f28da25';
const originalPty = '19210adfdaba3cd09809b56bb3281b14e74a8e5efc1f35d467d3c423c30856db';
const candidatePty = '8e1a7918403a6995655affc6b374e4e7604e60b1c52e3eacfa1876f41200323b';
export const MARKER_SOURCE = `\n#if defined(__APPLE__) && defined(NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS)\n// Packaging proof only; internal linkage, no runtime API.\n__attribute__((used, section("__TEXT,__noted_pty")))\nstatic const char noted_pty_build_marker[] = "${PTY_MARKER}";\n#endif\n`;
const sourceHashes = {
  'package.json': '68e1b916e13e114ff2f1b52043f496e7bd2cf5ba4289f09f79c0a798e9341172',
  'src/unix/spawn-helper.cc': '22195de1710b574d5904fc89be5624c25e531de20d5e17e5998a2fd19d86e0e6',
  'lib/utils.js': LOADER_SHA,
};
const addonTreeSHA = 'd9647bf848ed95a82d070b84da1df74a27d8f909248b243872acc970691e7a0a';
const drift = text => { throw new Error('[node-pty] ' + text + '; review the pinned patch/toolchain before rebuilding. Nothing may be installed.'); };

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) drift('exact patch context mismatch');
  return text.replace(before, after);
}

export function patchSources(gyp, pty) {
  if (sha256(gyp) === originalGyp) {
    const anchor = "          'ldflags': [],\n          'conditions': [\n";
    gyp = replaceOnce(gyp, anchor, anchor + "            ['OS==\"mac\"', { 'defines': ['NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS'] }],\n");
  }
  if (sha256(gyp) !== candidateGyp) drift('binding.gyp SHA drift');
  // Reapplying to this exact prepared copy is a no-op. Arbitrary patched input
  // still fails the candidate SHA below.
  if (pty.endsWith(MARKER_SOURCE)) pty = pty.slice(0, -MARKER_SOURCE.length);
  if (sha256(pty) === originalPty) {
    pty = replaceOnce(pty, '#include <thread>\n', '#include <thread>\n#include <memory>\n');
    pty = replaceOnce(pty,
      '    auto callback = [](Napi::Env env, Napi::Function cb, ExitEvent *exit_event) {\n',
      '    auto callback = [](Napi::Env env, Napi::Function cb, ExitEvent *raw) {\n      // Preserve exit delivery; release this payload even if the JS call throws.\n      std::unique_ptr<ExitEvent> exit_event(raw);\n');
    pty = replaceOnce(pty, '      delete exit_event;\n', '');
    pty = replaceOnce(pty, '      case napi_closing:\n        break;',
      '      case napi_closing:\n        delete exit_event; // The call did not enqueue or transfer ownership.\n        break;');
  }
  if (sha256(pty) !== candidatePty) drift('src/unix/pty.cc SHA drift');
  return { gyp, pty: pty + MARKER_SOURCE };
}

async function readRegular(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) drift('expected regular file ' + file);
  return fs.readFile(file);
}

async function readTree(root, prefix = '', files = {}) {
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) await readTree(root, relative, files);
    else files[relative] = await readRegular(path.join(root, relative));
  }
  return files;
}

// Returns a frozen input snapshot. Only this snapshot is copied to scratch;
// no symlink back to the project's dependencies/build/cache is introduced.
export async function readInputs(ptyDir) {
  for (const dir of [ptyDir, path.join(ptyDir, 'node_modules/node-addon-api')]) {
    if (!(await fs.lstat(dir)).isDirectory()) drift('expected real source directory ' + dir);
  }
  const files = {};
  for (const [name, hash] of Object.entries(sourceHashes)) {
    files[name] = await readRegular(path.join(ptyDir, name));
    if (sha256(files[name]) !== hash) drift(name + ' version/source SHA drift');
  }
  const gyp = (await readRegular(path.join(ptyDir, 'binding.gyp'))).toString();
  const pty = (await readRegular(path.join(ptyDir, 'src/unix/pty.cc'))).toString();
  // Installed sources must stay pristine. Patching is exclusively in scratch.
  if (sha256(gyp) !== originalGyp || sha256(pty) !== originalPty) drift('installed node-pty sources are not the pinned originals');
  const patched = patchSources(gyp, pty);
  files['binding.gyp'] = Buffer.from(patched.gyp);
  files['src/unix/pty.cc'] = Buffer.from(patched.pty);
  const addon = await readTree(path.join(ptyDir, 'node_modules/node-addon-api'));
  const hashes = Object.fromEntries(Object.keys(addon).sort().map(name => [name, sha256(addon[name])]));
  if (sha256(JSON.stringify(hashes)) !== addonTreeSHA) drift('nested node-addon-api 7.1.1 tree SHA drift');
  for (const [name, bytes] of Object.entries(addon)) files['node_modules/node-addon-api/' + name] = bytes;
  return files;
}

async function ensureRealDirectory(dir) {
  await fs.mkdir(dir, { recursive: true });
  // Canonicalize the parent (macOS /tmp itself is a symlink), but reject a
  // symlink at the publication boundary or in its build/Release descendants.
  if (!(await fs.lstat(dir)).isDirectory()) drift('publication directory is not a real directory: ' + dir);
}

export async function atomicPublish(file, bytes, mode = 0o644) {
  let current;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) drift('publication target is not a regular file: ' + file);
    current = await fs.readFile(file);
    if (current.equals(bytes) && (stat.mode & 0o777) === mode) return false;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await fs.mkdtemp(path.join(path.dirname(file), '.noted-pty-publish-'));
  try {
    const staged = path.join(staging, 'file');
    const handle = await fs.open(staged, 'wx', mode);
    try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
    finally { await handle.close(); }
    // Same-filesystem rename replaces the directory entry, never truncates a
    // mapped inode. Old live processes keep their original bytes.
    await fs.rename(staged, file);
    return true;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

export async function rebuildNodePty({ projectDir, electronVersion, arch, platform = process.platform }, {
  rebuild, scratchParent = tmpdir(),
} = {}) {
  if (platform !== 'darwin' || electronVersion !== ELECTRON_VERSION || !['arm64', 'x64'].includes(arch)) {
    drift('unsupported target ' + platform + '/' + arch + '/Electron ' + electronVersion);
  }
  const ptyDir = path.join(projectDir, 'node_modules/node-pty');
  const files = await readInputs(ptyDir); // fail before rebuild or publication
  const scratch = await fs.mkdtemp(path.join(scratchParent, 'noted-pty-build-'));
  try {
    const moduleDir = path.join(scratch, 'node_modules/node-pty');
    for (const [name, bytes] of Object.entries(files)) {
      const file = path.join(moduleDir, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
    }
    await fs.writeFile(path.join(scratch, 'package.json'), JSON.stringify({ name: 'noted-pty-private-build', version: '1.0.0', private: true, dependencies: { 'node-pty': PTY_VERSION } }));
    if (!rebuild) ({ rebuild } = await import('@electron/rebuild'));
    await rebuild({
      buildPath: scratch, projectRootPath: scratch, electronVersion, arch, platform,
      onlyModules: ['node-pty'], force: true, buildFromSource: true,
      mode: 'sequential', useCache: false, disablePreGypCopy: true,
    });
    const release = path.join(moduleDir, 'build/Release');
    const binary = await readRegular(path.join(release, 'pty.node'));
    const helper = await readRegular(path.join(release, 'spawn-helper'));
    const meta = await readRegular(path.join(release, '.forge-meta'));
    const config = JSON.parse((await readRegular(path.join(moduleDir, 'build/config.gypi'))).toString().replace(/^#.*$/gm, ''));
    if (String(config.variables?.node_module_version) !== ELECTRON_ABI || config.variables?.target_arch !== arch) {
      drift('node-gyp configured headers/architecture differ from the Electron target');
    }
    inspectMachO(binary, { arch, marker: true });
    inspectMachO(helper, { arch, type: 2 });
    if (meta.toString() !== arch + '--' + ELECTRON_ABI) drift('rebuilder .forge-meta ABI mismatch');
    // Refuse source changes that occurred during the async compiler call.
    await readInputs(ptyDir);
    await ensureRealDirectory(path.join(ptyDir, 'build'));
    const destination = path.join(ptyDir, 'build/Release');
    await ensureRealDirectory(destination);
    await atomicPublish(path.join(destination, 'spawn-helper'), helper, 0o755);
    await atomicPublish(path.join(destination, 'pty.node'), binary, 0o755);
    // Publish the real rebuilder's skip token last, after validated outputs.
    await atomicPublish(path.join(destination, '.forge-meta'), meta);
    return { arch, electronVersion, binarySHA: sha256(binary), helperSHA: sha256(helper), meta: meta.toString() };
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

// These versions/order were inspected locally. Updating them requires checking
// beforePack -> installAppDependencies -> afterExtract -> copyAppFiles again.
export async function checkToolchain(projectDir) {
  const require = createRequire(path.join(projectDir, 'package.json'));
  for (const [name, version] of [['electron', ELECTRON_VERSION], ['electron-builder', '25.1.8'], ['app-builder-lib', '25.1.8']]) {
    const actual = JSON.parse(await fs.readFile(require.resolve(name + '/package.json'), 'utf8')).version;
    if (actual !== version) drift(name + ' version drift: ' + actual + ', expected ' + version);
  }
  const entry = require.resolve('@electron/rebuild');
  const version = JSON.parse(await fs.readFile(path.join(path.dirname(entry), '../package.json'), 'utf8')).version;
  if (version !== '4.0.2') drift('@electron/rebuild version drift: ' + version);
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
  const nested = JSON.parse(await fs.readFile(builderRequire.resolve('@electron/rebuild/package.json'), 'utf8')).version;
  if (nested !== '3.6.1') drift('electron-builder rebuilder version drift: ' + nested);
}

const prepared = new WeakMap();
function targetFromContext(context) {
  const { packager } = context;
  if (packager.config.npmRebuild === false || packager.config.nodeGypRebuild === true
    || packager.config.nativeRebuilder === 'legacy' || packager.config.beforeBuild) {
    drift('native rebuild configuration no longer has the inspected .forge-meta skip contract');
  }
  const arch = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch];
  return { projectDir: packager.info.appDir, electronVersion: packager.info.framework.version, arch, platform: context.electronPlatformName };
}

export async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const target = targetFromContext(context);
  await checkToolchain(target.projectDir);
  const proof = await rebuildNodePty(target);
  prepared.set(context.packager, proof);
  console.log('[node-pty] privately rebuilt and atomically published ' + proof.arch + ' sha256=' + proof.binarySHA);
}

export async function verifyPublished(projectDir, proof) {
  if (!proof) drift('missing beforePack build proof');
  const release = path.join(projectDir, 'node_modules/node-pty/build/Release');
  const binary = await readRegular(path.join(release, 'pty.node'));
  const helper = await readRegular(path.join(release, 'spawn-helper'));
  inspectMachO(binary, { arch: proof.arch, marker: true });
  inspectMachO(helper, { arch: proof.arch, type: 2 });
  if (sha256(binary) !== proof.binarySHA || sha256(helper) !== proof.helperSHA
    || (await readRegular(path.join(release, '.forge-meta'))).toString() !== proof.meta) {
    drift('native rebuild replaced the prepared node-pty outputs');
  }
}

export async function afterExtract(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const target = targetFromContext(context);
  const proof = prepared.get(context.packager);
  if (proof?.arch !== target.arch || proof?.electronVersion !== target.electronVersion) drift('packaging target changed after beforePack');
  await verifyPublished(target.projectDir, proof);
  console.log('[node-pty] automatic rebuild preserved fixed binary; ready for ASAR');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectDir = fileURLToPath(new URL('../', import.meta.url));
  await checkToolchain(projectDir);
  const proof = await rebuildNodePty({ projectDir, electronVersion: ELECTRON_VERSION, arch: process.arch });
  await verifyPublished(projectDir, proof);
  console.log('[node-pty] rebuilt ' + proof.arch + ' sha256=' + proof.binarySHA);
}
