import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  hostNeedsInstall,
  installedHostPath,
  resolveCodeModeHost,
  vendorPackageName,
  vendorSearchRoots,
  vendorTargetTriple,
} from './noted-codex-host-resolve.mjs';

const TRIPLE = 'aarch64-apple-darwin';
const PACKAGE = '@openai/codex-darwin-arm64';

async function makeVendorRoot(root, {
  version,
  payloadVersion = version,
  nested = true,
  writePayloadManifest = true,
  packageVersionSuffix = '-darwin-arm64',
} = {}) {
  const base = nested
    ? join(root, '@openai', 'codex', 'node_modules', PACKAGE)
    : join(root, PACKAGE);
  const vendorDir = join(base, 'vendor', TRIPLE);
  await mkdir(join(vendorDir, 'bin'), { recursive: true });
  const hostPath = join(vendorDir, 'bin', 'codex-code-mode-host');
  await writeFile(hostPath, `host-${version}`);
  await chmod(hostPath, 0o755);
  await writeFile(
    join(base, 'package.json'),
    JSON.stringify({ name: PACKAGE, version: `${version}${packageVersionSuffix}` }),
  );
  if (writePayloadManifest) {
    await writeFile(
      join(vendorDir, 'codex-package.json'),
      JSON.stringify({ layoutVersion: 1, version: payloadVersion, target: TRIPLE }),
    );
  }
  return { base, hostPath };
}

async function withTempRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'noted-codex-host-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function resolveIn(root, expectedVersion) {
  return resolveCodeModeHost({
    expectedVersion,
    platform: 'darwin',
    arch: 'arm64',
    home: join(root, 'home'),
    env: { NOTED_CODEX_VENDOR_ROOT: root },
  });
}

test('resolves the host from a version-matching vendor payload', async () => {
  await withTempRoot(async (root) => {
    const { hostPath } = await makeVendorRoot(root, { version: '0.147.0' });
    const result = resolveIn(root, '0.147.0');

    assert.equal(result.ok, true);
    assert.equal(result.hostPath, hostPath);
    assert.equal(result.version, '0.147.0');
  });
});

test('rejects a host whose version differs from the patched CLI', async () => {
  // The host speaks a versioned framed protocol; silently accepting a
  // mismatched build would trade a clear install error for a runtime handshake
  // failure inside every Code Mode tool call.
  await withTempRoot(async (root) => {
    await makeVendorRoot(root, { version: '0.145.0' });
    const result = resolveIn(root, '0.147.0');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'version-mismatch');
    assert.equal(result.inspected[0].version, '0.145.0');
  });
});

test('reports not-found when no vendor payload exists at all', async () => {
  await withTempRoot(async (root) => {
    const result = resolveIn(root, '0.147.0');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-found');
    assert.deepEqual(result.inspected, []);
  });
});

test('payload manifest version wins over the suffixed package version', async () => {
  // Platform packages publish versions like "0.147.0-darwin-arm64"; the payload
  // manifest carries the plain CLI version and is the authoritative source.
  await withTempRoot(async (root) => {
    await makeVendorRoot(root, { version: '0.147.0' });
    assert.equal(resolveIn(root, '0.147.0').ok, true);
  });
});

test('falls back to the package version when the payload manifest is absent', async () => {
  await withTempRoot(async (root) => {
    await makeVendorRoot(root, { version: '0.147.0', writePayloadManifest: false });
    const result = resolveIn(root, '0.147.0');

    assert.equal(result.ok, true);
    assert.equal(result.version, '0.147.0');
  });
});

test('finds a standalone platform package without the nested wrapper', async () => {
  await withTempRoot(async (root) => {
    const { hostPath } = await makeVendorRoot(root, { version: '0.147.0', nested: false });
    const result = resolveIn(root, '0.147.0');

    assert.equal(result.ok, true);
    assert.equal(result.hostPath, hostPath);
  });
});

test('missing expected version fails closed instead of picking any host', async () => {
  await withTempRoot(async (root) => {
    await makeVendorRoot(root, { version: '0.147.0' });
    const result = resolveCodeModeHost({
      expectedVersion: null,
      platform: 'darwin',
      arch: 'arm64',
      env: { NOTED_CODEX_VENDOR_ROOT: root },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-expected-version');
  });
});

test('unsupported platform is reported rather than guessed', () => {
  const result = resolveCodeModeHost({
    expectedVersion: '0.147.0',
    platform: 'sunos',
    arch: 'sparc',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-platform');
});

test('platform mapping covers the published npm targets', () => {
  assert.equal(vendorPackageName('darwin', 'arm64'), PACKAGE);
  assert.equal(vendorTargetTriple('darwin', 'arm64'), TRIPLE);
  assert.equal(vendorTargetTriple('linux', 'x64'), 'x86_64-unknown-linux-musl');
  assert.equal(vendorPackageName('sunos', 'sparc'), null);
});

test('explicit vendor override is exclusive, not just first', () => {
  // Falling back past an explicit pin would resolve a host the caller never
  // asked for.
  const roots = vendorSearchRoots({
    home: '/home/u',
    env: { NOTED_CODEX_VENDOR_ROOT: '/override' },
  });

  assert.deepEqual(roots, ['/override']);
});

test('default roots cover the usual global npm install locations', () => {
  const roots = vendorSearchRoots({ home: '/home/u', env: {} });

  assert.equal(roots[0], '/home/u/.local/lib/node_modules');
  assert.ok(roots.includes('/opt/homebrew/lib/node_modules'));
});

test('installed host path is a sibling of the patched codex binary', () => {
  assert.equal(
    installedHostPath('/Users/x/.noted-terminal/bin/codex', 'darwin'),
    '/Users/x/.noted-terminal/bin/codex-code-mode-host',
  );
  assert.equal(
    installedHostPath('C:\\noted\\bin\\codex.exe', 'win32').endsWith('codex-code-mode-host.exe'),
    true,
  );
});

test('a missing installed host always needs installing', () => {
  const fs = { existsSync: () => false, statSync: () => ({ size: 1 }) };
  assert.equal(hostNeedsInstall({ sourcePath: '/a', targetPath: '/b', fs }), true);
});

test('an identical installed host does not need reinstalling', () => {
  const fs = { existsSync: () => true, statSync: () => ({ size: 42 }) };
  assert.equal(hostNeedsInstall({ sourcePath: '/a', targetPath: '/b', fs }), false);
});
