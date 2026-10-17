import * as fs from 'node:fs/promises';
import { PTY_MARKER } from './node-pty-binary.mjs';
import { patchNodePtyWriteTrace } from './node-pty-write-trace.mjs';

// Synthetic Mach-O-shaped bytes only. No executable code, compiler or dlopen.
export function fakeMachO({ arch = 'arm64', type = 8, marker = true } = {}) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4);
  bytes.writeUInt32LE(type, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(152, 20);
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(152, 36);
  bytes.write('__TEXT', 40);
  bytes.writeUInt32LE(1, 96);
  bytes.write(marker ? '__noted_pty' : '__text', 104);
  bytes.write('__TEXT', 120);
  const text = marker ? PTY_MARKER + '\0' : 'ordinary prebuilt module';
  bytes.writeBigUInt64LE(BigInt(text.length), 144);
  bytes.writeUInt32LE(184, 152);
  bytes.write(text, 184);
  return bytes;
}

export async function writePackagedNodePtyFixture(source) {
  const root = source + '/node_modules/node-pty';
  await fs.mkdir(root + '/build/Release', { recursive: true });
  await fs.mkdir(root + '/lib', { recursive: true });
  await fs.writeFile(root + '/lib/unixTerminal.js', patchNodePtyWriteTrace(
    await fs.readFile(new URL('../node_modules/node-pty/lib/unixTerminal.js', import.meta.url), 'utf8')));
  await fs.copyFile(new URL('../node_modules/node-pty/package.json', import.meta.url), root + '/package.json');
  await fs.copyFile(new URL('../node_modules/node-pty/lib/utils.js', import.meta.url), root + '/lib/utils.js');
  await fs.writeFile(root + '/build/Release/pty.node', fakeMachO());
  await fs.writeFile(root + '/build/Release/spawn-helper', fakeMachO({ type: 2, marker: false }), { mode: 0o755 });
}
