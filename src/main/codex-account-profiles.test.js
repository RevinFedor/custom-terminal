'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  CODEX_ACCOUNT_PROFILES_KEY,
  CodexAppServerClient,
  CodexAccountProfileManager,
  hashCodexAccountKey,
} = require('./codex-account-profiles');

function createStore(initial = null) {
  let value = initial;
  const writes = [];
  return {
    writes,
    getAppState(key) {
      assert.equal(key, CODEX_ACCOUNT_PROFILES_KEY);
      return value == null ? null : JSON.parse(JSON.stringify(value));
    },
    setAppState(key, next) {
      assert.equal(key, CODEX_ACCOUNT_PROFILES_KEY);
      value = JSON.parse(JSON.stringify(next));
      writes.push(JSON.parse(JSON.stringify(next)));
    },
    snapshot() {
      return value == null ? null : JSON.parse(JSON.stringify(value));
    },
  };
}

class FakeAppServerClient extends EventEmitter {
  constructor({ account = null, rateLimits = null } = {}) {
    super();
    this.account = account;
    this.rateLimits = rateLimits;
    this.requests = [];
    this.closed = false;
  }

  async start() {
    return this;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'account/login/start') {
      return {
        type: 'chatgptDeviceCode',
        loginId: 'login-1',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
      };
    }
    if (method === 'account/read') return { account: this.account, requiresOpenaiAuth: true };
    if (method === 'account/rateLimits/read') return this.rateLimits;
    if (method === 'account/login/cancel' || method === 'account/logout') return {};
    throw new Error(`Unexpected method ${method}`);
  }

  close() {
    this.closed = true;
  }
}

function createClientFactory(scenarios) {
  const clients = [];
  const factory = () => {
    const scenario = scenarios[Math.min(clients.length, scenarios.length - 1)] || {};
    const client = new FakeAppServerClient(scenario);
    clients.push(client);
    return client;
  };
  factory.clients = clients;
  return factory;
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function tempProfileRoots(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-codex-profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    defaultCodexHome: path.join(root, 'default'),
    profilesRoot: path.join(root, 'managed'),
  };
}

test('app-server client performs initialize handshake and routes responses', async (t) => {
  const writes = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        if (!line) continue;
        const message = JSON.parse(line);
        writes.push(message);
        if (message.id === 1) {
          child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'codex-test' } })}\n`);
        }
        if (message.id === 2) {
          child.stdout.write(`${JSON.stringify({
            id: 2,
            result: { account: { type: 'chatgpt', email: 'person@example.com' } },
          })}\n`);
        }
      }
    });
    child.kill = () => child.emit('exit', 0, null);
    process.nextTick(() => child.emit('spawn'));
    return child;
  };

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-codex-client-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const client = new CodexAppServerClient({
    codexHome,
    spawnImpl,
    requestTimeoutMs: 1000,
    initializeCapabilities: { experimentalApi: true },
  });
  await client.start();
  const result = await client.request('account/read', { refreshToken: false });
  assert.equal(result.account.email, 'person@example.com');
  assert.equal(writes[0].method, 'initialize');
  assert.deepEqual(writes[0].params.capabilities, { experimentalApi: true });
  assert.equal(writes[1].method, 'initialized');
  assert.equal(writes[2].method, 'account/read');
  client.close();
});

test('device login persists the account profile but never the one-time code', async (t) => {
  const roots = tempProfileRoots(t);
  const store = createStore();
  const clientFactory = createClientFactory([{
    account: { type: 'chatgpt', email: 'person@example.com', planType: 'pro' },
    rateLimits: { rateLimits: null },
  }]);
  const events = [];
  const manager = new CodexAccountProfileManager({
    ...roots,
    store,
    clientFactory,
    onChange: (payload) => events.push(payload),
  });

  const started = await manager.startLogin();
  assert.equal(started.login.userCode, 'ABCD-1234');
  assert.equal(started.profile.status, 'signing_in');
  assert.equal(JSON.stringify(store.snapshot()).includes('ABCD-1234'), false);

  clientFactory.clients[0].emit('notification', {
    method: 'account/login/completed',
    params: { loginId: 'login-1', success: true, error: null },
  });
  await nextTurn();
  await nextTurn();

  const connected = manager.listPublicProfiles().find((profile) => !profile.isDefault);
  assert.equal(connected.status, 'connected');
  assert.equal(connected.label, 'pe***@example.com');
  assert.equal(connected.accountKey, hashCodexAccountKey('person@example.com'));
  assert.equal(connected.planType, 'pro');
  assert.equal(connected.login, null);
  assert.equal(events.some((payload) => payload.event?.type === 'login-completed'), true);
  assert.equal(JSON.stringify(store.snapshot()).includes('person@example.com'), false);
  manager.shutdown();

  const restored = new CodexAccountProfileManager({
    ...roots,
    store,
    clientFactory: createClientFactory([{}]),
  });
  const restoredProfile = restored.listPublicProfiles().find((profile) => !profile.isDefault);
  assert.equal(restoredProfile.status, 'connected');
  assert.equal(restoredProfile.accountKey, hashCodexAccountKey('person@example.com'));
  restored.shutdown();
});

test('default auth identity blocks a duplicate before the first network refresh', async (t) => {
  const roots = tempProfileRoots(t);
  fs.mkdirSync(roots.defaultCodexHome, { recursive: true });
  fs.writeFileSync(path.join(roots.defaultCodexHome, 'auth.json'), JSON.stringify({
    tokens: { account_id: 'account-default' },
  }));
  const store = createStore();
  const factory = createClientFactory([{
    account: { type: 'chatgpt', accountId: 'account-default', planType: 'pro' },
  }]);
  const manager = new CodexAccountProfileManager({ ...roots, store, clientFactory: factory });
  assert.equal(
    manager.listPublicProfiles().find((profile) => profile.isDefault).accountKey,
    hashCodexAccountKey('account-default')
  );

  await manager.startLogin();
  factory.clients[0].emit('notification', {
    method: 'account/login/completed',
    params: { loginId: 'login-1', success: true },
  });
  await nextTurn();
  await nextTurn();

  assert.equal(manager.listPublicProfiles().length, 1);
  assert.equal(factory.clients[0].requests.some((request) => request.method === 'account/logout'), true);
  manager.shutdown();
});

test('a restart turns an unfinished login into a signed-out profile', async (t) => {
  const roots = tempProfileRoots(t);
  const store = createStore();
  const firstFactory = createClientFactory([{}]);
  const first = new CodexAccountProfileManager({ ...roots, store, clientFactory: firstFactory });
  const started = await first.startLogin();
  assert.equal(started.profile.status, 'signing_in');

  const second = new CodexAccountProfileManager({ ...roots, store, clientFactory: createClientFactory([{}]) });
  const restored = second.listPublicProfiles().find((profile) => !profile.isDefault);
  assert.equal(restored.status, 'signed_out');
  assert.equal(restored.login, null);
  first.shutdown();
  second.shutdown();
});

test('reconnect refuses a different browser account without replacing the row identity', async (t) => {
  const roots = tempProfileRoots(t);
  const accountAKey = hashCodexAccountKey('a@example.com');
  const store = createStore({
    version: 1,
    profiles: [
      { profileId: 'default', label: 'Default Codex', status: 'signed_out' },
      {
        profileId: 'profile-account-a',
        label: 'a***@example.com',
        accountKey: accountAKey,
        status: 'signed_out',
      },
    ],
  });
  const factory = createClientFactory([{
    account: { type: 'chatgpt', email: 'b@example.com', planType: 'plus' },
  }]);
  const manager = new CodexAccountProfileManager({ ...roots, store, clientFactory: factory });
  await manager.startLogin('profile-account-a');
  factory.clients[0].emit('notification', {
    method: 'account/login/completed',
    params: { loginId: 'login-1', success: true },
  });
  await nextTurn();
  await nextTurn();

  const profile = manager.listPublicProfiles().find((row) => row.profileId === 'profile-account-a');
  assert.equal(profile.accountKey, accountAKey);
  assert.equal(profile.status, 'error');
  assert.match(profile.lastError, /different Codex account/i);
  assert.equal(factory.clients[0].requests.some((request) => request.method === 'account/logout'), true);
  manager.shutdown();
});

test('logging out one managed profile does not change another profile', async (t) => {
  const roots = tempProfileRoots(t);
  const store = createStore({
    version: 1,
    profiles: [
      { profileId: 'default', label: 'Default Codex', status: 'signed_out' },
      {
        profileId: 'profile-account-a',
        label: 'a***@example.com',
        accountKey: hashCodexAccountKey('a@example.com'),
        status: 'connected',
      },
      {
        profileId: 'profile-account-b',
        label: 'b***@example.com',
        accountKey: hashCodexAccountKey('b@example.com'),
        status: 'connected',
      },
    ],
  });
  const factory = createClientFactory([{}]);
  const manager = new CodexAccountProfileManager({ ...roots, store, clientFactory: factory });
  await manager.logout('profile-account-a');

  const rows = manager.listPublicProfiles();
  assert.equal(rows.find((row) => row.profileId === 'profile-account-a').status, 'signed_out');
  assert.equal(rows.find((row) => row.profileId === 'profile-account-b').status, 'connected');
  assert.equal(factory.clients[0].requests.some((request) => request.method === 'account/logout'), true);
  manager.shutdown();
});

test('usage refresh can probe one managed account without waiting for every profile', async (t) => {
  const roots = tempProfileRoots(t);
  const accountAKey = hashCodexAccountKey('a@example.com');
  const accountBKey = hashCodexAccountKey('b@example.com');
  const store = createStore({
    version: 1,
    profiles: [
      { profileId: 'default', label: 'Default Codex', status: 'connected' },
      { profileId: 'profile-a', label: 'a***@example.com', accountKey: accountAKey, status: 'connected' },
      { profileId: 'profile-b', label: 'b***@example.com', accountKey: accountBKey, status: 'connected' },
    ],
  });
  const factory = createClientFactory([{
    account: { type: 'chatgpt', email: 'b@example.com', planType: 'pro' },
    rateLimits: { rateLimits: null },
  }]);
  const manager = new CodexAccountProfileManager({ ...roots, store, clientFactory: factory });

  const results = await manager.refreshManagedProfiles({ force: true, accountKey: accountBKey });

  assert.equal(results.length, 1);
  assert.equal(results[0].profile.profileId, 'profile-b');
  assert.equal(factory.clients.length, 1);
  manager.shutdown();
});
