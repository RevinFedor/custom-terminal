import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

// Code signing authenticates the archive as a blob, not its file table.
// If a source grows between the packer's stat and stream passes, later
// offsets can point into the previous file even in a valid signed bundle.
export async function validateAsarArchive(archivePath) {
  const { header, headerSize } = asar.getRawHeader(archivePath);
  const archive = await stat(archivePath);
  const payloadStart = 8 + headerSize;
  let checked = 0, bytes = 0;
  async function visit(directory, prefix = '') {
    for (const [name, node] of Object.entries(directory.files || {})) {
      if (name === '.' || name === '..' || path.basename(name) !== name) {
        throw new Error('Invalid ASAR path component');
      }
      const file = prefix ? prefix + '/' + name : name;
      if (node.files) { await visit(node, file); continue; }
      if (node.link) continue; // Its target is checked as a regular file.
      if (!Number.isSafeInteger(node.size) || node.size < 0
        || node.integrity?.algorithm !== 'SHA256'
        || !/^[a-f0-9]{64}$/.test(node.integrity?.hash || '')) {
        throw new Error('Missing/invalid ASAR integrity: ' + file);
      }
      const unpackedPath = archivePath + '.unpacked/' + file;
      const offset = Number(node.offset);
      const start = payloadStart + offset;
      if (!node.unpacked && (!Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(start + node.size) || start + node.size > archive.size)) {
        throw new Error('Invalid ASAR range: ' + file);
      }
      if (node.unpacked && (await stat(unpackedPath)).size !== node.size) {
        throw new Error('ASAR unpacked size mismatch: ' + file);
      }
      const hash = createHash('sha256');
      let readBytes = 0;
      if (node.size > 0) {
        const stream = node.unpacked ? createReadStream(unpackedPath)
          : createReadStream(archivePath, { start, end: start + node.size - 1 });
        for await (const chunk of stream) { hash.update(chunk); readBytes += chunk.length; }
      }
      if (readBytes !== node.size || hash.digest('hex') !== node.integrity.hash) {
        throw new Error('ASAR content integrity mismatch: ' + file
          + '; source may have changed during packaging. Rebuild before installing.');
      }
      checked++;
      bytes += readBytes;
    }
  }
  await visit(header);
  if (!checked) throw new Error('ASAR contains no verified files');
  return { checked, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: validate-app-asar.mjs <app.asar>');
  const result = await validateAsarArchive(path.resolve(process.argv[2]));
  console.log('[NotedInstall:asar] verified files=' + result.checked + ' bytes=' + result.bytes);
}
