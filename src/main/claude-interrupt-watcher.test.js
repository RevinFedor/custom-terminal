'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf('function startInterruptWatcher(');
const end = source.indexOf('\nfunction stopInterruptWatcher(', start);
const watcherSource = source.slice(start, end);
const marker = '[Request interrupted by user]';
const { claudeUserRecordText } = require('./ipc/claude-data')._api;

function harness(content) {
  const sessionId = 'session-a';
  const cwd = '/private/tmp/fixture.with dots/test';
  const exactPath = '/custom-claude/projects/-private-tmp-fixture-with-dots-test/session-a.jsonl';
  const paths = [], sent = [], ended = [], jobs = [];
  let bytes = Buffer.alloc(0), change;
  const watchers = new Map(), busy = new Map([['tab', true]]);
  const scope = {
    Buffer, path, console: { log() {}, warn() {} }, os: { homedir: () => '/home/test' },
    fs: {
      statSync: p => { if (p !== exactPath) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return { size: bytes.length }; },
      watch: (p, _opts, fn) => { paths.push(p); if (p !== exactPath) throw Error('wrong transcript'); change = fn; return { close() {} }; },
      openSync: () => 1,
      readSync: (_fd, target, offset, length, position) => bytes.copy(target, offset, position, position + length),
      closeSync() {},
    },
    findSessionFile: () => ({ filePath: exactPath }),
    terminalProjects: new Map([['tab', cwd]]), claudeInterruptWatchers: watchers,
    stopInterruptWatcher: id => watchers.delete(id),
    claudeTurnBusy: busy, claudeSpinnerBusy: new Map(), claudeTurnWatchdog: new Map(),
    claudeDataApi: { claudeUserRecordText }, INTERRUPT_TEXTS: new Set([marker]),
    setTimeout: fn => { jobs.push(fn); return jobs.length; }, clearTimeout() {},
    safelyObserveProviderSemantic: (_name, fn) => fn(),
    providerSemanticShadow: { finishClaudeTurn: detail => ended.push(detail) },
    terminalHistoryPreviewController: { finish: detail => ended.push(detail) },
    clearClaudeProviderFatalTurnWatch() {}, wakeClaudePostEnterResolutionWaitersForTurnIdle() {},
    taskCompletionIntents: { abortTurn() {} }, recordActivity() {},
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } },
    _webBroadcast() {},
  };
  vm.createContext(scope);
  vm.runInContext(watcherSource, scope);
  return { scope, exactPath, paths, busy, watchers, sent, ended,
    start: supplied => scope.startInterruptWatcher('tab', sessionId, supplied),
    append: () => { bytes = Buffer.from(JSON.stringify({ type: 'user', message: { content } }) + '\n'); change(); },
    flush: () => { for (const fn of jobs.splice(0)) fn(); },
  };
}

for (const content of [marker, [{ type: 'text', text: marker }]]) {
  test('native interrupt uses exact hook transcript path and resolves ' + (typeof content === 'string' ? 'string' : 'array') + ' marker', () => {
    const h = harness(content);
    h.start(h.exactPath);
    assert.deepEqual(h.paths, [h.exactPath]);
    h.append(); h.flush();
    assert.equal(h.busy.get('tab'), false);
    assert.equal(h.ended.length, 2);
    assert.equal(h.sent.find(([name]) => name === 'claude:turn-state')?.[1].event, 'InterruptStop');
    assert.equal(h.watchers.size, 0);
  });
}

test('without a hook path, shared discovery supplies the path; cwd is never re-encoded', () => {
  const h = harness(marker);
  h.start(null);
  assert.deepEqual(h.paths, [h.exactPath]);
});

test('a path naming a different session cannot replace shared exact discovery', () => {
  const h = harness(marker);
  h.start('/custom-claude/projects/other-session.jsonl');
  assert.deepEqual(h.paths, [h.exactPath]);
});

test('a pending old watcher callback cannot stop a replacement turn', () => {
  const h = harness(marker);
  h.start(h.exactPath); h.append();
  h.watchers.set('tab', {});
  h.flush();
  assert.equal(h.busy.get('tab'), true);
  assert.equal(h.ended.length, 0);
});
