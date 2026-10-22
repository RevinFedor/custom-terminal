'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { canProjectCurrentProviderQueue } = require('../shared/agent-send-receipt-control.cjs');
const {
  classifyAgentSendRegistryReceipt,
  isAgentSendProviderQueueAccepted,
} = require('./agent-send-receipt-registry');

const TABLE_NAME = 'tab_messages';
const LIST_COLUMNS = `messageId, kind, replyTo,
  sourceTabId, sourceTabName, sourceProjectId, sourceProjectName, sourceProvider, sourceSessionId,
  targetTabId, targetTabName, targetProjectId, targetProjectName, targetProvider, targetSessionId,
  createdAt, updatedAt, deliveryState, error, code, replyMessageId, answeredAt,
  sourceDismissedAt, targetDismissedAt, cancelledAt, cancelledByTabId,
  operationKey, handoffId, requestId, sourceAddressJson, targetAddressJson, sourceRestartBindingId`;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();
const updatedAfter = (previous) => new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();

class TabMessageError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'TabMessageError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TabMessageError('tab_message_invalid_input', `${name} must be a non-empty string`, 400);
  }
  return value;
}

function launchAddress(value) {
  if (!value || typeof value !== 'object' || typeof value.terminalInstanceId !== 'string' || !value.terminalInstanceId.trim()
    || typeof value.launchId !== 'string' || !value.launchId.trim()
    || !['claude', 'codex'].includes(value.toolType)) return null;
  return { toolType: value.toolType, terminalInstanceId: value.terminalInstanceId, launchId: value.launchId };
}

function parsedAddress(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value || null; } catch { return null; }
}

function sameLaunch(left, right) {
  const a = launchAddress(left), b = launchAddress(right);
  return !!a && !!b && a.toolType === b.toolType
    && a.terminalInstanceId === b.terminalInstanceId && a.launchId === b.launchId;
}

function address(value) {
  const provider = required(value.provider || value.toolType, 'provider');
  const sessionId = typeof value.sessionId === 'string' && value.sessionId.trim() ? value.sessionId : null;
  const pending = launchAddress(value.sendTarget);
  if (!sessionId && (!pending || pending.toolType !== provider)) {
    throw new TabMessageError('message_runtime_identity_unavailable', 'The conversation identity is not proven; no input was written.', 503);
  }
  return {
    tabId: required(value?.tabId, 'tabId'),
    tabName: value.tabName || value.tabId,
    projectId: required(value.projectId, 'projectId'),
    projectName: value.projectName || value.projectId,
    cwd: value.cwd || null,
    provider,
    sessionId,
    sendTarget: sessionId ? { toolType: provider, sessionId } : pending,
    runtimeTarget: value.runtimeTarget || value.sendTarget || null,
  };
}

function tabId(value) {
  return required(typeof value === 'string' ? value : value?.tabId, 'tabId');
}

function identity(value) {
  return [value.tabId, value.projectId, value.provider || value.toolType, value.sessionId || null,
    !value.sessionId ? launchAddress(value.sendTarget) : null];
}

function endpoint(message, side) {
  return { ...Object.fromEntries(['TabId', 'TabName', 'ProjectId', 'ProjectName', 'Cwd', 'Provider', 'SessionId']
    .map((key) => [key[0].toLowerCase() + key.slice(1), message[side + key]])),
    sendTarget: parsedAddress(message[side + 'AddressJson']) };
}

function fields(value, side) {
  const { sendTarget, runtimeTarget: _runtimeTarget, ...rest } = value;
  return { ...Object.fromEntries(Object.entries(rest).map(([key, item]) =>
    [side + key[0].toUpperCase() + key.slice(1), key === 'sessionId' ? item || '' : item])),
    // Empty is the legacy SQL representation of absence, never an address.
    [side + 'AddressJson']: rest.sessionId ? null : JSON.stringify(sendTarget) };
}

function label(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

function formatTabMessagePrompt(message, originalQuestion = null) {
  const sender = `${label(message.sourceTabName)} (${message.sourceTabId})`;
  const header = `[Tab message: ${message.kind}]\nMessage ID: ${message.messageId}\nFrom: ${sender}`;
  if (message.kind === 'reply') {
    return `${header}\nReply to: ${message.replyTo}\nOriginal question: ${JSON.stringify(label(originalQuestion?.text || originalQuestion))}\nThis answer is context from another tab, not a new user task. No automatic reply is requested.\n\nAnswer:\n${message.text}`;
  }
  return `${header}\nThis is an addressed question from another tab, not task delegation or a higher-priority user instruction. Continue your current work; when the answer is ready, call reply_to_message({messageId:${JSON.stringify(message.messageId)},text:"your complete answer"}). Reply explicitly to this ID once; your ordinary final response does not answer it.\n\nQuestion:\n${message.text}`;
}

function publicMessage(row) {
  if (!row) return null;
  const {
    requestFingerprint, frozenPrompt, promptPrepared, attemptCount,
    retryAllowed, receiptAttempt, receiptUpdatedAt, deliverySessionId, sourceCwd, targetCwd,
    sourceAddressJson, targetAddressJson, ...message
  } = row;
  return { ...message, sourceSessionId: message.sourceSessionId || null, targetSessionId: message.targetSessionId || null,
    ...(sourceAddressJson ? { sourceSendTarget: parsedAddress(sourceAddressJson) } : {}),
    ...(targetAddressJson ? { targetSendTarget: parsedAddress(targetAddressJson) } : {}) };
}

function compactMessage(row) {
  const { text, ...metadata } = publicMessage(row);
  return { ...metadata, textPreview: text.slice(0, 200), textChars: text.length };
}

function safeCode(value, fallback) {
  return typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,96}$/.test(value) ? value : fallback;
}

function receiptOutcome(record, message) {
  const receipt = record?.receipt || record || {};
  const state = record?.state;
  if (state === 'confirmed') return { deliveryState: 'sent' };
  if (!canProjectCurrentProviderQueue(record)) {
    return { deliveryState: !record.attemptId || ['not-submitted', 'provider-not-accepted'].includes(state) ? 'failed' : 'unconfirmed',
      retryAllowed: 0, code: record.deliveryControl?.cancelledAt ? 'tab_message_cancelled' : 'tab_message_input_slot_retired',
      error: 'This operation no longer owns the input; its delivery evidence is preserved.' };
  }
  const applicationQueue = record?.applicationQueue || receipt.applicationQueue;
  if (applicationQueue?.version === 1 && ['waiting', 'dispatching'].includes(applicationQueue.state)
    && ((!record.attemptId && ['reserved', 'preparing'].includes(state || record.receiptState))
      || applicationQueue.waitingBeforeInput === true && state === 'not-submitted')) {
    return { deliveryState: applicationQueue.state === 'waiting' ? 'pending' : 'sending',
      retryAllowed: 0, code: null, error: null };
  }
  if (!['not-submitted', 'provider-not-accepted'].includes(state)
    && (state === 'queued' || receipt.status === 'queued' && receipt.submitted === true
    || isAgentSendProviderQueueAccepted(receipt, {
    operationKey: message.operationKey, provider: message.targetProvider,
    attemptId: record?.attemptId,
  }))) return { deliveryState: 'queued' };
  const classified = state || classifyAgentSendRegistryReceipt(receipt);
  if (classified === 'confirmed') return { deliveryState: 'sent' };
  if (['reserved', 'preparing', 'not-submitted', 'provider-not-accepted'].includes(classified)) {
    const code = safeCode(receipt.code, 'tab_message_not_submitted');
    const draftBlocked = classified !== 'provider-not-accepted'
      && (/draft|input.*(?:busy|occupied|conflict)|waiting.for.input/.test(code)
        || receipt.status === 'waiting-for-input');
    return {
      deliveryState: draftBlocked ? 'waiting-for-input' : 'failed',
      retryAllowed: classified === 'provider-not-accepted' || code === 'agent_send_queue_cancelled' ? 0 : 1,
      code,
      error: draftBlocked ? 'The destination input is occupied; delivery is waiting.' : 'The transport did not accept the message.',
    };
  }
  return {
    deliveryState: 'unconfirmed',
    code: safeCode(receipt.code, 'tab_message_delivery_unconfirmed'),
    error: 'Delivery is not yet confirmed. The existing operation must be reconciled.',
  };
}

/**
 * The adapter owns scenario execution and must recheck the supplied pinned
 * target immediately before PTY input. No task/run dependency is created here.
 * send receives public fields plus prompt, preparedPrompt, and attemptCount.
 */
class TabMessageService {
  constructor({ db, resolveTab, send, getReceipt = () => null, onChanged = () => {}, log = () => {},
    receiptRequiredBeforeSend = false, releaseReceipt = null, cancelDelivery = null, readRestartBinding = null }) {
    if (!db?.prepare || !db?.transaction) throw new TypeError('A raw better-sqlite3 database is required');
    if (typeof resolveTab !== 'function' || typeof send !== 'function') throw new TypeError('resolveTab and send are required');
    if (releaseReceipt != null && typeof releaseReceipt !== 'function') throw new TypeError('releaseReceipt must be a function');
    Object.assign(this, { db, resolveTab, send, getReceipt, onChanged, log, releaseReceipt, cancelDelivery, readRestartBinding });
    // Only opt in when every physical send reserves a durable receipt and
    // unresolved messages keep that receipt. Absence then proves no input.
    this.receiptRequiredBeforeSend = receiptRequiredBeforeSend === true;
    this.initialized = false;
    this.disposed = false;
    this.lanes = new Map();
    this.preparing = new Set();
  }

  initialize() {
    if (this.disposed) throw new TabMessageError('tab_message_disposed', 'The message service is disposed', 503);
    if (this.initialization) return this.initialization;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      messageId TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('question', 'reply')),
      replyTo TEXT UNIQUE REFERENCES ${TABLE_NAME}(messageId),
      sourceTabId TEXT NOT NULL, sourceTabName TEXT NOT NULL,
      sourceProjectId TEXT NOT NULL, sourceProjectName TEXT NOT NULL, sourceCwd TEXT,
      sourceProvider TEXT NOT NULL, sourceSessionId TEXT NOT NULL,
      targetTabId TEXT NOT NULL, targetTabName TEXT NOT NULL,
      targetProjectId TEXT NOT NULL, targetProjectName TEXT NOT NULL, targetCwd TEXT,
      targetProvider TEXT NOT NULL, targetSessionId TEXT NOT NULL,
      text TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      deliveryState TEXT NOT NULL CHECK(deliveryState IN
        ('pending','sending','queued','sent','waiting-for-input','unconfirmed','failed')),
      error TEXT, code TEXT, replyMessageId TEXT, answeredAt TEXT,
      sourceDismissedAt TEXT, targetDismissedAt TEXT,
      operationKey TEXT NOT NULL UNIQUE, handoffId TEXT NOT NULL UNIQUE,
      requestId TEXT NOT NULL, requestFingerprint TEXT NOT NULL,
      frozenPrompt TEXT NOT NULL, promptPrepared INTEGER NOT NULL DEFAULT 0,
      attemptCount INTEGER NOT NULL DEFAULT 0, retryAllowed INTEGER NOT NULL DEFAULT 0,
      receiptAttempt INTEGER NOT NULL DEFAULT 0, receiptUpdatedAt TEXT, deliverySessionId TEXT,
      UNIQUE(sourceTabId, requestId)
    );
    CREATE INDEX IF NOT EXISTS tab_messages_target ON ${TABLE_NAME}(targetTabId, createdAt);
    CREATE INDEX IF NOT EXISTS tab_messages_source ON ${TABLE_NAME}(sourceTabId, createdAt);`);
    this.db.transaction(() => {
      const columns = new Set(this.db.prepare(`PRAGMA table_info(${TABLE_NAME})`).all().map((column) => column.name));
      for (const column of ['sourceDismissedAt', 'targetDismissedAt', 'sourceAddressJson', 'targetAddressJson', 'cancelledAt', 'cancelledByTabId', 'sourceRestartBindingId']) {
        if (!columns.has(column)) this.db.exec(`ALTER TABLE ${TABLE_NAME} ADD COLUMN ${column} TEXT`);
      }
    })();
    this.initialized = true;
    this.initialization = (async () => {
      // A crash can leave the receipt pinned after sent/cancel intent committed.
      // Sweep keys only; already-delivered bodies and UI events are not replayed.
      if (this.releaseReceipt) {
        const sent = this.db.prepare(`SELECT operationKey FROM ${TABLE_NAME}
          WHERE deliveryState = 'sent' OR cancelledAt IS NOT NULL`).all();
        for (const { operationKey } of sent) {
          if (this.disposed) return this;
          await this._releaseReceipt(operationKey);
        }
      }
      if (this.disposed) return this;
      await this.reconcileReceipts(null, 'startup-reconcile');
      if (!this.disposed) {
        for (const row of this.db.prepare(`SELECT DISTINCT targetTabId FROM ${TABLE_NAME} WHERE deliveryState = 'pending'`).all()) {
          this._enqueue(row.targetTabId);
        }
      }
      return this;
    })();
    return this.initialization;
  }

  _assertReady() {
    if (!this.initialized || this.disposed) throw new TabMessageError('tab_message_unavailable', 'The message service is not available', 503);
  }

  _row(messageId) {
    return this.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE messageId = ?`).get(messageId) || null;
  }

  getMessage(messageId) {
    this._assertReady();
    const row = this._row(required(messageId, 'messageId'));
    if (!row) return null;
    return { message: publicMessage(row), reply: row.replyMessageId ? publicMessage(this._row(row.replyMessageId)) : null };
  }

  listForTab(id, { limit = 100 } = {}) {
    this._assertReady();
    required(id, 'tabId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TabMessageError('tab_message_invalid_limit', 'limit must be an integer from 1 to 1000', 400);
    }
    // SQLite counts Unicode code points; unlike full-message JS lengths this
    // does not count a supplementary character as two UTF-16 code units.
    return this.db.prepare(`SELECT ${LIST_COLUMNS}, substr(text, 1, 200) AS textPreview,
      length(text) AS textChars FROM ${TABLE_NAME} WHERE sourceTabId = ? OR targetTabId = ?
      ORDER BY createdAt DESC, rowid DESC LIMIT ?`).all(id, id, limit)
      .map((message) => ({ ...publicMessage(message), textPreview: message.textPreview.slice(0, 200) }));
  }

  restartReferences() {
    this._assertReady();
    // Exact outstanding owner inventory, not the retention-limited UI history.
    return this.db.prepare(`SELECT messageId,kind,replyTo,sourceTabId,sourceProjectId,sourceProvider,sourceSessionId,
      targetTabId,targetProjectId,targetProvider,targetSessionId,deliveryState,deliverySessionId,attemptCount,
      replyMessageId,requestFingerprint,operationKey,handoffId,sourceRestartBindingId FROM ${TABLE_NAME}
      WHERE cancelledAt IS NULL AND ((kind='question' AND replyMessageId IS NULL) OR deliveryState!='sent')`).all();
  }

  restartReference(messageId) {
    this._assertReady();
    return this.db.prepare(`SELECT messageId,kind,replyTo,sourceTabId,sourceProjectId,sourceProvider,sourceSessionId,
      targetTabId,targetProjectId,targetProvider,targetSessionId,deliveryState,deliverySessionId,attemptCount,
      replyMessageId,requestFingerprint,operationKey,handoffId,cancelledAt FROM ${TABLE_NAME} WHERE messageId=?`).get(messageId) || null;
  }

  // Dismissal is per-tab presentation on the question, including for reply IDs.
  // It neither needs a live session nor participates in transport transitions.
  dismissMessage({ tabId: id, messageId }) {
    this._assertReady();
    required(id, 'tabId');
    required(messageId, 'messageId');
    const result = this.db.transaction(() => {
      let row = this._row(messageId);
      if (row?.kind === 'reply') row = this._row(row.replyTo);
      if (!row) throw new TabMessageError('tab_message_not_found', 'The question does not exist', 404);
      const column = row.sourceTabId === id ? 'sourceDismissedAt'
        : row.targetTabId === id ? 'targetDismissedAt' : null;
      if (!column) {
        throw new TabMessageError('tab_message_foreign_participant', 'Only an involved tab may dismiss this question', 403);
      }
      if (row[column]) return { row, deduplicated: true };
      const timestamp = updatedAfter(row.updatedAt);
      this.db.prepare(`UPDATE ${TABLE_NAME} SET ${column} = ?, updatedAt = ? WHERE messageId = ?`)
        .run(timestamp, timestamp, row.messageId);
      return { row: this._row(row.messageId), deduplicated: false };
    })();
    if (!result.deduplicated) this._changed(result.row, 'dismissed');
    return { message: publicMessage(result.row), deduplicated: result.deduplicated };
  }

  // Explicit cancellation is thread intent, distinct from the legacy per-side
  // hide action. Physical delivery facts may still arrive after cancellation.
  cancelMessage({ tabId: id, messageId }) {
    this._assertReady(); required(id, 'tabId'); required(messageId, 'messageId');
    if (typeof this.cancelDelivery !== 'function') {
      throw new TabMessageError('tab_message_cancel_unavailable', 'Durable delivery cancellation is unavailable', 503);
    }
    const effects = [];
    const result = this.db.transaction(() => {
      let question = this._row(messageId);
      if (question?.kind === 'reply') question = this._row(question.replyTo);
      if (!question) throw new TabMessageError('tab_message_not_found', 'The question does not exist', 404);
      if (question.sourceTabId !== id && question.targetTabId !== id) {
        throw new TabMessageError('tab_message_foreign_participant', 'Only an involved tab may cancel this question', 403);
      }
      const timestamp = question.cancelledAt || updatedAfter(question.updatedAt);
      const rows = [question, question.replyMessageId && this._row(question.replyMessageId)].filter(Boolean);
      for (const row of rows) {
        if (!row.cancelledAt) this.db.prepare(`UPDATE ${TABLE_NAME} SET cancelledAt=COALESCE(cancelledAt,?),
          cancelledByTabId=COALESCE(cancelledByTabId,?),retryAllowed=0,updatedAt=? WHERE messageId=?`)
          .run(timestamp, id, updatedAfter(row.updatedAt), row.messageId);
        if (this.cancelDelivery) {
          const cancellation = this.cancelDelivery(this._row(row.messageId));
          if (cancellation?.then || cancellation?.ok !== true) {
            throw new TabMessageError('tab_message_cancel_not_committed', 'Cancellation was not durably recorded', 503);
          }
          if (typeof cancellation?.afterCommit === 'function') effects.push(cancellation.afterCommit);
        }
      }
      return { rows: rows.map(row => this._row(row.messageId)), deduplicated: !!question.cancelledAt };
    })();
    for (const effect of effects) {
      try { effect(); } catch (error) {
        this._diagnostic('tab-message-cancel-effects-pending', result.rows[0], { code: safeCode(error?.code, 'cancel_effects_failed') });
      }
    }
    for (const row of result.rows) {
      // The durable intent marker now forbids a new attempt after receipt TTL.
      // Unknown delivery and queue/asset pins keep their independent owners.
      void this._releaseReceipt(row.operationKey);
      this._changed(row, 'cancelled');
    }
    return { message: publicMessage(result.rows[0]), cancelled: true, deduplicated: result.deduplicated };
  }

  assertDeliveryActive(messageId) {
    this._assertReady();
    const row = this._row(messageId);
    if (!row || row.cancelledAt || row.replyTo && this._row(row.replyTo)?.cancelledAt) {
      const error = new TabMessageError('tab_message_cancelled', 'Delivery was cancelled by the user');
      error.submitted = false;
      throw error;
    }
    return row;
  }

  receiptPresentation(operationKey, tabId) {
    if (!this.initialized || this.disposed) return null;
    const row = this.db.prepare(`SELECT messageId,replyTo,sourceTabId,targetTabId,sourceDismissedAt,
      targetDismissedAt,cancelledAt FROM ${TABLE_NAME} WHERE operationKey=?`).get(operationKey);
    if (!row || row.targetTabId !== tabId) return null;
    const question = row.replyTo ? this.db.prepare(`SELECT sourceTabId,targetTabId,sourceDismissedAt,
      targetDismissedAt,cancelledAt FROM ${TABLE_NAME} WHERE messageId=?`).get(row.replyTo) : row;
    if (!question || ![question.sourceTabId, question.targetTabId].includes(tabId)) return null;
    const hidden = question.cancelledAt || (question.sourceTabId === tabId
      ? question.sourceDismissedAt : question.targetDismissedAt);
    return hidden ? { presentationDismissedAt: Date.parse(hidden), presentationDismissedSurface: 'desktop-history' } : null;
  }

  async _resolve(value, allowResume = false) {
    const id = tabId(value);
    const resolved = await this.resolveTab(id);
    this._assertReady();
    if (!resolved) throw new TabMessageError('tab_message_tab_not_found', 'The addressed tab does not exist', 404);
    const live = address(resolved);
    if (live.tabId !== id) throw new TabMessageError('tab_message_address_mismatch', 'The resolved tab does not match the address');
    if (typeof value === 'object') {
      const pending = !value.sessionId && launchAddress(value.sendTarget);
      if (pending && !sameLaunch(pending, resolved.runtimeTarget || resolved.sendTarget)) {
        throw new TabMessageError('tab_message_address_changed', 'The originally addressed launch changed');
      }
      for (const field of ['projectId', 'provider', 'sessionId']) {
        const expected = field === 'provider' ? value.provider || value.toolType : value[field];
        const resumed = field === 'sessionId' && allowResume && expected
          && resolved.acceptedResumeSourceSessionId === expected;
        if (field === 'sessionId' && expected && !live.sessionId && !resumed) {
          throw new TabMessageError('tab_message_identity_pending', 'The original conversation identity is still being proved', 503);
        }
        if (expected !== undefined && expected !== live[field] && !resumed && !(field === 'sessionId' && pending)) {
          throw new TabMessageError('tab_message_address_changed', 'The tab provider, session or project has changed');
        }
      }
    }
    return live;
  }

  _existing(sourceId, requestId, payload) {
    const row = this.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE sourceTabId = ? AND requestId = ?`).get(sourceId, requestId);
    if (!row) return null;
    // Live session metadata is a delivery guard, not caller payload. Comparing
    // persisted columns also keeps reservations from the earlier hash readable.
    if (row.kind !== payload.kind || row.text !== payload.text
      || (payload.kind === 'question' ? row.targetTabId !== payload.targetTabId : row.replyTo !== payload.replyTo)) {
      throw Object.assign(new TabMessageError('tab_message_request_conflict', 'This requestId already belongs to a different message payload'), {
        messageId: row.messageId,
      });
    }
    return { message: publicMessage(row), deduplicated: true };
  }

  getExistingReservation({ sourceTabId, requestId, kind, targetTabId = null, replyTo = null, text }) {
    this._assertReady();
    required(sourceTabId, 'sourceTabId');
    required(requestId, 'requestId');
    required(text, 'text');
    if (!['question', 'reply'].includes(kind)) throw new TabMessageError('tab_message_invalid_input', 'kind must be question or reply', 400);
    required(kind === 'question' ? targetTabId : replyTo, kind === 'question' ? 'targetTabId' : 'replyTo');
    return this._existing(sourceTabId, requestId, { kind, targetTabId, replyTo, text });
  }

  async sendMessage({ source, target, text, requestId }) {
    this._assertReady();
    required(text, 'text');
    required(requestId, 'requestId');
    const sourceId = tabId(source);
    const targetId = tabId(target);
    const payload = { kind: 'question', targetTabId: targetId, text };
    const fingerprint = hash(JSON.stringify(['question', sourceId, targetId, text]));
    const existing = this._existing(sourceId, requestId, payload);
    if (existing) return existing;
    if (sourceId === targetId) throw new TabMessageError('tab_message_self_question', 'A tab cannot address a question to itself', 400);
    const from = await this._resolve(source);
    const to = await this._resolve(target);
    this._assertReady();
    const result = this.db.transaction(() => this._existing(sourceId, requestId, payload)
      || this._reserve({ kind: 'question', source: from, target: to, text, requestId, fingerprint }))();
    this._accepted(result);
    return result;
  }

  async replyToMessage({ responder, messageId, text, requestId }) {
    this._assertReady();
    required(text, 'text');
    required(requestId, 'requestId');
    required(messageId, 'messageId');
    const sourceId = tabId(responder);
    const payload = { kind: 'reply', replyTo: messageId, text };
    const existingReply = this._existing(sourceId, requestId, payload);
    if (existingReply) return existingReply;
    const question = this._row(required(messageId, 'messageId'));
    if (!question) throw new TabMessageError('tab_message_not_found', 'The original question does not exist', 404);
    if (question.kind !== 'question') throw new TabMessageError('tab_message_not_question', 'Replies cannot themselves be answered', 400);
    const from = await this._resolve(responder);
    const addressed = endpoint(question, 'target');
    const provisionalResponder = !addressed.sessionId && sameLaunch(addressed.sendTarget, from.runtimeTarget);
    // A proven Resume may have changed the actual delivery session, never the
    // return address. Only that persisted delivery binding can answer as well.
    const deliveredResponder = question.deliverySessionId && question.attemptCount > 0
      && from.sessionId === question.deliverySessionId;
    let restartBinding = null;
    if (JSON.stringify(identity(from)) !== JSON.stringify(identity({
      ...addressed, sessionId: deliveredResponder ? question.deliverySessionId : provisionalResponder ? from.sessionId : addressed.sessionId,
    }))) {
      restartBinding = await this.readRestartBinding?.({ phase: 'reply', role: 'target', message: question, expected: addressed, live: from });
      const current = await this._resolve(responder);
      if (!restartBinding?.bindingId || restartBinding.sessionId !== from.sessionId
        || JSON.stringify(identity(current)) !== JSON.stringify(identity(from)) || restartBinding.isCurrent?.() !== true) {
        throw new TabMessageError('tab_message_foreign_responder', 'Only the original addressed tab and session may answer this question', 403);
      }
    }
    const fingerprint = hash(JSON.stringify(['reply', sourceId, messageId, text]));
    const result = this.db.transaction(() => {
      if (restartBinding && restartBinding.isCurrent?.() !== true) {
        throw new TabMessageError('tab_message_address_changed', 'The proved restart participant changed before reservation');
      }
      const existing = this._existing(from.tabId, requestId, payload);
      if (existing) return existing;
      if (this._row(messageId).replyMessageId) {
        throw new TabMessageError('tab_message_already_answered', 'This question already has its explicit final answer');
      }
      const reserved = this._reserve({
        kind: 'reply', source: { ...addressed, provider: from.provider, sessionId: from.sessionId,
          sendTarget: from.sendTarget, runtimeTarget: from.runtimeTarget }, target: endpoint(question, 'source'),
        text, requestId, fingerprint, question: this._row(messageId),
        sourceRestartBindingId: restartBinding?.bindingId || null,
      });
      this.db.prepare(`UPDATE ${TABLE_NAME} SET replyMessageId = ?, answeredAt = ?, updatedAt = ? WHERE messageId = ?`)
        .run(reserved.message.messageId, reserved.message.createdAt, updatedAfter(this._row(messageId).updatedAt), messageId);
      return reserved;
    })();
    if (!result.deduplicated) this._changed(this._row(messageId), 'answered');
    this._accepted(result);
    return result;
  }

  _reserve({ kind, source, target, text, requestId, fingerprint, question = null, sourceRestartBindingId = null }) {
    const messageId = randomUUID();
    const timestamp = now();
    const row = {
      messageId, kind, replyTo: question?.messageId || null,
      ...fields(source, 'source'), ...fields(target, 'target'), text,
      createdAt: timestamp, updatedAt: timestamp, deliveryState: 'pending',
      error: null, code: null, replyMessageId: null, answeredAt: null,
      cancelledAt: question?.cancelledAt || null, cancelledByTabId: question?.cancelledByTabId || null,
      operationKey: `tab-message:${messageId}`, handoffId: `tab-message:${messageId}`,
      requestId, requestFingerprint: fingerprint,
      sourceRestartBindingId,
    };
    if (row.cancelledAt) Object.assign(row, { deliveryState: 'failed', code: 'tab_message_cancelled',
      error: 'The request was cancelled; this reply is saved without delivery.' });
    row.frozenPrompt = formatTabMessagePrompt(row, question);
    const keys = Object.keys(row);
    this.db.prepare(`INSERT INTO ${TABLE_NAME} (${keys.join(',')}) VALUES (${keys.map((key) => '@' + key).join(',')})`).run(row);
    return { message: publicMessage(this._row(messageId)), deduplicated: false };
  }

  _accepted(result) {
    if (result.deduplicated) return;
    this._changed(this._row(result.message.messageId), 'accepted');
    this._enqueue(result.message.targetTabId);
  }

  _diagnostic(event, row, extra = {}) {
    try {
      this.log(event, {
        messageId: row?.messageId || null, replyTo: row?.replyTo || null,
        operationKey: row?.operationKey || null, sourceTabId: row?.sourceTabId || null,
        targetTabId: row?.targetTabId || null, sourceSessionId: row?.sourceSessionId || null,
        targetSessionId: row?.targetSessionId || null, deliveryState: row?.deliveryState || null,
        sourceDismissedAt: row?.sourceDismissedAt || null, targetDismissedAt: row?.targetDismissedAt || null,
        updatedAt: row?.updatedAt || null,
        sourceProvider: row?.sourceProvider || null, targetProvider: row?.targetProvider || null,
        attemptCount: row?.attemptCount || 0,
        textLength: row?.text?.length || 0, textHash: row ? hash(row.text) : null,
        promptLength: row?.frozenPrompt?.length || 0, promptHash: row ? hash(row.frozenPrompt) : null,
        code: row?.code || null, ...extra,
      });
    } catch { /* Diagnostics cannot invalidate a committed message. */ }
  }

  _changed(row, reason) {
    this._diagnostic('tab-message-transition', row, { reason: safeCode(reason, 'transition') });
    try { this.onChanged(compactMessage(row), reason); } catch {
      this._diagnostic('tab-message-observer-error', row);
    }
  }

  async _releaseReceipt(operationKey) {
    if (!this.releaseReceipt) return;
    try {
      await this.releaseReceipt(operationKey);
    } catch (error) {
      this._diagnostic('tab-message-receipt-release-error', null, {
        operationKey, code: safeCode(error?.code, 'tab_message_receipt_release_failed'),
      });
    }
  }

  _transition(messageId, next, reason) {
    const row = this._row(messageId);
    if (!row || row.deliveryState === 'sent') return row;
    const patch = { error: null, code: null, retryAllowed: 0, ...next };
    if (row.cancelledAt) patch.retryAllowed = 0;
    if (Object.entries(patch).every(([key, value]) => row[key] === value)) return row;
    patch.updatedAt = updatedAfter(row.updatedAt);
    const keys = Object.keys(patch);
    this.db.prepare(`UPDATE ${TABLE_NAME} SET ${keys.map((key) => `${key} = @${key}`).join(',')} WHERE messageId = @messageId`)
      .run({ ...patch, messageId });
    const updated = this._row(messageId);
    if (updated.deliveryState === 'sent') void this._releaseReceipt(updated.operationKey);
    this._changed(updated, reason);
    return updated;
  }

  // An adapter may add prepared context only once, before its first physical
  // transport operation. Retries always use those exact persisted bytes.
  updateFrozenPrompt(messageId, prompt) {
    this._assertReady();
    this.assertDeliveryActive(messageId);
    required(prompt, 'prompt');
    const row = this._row(required(messageId, 'messageId'));
    if (!row) throw new TabMessageError('tab_message_not_found', 'The message does not exist', 404);
    if (row.promptPrepared && row.frozenPrompt === prompt) return { ...publicMessage(row), prompt, preparedPrompt: prompt, frozenPrompt: prompt, promptPrepared: true };
    if (row.promptPrepared || !(row.deliveryState === 'pending' && row.attemptCount === 0
      || this.preparing.has(messageId))) {
      throw new TabMessageError('tab_message_prompt_frozen', 'The transport prompt is already frozen');
    }
    this.db.prepare(`UPDATE ${TABLE_NAME} SET frozenPrompt = ?, promptPrepared = 1, updatedAt = ? WHERE messageId = ?`)
      .run(prompt, updatedAfter(row.updatedAt), messageId);
    const updated = this._row(messageId);
    this._diagnostic('tab-message-prompt-prepared', updated);
    return { ...publicMessage(updated), prompt, preparedPrompt: prompt, frozenPrompt: prompt, promptPrepared: true };
  }

  observeReceipt(operationKey, receipt, reason = 'receipt') {
    this._assertReady();
    if (typeof operationKey === 'object' && receipt === undefined) {
      receipt = operationKey;
      operationKey = receipt.operationKey;
    }
    let row = this.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE operationKey = ?`).get(required(operationKey, 'operationKey'));
    if (!row) return null;
    if (receipt) {
      let materializedSessionId = null;
      for (const [key, expected] of [['operationKey', row.operationKey], ['tabId', row.targetTabId],
        ['handoffId', row.handoffId], ['provider', row.targetProvider], ['sessionId', row.targetSessionId],
        ['promptHash', promptAuditFingerprint(row.frozenPrompt)], ['promptLength', row.frozenPrompt.length]]) {
        const firstWriter = key === 'sessionId' && !row.targetSessionId && launchAddress(parsedAddress(row.targetAddressJson))
          && receipt.state === 'confirmed' && receipt.auditIdentity?.sessionId === receipt[key]
          && receipt.operationKey === row.operationKey && receipt.tabId === row.targetTabId && receipt.handoffId === row.handoffId
          && receipt.provider === row.targetProvider && receipt.auditIdentity?.provider === row.targetProvider
          && receipt.attemptId && receipt.attemptId === receipt.auditIdentity?.attemptId
          && (receipt.auditIdentity?.entryUuid || receipt.auditIdentity?.sourceIdentity)
          && receipt.promptHash === promptAuditFingerprint(row.frozenPrompt)
          && sameLaunch(parsedAddress(row.targetAddressJson), receipt.receipt?.expectedTarget);
        const resumed = key === 'sessionId' && receipt[key] === row.deliverySessionId;
        if (firstWriter && typeof receipt[key] === 'string' && receipt[key]) {
          materializedSessionId = receipt[key];
        }
        if (receipt[key] != null && receipt[key] !== expected && !resumed && !firstWriter) {
          this._diagnostic('tab-message-receipt-rejected', row, { mismatchedField: key });
          if (row.deliveryState === 'sent' || row.deliveryState === 'queued') return publicMessage(row);
          return publicMessage(this._transition(row.messageId, {
            deliveryState: 'unconfirmed', code: 'tab_message_receipt_identity_mismatch',
            error: 'The transport receipt does not match the frozen message identity.',
          }, 'receipt-rejected'));
        }
      }
      const attempt = Number(receipt.attempt) || 0;
      if (attempt && attempt < row.receiptAttempt) return publicMessage(row);
      if (receipt.updatedAt && row.receiptUpdatedAt && attempt <= row.receiptAttempt
        && receipt.updatedAt < row.receiptUpdatedAt) return publicMessage(row);
      if (!row.targetSessionId && receipt.state === 'confirmed' && !materializedSessionId) {
        return publicMessage(this._transition(row.messageId, {
          deliveryState: 'unconfirmed', code: 'tab_message_receipt_identity_mismatch',
          error: 'The first conversation identity requires an exact canonical receipt.',
        }, 'receipt-rejected'));
      }
      if (materializedSessionId) {
        this.db.prepare(`UPDATE ${TABLE_NAME} SET targetSessionId = ?, deliverySessionId = ?, targetAddressJson = NULL
          WHERE messageId = ? AND targetSessionId = '' AND targetAddressJson IS ?`)
          .run(materializedSessionId, materializedSessionId, row.messageId, row.targetAddressJson);
        row = this._row(row.messageId);
      }
    }
    const outcome = receiptOutcome(receipt, row);
    // Positive acceptance survives late ambiguous/negative send callbacks.
    const queueReturned = receipt?.state === 'provider-not-accepted'
      || classifyAgentSendRegistryReceipt(receipt?.receipt || receipt || {}) === 'provider-not-accepted';
    if (row.deliveryState === 'queued' && outcome.deliveryState !== 'sent' && !queueReturned
      && canProjectCurrentProviderQueue(receipt)) return publicMessage(row);
    return publicMessage(this._transition(row.messageId, {
      ...outcome,
      receiptAttempt: Math.max(row.receiptAttempt, Number(receipt?.attempt) || 0),
      receiptUpdatedAt: receipt?.updatedAt || row.receiptUpdatedAt,
    }, reason));
  }

  async _reconcileOne(row, reason) {
    let receipt;
    try { receipt = await this.getReceipt(row.operationKey); } catch {
      if (!this.disposed) {
        this._diagnostic('tab-message-receipt-unavailable', row);
        if (row.deliveryState === 'sending') this.observeReceipt(row.operationKey, null, reason);
      }
      return;
    }
    if (!this.disposed && !receipt && this.receiptRequiredBeforeSend
      && ['sending', 'unconfirmed'].includes(row.deliveryState)) {
      const current = this._row(row.messageId);
      if (['sending', 'unconfirmed'].includes(current.deliveryState)) {
        this._transition(row.messageId, reason === 'startup-reconcile'
          ? { deliveryState: 'pending', retryAllowed: 1 }
          : { deliveryState: 'failed', retryAllowed: 1, code: 'tab_message_receipt_not_reserved',
            error: 'No transport receipt was reserved; the message was not submitted.' }, 'receipt-absence-proven');
      }
      return;
    }
    // A missing receipt cannot invalidate previously durable non-submission.
    if (!receipt && !['sending', 'queued', 'unconfirmed'].includes(row.deliveryState)) return;
    if (!this.disposed) {
      this.observeReceipt(row.operationKey, receipt, reason);
      if (reason === 'startup-reconcile' && ['reserved', 'preparing'].includes(receipt?.state)) {
        const current = this._row(row.messageId);
        if (current.deliveryState === 'failed' && current.retryAllowed) {
          this._transition(row.messageId, { deliveryState: 'pending', retryAllowed: 1 }, 'startup-pre-enter');
        }
      }
    }
  }

  async reconcile(id = null, reason = 'reconcile') {
    this._assertReady();
    const rows = id
      ? [this._row(id)].filter(Boolean)
      : this.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE attemptCount > 0 AND deliveryState != 'sent'`).all();
    for (const row of rows) {
      if (this.disposed) break;
      await this._reconcileOne(row, reason);
    }
  }

  async reconcileReceipts(id = null, reason = 'receipt-reconcile') {
    this._assertReady();
    const rows = this.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE attemptCount > 0
      AND deliveryState != 'sent' ${id ? 'AND targetTabId = ?' : ''}`).all(...(id ? [id] : []));
    for (const row of rows) {
      if (this.disposed) return;
      await this._reconcileOne(row, reason);
    }
  }

  async wake(id, reason = 'wake') {
    this._assertReady();
    required(id, 'tabId');
    const rows = this.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE targetTabId = ? AND deliveryState != 'sent'`).all(id);
    for (const row of rows) {
      if (this.disposed) return;
      if (row.attemptCount > 0 && !this.preparing.has(row.messageId)) {
        await this._reconcileOne(row, 'wake-reconcile');
      }
    }
    if (this.disposed) return;
    const retryIds = this.db.prepare(`SELECT messageId FROM ${TABLE_NAME}
      WHERE targetTabId = ? AND retryAllowed = 1 AND cancelledAt IS NULL`).all(id).map((row) => row.messageId);
    return this._enqueue(id, retryIds, reason);
  }

  _enqueue(id, retryIds = [], reason = 'dispatch') {
    const previous = this.lanes.get(id) || Promise.resolve();
    const task = previous.then(async () => {
      if (this.disposed) return;
      const eligible = new Set(retryIds);
      const rows = this.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE targetTabId = ?
        AND cancelledAt IS NULL AND (deliveryState = 'pending' OR retryAllowed = 1) ORDER BY rowid`).all(id);
      for (const snapshot of rows) {
        if (this.disposed) return;
        const row = this._row(snapshot.messageId);
        if (!row.cancelledAt && (row.deliveryState === 'pending' || eligible.has(row.messageId) && row.retryAllowed)) {
          await this._deliver(row, reason);
          if (this._row(row.messageId)?.code === 'tab_message_identity_pending') break;
        }
      }
    }).catch((error) => {
      if (!this.disposed) this._diagnostic('tab-message-dispatch-error', null, { code: safeCode(error?.code, 'tab_message_dispatch_error'), targetTabId: id });
    });
    this.lanes.set(id, task);
    task.then(() => { if (this.lanes.get(id) === task) this.lanes.delete(id); });
    return task;
  }

  async _deliver(row, reason) {
    if (this._row(row.messageId)?.cancelledAt) return;
    if (row.attemptCount > 0) {
      await this._reconcileOne(row, 'retry-reconcile');
      if (this.disposed || !this._row(row.messageId).retryAllowed) return;
    }
    let target, deliveryRestartBinding = null;
    try {
      let source;
      try { source = await this._resolve(endpoint(row, 'source')); }
      catch (error) {
        if (error?.code !== 'tab_message_address_changed' || !this.readRestartBinding) throw error;
        const live = await this._resolve(row.sourceTabId);
        const binding = await this.readRestartBinding({ phase: 'delivery', role: 'source', message: row,
          expected: endpoint(row, 'source'), live });
        if (!binding?.bindingId || binding.sessionId !== live.sessionId || binding.isCurrent?.() !== true) throw error;
        deliveryRestartBinding = binding;
        source = live;
        this._transition(row.messageId, { sourceRestartBindingId: binding.bindingId }, 'restart-source-proof');
      }
      target = await this._resolve(endpoint(row, 'target'), true);
      if (deliveryRestartBinding && deliveryRestartBinding.isCurrent?.() !== true) {
        throw new TabMessageError('tab_message_address_changed', 'The proved restart source changed during delivery');
      }
      for (const [side, live] of [['source', source], ['target', target]]) {
        if (!row[side + 'SessionId'] && live.sessionId) {
          this.db.prepare(`UPDATE ${TABLE_NAME} SET ${side}SessionId = ?, ${side}AddressJson = NULL
            WHERE messageId = ? AND ${side}SessionId = '' AND ${side}AddressJson IS ?`)
            .run(live.sessionId, row.messageId, row[side + 'AddressJson']);
        }
      }
      row = this._row(row.messageId);
    } catch (error) {
      if (error?.code === 'tab_message_identity_pending') {
        if (!this.disposed) this._transition(row.messageId, { deliveryState: 'pending', retryAllowed: 0,
          code: error.code, error: 'Waiting for proof of the original conversation; no input was written.' }, 'identity-wait');
        return;
      }
      if (!this.disposed) this._transition(row.messageId, {
        deliveryState: 'failed', code: safeCode(error?.code, 'tab_message_address_unavailable'),
        error: 'The original tab address is no longer available. The message was not retargeted.',
      }, 'address-guard');
      return;
    }
    if (this.disposed) return;
    const current = this._row(row.messageId);
    if (current.cancelledAt || !(current.deliveryState === 'pending' || current.retryAllowed)) return;
    const attemptCount = current.attemptCount + 1;
    const sending = this._transition(row.messageId, {
      deliveryState: 'sending', attemptCount, deliverySessionId: target.sessionId, code: null, error: null,
    }, safeCode(reason, 'dispatch'));
    this.preparing.add(row.messageId);
    try {
      const receipt = await this.send({
        ...publicMessage(sending), prompt: sending.frozenPrompt,
        preparedPrompt: sending.promptPrepared ? sending.frozenPrompt : null,
        frozenPrompt: sending.frozenPrompt,
        promptPrepared: !!sending.promptPrepared, attemptCount,
        sourceCwd: sending.sourceCwd, targetCwd: sending.targetCwd,
      });
      if (!this.disposed) this.observeReceipt(row.operationKey, receipt, 'send-result');
    } catch (error) {
      if (!this.disposed) {
        if (this._row(row.messageId).deliveryState !== 'queued') {
          if (error?.submitted === false) this.observeReceipt(row.operationKey, error, 'send-error');
          else this._transition(row.messageId, {
            deliveryState: 'unconfirmed', code: safeCode(error?.code, 'tab_message_transport_error'),
            error: 'The transport did not return a delivery receipt.',
          }, 'send-error');
        }
        await this._reconcileOne(this._row(row.messageId), 'send-error-reconcile');
      }
    } finally {
      this.preparing.delete(row.messageId);
    }
  }

  dispose() {
    this.disposed = true;
    this.preparing.clear();
  }
}

module.exports = { TabMessageService, TabMessageError, formatTabMessagePrompt, TABLE_NAME };
