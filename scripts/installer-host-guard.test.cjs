'use strict';

// Scar 01Nov: `npm run build:i-c` was started from a Noted tab (via `env -i`).
// It began maintenance, captured six working tabs, asked Main to quit and was
// killed with the PTY it had just closed: no compile, no relaunch, no
// maintenance complete. Installers must refuse to run inside the Noted Main
// they are about to quit — decided by process ancestry, not environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectInstallerHost, assertInstallerOutsideNoted } = require('./noted-prod-api');

const MAIN = '/Applications/Noted Terminal.app/Contents/MacOS/Noted Terminal';

// The exact shape observed live: PTY zsh is a direct child of Main.
const insideNoted = [
  `70442     1 ${MAIN} --research-maintenance-operation=install:noted:x`,
  `70826 70442 /bin/zsh`,
  `71500 70826 claude --resume be82a19d`,
  `71600 71500 /bin/zsh -c env -i HOME=/Users/fedor npm run build:i-c`,
  `71700 71600 node scripts/build-and-continue-immediate.cjs`,
].join('\n');

const outsideNoted = [
  `13614     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal`,
  `58465 13614 -zsh`,
  `71700 58465 node scripts/build-and-continue-immediate.cjs`,
  `70442     1 ${MAIN}`,
].join('\n');

const snap = text => () => text;

test('a process started from a Noted tab is inside Main, even after env -i', () => {
  const host = inspectInstallerHost({ startPid: 71700, processSnapshot: snap(insideNoted) });
  assert.deepEqual(host, { status: 'inside', mainPid: 70442 });
});

test('a process started from Terminal.app is outside, even while Noted runs', () => {
  assert.deepEqual(inspectInstallerHost({ startPid: 71700, processSnapshot: snap(outsideNoted) }), { status: 'outside' });
});

test('Electron helpers and the detached MCP hub are not the Main to be quit', () => {
  for (const ancestor of [`${MAIN} --type=renderer`, `${MAIN} /x/app.asar/src/main/mcp-hub.js --standalone`]) {
    const table = [`500 1 ${ancestor}`, `600 500 /bin/zsh`, `700 600 node install.cjs`].join('\n');
    assert.equal(inspectInstallerHost({ startPid: 700, processSnapshot: snap(table) }).status, 'outside', ancestor);
  }
});

test('an unreadable or broken process table is unknown, never outside', () => {
  const failing = () => { throw new Error('ps timeout'); };
  assert.equal(inspectInstallerHost({ startPid: 1, processSnapshot: failing }).status, 'unknown');
  assert.equal(inspectInstallerHost({ startPid: 5, processSnapshot: snap('') }).status, 'unknown');
  assert.equal(inspectInstallerHost({ startPid: 999, processSnapshot: snap(outsideNoted) }).status, 'unknown',
    'own pid missing from the snapshot');
  const cycle = [`10 20 /bin/zsh`, `20 10 /bin/zsh`].join('\n');
  assert.notEqual(inspectInstallerHost({ startPid: 10, processSnapshot: snap(cycle) }).status, 'inside',
    'a parent cycle terminates without inventing a Main');
});

test('the assertion refuses inside and unknown with an actionable message, passes outside', () => {
  assert.throws(() => assertInstallerOutsideNoted('build:i-c', { startPid: 71700, processSnapshot: snap(insideNoted) }),
    error => error.code === 'installer_inside_noted'
      && /build:i-c refused/.test(error.message) && /Main pid 70442/.test(error.message)
      && /build_install_noted_terminal/.test(error.message));
  assert.throws(() => assertInstallerOutsideNoted('build:install', { processSnapshot: () => { throw Error('x'); } }),
    error => error.code === 'installer_host_unknown');
  assert.equal(assertInstallerOutsideNoted('build:install',
    { startPid: 71700, processSnapshot: snap(outsideNoted) }).status, 'outside');
});

test('every app-quitting CLI refuses before work; build:i-c --resume stays allowed', () => {
  const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
  const cases = [
    ['build-and-continue-immediate.cjs', "assertInstallerOutsideNoted('build:i-c')"],
    ['build-install-noted-terminal.mjs', "assertInstallerOutsideNoted('build:install')"],
    ['build-when-idle.js', "assertInstallerOutsideNoted('build:i-obs')"],
    ['build-and-continue.js', "assertInstallerOutsideNoted('build:i-cont')"],
  ];
  for (const [file, call] of cases) {
    const source = read(file);
    const guard = source.indexOf(call);
    assert.ok(guard > 0, file + ' calls the host guard');
    const entry = source.lastIndexOf('main()');
    assert.ok(entry > guard, file + ' guards before main() runs');
  }
  assert.match(read('build-and-continue-immediate.cjs'), /process\.argv\[2\] !== '--resume'/,
    '--resume only re-registers restore and must not be refused');
});
