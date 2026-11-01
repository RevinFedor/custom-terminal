import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(process.env.GRACEFUL_QUIT_SOURCE || join(root, 'scripts/graceful-quit.sh'), 'utf8');

// Behaviour on a copy bound to a synthetic app name: no real Noted Terminal,
// hub or user process can ever match its patterns. --wait-only, so no
// AppleScript Quit is sent to anything.
function syntheticRun(t, { withPid }) {
  const dir = mkdtempSync(join(tmpdir(), 'noted-graceful-quit-'));
  const appName = 'NotedQuitFixture ' + process.pid + '-' + Date.now();
  const marker = '/Applications/' + appName + '.app/Contents/MacOS/' + appName;
  assert.match(source, /^APP_NAME="Noted Terminal"$/m);
  const script = join(dir, 'graceful-quit.sh');
  writeFileSync(script, source.replace(/^APP_NAME="Noted Terminal"$/m, 'APP_NAME="' + appName + '"'));
  const spawnAs = args => spawn('/bin/bash', ['-c', 'exec -a "$0" "$@"', marker, ...args], { stdio: 'ignore' });
  const main = spawnAs(['/bin/sleep', '60']);
  const hub = spawnAs(['/usr/bin/perl', '-e', 'sleep 60', '/x/src/main/mcp-hub.js', '--standalone']);
  // The synchronous test cannot reap its children, so a signalled one stays a
  // zombie that kill -0 still reports; read its state instead.
  const alive = pid => {
    const stat = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    return stat !== '' && !stat.startsWith('Z');
  };
  t.after(() => {
    for (const child of [main, hub]) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  // Wait until both children carry the synthetic argv0 (exec has happened);
  // otherwise a "survived" hub would prove nothing.
  let carried = 0;
  for (let i = 0; i < 200 && carried < 2; i++) {
    const out = spawnSync('/bin/ps', ['-o', 'command=', '-p', main.pid + ',' + hub.pid], { encoding: 'utf8' }).stdout;
    carried = out.split('\n').filter(line => line.startsWith(marker)).length;
    if (carried < 2) spawnSync('/bin/sleep', ['0.05']);
  }
  assert.equal(carried, 2, 'both decoys run under the synthetic executable path');
  const run = spawnSync('/bin/bash', [script, '1', '', '--wait-only', ...(withPid ? [String(main.pid)] : [])],
    { encoding: 'utf8', timeout: 30_000 });
  spawnSync('/bin/sleep', ['0.3']);
  return { run, mainAlive: alive(main.pid), hubAlive: alive(hub.pid) };
}

test('with the captured Main PID only Main is signalled; the shared MCP hub survives', t => {
  const { run, mainAlive, hubAlive } = syntheticRun(t, { withPid: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /waiting for captured Main pid=/);
  assert.equal(mainAlive, false, 'Main received the fallback signal');
  assert.equal(hubAlive, true, 'the hub (same executable path) was not touched');
});

test('without a PID the legacy path-wide fallback still reaches every matching process', t => {
  const { run, mainAlive, hubAlive } = syntheticRun(t, { withPid: false });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(mainAlive, false); assert.equal(hubAlive, false);
});

test('crash detection snapshots report identities before requesting quit', () => {
  const baseline = source.indexOf('CRASH_BASELINE="$(mktemp -t noted-crash-baseline)"');
  const quit = source.indexOf('osascript -e');
  assert.ok(baseline >= 0 && baseline < quit);
  assert.match(source, /grep -Fqx -- "\$\{report\}" "\$\{CRASH_BASELINE\}"/);
});

test('touched old reports cannot be mistaken for a new crash', () => {
  assert.doesNotMatch(source, /^\s*find[^\n]*-newer/m);
  assert.doesNotMatch(source, /noted-quit-marker/);
  assert.match(source, /find "\$\{CRASH_DIR\}"[^\n]*-name "\$\{APP_NAME\}-\*\.ips"/);
});
