import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('./terminal-server.mjs', import.meta.url), 'utf8');
const installed = '/Applications/Voice Record.app/Contents/MacOS/Voice Record';
const declaration = name => {
  const start = source.indexOf('async function ' + name + '(');
  return start < 0 ? '' : source.slice(start, source.indexOf('\n}', start) + 2);
};
function harness(candidates, identities, response = async () => ({ ok: true, status: 202,
  text: async () => JSON.stringify({ ok: true, job: { id: 'one-job' } }) }), forceSupported = true) {
  const posts = [];
  const context = vm.createContext({
    readSharedToken: () => 'fixture-token', TOKEN_PATH: '/fixture/token', PORT_DIR: '/fixture',
    listLiveVoiceInstances: () => candidates,
    execFileAsync: async (command, args) => {
      const pid = Number(args[args.indexOf('-p') + 1]);
      const identity = identities[pid];
      if (!identity) throw new Error('process gone');
      if (command === '/bin/ps') return { stdout: identity.command + '\n' };
      assert.equal(command, '/usr/sbin/lsof');
      assert.ok(args.includes('-a'), 'PID and port filters must be conjunctive');
      return { stdout: identity.listens === false ? '' : 'p' + pid + '\n' };
    },
    fetch: async (url, options) => {
      if (url.endsWith('/api/me')) return { ok: true, json: async () => ({ application: 'voice-record',
        pid: Number(new URL(url).port) === 7888 ? 10 : 20,
        capabilities: { terminalBuildInstall: { version: 2, durableRequests: true, force: forceSupported } } }) };
      posts.push({ url, options }); return response(url);
    },
  });
  vm.runInContext([
    declaration('observeVoiceInstallOwner'), declaration('selectVoiceInstallInstance'),
    declaration('verifyVoiceBuildInstall'),
    declaration('httpPostVoice'), 'globalThis.post = httpPostVoice;',
  ].join('\n'), context);
  return { posts, post: (extra = {}) => context.post('/api/terminal/build-install', { returnTo: { tabId: 'root' }, ...extra }) };
}

test('FORCE is an explicit capability, never a silent normal-mode fallback', async () => {
  const candidates = [{ pid: 10, port: 7888 }], identities = { 10: { command: installed } };
  const old = harness(candidates, identities, undefined, false);
  await assert.rejects(() => old.post({ force: true }), /FORCE installer update required/); assert.equal(old.posts.length, 0);
  const current = harness(candidates, identities);
  await current.post({ requestId: 'same-operation', force: true });
  assert.equal(JSON.parse(current.posts[0].options.body).force, true); assert.equal(current.posts.length, 1);
});

test('newer private Voice dev never steals a production install', async () => {
  const h = harness([{ pid: 20, port: 17988 }, { pid: 10, port: 7888 }], {
    20: { command: '/fixture/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' },
    10: { command: installed },
  });
  const result = await h.post();
  assert.equal(result.pid, 10);
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].url, /:7888\/api\/terminal\/build-install$/);
});

test('alive reused PID in a stale discovery file is not an installer owner', async () => {
  const h = harness([{ pid: 30, port: 7888 }, { pid: 10, port: 7888 }], {
    30: { command: '/Applications/Yandex.app/Contents/MacOS/Yandex' }, 10: { command: installed },
  });
  assert.equal((await h.post()).pid, 10);
});

test('installed executable must also own the advertised listening port', async () => {
  const h = harness([{ pid: 10, port: 7888 }], { 10: { command: installed, listens: false } });
  await assert.rejects(h.post, /Voice Record.*production/i);
  assert.equal(h.posts.length, 0);
});

test('dev-only or ambiguous production discovery never falls back to a guessed target', async () => {
  for (const identities of [
    { 10: { command: '/fixture/Electron' }, 20: { command: '/fixture/Electron' } },
    { 10: { command: installed }, 20: { command: installed } },
  ]) {
    const h = harness([{ pid: 10, port: 7888 }, { pid: 20, port: 7889 }], identities);
    await assert.rejects(h.post, /Voice Record.*production/i);
    assert.equal(h.posts.length, 0);
  }
});

test('HTTP failure or uncertain response never posts the same install to a second Voice instance', async () => {
  for (const response of [
    async () => ({ ok: false, status: 500, text: async () => '{"error":"refused"}' }),
    async () => { throw new Error('connection lost after dispatch'); },
  ]) {
    const h = harness([{ pid: 10, port: 7888 }, { pid: 20, port: 17988 }], {
      10: { command: installed }, 20: { command: '/fixture/Electron' },
    }, response);
    await assert.rejects(h.post);
    assert.equal(h.posts.length, 1, 'a dispatched operation cannot migrate to another app');
  }
});

// Execute the production tool case, with only API/identity transport leaves
// controlled; discovery-only helper tests cannot prove this admission seam.
function toolCaseHarness() {
  const begin = source.indexOf("    case 'build_install_noted_terminal': {");
  const end = source.indexOf('\n    default:', begin);
  assert.ok(begin > 0 && end > begin);
  const calls = [];
  const context = vm.createContext({
    randomUUID: () => 'one-request', PARENT_TAB_ID: () => '', PARENT_PROJECT_ID: () => 'P',
    PROJECT_CWD_: () => '/private/project', projectHint: () => ({ cwd: '/private/project', projectId: 'P' }),
    httpGet: async () => ({ tabs: [] }), httpGetOnPort: async () => ({ tabs: [] }),
    verifyVoiceBuildInstall: async () => {},
    httpApiPost: async (target, route, body) => { calls.push({ kind: 'source', target, route, body }); return {}; },
    httpPostVoice: async (route, body) => { calls.push({ kind: 'voice', route, body });
      return { pid: 10, port: 7888, body: { job: { id: 'one-job' } } }; },
  });
  vm.runInContext('globalThis.invoke = async args => { switch ("build_install_noted_terminal") {\n'
    + source.slice(begin, end) + '\n} };', context);
  return { calls, invoke: args => context.invoke(args) };
}

test('actual FORCE tool case rejects missing source or disabled success report BEFORE either API mutation; normal mode keeps its callback choice', async () => {
  for (const args of [
    { force: true },
    { force: true, returnToTabId: '753' },
    { force: true, returnToTabId: '753', sessionId: 'S', notifyOnSuccess: false },
  ]) {
    const h = toolCaseHarness();
    await assert.rejects(() => h.invoke(args), /FORCE requires an exact source tab\/session and the success report callback/);
    assert.equal(h.calls.length, 0, 'rejected FORCE cannot reserve a hold or install');
  }
  const force = toolCaseHarness();
  await force.invoke({ force: true, returnToTabId: '753', sessionId: 'S', requestId: 'I' });
  assert.deepEqual(force.calls.map(x => x.kind), ['source', 'voice']);
  assert.equal(force.calls[0].body.installRequestId, 'I'); assert.equal(force.calls[1].body.requestId, 'I');
  assert.equal(force.calls[1].body.force, true); assert.equal(force.calls[1].body.returnTo.sessionId, 'S');
  const normal = toolCaseHarness();
  await normal.invoke({ returnToTabId: '753', sessionId: 'S', notifyOnSuccess: false });
  assert.equal(normal.calls[1].body.returnTo.notifyOnSuccess, false); assert.equal(normal.calls[1].body.force, false);
});
