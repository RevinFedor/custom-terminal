// Regression 01.11.2026: the IPC attribution wrapper called an unbound
// `markRendererActivity` (only re-exported, never imported). Every marked
// delivery threw, and because ipcRenderer is a plain EventEmitter every LATER
// listener of that event was skipped: History never received
// agent-transcript:changed / live-message, so Claude replies vanished.
// Bundles the REAL probe module and drives a real EventEmitter.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadProbe() {
  const out = await build({ entryPoints: [path.join(here, 'perfFreezeProbe.ts')], bundle: true, write: false,
    format: 'esm', platform: 'browser', logLevel: 'silent',
    plugins: [{ name: 'stub-stores', setup(b) {
      b.onResolve({ filter: /store\/useWorkspaceStore/ }, () => ({ path: 'ws', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useWorkspaceStore={getState:()=>({})};', loader: 'js' }));
    } }] });
  const url = 'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64');
  return import(url);
}

test('a throwing subscriber no longer starves later subscribers, and the wrapper itself never throws', async () => {
  const ipc = new EventEmitter();
  const lines = [];
  globalThis.window = { require: id => (id === 'electron' ? { ipcRenderer: ipc } : undefined) };
  globalThis.performance ??= { now: () => Date.now() };
  const probe = await loadProbe();
  probe.installIpcDeliveryAttribution(line => lines.push(line));
  const got = [];
  ipc.on('agent-transcript:changed', () => { throw new Error('faulty subscriber'); });
  ipc.on('agent-transcript:changed', (_e, d) => got.push(d.sessionId));
  for (let i = 0; i < 70; i++) ipc.emit('agent-transcript:changed', {}, { sessionId: 'S' + i });
  assert.equal(got.length, 70, 'History-like subscriber received every event (marked and unmarked paths)');
  assert.ok(lines.some(l => l.startsWith('[IpcListenerError] channel=agent-transcript:changed')));
  assert.ok(!lines.some(l => /markRendererActivity is not defined/.test(l)), 'wrapper has no unbound name');
  // Removal finds the same wrapper.
  const fn = () => got.push('x');
  ipc.on('c2', fn); ipc.removeListener('c2', fn); ipc.emit('c2', {});
  assert.ok(!got.includes('x'));
});
