import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import asar from '@electron/asar';
import { validateAsarArchive as validateNotedArchive } from './validate-app-asar.mjs';

// These fixtures exercise generic ASAR integrity, not a packaged Noted app.
const validateAsarArchive = archive => validateNotedArchive(archive, { requirePatchedNodePty: false });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'noted-asar-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const archive = path.join(root, 'app.asar');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'main.js'), 'module.exports = "original";');
  await fs.writeFile(path.join(source, 'empty'), '');
  await fs.writeFile(path.join(source, 'external.node'), 'native file fixture');
  await asar.createPackageWithOptions(source, archive, { unpack: '*.node' });
  return archive;
}

test('verifies real packed, unpacked and empty files using bounded streams', async t => {
  const archive = await fixture(t);
  assert.equal((await validateAsarArchive(archive)).checked, 3);
});

test('rejects bytes at a wrong archive offset even with a valid file-table hash', async t => {
  const archive = await fixture(t);
  const { header, headerSize } = asar.getRawHeader(archive);
  const fd = await fs.open(archive, 'r+');
  await fd.write(Buffer.from('CORRUPT'), 0, 7, 8 + headerSize + Number(header.files['main.js'].offset));
  await fd.close();
  await assert.rejects(validateAsarArchive(archive), /ASAR content integrity mismatch: main.js/);
});

test('unpacked tampering and truncated archive fail before installation', async t => {
  const archive = await fixture(t);
  await fs.writeFile(archive + '.unpacked/external.node', 'changed native file');
  await assert.rejects(validateAsarArchive(archive), /ASAR.*mismatch: external.node/);
  const other = await fixture(t);
  await fs.truncate(other, (await fs.stat(other)).size - 4);
  await assert.rejects(validateAsarArchive(other), /Invalid ASAR range: main.js/);
});

test('rejects a bundled main entry whose static relative require is absent', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'noted-asar-require-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const archive = path.join(root, 'app.asar');
  await fs.mkdir(path.join(source, 'dist/main'), { recursive: true });
  await fs.writeFile(
    path.join(source, 'dist/main/main.js'),
    'const helper = require("../shared/helper.cjs"); module.exports = helper;',
  );
  await asar.createPackage(source, archive);
  await assert.rejects(
    validateAsarArchive(archive),
    /ASAR missing static relative require target: dist\/main\/main\.js -> \.\.\/shared\/helper\.cjs/,
  );
});

test('accepts a bundled main entry when its static relative target is packed', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'noted-asar-require-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const archive = path.join(root, 'app.asar');
  await fs.mkdir(path.join(source, 'dist/main'), { recursive: true });
  await fs.mkdir(path.join(source, 'dist/shared'), { recursive: true });
  await fs.writeFile(
    path.join(source, 'dist/main/main.js'),
    'const helper = require("../shared/helper.cjs"); module.exports = helper;',
  );
  await fs.writeFile(path.join(source, 'dist/shared/helper.cjs'), 'module.exports = 1;');
  await asar.createPackage(source, archive);
  assert.equal((await validateAsarArchive(archive)).checked, 2);
});
