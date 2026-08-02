const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CodexImageTransport,
  buildCodexImagePastePlan,
  replaceUnavailableImagePathMarkers,
} = require('./codex-image-transport');

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

test('degrades a missing image to an explicit ordered error segment', () => {
  const marker = '[imagePath: /missing/image.png]';
  const plan = buildCodexImagePastePlan(
    marker + ' question',
    () => ({ success: false, path: '/missing/image.png', error: 'image_path_missing' }),
  );

  assert.equal(plan.text, '[imageError: codex_image_path_unavailable #1] question');
  assert.deepEqual(plan.segments, [{
    kind: 'text',
    text: '[imageError: codex_image_path_unavailable #1] question',
  }]);
  assert.deepEqual(plan.missing, [{ path: '/missing/image.png', error: 'image_path_missing' }]);
});

test('keeps relative paths and prose examples as literal text', () => {
  let stageCalls = 0;
  const input = 'docs [imagePath: absolute path] and [imagePath: images/example.png]';
  const plan = buildCodexImagePastePlan(input, () => {
    stageCalls += 1;
    return { success: false, error: 'must_not_run' };
  });

  assert.equal(plan.text, input);
  assert.deepEqual(plan.segments, [{ kind: 'text', text: input }]);
  assert.equal(plan.replaced, 0);
  assert.equal(stageCalls, 0);
  assert.deepEqual(plan.missing, []);
});

test('keeps surrounding text and available images when one middle image disappears', () => {
  const plan = buildCodexImagePastePlan(
    'before [imagePath: /ok.png] middle [imagePath: /gone.png] after',
    (rawPath) => rawPath.trim() === '/ok.png'
      ? { success: true, path: '/ok.png', inputPath: '/tmp/ok.png' }
      : { success: false, path: '/gone.png', error: 'image_path_missing' },
  );

  assert.deepEqual(plan.segments, [
    { kind: 'text', text: 'before ' },
    { kind: 'image', text: '/tmp/ok.png', sourcePath: '/ok.png' },
    { kind: 'text', text: ' middle [imageError: codex_image_path_unavailable #2] after' },
  ]);
  assert.equal(plan.staged.length, 1);
  assert.equal(plan.missing.length, 1);
});

test('preflight replacement changes only unavailable path slots and preserves order', () => {
  const result = replaceUnavailableImagePathMarkers(
    'example [imagePath: path] A [imagePath: /ok.png] B [imagePath: /gone.png] C',
    [{ path: '/gone.png', error: 'image_path_missing' }],
  );
  assert.equal(
    result,
    'example [imagePath: path] A [imagePath: /ok.png] B [imageError: queue_image_path_unavailable #2] C',
  );
});
