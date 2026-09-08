import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installCaptureEditorHelper } from './install-claude-turn-hook.mjs';

test('versioned capture install leaves the live legacy helper untouched, supports dry-run and is idempotent', async t => {
  const taskHome = await mkdtemp('/tmp/noted-editor-install-test-');
  t.after(() => rm(taskHome, { recursive: true, force: true }));
  const hooks = join(taskHome, '.claude', 'hooks');
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main');
  await mkdir(hooks, { recursive: true });
  const legacy = join(hooks, 'noted-code-grab.js');
  await writeFile(legacy, 'live legacy main must keep this exact helper\n');
  const dryRun = await installCaptureEditorHelper({ home: taskHome, dryRun: true });
  assert.equal(dryRun.changed, true);
  assert.equal(existsSync(join(hooks, 'noted-code-grab-v2.js')), false);
  assert.equal(existsSync(join(hooks, 'agent-input-capture-protocol.js')), false);
  const first = await installCaptureEditorHelper({ home: taskHome });
  assert.equal(first.changed, true);
  for (const basename of ['agent-input-capture-protocol.js', 'noted-code-grab-v2.js']) {
    assert.deepEqual(await readFile(join(hooks, basename)), await readFile(join(sourceRoot, basename)));
  }
  assert.notEqual((await stat(join(hooks, 'noted-code-grab-v2.js'))).mode & 0o111, 0);
  assert.equal(await readFile(legacy, 'utf8'), 'live legacy main must keep this exact helper\n');
  assert.equal((await installCaptureEditorHelper({ home: taskHome })).changed, false);
  await writeFile(join(hooks, 'agent-input-capture-protocol.js'), 'outdated protocol\n');
  const repaired = await installCaptureEditorHelper({ home: taskHome });
  assert.equal(repaired.changed, true);
  assert.deepEqual(await readFile(join(hooks, 'agent-input-capture-protocol.js')),
    await readFile(join(sourceRoot, 'agent-input-capture-protocol.js')));
  assert.equal(await readFile(legacy, 'utf8'), 'live legacy main must keep this exact helper\n');
});
