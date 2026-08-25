'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const test = require('node:test');
const { CodexStorageDeletionProvider } = require('./codex-storage-deletion-provider');

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.requests = [];
    this.closed = false;
  }

  async start() {}

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/list') {
      if (params.archived) {
        return { data: [{ id: 'archived-child' }, { id: 'active-child-2' }], nextCursor: null };
      }
      if (!params.cursor) {
        return { data: [{ id: 'active-child-1' }], nextCursor: 'active-page-2' };
      }
      return { data: [{ id: 'active-child-2' }], nextCursor: null };
    }
    if (method === 'thread/delete') {
      process.nextTick(() => {
        for (const threadId of ['active-child-1', 'active-child-2', 'archived-child', 'root']) {
          this.emit('notification', { method: 'thread/deleted', params: { threadId } });
        }
      });
      return {};
    }
    throw new Error(`Unexpected method ${method}`);
  }

  close() {
    this.closed = true;
  }
}

test('Codex deletion provider inspects every active and archived descendant page and captures actual notifications', async () => {
  const client = new FakeClient();
  let clientOptions = null;
  const provider = new CodexStorageDeletionProvider({
    codexHome: '/tmp/codex-home',
    command: '/tmp/codex',
    notificationWaitMs: 100,
    clientFactory: (options) => {
      clientOptions = options;
      return client;
    },
  });
  const closure = await provider.inspectDeleteClosure('root');
  assert.deepEqual(closure, ['root', 'active-child-1', 'active-child-2', 'archived-child']);
  assert.deepEqual(clientOptions.initializeCapabilities, { experimentalApi: true });
  assert.equal(client.requests.filter((entry) => entry.method === 'thread/list').length, 3);
  assert.equal(client.requests.every((entry) => entry.method !== 'thread/list' || entry.params.useStateDbOnly === true), true);

  const deleted = await provider.deleteSession('root', closure);
  assert.deepEqual(deleted.deletedSessionIds, ['active-child-1', 'active-child-2', 'archived-child', 'root']);
  assert.equal(deleted.notificationsComplete, true);
  assert.deepEqual(client.requests.at(-1), { method: 'thread/delete', params: { threadId: 'root' } });
  provider.close();
  assert.equal(client.closed, true);
});
