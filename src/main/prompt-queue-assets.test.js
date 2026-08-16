const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PromptQueueAssetStore,
  collectComposerDraftAssetIds,
  collectReferencedAssetIds,
} = require('./prompt-queue-assets');

async function fixture() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prompt-queue-assets-test-'));
  const rootDir = path.join(dir, 'assets');
  const sourcePath = path.join(dir, 'source.png');
  await fs.promises.writeFile(sourcePath, Buffer.from('stable-image-bytes'));
  return {
    dir,
    rootDir,
    sourcePath,
    cleanup: () => fs.promises.rm(dir, { recursive: true, force: true }),
  };
}

test('materialized image survives source deletion and a new store instance', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const firstStore = new PromptQueueAssetStore({ rootDir: f.rootDir });
  const first = await firstStore.materializeRef({ id: 1, path: f.sourcePath, mediaType: 'image/png', size: 0 });
  assert.equal(first.availability, 'available');
  assert.match(first.assetId, /^[a-f0-9]{64}\.png$/);
  assert.equal(await fs.promises.readFile(first.path, 'utf8'), 'stable-image-bytes');

  await fs.promises.unlink(f.sourcePath);
  const restoredStore = new PromptQueueAssetStore({ rootDir: f.rootDir });
  const restored = await restoredStore.materializeRef({ ...first, path: '/missing/old-user-data/path.png' });
  assert.equal(restored.availability, 'available');
  assert.equal(restored.assetId, first.assetId);
  assert.equal(restored.path, first.path);
});

test('same bytes deduplicate while preserving queue slot ids', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const secondSource = path.join(f.dir, 'second.png');
  await fs.promises.copyFile(f.sourcePath, secondSource);
  const store = new PromptQueueAssetStore({ rootDir: f.rootDir });
  const refs = await store.materializeRefs([
    { id: 4, path: f.sourcePath, mediaType: 'image/png', size: 0 },
    { id: 9, path: secondSource, mediaType: 'image/png', size: 0 },
  ]);
  assert.equal(refs[0].assetId, refs[1].assetId);
  assert.equal(refs[0].id, 4);
  assert.equal(refs[1].id, 9);
});

test('deduplicating old bytes refreshes asset age before garbage collection', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let now = 1_900_000_000_000;
  const store = new PromptQueueAssetStore({ rootDir: f.rootDir, now: () => now });
  const first = await store.materializeRef({ id: 1, path: f.sourcePath, mediaType: 'image/png', size: 0 });
  const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000);
  await fs.promises.utimes(first.path, oldDate, oldDate);

  now += 1000;
  const duplicateSource = path.join(f.dir, 'duplicate.png');
  await fs.promises.copyFile(f.sourcePath, duplicateSource);
  const duplicate = await store.materializeRef({ id: 2, path: duplicateSource, mediaType: 'image/png', size: 0 });
  assert.equal(duplicate.assetId, first.assetId);
  assert.ok((await fs.promises.stat(first.path)).mtimeMs >= now - 5);

  const result = await store.garbageCollect(new Set());
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(first.path), true);
});

test('missing source remains explicit and is never reported available', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const store = new PromptQueueAssetStore({ rootDir: f.rootDir });
  const ref = await store.materializeRef({ id: 1, path: path.join(f.dir, 'missing.png'), mediaType: 'image/png', size: 0 });
  assert.equal(ref.availability, 'missing');
  assert.equal(ref.error, 'image_path_missing');
});

test('synchronous History recovery accepts only an existing content-addressed managed asset', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const store = new PromptQueueAssetStore({ rootDir: f.rootDir });
  const materialized = await store.materializeRef({
    id: 7,
    path: f.sourcePath,
    mediaType: 'image/png',
    size: 0,
  });

  const recovered = store.existingManagedRefSync({ path: materialized.path });
  assert.equal(recovered.path, materialized.path);
  assert.equal(recovered.assetId, materialized.assetId);
  assert.equal(recovered.availability, 'available');
  assert.equal(recovered.size, Buffer.byteLength('stable-image-bytes'));
  assert.equal(store.existingManagedRefSync({ path: f.sourcePath }), null);
  assert.equal(store.existingManagedRefSync({
    path: path.join(f.rootDir, 'not-content-addressed.png'),
  }), null);
});

test('garbage collection keeps referenced assets and removes only old unreferenced assets', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let now = 1_900_000_000_000;
  const store = new PromptQueueAssetStore({ rootDir: f.rootDir, now: () => now });
  const kept = await store.materializeRef({ id: 1, path: f.sourcePath, mediaType: 'image/png', size: 0 });
  await fs.promises.writeFile(f.sourcePath, Buffer.from('other-image'));
  const removed = await store.materializeRef({ id: 2, path: f.sourcePath, mediaType: 'image/png', size: 0 });
  const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000);
  await fs.promises.utimes(kept.path, oldDate, oldDate);
  await fs.promises.utimes(removed.path, oldDate, oldDate);

  const result = await store.garbageCollect(new Set([kept.assetId]));
  assert.deepEqual(result.removed, [removed.assetId]);
  assert.equal(fs.existsSync(kept.path), true);
  assert.equal(fs.existsSync(removed.path), false);
});

test('queue snapshot reference collector reads nested item assets', () => {
  const ids = collectReferencedAssetIds({
    tab: {
      items: [{ imagePaths: [{ assetId: 'a'.repeat(64) + '.png' }] }],
    },
  });
  assert.deepEqual([...ids], ['a'.repeat(64) + '.png']);
});

test('History composer draft reference collector protects persisted image assets', () => {
  const available = 'b'.repeat(64) + '.png';
  const fallbackPath = '/tmp/prompt-queue-assets/' + 'c'.repeat(64) + '.webp';
  const ids = collectComposerDraftAssetIds(JSON.stringify({
    'tab-a': {
      text: '[Image #1] [Image #2]',
      images: [
        { id: 1, assetId: available, path: '/old/path.png' },
        { id: 2, path: fallbackPath },
      ],
      chips: [],
      updatedAt: 10,
    },
  }));
  assert.deepEqual([...ids], [available, 'c'.repeat(64) + '.webp']);
});
