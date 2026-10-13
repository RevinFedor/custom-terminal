'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observeCodexSettingsApplication } = require('./codex-settings-send');
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(initial = { valid: true, model: 'old', effort: 'high' }) {
  let frame = initial, current = true, wake, reads = 0, disposals = 0;
  return {
    start(extra = {}) { return observeCodexSettingsApplication({
      model: 'chosen', effort: 'max', timeoutMs: 100,
      readFrame: async () => { reads++; return frame; }, isCurrent: () => current,
      subscribe: callback => { wake = callback; return () => { disposals++; }; }, ...extra,
    }); },
    set(next) { frame = next; wake?.(); },
    revoke() { current = false; wake?.(); },
    get reads() { return reads; }, get disposals() { return disposals; },
  };
}

test('old pair remains pending; only a fresh matching frame confirms, without polling', async () => {
  const f = fixture(); let settled = false;
  const result = f.start().then(value => { settled = true; return value; });
  await turn(); await turn();
  assert.equal(settled, false); assert.equal(f.reads, 1);
  f.set({ valid: false, model: 'chosen', effort: 'max' }); await turn();
  assert.equal(settled, false);
  f.set({ valid: true, model: 'chosen', effort: 'max', frameSeq: 3 });
  assert.equal((await result).success, true);
  assert.equal(f.reads, 3); assert.equal(f.disposals, 1);
});

test('stable current pair does not wait for another frame event', async () => {
  const f = fixture({ valid: true, model: 'chosen', effort: 'max' });
  assert.equal((await f.start()).success, true); assert.equal(f.reads, 1);
});

test('different actual pair at deadline is unconfirmed, never success by elapsed time', async () => {
  const f = fixture({ valid: true, model: 'reserve', effort: 'max' });
  const result = await f.start({ timeoutMs: 10 });
  assert.equal(result.success, false); assert.equal(result.code, 'codex_settings_observation_changed');
  assert.equal(result.observation.status, 'expired'); assert.equal(f.reads, 1);
  assert.equal(f.disposals, 1);
});

test('Stop or replacement revokes an otherwise matching asynchronous frame', async () => {
  const f = fixture(); let finishRead;
  const result = f.start({ readFrame: () => new Promise(resolve => { finishRead = resolve; }) });
  await turn(); f.revoke();
  finishRead({ valid: true, model: 'chosen', effort: 'max' });
  assert.equal((await result).code, 'codex_settings_application_owner_changed');
  assert.equal(f.disposals, 1);
});

test('configured display labels use the same model identity resolver', async () => {
  const f = fixture({ valid: true, model: 'Chosen label', effort: 'MAX' });
  const result = await f.start({ resolveModelIdentity: value => value === 'Chosen label' ? 'chosen' : value });
  assert.equal(result.success, true);
});

test('empty metadata and failed reads do not prove chosen settings', async () => {
  const f = fixture({ valid: true, model: '', effort: '' });
  assert.equal((await f.start({ model: '', effort: '', timeoutMs: 10 })).success, false);
  const error = fixture();
  assert.equal((await error.start({ readFrame: async () => { throw Error('unavailable'); } })).success, false);
  assert.equal(error.disposals, 1);
});

test('actual headless terminal/footer parser confirms only the newly rendered requested pair', async () => {
  const { Terminal } = require('@xterm/headless');
  const { parseCodexVerifiedComposerFooter } = require('./codex-tui-readiness');
  const term = new Terminal({ cols: 100, rows: 8, allowProposedApi: true });
  let wake, frameSeq = 0, current = true;
  const write = async (model, effort) => {
    await new Promise(resolve => term.write('\x1b[2J\x1b[H› Ask Codex to do anything\r\n'
      + model + ' ' + effort + ' · Context 42% used', resolve));
    frameSeq++; wake?.();
  };
  const readFrame = async () => {
    const text = Array.from({ length: term.buffer.active.length }, (_, row) =>
      term.buffer.active.getLine(row).translateToString(true)).join('\n');
    const pair = parseCodexVerifiedComposerFooter(text);
    return { valid: !!pair, ...pair, frameSeq };
  };
  try {
    await write('gpt-6-astra', 'max');
    let done = false;
    const pending = observeCodexSettingsApplication({ model: 'gpt-6.1-sol', effort: 'max',
      isCurrent: () => current, readFrame,
      subscribe: callback => { wake = callback; return () => { wake = null; }; },
    }).then(value => { done = true; return value; });
    await turn(); assert.equal(done, false);
    await write('gpt-6.1-sol', 'max');
    const result = await pending;
    assert.equal(result.success, true); assert.equal(result.frame.frameSeq, 2);
    assert.equal(wake, null);
  } finally { current = false; term.dispose(); }
});
