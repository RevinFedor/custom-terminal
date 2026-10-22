// Execute the real store preference initializer/actions with a controlled store
// and IPC. This is a source wiring control, not a mounted Zustand/React test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createPaneStripInterfacePreferences, initialPaneStripInterfacePreferences } from '../utils/paneStripInterfacePreferences.mjs';

const require = createRequire(import.meta.url);
let compile;
try { const { transformSync } = require('esbuild'); compile = source => transformSync(source, { loader: 'ts', format: 'cjs' }).code; }
catch { compile = require('node:module').stripTypeScriptTypes; }
assert.equal(typeof compile, 'function', 'source control needs esbuild or Node with stripTypeScriptTypes');

const source = fs.readFileSync(process.env.NOTED_INTERFACE_PREFS_PREIMAGE
  ? path.join(process.env.NOTED_INTERFACE_PREFS_PREIMAGE, 'src/renderer/store/useUIStore.ts')
  : new URL('./useUIStore.ts', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const bootstrapStart = source.indexOf('const paneStripInterfacePreferences = createPaneStripInterfacePreferences(');
  const bootstrapEndMarker = 'void paneStripInterfacePreferences.hydrate();';
  const bootstrapEnd = source.indexOf(bootstrapEndMarker, bootstrapStart);
  assert.ok(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart, 'actual store must install the preference owner');
  const actions = ['setPaneStripSelectedFirst', 'setPaneStripCloseOnClick', 'setPaneStripInstantHover', 'retryPaneStripInterfacePreference']
    .map(name => {
      const line = source.slice(source.indexOf('export const useUIStore =')).split('\n').find(value => value.trim().startsWith(name + ': ('));
      assert.ok(line, 'actual public action exists: ' + name); return line;
    }).join('\n');
  const start = source.indexOf('  ...(initialPaneStripInterfacePreferences()');
  assert.ok(start >= 0, 'actual initial store spreads both OFF modes');
  const initialLine = source.slice(start, source.indexOf('\n', start));
  const reads = new Map(), writes = [], warnings = [];
  let state = {};
  const api = { getState: () => state, setState: patch => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  } };
  const context = {
    createPaneStripInterfacePreferences, initialPaneStripInterfacePreferences, useUIStore: api,
    console: { warn: (...args) => warnings.push(args) },
    window: { require: name => {
      assert.equal(name, 'electron'); return { ipcRenderer: { invoke: (channel, payload) => {
        if (channel === 'app:getState') { const read = deferred(); reads.set(payload, read); return read.promise; }
        assert.equal(channel, 'app:setState'); const write = deferred(); writes.push({ payload, write }); return write.promise;
      } } };
    } },
  };
  const code = 'useUIStore.setState({' + initialLine + '\n' + actions + '\nshowToast:()=>{}});\n'
    + source.slice(bootstrapStart, bootstrapEnd + bootstrapEndMarker.length);
  vm.runInNewContext(compile(code), context);
  return { get state() { return state; }, reads, writes, warnings };
}

test('actual UIStore public actions address separate keys and protect local intent from its late hydrate', async () => {
  const h = fixture();
  const selected = h.state.setPaneStripSelectedFirst(true);
  const close = h.state.setPaneStripCloseOnClick(false); // explicit OFF must fence a persisted ON
  assert.deepEqual(h.writes.map(({ payload }) => [payload.key, payload.value]),
    [['paneStripSelectedFirst', true], ['paneStripCloseOnClick', false]]);
  h.reads.get('paneStripSelectedFirst').resolve(false); h.reads.get('paneStripCloseOnClick').resolve(true);
  h.reads.get('paneStripInstantHover').resolve(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.paneStripSelectedFirst, true); assert.equal(h.state.paneStripCloseOnClick, false);
  assert.equal(h.state.paneStripPreferenceStatus.paneStripCloseOnClick, 'saving');
  h.writes[0].write.resolve({ success: true }); h.writes[1].write.resolve({ success: false });
  assert.equal(await selected, true); assert.equal(await close, false);
  assert.equal(h.state.paneStripPreferenceStatus.paneStripSelectedFirst, 'ready');
  assert.equal(h.state.paneStripPreferenceStatus.paneStripCloseOnClick, 'save-error');
});

test('actual store owns unconfirmed settings independently of a Settings component instance', async () => {
  const h = fixture();
  for (const read of h.reads.values()) read.resolve(false);
  await new Promise(resolve => setImmediate(resolve));
  const save = h.state.setPaneStripCloseOnClick(true);
  h.writes[0].write.resolve(undefined); assert.equal(await save, false);
  assert.equal(h.state.paneStripPreferenceStatus.paneStripCloseOnClick, 'save-unknown');
  const retry = h.state.retryPaneStripInterfacePreference('paneStripCloseOnClick');
  assert.equal(h.writes[1].payload.value, true);
  h.writes[1].write.resolve({ success: true }); assert.equal(await retry, true);
  assert.equal(h.state.paneStripPreferenceStatus.paneStripCloseOnClick, 'ready');
});

test('actual third toggle is independent, default OFF, and its explicit OFF survives a late persisted ON', async()=>{
  const h=fixture();assert.equal(h.state.paneStripInstantHover,false);
  const save=h.state.setPaneStripInstantHover(false);
  for(const read of h.reads.values())read.resolve(true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.state.paneStripInstantHover,false);assert.equal(h.state.paneStripCloseOnClick,true);assert.equal(h.state.paneStripSelectedFirst,true);
  assert.equal(h.writes.length,1);assert.equal(h.writes[0].payload.key,'paneStripInstantHover');
  h.writes[0].write.resolve({success:true});assert.equal(await save,true);assert.equal(h.state.paneStripPreferenceStatus.paneStripInstantHover,'ready');
});
