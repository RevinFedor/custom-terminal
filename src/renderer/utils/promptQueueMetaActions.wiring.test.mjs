import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(renderer, relative), 'utf8');

test('Run After meta-actions wire footer selection, Timeline target and runner execution', () => {
  const overlay = read('components/Workspace/PromptQueueOverlay.tsx');
  const timeline = read('components/Workspace/Timeline.tsx');
  const runner = read('hooks/usePromptQueueRunner.ts');
  const store = read('store/usePromptQueueStore.ts');

  assert.match(overlay, /data-prompt-queue-meta-actions/);
  assert.match(overlay, /publishQueuedRewindTarget\(tabId, requestId\)/);
  assert.match(read('utils/queuedRewindTarget.mjs'), /prompt-queue:request-rewind-target/);
  assert.match(timeline, /pendingQueuedRewindTarget\(tabId\)/);
  assert.match(overlay, /addMetaAction\(tabId, \{ kind: 'restart' \}/);
  assert.match(overlay, /codexSettings\.models/,
    'Codex queue choices must use the Settings-backed model catalog');
  assert.match(overlay, /kind: 'model-effort',[\s\S]{0,120}model: model\.id/,
    'the queued action stores the Settings model id, not its display label');
  assert.match(timeline, /data-prompt-queue-rewind-target-mode/);
  assert.match(timeline, /prompt-queue:rewind-target-selected/);
  assert.match(store, /metaAction\?: QueuedMetaAction/);
  assert.match(runner, /head\.metaAction/);
  assert.match(runner, /terminal:deterministic-stop/);
  assert.match(runner, /executeHistoryRewriteRewindScenario/);
  assert.match(runner, /classifyQueuedCodexSettingsIntent/);
  assert.doesNotMatch(runner, /if \(intentError\) \{\s*finish\(/,
    'a retryable main intent error must not stop Run After before the same revision settles');
});
