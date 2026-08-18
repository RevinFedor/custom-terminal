#!/usr/bin/env node
// Resolve the canonical `codex-code-mode-host` companion binary for a given
// patched Codex build.
//
// Why this file exists
// --------------------
// Noted Terminal ships its own patched `codex` binary in ~/.noted-terminal/bin
// so Codex tabs can emit the semantic side-channel that feeds Timeline/History.
// Since Codex 0.147 the CLI resolves `codex-code-mode-host` as a *sibling of the
// running executable* (InstallContext::code_mode_host_program_from_exe). Our
// build-install therefore has to place the host next to our `codex`, otherwise
// every Code Mode tool call fails with:
//
//   failed to spawn code-mode host <path>: host executable was not found
//
// The host CANNOT be built from source here: `codex-code-mode-runtime` depends
// on the `v8` crate, and no prebuilt V8 archive is published for
// aarch64-apple-darwin (build.rs aborts with HTTP 404). Building V8 from source
// (V8_FROM_SOURCE=1) is a multi-hour toolchain-heavy job. The only supported
// source is therefore the official vendor payload that ships inside the
// `@openai/codex-<platform>` npm package.
//
// Version pinning is mandatory: the host speaks a versioned framed protocol
// (ClientHello/SupportedProtocolVersions), so a host from a different Codex
// release may negotiate a version our patched CLI does not support. We only
// accept a vendor payload whose version equals our patched CLI version.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE_MODE_HOST_EXECUTABLE_NAME = 'codex-code-mode-host';

/** Vendor package name for the current platform+arch, matching npm's optionalDependencies. */
export function vendorPackageName(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  switch (key) {
    case 'darwin-arm64': return '@openai/codex-darwin-arm64';
    case 'darwin-x64': return '@openai/codex-darwin-x64';
    case 'linux-arm64': return '@openai/codex-linux-arm64';
    case 'linux-x64': return '@openai/codex-linux-x64';
    case 'win32-arm64': return '@openai/codex-win32-arm64';
    case 'win32-x64': return '@openai/codex-win32-x64';
    default: return null;
  }
}

/** Rust target triple for the current platform+arch — the vendor payload subdir. */
export function vendorTargetTriple(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  switch (key) {
    case 'darwin-arm64': return 'aarch64-apple-darwin';
    case 'darwin-x64': return 'x86_64-apple-darwin';
    case 'linux-arm64': return 'aarch64-unknown-linux-musl';
    case 'linux-x64': return 'x86_64-unknown-linux-musl';
    case 'win32-arm64': return 'aarch64-pc-windows-msvc';
    case 'win32-x64': return 'x86_64-pc-windows-msvc';
    default: return null;
  }
}

function readJson(filePath, fs) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Candidate roots that may hold a vendored Codex payload, most-preferred first.
 * Only npm/global-install roots are considered: they are the canonical
 * distribution channel and carry a machine-readable version we can match.
 */
export function vendorSearchRoots({ home = homedir(), env = process.env } = {}) {
  // An explicit override is exclusive, not merely first: pinning a vendor root
  // and then silently falling back to some other global install would resolve a
  // host the caller never asked for (and, in tests, leak the real machine's
  // Codex installs into the fixture).
  if (env.NOTED_CODEX_VENDOR_ROOT) return [env.NOTED_CODEX_VENDOR_ROOT];

  const roots = [];
  const push = (value) => {
    if (value && !roots.includes(value)) roots.push(value);
  };
  push(join(home, '.local', 'lib', 'node_modules'));
  push(join(home, '.npm-global', 'lib', 'node_modules'));
  push('/opt/homebrew/lib/node_modules');
  push('/usr/local/lib/node_modules');
  push('/usr/lib/node_modules');
  return roots;
}

/**
 * Find a `codex-code-mode-host` whose vendor payload version equals
 * `expectedVersion`.
 *
 * @returns {{ok: true, hostPath: string, version: string, root: string}
 *          |{ok: false, reason: string, inspected: Array<{root: string, version: string|null, detail: string}>}}
 */
export function resolveCodeModeHost({
  expectedVersion,
  platform = process.platform,
  arch = process.arch,
  home = homedir(),
  env = process.env,
  fs = { existsSync, readFileSync, statSync },
} = {}) {
  if (!expectedVersion) {
    return { ok: false, reason: 'missing-expected-version', inspected: [] };
  }
  const packageName = vendorPackageName(platform, arch);
  const triple = vendorTargetTriple(platform, arch);
  if (!packageName || !triple) {
    return { ok: false, reason: 'unsupported-platform', inspected: [] };
  }
  const executable = platform === 'win32'
    ? `${CODE_MODE_HOST_EXECUTABLE_NAME}.exe`
    : CODE_MODE_HOST_EXECUTABLE_NAME;

  const inspected = [];
  for (const root of vendorSearchRoots({ home, env })) {
    // Both layouts are supported: the host package with a nested vendor
    // dependency, and the platform package installed standalone.
    const bases = [
      join(root, '@openai', 'codex', 'node_modules', packageName),
      join(root, packageName),
    ];
    for (const base of bases) {
      const vendorDir = join(base, 'vendor', triple);
      const hostPath = join(vendorDir, 'bin', executable);
      if (!fs.existsSync(hostPath)) continue;

      // Prefer the payload manifest (authoritative for the vendored binaries);
      // fall back to the package manifest.
      const payload = readJson(join(vendorDir, 'codex-package.json'), fs);
      const pkg = readJson(join(base, 'package.json'), fs);
      const rawVersion = payload?.version
        || (typeof pkg?.version === 'string' ? pkg.version.split('-')[0] : null);

      if (!rawVersion) {
        inspected.push({ root: base, version: null, detail: 'no readable version' });
        continue;
      }
      if (rawVersion !== expectedVersion) {
        inspected.push({ root: base, version: rawVersion, detail: 'version mismatch' });
        continue;
      }
      return { ok: true, hostPath, version: rawVersion, root: base };
    }
  }
  return { ok: false, reason: inspected.length ? 'version-mismatch' : 'not-found', inspected };
}

function parseArgs(argv) {
  const result = { expectVersion: null, printPath: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--expect-version') result.expectVersion = argv[++index];
    else if (value === '--print-path') result.printPath = true;
    else throw new Error('Unknown argument: ' + value);
  }
  return result;
}

export function formatFailure(result, expectedVersion) {
  const lines = [`codex-code-mode-host ${expectedVersion} not found (${result.reason}).`];
  for (const entry of result.inspected) {
    lines.push(`  - ${entry.root}: ${entry.detail}${entry.version ? ` (found ${entry.version})` : ''}`);
  }
  return lines.join('\n');
}

/** Where the host must live so our patched `codex` finds it as a sibling. */
export function installedHostPath(installedCodexPath, platform = process.platform) {
  const executable = platform === 'win32'
    ? `${CODE_MODE_HOST_EXECUTABLE_NAME}.exe`
    : CODE_MODE_HOST_EXECUTABLE_NAME;
  return join(dirname(installedCodexPath), executable);
}

/**
 * Decide whether the installed host is already the right one.
 * Size+mtime is deliberately NOT used: only content identity counts.
 */
export function hostNeedsInstall({ sourcePath, targetPath, fs = { existsSync, statSync } }) {
  if (!fs.existsSync(targetPath)) return true;
  try {
    return fs.statSync(targetPath).size !== fs.statSync(sourcePath).size;
  } catch {
    return true;
  }
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = resolveCodeModeHost({ expectedVersion: args.expectVersion });
    if (!result.ok) {
      process.stderr.write(formatFailure(result, args.expectVersion) + '\n');
      process.exit(1);
    }
    process.stdout.write(args.printPath ? `${result.hostPath}\n` : `${result.version}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
