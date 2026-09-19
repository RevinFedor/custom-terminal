import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const history = fs.readFileSync(
  path.join(repo, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);
const presence = fs.readFileSync(
  path.join(repo, 'src/renderer/utils/codexPtyPresence.mjs'),
  'utf8',
);

test('History retries the current presence generation instead of leaving CHECKING terminal', () => {
  const refreshStart = history.indexOf('const refreshPresence = useCallback');
  const refreshEnd = history.indexOf('const refreshHistoryWithUpdating', refreshStart);
  const block = history.slice(refreshStart, refreshEnd);
  assert.match(block, /presenceGenerationRef\.current !== presenceGeneration[\s\S]{0,420}flight\.trailing = true;[\s\S]{0,80}continue;/);
  assert.match(block, /catch \(e: any\)[\s\S]*presenceGenerationRef\.current !== presenceGeneration[\s\S]{0,180}flight\.trailing = true;/);
});

test('successful presence stays authoritative when an optional runtime projection fails', () => {
  const refreshStart = history.indexOf('const refreshPresence = useCallback');
  const refreshEnd = history.indexOf('const refreshHistoryWithUpdating', refreshStart);
  const block = history.slice(refreshStart, refreshEnd);
  assert.match(block, /applyHistoryPresenceProjection\(\{[\s\S]{0,360}setStatus: \(next\) => setStatusFrom\(next, 'presence'\)/);
  assert.match(block, /onProjectionError:[\s\S]{0,260}runtime projection failed/);
  assert.doesNotMatch(block, /onRuntimeSnapshotChange\?\.\(presence\.runtimeSnapshot \|\| null\)/);
});

test('History Codex presence reads the event projection, not the observation command', () => {
  assert.match(presence, /invoke\('codex:get-runtime-projection'/);
  assert.doesNotMatch(presence, /invoke\('codex:get-runtime-session'/);
});
