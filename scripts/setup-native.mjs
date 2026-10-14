#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rebuild } from '@electron/rebuild';
import { checkToolchain, rebuildNodePty, verifyPublished } from './node-pty-build.mjs';
import { ELECTRON_VERSION } from './node-pty-binary.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') throw new Error('This source distribution supports macOS only.');
await checkToolchain(root);
// Only this checkout is rebuilt. Do not touch another installed application.
await rebuild({ buildPath: root, electronVersion: ELECTRON_VERSION,
  onlyModules: ['better-sqlite3'], force: true, mode: 'sequential' });
const proof = await rebuildNodePty({ projectDir: root, electronVersion: ELECTRON_VERSION, arch: process.arch });
await verifyPublished(root, proof);
console.log('[Setup] Electron native modules prepared for ' + process.arch);
