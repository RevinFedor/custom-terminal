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
  text: async () => JSON.stringify({ ok: true, job: { id: 'one-job' } }) })) {
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
    fetch: async (url, options) => { posts.push({ url, options }); return response(url); },
  });
  vm.runInContext([
    declaration('observeVoiceInstallOwner'), declaration('selectVoiceInstallInstance'),
    declaration('httpPostVoice'), 'globalThis.post = httpPostVoice;',
  ].join('\n'), context);
  return { posts, post: () => context.post('/api/terminal/build-install', { returnTo: { tabId: 'root' } }) };
}

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
