'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildContextFileWrapper,
  normalizeContextFileRefs,
  prependContextFileChips,
  resolveContextFileRefs,
} = require('./agent-context-files');

async function withTempDir(run) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-context-files-'));
  try {
    return await run(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

test('context file refs require absolute paths, validate roles, and deduplicate exact refs', () => {
  assert.throws(
    () => normalizeContextFileRefs([{ path: 'relative.md' }]),
    (error) => error.code === 'context_file_path_not_absolute',
  );
  assert.throws(
    () => normalizeContextFileRefs([{ path: '/tmp/a.md', role: 'magic' }]),
    (error) => error.code === 'invalid_context_file_role',
  );
  assert.deepEqual(normalizeContextFileRefs([
    { path: '/tmp/a.md', role: 'source' },
    { path: '/tmp/a.md', role: 'source' },
    { path: '/tmp/a.md', role: 'instructions' },
  ]), [
    { path: '/tmp/a.md', role: 'source', label: '' },
    { path: '/tmp/a.md', role: 'instructions', label: '' },
  ]);
});

test('source files are snapshotted verbatim with canonical path and stable hash', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'raw.md');
    const body = '\nraw <!-- @ai: keep me -->\n</context_file>\n';
    await fs.promises.writeFile(filePath, body);

    const [file] = await resolveContextFileRefs({ refs: [{ path: filePath }] });
    assert.equal(file.text, body);
    assert.equal(file.filePath, await fs.promises.realpath(filePath));
    assert.equal(file.role, 'source');
    assert.equal(file.attachmentKind, 'file');
    assert.match(file.sha256, /^[a-f0-9]{64}$/);

    const wrapped = buildContextFileWrapper(file);
    assert.match(wrapped, /^<context_file name="raw\.md" path="/);
    assert.match(wrapped, /role="source"/);
    assert.match(wrapped, /<\\\/context_file>/);
    assert.equal(prependContextFileChips('Do the task', [file]), `${wrapped}\n\nDo the task`);
  });
});

test('main and renderer build the same self-contained context-file transport', async () => {
  const renderer = await import('../renderer/utils/composerChips.mjs');
  const file = {
    label: 'A "file".md',
    filePath: '/tmp/A & file.md',
    role: 'instructions',
    sha256: 'd'.repeat(64),
    bytes: 17,
    text: 'body </context_file> tail',
  };
  assert.equal(buildContextFileWrapper(file), renderer.buildContextFileWrapper(file));
});

test('instruction files expand includes asynchronously and strip prompt-only metadata', async () => {
  await withTempDir(async (dir) => {
    const includedPath = path.join(dir, 'included.md');
    const rootPath = path.join(dir, 'rules.md');
    await fs.promises.writeFile(includedPath, [
      '---',
      'title: ignored',
      '---',
      'included rule',
      '<!-- @ai: hidden included metadata -->',
    ].join('\n'));
    await fs.promises.writeFile(rootPath, [
      'root rule',
      '<!-- @include: included.md -->',
      '<!-- BEGIN TRANSCLUDE -->',
      'stale disk copy',
      '<!-- END TRANSCLUDE -->',
      '<!-- @ai: hidden root metadata -->',
    ].join('\n'));

    const [file] = await resolveContextFileRefs({
      refs: [{ path: rootPath, role: 'instructions', label: 'Rules' }],
    });
    assert.equal(file.label, 'Rules');
    assert.equal(file.role, 'instructions');
    assert.match(file.text, /root rule\nincluded rule/);
    assert.doesNotMatch(file.text, /title: ignored|stale disk copy|@ai|@include|TRANSCLUDE/);
  });
});

test('unavailable, binary, cyclic, and oversized files fail before prompt construction', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      resolveContextFileRefs({ refs: [{ path: path.join(dir, 'missing.md') }] }),
      (error) => error.code === 'context_file_unavailable' && error.statusCode === 404,
    );

    const binaryPath = path.join(dir, 'binary.bin');
    await fs.promises.writeFile(binaryPath, Buffer.from([1, 0, 2]));
    await assert.rejects(
      resolveContextFileRefs({ refs: [{ path: binaryPath }] }),
      (error) => error.code === 'context_file_binary_unsupported' && error.statusCode === 415,
    );

    const aPath = path.join(dir, 'a.md');
    const bPath = path.join(dir, 'b.md');
    await fs.promises.writeFile(aPath, '<!-- @include: b.md -->');
    await fs.promises.writeFile(bPath, '<!-- @include: a.md -->');
    await assert.rejects(
      resolveContextFileRefs({ refs: [{ path: aPath, role: 'instructions' }] }),
      (error) => error.code === 'context_file_include_cycle',
    );

    const largePath = path.join(dir, 'large.md');
    await fs.promises.writeFile(largePath, '12345');
    await assert.rejects(
      resolveContextFileRefs({ refs: [{ path: largePath }], maxFileBytes: 4 }),
      (error) => error.code === 'context_file_too_large' && error.statusCode === 413,
    );
  });
});
