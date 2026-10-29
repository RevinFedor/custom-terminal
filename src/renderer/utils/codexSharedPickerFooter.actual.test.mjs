import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { rendererSharedCjsDevPlugin } from '../../../scripts/lib/renderer-shared-cjs.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const file = path.join(root, 'src/shared/codex-native-picker-proof.cjs');
const importer = path.join(root, 'src/renderer/utils/codexEffectiveSettings.mjs');
const require = createRequire(import.meta.url);

test('real shared CJS alias and in-memory browser bundle preserve model identity without touching app build output', async () => {
  const plugin = rendererSharedCjsDevPlugin(root);
  const resolved = await plugin.resolveId.call({ resolve: async (id) => ({ id }) },
    '../../shared/codex-native-picker-proof.cjs', importer, {});
  const alias = plugin.config().resolve.alias.find(row => row.find === resolved?.id);
  assert.equal(alias?.replacement, file);
  const source = await readFile(file, 'utf8');
  const result = await build({ stdin: { contents: source, sourcefile: file, resolveDir: path.dirname(file) },
    bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
  assert.equal(result.outputFiles.length, 1);
  const browser = (await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))).default;
  const node = require('../../shared/codex-native-picker-proof.cjs');
  const catalog = [{ id: 'gpt-7.2-artemis', label: 'GPT-7.2 Artemis' }];
  for (const [text, rows] of [
    ['• Model changed to gpt-6.1-terra max', []],
    ['• Model changed to GPT-7.2 Artemis high', catalog],
    ['• Model changed to GPT-7.2 Artemis high', []],
  ]) assert.deepEqual(browser.parseCodexModelChangeAcknowledgement(text, rows), node.parseCodexModelChangeAcknowledgement(text, rows));
});
