'use strict';

// A detached hub survives Build Install by design, but the installer deletes
// the bundle it was launched from. macOS grants file access per executable
// identity, so that hub keeps answering /mcp/_status while it and all six
// children lose the project directory: EPERM on index reads, Browser's host
// binding invalid, Python workers unable to start. Its children stay `ready`
// with no ENOENT, so the previous `brokenLaunch` check never saw it and Main
// adopted it as healthy. Production incident 02.11.2026: hub 18670 ran out of
// /Applications/.noted-terminal-install-af50CP/previous.app for a whole day.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHubController } = require('./mcp-hub-controller');

const CURRENT = '/Applications/Noted Terminal.app/Contents/MacOS/Noted Terminal';
const REMOVED = '/Applications/.noted-terminal-install-af50CP/previous.app/Contents/MacOS/Noted Terminal';

// A hub that looks perfectly healthy: every child ready, no errors, idle.
function healthyHub(executable) {
  return {
    pid: 18670,
    executable,
    capabilities: { launchEnvironment: 1, executableIdentity: 1 },
    servers: ['terminal', 'knowledge', 'browser', 'electron', 'ios', 'sc-desktop']
      .map((name) => ({ name, up: true, initialized: true, recovering: false, pendingRequests: 0, lastError: null })),
  };
}

function harness({ existing, existsOnDisk }) {
  const calls = { shutdownPid: null, launched: 0 };
  const serverDefs = Object.fromEntries(healthyHub(CURRENT).servers.map((s) => [s.name, { command: 'node', args: [] }]));
  const controller = createMcpHubController({
    port: 59999,
    script: '/tmp/hub.cjs',
    log() {},
    executable: CURRENT,
    io: { existsSync: (p) => existsOnDisk.includes(p) },
    readConfiguration: () => ({ fingerprint: 'fp', canLaunch: true, status: {}, serverDefs }),
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/mcp/_status')) {
        if (!existing) return { ok: false };
        return { ok: true, json: async () => (calls.shutdownPid ? healthyHub(CURRENT) : existing) };
      }
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) };
      return { ok: false };
    },
    spawnImpl: () => { throw new Error('spawn must not run in this unit test'); },
  });
  return { controller, calls };
}

test('a hub running out of a removed bundle is replaced even though every child is ready', async () => {
  // The exact production shape: answers fine, children ready, bundle gone.
  // shutdown() speaks real HTTP, so reaching it (instead of returning the hub)
  // is the observable proof that the stale executable triggered a replacement.
  const { controller } = harness({ existing: healthyHub(REMOVED), existsOnDisk: [CURRENT] });
  const outcome = await controller.ensure().then(
    (value) => ({ adopted: value }),
    (error) => ({ error: String(error && error.message) }),
  );
  assert.ok(!outcome.adopted || outcome.adopted.pid !== 18670,
    'the stale hub must not be adopted as healthy');
  assert.match(outcome.error || '', /порт|spawn|ECONNREFUSED|socket/i,
    'Main proceeded to shut the stale hub down rather than reusing it');
});

test('a hub from the current bundle is adopted, never replaced', async () => {
  const { controller } = harness({ existing: healthyHub(CURRENT), existsOnDisk: [CURRENT] });
  const result = await controller.ensure();
  assert.equal(result.pid, 18670, 'a current healthy hub is reused as-is');
});

test('a different bundle that still exists on disk is not treated as stale', async () => {
  // Another installed copy is a configuration question, not a dead executable:
  // replacing it here would fight another live application over the port.
  const other = '/Applications/Noted Terminal Dev.app/Contents/MacOS/Noted Terminal';
  const { controller } = harness({ existing: healthyHub(other), existsOnDisk: [CURRENT, other] });
  const result = await controller.ensure();
  assert.equal(result.pid, 18670, 'an existing foreign bundle is reported, not shut down');
});

test('an older hub that does not report its executable keeps the previous behaviour', async () => {
  const legacy = healthyHub(undefined);
  delete legacy.executable;
  const { controller } = harness({ existing: legacy, existsOnDisk: [CURRENT] });
  const result = await controller.ensure();
  assert.equal(result.pid, 18670, 'absent identity is unknown, not proof of staleness');
});
