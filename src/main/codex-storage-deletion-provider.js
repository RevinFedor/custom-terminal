'use strict';

const { CodexAppServerClient } = require('./codex-account-profiles');

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_NOTIFICATION_WAIT_MS = 1_000;

function uniqueSessionIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

class CodexStorageDeletionProvider {
  constructor({
    codexHome,
    command = 'codex',
    clientFactory = (options) => new CodexAppServerClient(options),
    requestTimeoutMs = 120_000,
    notificationWaitMs = DEFAULT_NOTIFICATION_WAIT_MS,
  } = {}) {
    this.codexHome = codexHome;
    this.command = command;
    this.clientFactory = clientFactory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.notificationWaitMs = notificationWaitMs;
    this.client = null;
    this.startInflight = null;
  }

  async _getClient() {
    if (this.client) return this.client;
    if (!this.startInflight) {
      const client = this.clientFactory({
        codexHome: this.codexHome,
        command: this.command,
        requestTimeoutMs: this.requestTimeoutMs,
        initializeCapabilities: { experimentalApi: true },
      });
      this.startInflight = Promise.resolve(client.start()).then(() => {
        this.client = client;
        return client;
      }).catch((error) => {
        try { client.close?.(); } catch {}
        throw error;
      }).finally(() => {
        this.startInflight = null;
      });
    }
    return this.startInflight;
  }

  async _listDescendants(sessionId, archived) {
    const client = await this._getClient();
    const descendants = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const result = await client.request('thread/list', {
        ancestorThreadId: sessionId,
        archived,
        cursor,
        limit: DEFAULT_PAGE_SIZE,
        useStateDbOnly: true,
      }, this.requestTimeoutMs);
      for (const thread of Array.isArray(result?.data) ? result.data : []) {
        if (thread?.id) descendants.push(thread.id);
      }
      const nextCursor = typeof result?.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : null;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return descendants;
  }

  async inspectDeleteClosure(sessionId) {
    const root = String(sessionId || '').trim();
    if (!root) throw new Error('Codex session id is required for deletion preflight');
    const [active, archived] = await Promise.all([
      this._listDescendants(root, false),
      this._listDescendants(root, true),
    ]);
    return uniqueSessionIds([root, ...active, ...archived]);
  }

  async deleteSession(sessionId, expectedSessionIds = null) {
    const root = String(sessionId || '').trim();
    const expected = uniqueSessionIds(expectedSessionIds?.length
      ? expectedSessionIds
      : await this.inspectDeleteClosure(root));
    const client = await this._getClient();
    const deleted = new Set();
    let resolveNotifications = null;
    const notificationsComplete = new Promise((resolve) => {
      resolveNotifications = resolve;
    });
    const maybeResolve = () => {
      if (expected.every((id) => deleted.has(id))) resolveNotifications?.();
    };
    const onNotification = (message) => {
      if (message?.method !== 'thread/deleted') return;
      const deletedId = String(message?.params?.threadId || '').trim();
      if (!deletedId) return;
      deleted.add(deletedId);
      maybeResolve();
    };
    client.on('notification', onNotification);
    try {
      await client.request('thread/delete', { threadId: root }, this.requestTimeoutMs);
      maybeResolve();
      if (!expected.every((id) => deleted.has(id))) {
        await Promise.race([
          notificationsComplete,
          new Promise((resolve) => setTimeout(resolve, this.notificationWaitMs)),
        ]);
      }
      return {
        deletedSessionIds: uniqueSessionIds([...deleted]),
        expectedSessionIds: expected,
        notificationsComplete: expected.every((id) => deleted.has(id)),
      };
    } finally {
      client.removeListener('notification', onNotification);
    }
  }

  close() {
    try { this.client?.close?.(); } catch {}
    this.client = null;
  }
}

module.exports = {
  CodexStorageDeletionProvider,
  uniqueSessionIds,
};
