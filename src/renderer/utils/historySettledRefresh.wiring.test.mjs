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

const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

test('settled turns reconcile durable History without exposing the background apply wait', () => {
  const refreshBlock = between(
    history,
    'const refreshHistory = useCallback',
    'const refreshHistoryWithUpdating = useCallback',
  );
  assert.match(refreshBlock, /setHistoryUpdating\(visible\)/);
  assert.match(refreshBlock, /presentation=' \+ \(visible \? 'visible' : 'background'\)/);

  const lifecycleBlock = between(
    history,
    'const handleBusy =',
    'if (runtime.readyEvent) ipcRenderer.on',
  );
  assert.match(
    lifecycleBlock,
    /refreshHistoryInBackground\('busy-false:' \+ \(data\.reason \|\| 'unknown'\)\)/,
  );
  assert.match(lifecycleBlock, /refreshHistoryInBackground\('command-finished'\)/);
  assert.doesNotMatch(
    lifecycleBlock,
    /refreshHistoryWithUpdating\('busy-false:|refreshHistoryWithUpdating\('command-finished'/,
  );
});

test('a background settlement invalidates any older visible refresh indicator', () => {
  const backgroundBlock = between(
    history,
    'const refreshHistoryInBackground = useCallback',
    'const durableIdentityForPending = useCallback',
  );
  assert.match(backgroundBlock, /refreshHistory\(reason, false\)/);

  // The shared refresh path increments the same sequence before clearing the
  // flag. An older visible refresh can therefore neither survive nor restore
  // UPDATING when its promise eventually resolves.
  const refreshBlock = between(
    history,
    'const refreshHistory = useCallback',
    'const refreshHistoryWithUpdating = useCallback',
  );
  assert.match(refreshBlock, /const seq = \+\+historyUpdateSeqRef\.current/);
  assert.match(refreshBlock, /setHistoryUpdating\(visible\)/);
  assert.match(refreshBlock, /historyUpdateSeqRef\.current === seq/);
});
