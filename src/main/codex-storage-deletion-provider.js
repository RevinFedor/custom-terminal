'use strict';

const { CodexAppServerClient } = require('./codex-account-profiles');
const fs = require('node:fs/promises');
const path = require('node:path');

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
    allowedRoot = null,
  } = {}) {
    this.codexHome = codexHome;
    this.command = command;
    this.clientFactory = clientFactory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.notificationWaitMs = notificationWaitMs;
    this.client = null;
    this.allowedRoot = allowedRoot;
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

  async _assertPrivateStorage(sessionIds, item = null) {
    if (!this.allowedRoot) return;
    const root = await fs.realpath(this.allowedRoot);
    const client = await this._getClient();
    for (const threadId of sessionIds) {
      // A copied state.sqlite may still contain an ABSOLUTE rollout path to
      // its source profile. CODEX_HOME alone does not prove deletion scope.
      const result = await client.request('thread/read', { threadId, includeTurns: false }, this.requestTimeoutMs);
      const thread = result?.thread;
      if (thread?.id !== threadId || typeof thread.path !== 'string')
        throw Object.assign(new Error('Private test rollout path is unproven'), { code: 'storage_test_provider_path_unproven' });
      const actual = await fs.realpath(thread.path);
      if (!actual.startsWith(root + path.sep)
        || item?.sessionId === threadId && actual !== await fs.realpath(item.path)) {
        throw Object.assign(new Error('Private test state refers to a rollout outside the selected profile'), { code: 'storage_test_provider_path_outside_scope' });
      }
    }
  }

  async inspectDeleteClosure(sessionId, item = null) {
    const root = String(sessionId || '').trim();
    if (!root) throw new Error('Codex session id is required for deletion preflight');
    const [active, archived] = await Promise.all([
      this._listDescendants(root, false),
      this._listDescendants(root, true),
    ]);
    const closure = uniqueSessionIds([root, ...active, ...archived]);
    await this._assertPrivateStorage(closure, item);
    return closure;
  }

  async deleteSession(sessionId, expectedSessionIds = null, item = null, beforeDelete = null) {
    const root = String(sessionId || '').trim();
    const expected = uniqueSessionIds(expectedSessionIds?.length
      ? expectedSessionIds
      : await this.inspectDeleteClosure(root));
    const client = await this._getClient();
    await this._assertPrivateStorage(expected, item);
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
      const proof = beforeDelete?.();
      if (proof?.then) throw new Error('storage_final_delete_guard_must_be_synchronous');
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
