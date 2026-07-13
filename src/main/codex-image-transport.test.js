const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CodexImageTransport, buildCodexImagePastePlan } = require('./codex-image-transport');

test('stages a durable image through a whitespace-free alias without copying bytes', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-image-transport-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourceDir = path.join(dir, 'Application Support', 'noted-terminal');
  const sourcePath = path.join(sourceDir, 'asset.png');
  await fs.promises.mkdir(sourceDir, { recursive: true });
  await fs.promises.writeFile(sourcePath, Buffer.from('4k-image-bytes'));
  const aliasRoot = path.join(dir, 'aliases');
  const transport = new CodexImageTransport({ rootDir: aliasRoot });

  const first = transport.stageSync({
    path: sourcePath,
    assetId: 'a'.repeat(64) + '.png',
  });
  assert.equal(first.success, true);
  assert.equal(/\s/.test(first.path), false);
  assert.equal(await fs.promises.readFile(first.path, 'utf8'), '4k-image-bytes');
  assert.equal(fs.lstatSync(first.path).isSymbolicLink(), true);

  const second = transport.stageSync({
    path: sourcePath,
    assetId: 'a'.repeat(64) + '.png',
  });
  assert.equal(second.path, first.path);
});

test('refuses a transport root whose own path contains whitespace', () => {
  assert.throws(
    () => new CodexImageTransport({ rootDir: '/tmp/noted terminal aliases' }),
    /must not contain whitespace/,
  );
});

test('keeps an image path isolated from text appended to the queued prompt', () => {
  const sourcePath = '/durable/image.png';
  const inputPath = '/tmp/noted-terminal-codex-image-input/image.png';
  const plan = buildCodexImagePastePlan(
    `[imagePath: ${sourcePath}] describe this image`,
    (rawPath) => ({ success: true, path: rawPath.trim(), inputPath }),
  );

  assert.equal(plan.text, `${inputPath} describe this image`);
  assert.deepEqual(plan.segments, [
    { kind: 'image', text: inputPath, sourcePath },
    { kind: 'text', text: ' describe this image' },
  ]);
  assert.equal(plan.replaced, 1);
  assert.equal(plan.staged.length, 1);
  assert.deepEqual(plan.missing, []);
});

test('preserves text and multiple image positions as separate paste segments', () => {
  const first = '/durable/first.png';
  const second = '/durable/second.webp';
  const plan = buildCodexImagePastePlan(
    `before [imagePath: ${first}] middle [imagePath: ${second}] after`,
    (rawPath) => ({
      success: true,
      path: rawPath.trim(),
      inputPath: '/tmp/' + path.basename(rawPath.trim()),
    }),
  );

  assert.deepEqual(plan.segments.map(segment => [segment.kind, segment.text]), [
    ['text', 'before '],
    ['image', '/tmp/first.png'],
    ['text', ' middle '],
    ['image', '/tmp/second.webp'],
    ['text', ' after'],
  ]);
  assert.deepEqual(plan.staged.map(result => result.path), [first, second]);
});

test('reports a missing image without silently dropping its marker', () => {
  const marker = '[imagePath: /missing/image.png]';
  const plan = buildCodexImagePastePlan(
    marker + ' question',
    () => ({ success: false, path: '/missing/image.png', error: 'image_path_missing' }),
  );

  assert.equal(plan.text, marker + ' question');
  assert.deepEqual(plan.segments, [{ kind: 'text', text: marker + ' question' }]);
  assert.deepEqual(plan.missing, [{ path: '/missing/image.png', error: 'image_path_missing' }]);
});
