#!/usr/bin/env node
// Private Main-process integration for the actual image-preview IPC handler.
// It executes source-extracted production functions in a disposable Electron
// Main process with private files and a require shim for web-server only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const packet = '/private/tmp/ios-settings-images-20261003';
const artifact = process.env.NOTED_NATIVE_IMAGES_MAIN_ARTIFACT
  || await fs.mkdtemp('/private/tmp/noted-native-images-main-');
const privateTemp = path.join(artifact, 'private-temp');
const privateUserData = path.join(artifact, 'user-data');
const mobileRoot = path.join(privateTemp, 'noted-terminal-mobile-attachments');
const eventLog = [];
const stamp = () => new Date().toISOString();
const log = (message, data = {}) => {
  const line = `${stamp()} ${message}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`;
  eventLog.push(line);
  return line;
};
const sha256 = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

function extractFunction(source, name) {
  const marker = `function ${name}`;
  let start = source.indexOf(marker);
  assert.ok(start >= 0, `source function missing: ${name}`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `source function body missing: ${name}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let template = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '`') { template = !template; continue; }
    if (template) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated source function: ${name}`);
}

function extractPreviewHandler(source) {
  const marker = "ipcMain.handle('prompt-queue:get-image-preview-data-url'";
  const markerAt = source.indexOf(marker);
  assert.ok(markerAt >= 0, 'preview IPC registration missing');
  const nextRegistration = source.indexOf("\nipcMain.handle('prompt-queue:copy-image-to-clipboard'", markerAt);
  assert.ok(nextRegistration > markerAt, 'preview IPC following registration missing');
  const registration = source.slice(markerAt, nextRegistration);
  const arrowStart = registration.indexOf('async (_event, ref = {}) => {');
  assert.ok(arrowStart >= 0, 'preview IPC arrow body missing');
  const close = registration.indexOf('\n});', arrowStart);
  assert.ok(close >= 0, 'preview IPC closing registration missing');
  return registration.slice(arrowStart, close + 2);
}

const mainSource = await fs.readFile(path.join(repo, 'src/main/main.js'), 'utf8');
const webSource = await fs.readFile(path.join(repo, 'src/main/web-server.js'), 'utf8');
const sourceHashes = {
  'src/main/main.js': crypto.createHash('sha256').update(mainSource).digest('hex'),
  'src/main/web-server.js': crypto.createHash('sha256').update(webSource).digest('hex'),
};
await fs.mkdir(artifact, { recursive: true });
await fs.mkdir(mobileRoot, { recursive: true });
await fs.mkdir(privateUserData, { recursive: true });
await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify({ capturedAt: stamp(), sourceHashes }, null, 2));
log('FREEZE actual Main/web source hashes', sourceHashes);

const entry = JSON.parse(await fs.readFile(path.join(packet, 'image-entry.json'), 'utf8'));
const captures = JSON.parse(await fs.readFile(path.join(packet, 'receipt-captures.json'), 'utf8'));
const captured = captures[0].records[0];
assert.equal(captured.provider, 'codex');
assert.equal(entry.imagePaths.length, 2);

const copies = [];
for (const [index, ref] of entry.imagePaths.entries()) {
  const source = ref.path;
  const originalHash = await sha256(source);
  const id = `mobile-${index + 1}`;
  const targetDir = path.join(mobileRoot, id);
  const target = path.join(targetDir, `photo-${index + 1}.jpg`);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(source, target);
  const copiedHash = await sha256(target);
  assert.equal(copiedHash, originalHash);
  copies.push({ id, source, target, bytes: (await fs.stat(target)).size, originalHash, copiedHash });
}
const managedDir = path.join(artifact, 'managed-assets');
await fs.mkdir(managedDir, { recursive: true });
const managedPath = path.join(managedDir, 'managed-image.jpg');
await fs.copyFile(copies[0].target, managedPath);
await fs.writeFile(path.join(mobileRoot, 'mobile-file', 'note.txt'), 'private non-image fixture\n').catch(async () => {
  await fs.mkdir(path.join(mobileRoot, 'mobile-file'), { recursive: true });
  await fs.writeFile(path.join(mobileRoot, 'mobile-file', 'note.txt'), 'private non-image fixture\n');
});
const oversizedPath = path.join(mobileRoot, 'mobile-large', 'large.jpg');
await fs.mkdir(path.dirname(oversizedPath), { recursive: true });
const oversizedHandle = await fs.open(oversizedPath, 'w');
await oversizedHandle.truncate(12 * 1024 * 1024 + 1);
await oversizedHandle.close();
await fs.writeFile(path.join(artifact, 'fixture-manifest.json'), JSON.stringify({ copies, managedPath, oversizedPath }, null, 2));
log('FIXTURE private JPEG copies verified', { copies: copies.map(({ id, bytes, originalHash }) => ({ id, bytes, originalHash })) });

const dependencies = [
  'cleanOptionalString', 'mobileAttachmentRoot', 'sanitizeMobileAttachmentName',
  'normalizeMobileAttachmentKind', 'inferMobileAttachmentMimeType', 'sendAttachmentError',
  'readMobileAttachmentPreview',
].map((name) => extractFunction(webSource, name)).join('\n');
const arrowSource = extractPreviewHandler(mainSource);
const childSource = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app: electronApp, nativeImage } = require('electron');
const artifact = ${JSON.stringify(artifact)};
const privateTemp = ${JSON.stringify(privateTemp)};
const privateUserData = ${JSON.stringify(privateUserData)};
const mobileRoot = ${JSON.stringify(mobileRoot)};
const managedPath = ${JSON.stringify(managedPath)};
const oversizedPath = ${JSON.stringify(oversizedPath)};
const mobileAttachmentIndex = new Map();
const MOBILE_ATTACHMENT_PREVIEW_MAX_BYTES = 12 * 1024 * 1024;
electronApp.setPath('temp', privateTemp);
electronApp.setPath('userData', privateUserData);
const appShim = {
  getPath(kind) { if (kind === 'temp') return privateTemp; if (kind === 'userData') return privateUserData; throw new Error('unexpected app path '+kind); },
  quit() { return electronApp.quit(); },
};
const app = appShim;
${dependencies}
const webServerModule = { readMobileAttachmentPreview };
const originalRequire = require;
const requireShim = (request) => request.endsWith('/web-server') ? webServerModule : originalRequire(request);
const makePreviewHandler = (require) => eval('(' + ${JSON.stringify(arrowSource)} + ')');
const promptQueueAssetStore = {
  async existingManagedRef(ref) {
    return ref?.assetId === 'managed-fixture-1' ? { assetId: 'managed-fixture-1', path: managedPath } : null;
  },
};
const srcMainDir = '/private/extracted-main';
const previewHandler = makePreviewHandler(requireShim);
const digest = (dataUrl) => crypto.createHash('sha256').update(dataUrl).digest('hex');
const call = async (name, ref) => {
  const value = await previewHandler({}, ref);
  return { name, ref, value: {
    success: value?.success === true,
    error: value?.error || null,
    assetId: value?.assetId || null,
    variant: value?.variant || null,
    width: value?.width || null,
    height: value?.height || null,
    dataUrlLength: typeof value?.dataUrl === 'string' ? value.dataUrl.length : 0,
    dataUrlPrefix: typeof value?.dataUrl === 'string' ? value.dataUrl.slice(0, 22) : '',
    dataUrlHash: typeof value?.dataUrl === 'string' ? digest(value.dataUrl) : null,
  } };
};
electronApp.whenReady().then(async () => {
  const results = [];
  const mobileOne = path.join(mobileRoot, 'mobile-1', 'photo-1.jpg');
  const mobileTwo = path.join(mobileRoot, 'mobile-2', 'photo-2.jpg');
  results.push(await call('mobile-thumbnail-1', { path: mobileOne, variant: 'thumbnail' }));
  results.push(await call('mobile-detail-1', { path: mobileOne, variant: 'detail' }));
  results.push(await call('mobile-thumbnail-2', { path: mobileTwo, variant: 'thumbnail' }));
  results.push(await call('managed-thumbnail', { assetId: 'managed-fixture-1', variant: 'thumbnail' }));
  results.push(await call('outside-arbitrary', { path: '/tmp/noted-terminal-codex-image-input/c1bee904a509ec8959c6dcfd3411695fcd4d31a3634c8c54bfb2278c772c4b21.jpg', variant: 'detail' }));
  results.push(await call('outside-transport-alias', { path: '/tmp/noted-terminal-codex-image-input/0e97f774590d18d267c0c661d08009b8e43ff8048c3076a2798367edddc8ecad.jpg', variant: 'thumbnail' }));
  results.push(await call('missing-within-root', { path: path.join(mobileRoot, 'mobile-missing', 'missing.jpg'), variant: 'thumbnail' }));
  results.push(await call('non-image', { path: path.join(mobileRoot, 'mobile-file', 'note.txt'), variant: 'detail' }));
  results.push(await call('over-budget', { path: oversizedPath, variant: 'detail' }));
  const byName = Object.fromEntries(results.map((item) => [item.name, item.value]));
  if (!byName['mobile-thumbnail-1'].success || !byName['mobile-detail-1'].success || !byName['mobile-thumbnail-2'].success) throw new Error('mobile preview happy path failed');
  if (!(byName['mobile-thumbnail-1'].width <= 64 && byName['mobile-thumbnail-1'].height <= 64)) throw new Error('thumbnail exceeds 64px bound');
  if (!(byName['mobile-detail-1'].width <= 1024 && byName['mobile-detail-1'].height <= 1024)) throw new Error('detail exceeds 1024px bound');
  if (!(byName['mobile-detail-1'].dataUrlLength > byName['mobile-thumbnail-1'].dataUrlLength)) throw new Error('detail is not larger than thumbnail');
  if (byName['mobile-thumbnail-1'].dataUrlHash === byName['mobile-thumbnail-2'].dataUrlHash) throw new Error('distinct mobile images produced identical preview');
  for (const name of ['outside-arbitrary', 'outside-transport-alias', 'missing-within-root', 'non-image', 'over-budget']) {
    if (byName[name].success) throw new Error(name+' unexpectedly succeeded');
  }
  if (byName['missing-within-root'].error !== 'attachment_missing') throw new Error('missing path did not preserve 410 error code');
  if (byName['outside-arbitrary'].error !== 'attachment path outside mobile temp root') throw new Error('outside path was not rejected by root guard');
  console.log(JSON.stringify({ status: 'PASS', results, root: mobileRoot, previewLimitBytes: MOBILE_ATTACHMENT_PREVIEW_MAX_BYTES }));
  await app.quit();
}).catch(async (error) => { console.error(JSON.stringify({ status: 'FAIL', error: error?.stack || String(error) })); await app.quit(); process.exitCode = 1; });
`;
await fs.writeFile(path.join(artifact, 'main-vm.cjs'), childSource);
const lease = { command: [path.join(repo, 'node_modules/.bin/electron'), path.join(artifact, 'main-vm.cjs')], cwd: artifact, startedAt: stamp(), ownedByThisRun: true };
await fs.writeFile(path.join(artifact, 'process-lease.json'), JSON.stringify(lease, null, 2));
log('LEASE private Electron Main VM starting', lease);
let child;
let stdout = '';
let stderr = '';
try {
  const command = path.join(repo, 'node_modules/.bin/electron');
  const result = await execFileAsync(command, [path.join(artifact, 'main-vm.cjs')], {
    cwd: artifact,
    env: { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: privateUserData, ELECTRON_NO_ATTACH_CONSOLE: '1' },
    maxBuffer: 12 * 1024 * 1024,
  });
  stdout = result.stdout;
  stderr = result.stderr;
  log('MAIN VM exited cleanly', { stdout: stdout.trim().slice(-4000), stderr: stderr.trim().slice(-2000) });
} catch (error) {
  stdout = error.stdout || '';
  stderr = error.stderr || '';
  log('MAIN VM failed', { message: error.message, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
}
await fs.writeFile(path.join(artifact, 'main-vm.stdout.log'), stdout);
await fs.writeFile(path.join(artifact, 'main-vm.stderr.log'), stderr);
let parsed = null;
for (const line of stdout.split(/\r?\n/).reverse()) {
  if (!line.trim()) continue;
  try { parsed = JSON.parse(line); break; } catch {}
}
const final = { status: parsed?.status === 'PASS' ? 'PASS' : 'FAIL', artifact, sourceHashes, copies, parsed, root: mobileRoot, previewLimitBytes: 12 * 1024 * 1024, actions: ['source-extracted actual Main IPC arrow executed in private Electron Main', 'actual web-server readMobileAttachmentPreview and dependency functions executed via narrow require shim', 'private mobile managed/outside/missing/non-image/over-budget cases checked'], errors: parsed?.status === 'PASS' ? [] : [stderr.slice(-4000) || stdout.slice(-4000) || 'private Main VM produced no PASS result'] };
await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(final, null, 2));
await fs.writeFile(path.join(artifact, 'test-run.log'), `${eventLog.join('\n')}\n`);
console.log(JSON.stringify(final, null, 2));
if (final.status !== 'PASS') process.exitCode = 1;
