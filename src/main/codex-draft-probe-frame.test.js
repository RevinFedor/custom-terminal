const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const authority = require('./codex-draft-authority');
const source = fs.readFileSync(require('node:path').join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf('async function requestTerminalCodexDraftState(');
const end = source.indexOf('\n// Stash-detect helper.', start);
assert.ok(start > 0 && end > start);

function harness({ replacement = false, realDraft = false, flushFailure = false } = {}) {
  const mirror = {};
  const ipcMain = new EventEmitter();
  let rendererRead = false, mainReads = 0, flushes = 0;
  const incidents = [];
  const webContents = { isDestroyed: () => false, send: (_channel, request) => {
    rendererRead = true;
    setImmediate(() => ipcMain.emit('terminal:codex-draft-state-response', null, {
      requestId: request.requestId, success: true, hasDraft: true,
      preview: '5. More reasoning…   Max and Ultra consume usage limits', source: 'tail:1024',
      frameIdentity: { generation: 'pty-a', writeSeq: 41 },
    }));
  } };
  const context = vm.createContext({
    ...authority, crypto, ipcMain, setTimeout, clearTimeout,
    reportTerminalIncident: (key, payload) => incidents.push({ key, payload }),
    console: { log() {}, warn() {} }, HEADLESS_XTERM_FLUSH_TIMEOUT_MS: 500,
    getHeadlessTerminalMirror: () => replacement && rendererRead ? {} : mirror,
    flushHeadlessTerminalMirror: async () => { flushes++; return { success: !flushFailure || !rendererRead }; },
    getHeadlessCodexDraftState: () => ({ success: true, hasDraft: rendererRead && realDraft,
      source: 'headless-main:cursor:1016:dim-hint', frameIdentity: { generation: 'pty-a', writeSeq: ++mainReads + 41 } }),
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.read = requestTerminalCodexDraftState;', context);
  return { read: () => context.read(webContents, 'T', 'codex-pre-submit-before-paste', 50, { mergeRendererPositive: true }),
    stats: () => ({ mainReads, flushes }), incidents };
}

test('actual main request catches up after renderer reply and rejects its older positive frame', async () => {
  const h = harness();
  const state = await h.read();
  assert.equal(state.hasDraft, false);
  assert.equal(state.rendererPositiveIgnored, 'renderer-frame-behind');
  assert.deepEqual(h.stats(), { mainReads: 2, flushes: 2 });
  assert.equal(h.incidents.length, 1, 'ignored contradictions are still captured');
  assert.equal(h.incidents[0].payload.context.decision, 'renderer-frame-behind');
});

test('actual main request preserves a genuine draft arriving during the asynchronous probe', async () => {
  const h = harness({ realDraft: true });
  assert.equal((await h.read()).hasDraft, true);
});

test('mirror replacement while awaiting renderer cannot authorize input in another process', async () => {
  assert.equal((await harness({ replacement: true }).read()).hasDraft, null);
});

test('failed final flush never reuses earlier empty proof; conservative positive fallback still protects input', async () => {
  assert.equal((await harness({ flushFailure: true }).read()).hasDraft, true);
});

test('renderer caller → real IPC handler rejects its old positive sample but still captures the contradiction', async () => {
  const { readCodexDraftAuthority } = await import('../renderer/utils/codexDraftAuthority.mjs');
  const start = source.indexOf("ipcMain.handle('codex:get-draft-state'");
  const end = source.indexOf("ipcMain.handle('claude:get-draft-state'", start);
  const reports = [], handlers = new Map();
  const mainState = { success: true, hasDraft: false, source: 'headless-main',
    frameIdentity: { generation: 'G', writeSeq: 148 } };
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, mainWindow: null,
    requestTerminalCodexDraftState: async () => mainState,
    decorateAgentDraftProofIdentity: (_tabId, result) => result,
    mergeCodexDraftAuthority: authority.mergeCodexDraftAuthority,
    reportTerminalIncident: (...args) => reports.push(args),
  });
  const result = await readCodexDraftAuthority({ tabId: 'T',
    visualState: { hasDraft: true, preview: 'old menu', source: 'renderer',
      frameIdentity: { generation: 'G', writeSeq: 125 } },
    invoke: (name, ...args) => handlers.get(name)(null, ...args),
  });
  assert.equal(result.hasDraft, false);
  assert.equal(result.rendererPositiveIgnored, 'renderer-frame-behind');
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1].context.decision, 'renderer-frame-behind');
  assert.equal(reports[0][1].context.rendererState.frameIdentity.writeSeq, 125);
});
