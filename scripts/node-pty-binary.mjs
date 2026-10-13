import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

export const PTY_VERSION = '1.2.0-beta.13';
export const ELECTRON_VERSION = '28.3.3';
export const ELECTRON_ABI = '119';
export const PTY_MARKER = 'noted-terminal:node-pty:1.2.0-beta.13:node-addon-api:7.1.1:electron:28.3.3:exit-owner+unthrowable:v1';
export const LOADER_SHA = '807bc62c8b702377d591136862309718ba48fb2b9eca54f4b25fbe43838c8fc6';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Read bytes only: never dlopen a native module in the build/validation process.
// The private marker is emitted into a retained Mach-O section only when the
// macOS exception define is active. A string in a source/receipt is not proof.
export function inspectMachO(bytes, { arch, type = 8, marker = false } = {}) {
  const fail = reason => { throw new Error('[node-pty] invalid Mach-O: ' + reason); };
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) fail('expected thin 64-bit Mach-O');
  const actualArch = new Map([[0x100000c, 'arm64'], [0x1000007, 'x64']]).get(bytes.readUInt32LE(4));
  if (!actualArch || (arch && actualArch !== arch)) fail('architecture ' + actualArch + ', expected ' + arch);
  if (bytes.readUInt32LE(12) !== type) fail('unexpected file type');
  const count = bytes.readUInt32LE(16), commandsEnd = 32 + bytes.readUInt32LE(20);
  if (commandsEnd > bytes.length || count > (commandsEnd - 32) / 8) fail('load command bounds');
  const name = offset => bytes.subarray(offset, offset + 16).toString('ascii').replace(/\0.*$/, '');
  let offset = 32, markers = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > commandsEnd) fail('truncated command');
    const cmd = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > commandsEnd) fail('command size');
    if (cmd === 0x19) { // LC_SEGMENT_64
      if (size < 72) fail('segment size');
      const sections = bytes.readUInt32LE(offset + 64);
      if (72 + sections * 80 > size) fail('section table');
      for (let j = 0; j < sections; j++) {
        const section = offset + 72 + j * 80;
        if (name(section) !== '__noted_pty') continue;
        if (name(offset + 8) !== '__TEXT' || name(section + 16) !== '__TEXT') fail('marker segment');
        const start = bytes.readUInt32LE(section + 48), length = Number(bytes.readBigUInt64LE(section + 40));
        if (!Number.isSafeInteger(length) || start < commandsEnd || start + length > bytes.length) fail('marker bounds');
        if (!bytes.subarray(start, start + length).equals(Buffer.from(PTY_MARKER + '\0'))) fail('marker content');
        markers++;
      }
    }
    offset += size;
  }
  if (offset !== commandsEnd) fail('load command length');
  if (marker && markers !== 1) fail('missing/duplicate compiled node-pty fix marker');
  return { arch: actualArch, sha256: sha256(bytes) };
}

export function validatePackagedNodePty(asar, archivePath, packedFiles) {
  const root = 'node_modules/node-pty/';
  const read = relative => {
    const file = root + relative;
    if (!packedFiles.has(file)) throw new Error('[node-pty] ASAR missing ' + file);
    return asar.extractFile(archivePath, file);
  };
  const pkg = JSON.parse(read('package.json'));
  if (pkg.version !== PTY_VERSION) throw new Error('[node-pty] packaged version drift: ' + pkg.version);
  if (sha256(read('lib/utils.js')) !== LOADER_SHA) throw new Error('[node-pty] packaged native loader drift');
  const binary = 'build/Release/pty.node';
  const bytes = read(binary);
  if (!asar.statFile(archivePath, root + binary).unpacked) throw new Error('[node-pty] packaged pty.node must be unpacked');
  const proof = inspectMachO(bytes, { marker: true });
  const helper = 'build/Release/spawn-helper';
  inspectMachO(read(helper), { arch: proof.arch, type: 2 });
  if (!asar.statFile(archivePath, root + helper).unpacked
    || !(statSync(archivePath + '.unpacked/' + root + helper).mode & 0o111)) {
    throw new Error('[node-pty] packaged spawn-helper must be unpacked and executable');
  }
  return proof;
}
