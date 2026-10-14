#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('This build path supports macOS only.');
if (!['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported native architecture: ' + process.arch);
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(command + ' exited ' + code)));
});
await run('npm', ['run', 'build:renderer']);
await run(path.join(root, 'node_modules/.bin/electron-builder'), ['--mac', '--dir', '--' + process.arch]);
const app = path.join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Noted Terminal.app');
await run(process.execPath, ['scripts/validate-app-asar.mjs', path.join(app, 'Contents/Resources/app.asar')]);
await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
console.log('[PublicBuild] Local app ready: ' + app + ' (ad-hoc, not notarized; not installed or opened)');
