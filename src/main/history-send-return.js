'use strict';

// A pre-input fence for an explicitly reversible History authoring handoff.
// Not a delivery queue: it never starts/stops a process or writes/replays input.
// SQLite orders return against the FIRST payload write, including a write that
// subsequently throws. The existing Send/FIFO/receipt owners remain unchanged.
const instances = new WeakMap();
function historySendReturnControl(store) {
  if (instances.has(store)) return instances.get(store);
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS history_send_return_control (
    tab_id TEXT NOT NULL, handoff_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
    input_started_at INTEGER, returned_at INTEGER, restored_at INTEGER,
    PRIMARY KEY(tab_id, handoff_id)
  )`);
  const select = db.prepare('SELECT * FROM history_send_return_control WHERE tab_id=? AND handoff_id=?');
  const project = row => row ? { version: 1, tabId: row.tab_id, handoffId: row.handoff_id,
    token: row.token, provider: row.provider, state: row.state,
    inputStartedAt: row.input_started_at, returnedAt: row.returned_at, restoredAt: row.restored_at } : null;
  const read = (tabId, handoffId) => project(select.get(tabId, handoffId));
  const valid = input => input && ['tabId', 'handoffId', 'token'].every(key =>
    typeof input[key] === 'string' && input[key].length > 0 && input[key].length <= 8192);
  const identity = input => {
    if (!valid(input)) return null;
    const row = select.get(input.tabId, input.handoffId);
    return row?.token === input.token ? row : null;
  };
  const control = {
    read,
    register(input, { allowUnattemptedQueue = false } = {}) {
      return db.transaction(() => {
        if (!valid(input) || !['codex', 'claude'].includes(input.provider)) return { success: false, reason: 'invalid-return-owner' };
        const row = select.get(input.tabId, input.handoffId);
        if (row) return row.token === input.token && row.provider === input.provider
          ? { success: true, control: project(row) } : { success: false, reason: 'return-owner-conflict' };
        // Never retrofit no-write authority onto an old/unknown physical send.
        const records = store.list({ tabId: input.tabId, handoffId: input.handoffId, limit: 2 });
        if (records.length && !(allowUnattemptedQueue && records.length === 1 && !records[0].attemptId
          && ['reserved', 'preparing'].includes(records[0].state)
          && db.prepare('SELECT state FROM agent_send_queue WHERE operation_key=?').get(records[0].operationKey)?.state === 'waiting')) {
          return { success: false, reason: 'send-already-admitted' };
        }
        db.prepare(`INSERT INTO history_send_return_control
          (tab_id,handoff_id,token,provider,state,created_at) VALUES(?,?,?,?,'available',?)`)
          .run(input.tabId, input.handoffId, input.token, input.provider, Date.now());
        return { success: true, control: read(input.tabId, input.handoffId) };
      })();
    },
    request(input) {
      return db.transaction(() => {
        const row = identity(input);
        if (!row) return { success: false, returned: false, reason: 'return-owner-unavailable' };
        if (row.state === 'available' && store.list({ tabId: input.tabId, handoffId: input.handoffId, limit: 2 })
          .some(record => record.receipt?.mergedIntoOperationKey || record.state === 'confirmed')) {
          db.prepare("UPDATE history_send_return_control SET state='superseded' WHERE tab_id=? AND handoff_id=?")
            .run(input.tabId, input.handoffId);
          return { success: true, returned: false, reason: 'send-superseded', control: read(input.tabId, input.handoffId) };
        }
        if (row.state === 'superseded') return { success: true, returned: false, reason: 'send-superseded', control: project(row) };
        if (row.state === 'writing') return { success: true, returned: false,
          reason: 'message-input-started', control: project(row) };
        if (row.state === 'available') db.prepare(`UPDATE history_send_return_control
          SET state='returned', returned_at=? WHERE tab_id=? AND handoff_id=? AND state='available'`)
          .run(Date.now(), input.tabId, input.handoffId);
        const current = read(input.tabId, input.handoffId);
        return { success: true, returned: true, restored: current.state === 'restored', control: current };
      })();
    },
    acknowledge(input) {
      const row = identity(input);
      if (!row || !['returned', 'restored'].includes(row.state)) return { success: false, reason: 'return-not-confirmed' };
      db.prepare(`UPDATE history_send_return_control SET state='restored',restored_at=?
        WHERE tab_id=? AND handoff_id=? AND state='returned'`).run(Date.now(), input.tabId, input.handoffId);
      return { success: true, control: read(input.tabId, input.handoffId) };
    },
    isReturned(tabId, handoffId) {
      return !!handoffId && ['returned', 'restored'].includes(read(tabId, handoffId)?.state);
    },
    beforeWrite(tabId, handoffId) {
      if (!tabId || !handoffId) return null;
      return db.transaction(() => {
        const row = select.get(tabId, handoffId);
        if (!row) return null; // Unregistered callers retain their prior contract.
        if (['returned', 'restored', 'superseded'].includes(row.state)) throw Object.assign(
          new Error('Message returned to History input before terminal insertion'),
          { code: 'history_send_returned', submitted: false, pasteWritten: false, enterWritten: false });
        if (row.state === 'available') db.prepare(`UPDATE history_send_return_control
          SET state='writing',input_started_at=? WHERE tab_id=? AND handoff_id=? AND state='available'`)
          .run(Date.now(), tabId, handoffId);
        return { ...read(tabId, handoffId), newlyStarted: row.state === 'available' };
      })();
    },
  };
  instances.set(store, control);
  return control;
}
module.exports = { historySendReturnControl };
