import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = fs.readFileSync(new URL('../components/Workspace/Timeline.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const getRewindRequestState =');
const end = source.indexOf('\n  // Violet Rewind from a SINGLE point.', start);
assert.ok(start >= 0 && end > start);
const actual = transformSync(source.slice(start, end)
  + '\nglobalThis.requestRewind = requestRewind;', { loader: 'ts', format: 'esm' }).code;

async function run({ cached, fresh }) {
  const events = [];
  const context = vm.createContext({
    console: { warn() {} }, tabId: 'T', toolType: 'codex', sessionId: 'S',
    rewindAgentPresence: cached, rewindAgentStatus: cached?.status || null,
    historyActionSnapshot: cached?.runtimeSnapshot || null,
    rewindState: null, readOnly: false, isCodex: true,
    isTabAiBusy: false, isTurnBusy: false, lifecycleBlocksHistoryAction: false,
    getRewindTargetContext: () => ({ targetUuid: 'target' }),
    getHistoryAgentRuntime: () => ({ getPresence: async () => { events.push('read-current'); return fresh; } }),
    setRewindAgentPresence: value => events.push('observe:' + value?.status),
    setContextMenu: value => events.push('menu:' + value),
    handleRewind: async () => { events.push('native-start'); },
    useUIStore: { getState: () => ({ showToast: () => events.push('toast') }) },
    rewindRequestPendingTabRef: { current: null },
  });
  vm.runInContext(actual, context);
  const accepted = await context.requestRewind({ uuid: 'target' }, 'native', 'history-message');
  return { accepted, events };
}

test('History native Rewind reads current main owner after a stopped→ready transition', async () => {
  const result = await run({
    cached: { status: 'inactive', runtimeSnapshot: { canNativeRewind: false } },
    fresh: { status: 'active', runtimeSnapshot: { canNativeRewind: true } },
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.events, ['read-current', 'observe:active', 'menu:null', 'native-start']);
});

test('a stale positive Rewind button cannot override current main refusal', async () => {
  const result = await run({
    cached: { status: 'active', runtimeSnapshot: { canNativeRewind: true } },
    fresh: { status: 'unknown', runtimeSnapshot: { canNativeRewind: false,
      historyActionReason: 'runtime-identity-unknown' } },
  });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.events, ['read-current', 'observe:unknown', 'toast']);
});
