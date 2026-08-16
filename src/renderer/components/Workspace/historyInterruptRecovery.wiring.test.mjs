import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('./HistoryPanel.tsx', import.meta.url),
  'utf8',
);

test('interrupt recovery probes the returned terminal draft before trusting cached History', () => {
  const start = source.indexOf("const handleInterruptRecovery");
  const end = source.indexOf("ipcRenderer.on(runtime.busyEvent", start);
  assert.ok(start >= 0 && end > start, 'interrupt recovery effect must exist');
  const block = source.slice(start, end);
  const draftProbe = block.indexOf("readTerminalDraft('interrupt-recovery')");
  const forcedHistoryRefresh = block.indexOf('forceRefresh: true', draftProbe);
  assert.ok(draftProbe >= 0, 'authoritative interrupt must inspect the real terminal draft');
  assert.ok(
    forcedHistoryRefresh > draftProbe,
    'an exact returned draft must force a fresh active-branch read after the draft probe',
  );
  assert.equal(
    block.slice(0, forcedHistoryRefresh).includes('hasDurablePendingPrompt(pending)'),
    false,
    'a cached durable row must not bypass either the draft match or fresh branch read',
  );
});
