const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

const SC_DESKTOP_TERMINAL_COMPLETION_URL =
  'http://127.0.0.1:53127/notifications/terminal-completion';
const SC_DESKTOP_TERMINAL_USER_URL =
  'http://127.0.0.1:53127/notifications/terminal-user';
const SC_DESKTOP_NOTIFICATION_TIMEOUT_MS = 8_000;
const DEFAULT_SC_DESKTOP_NOTIFICATION_TOKEN_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'sc-desktop',
  'notification-bridge-token',
);

const OUTBOX_VERSION = 1;
const OUTBOX_INITIAL_RETRY_MS = 1_000;
const OUTBOX_MAX_RETRY_MS = 60_000;
const OUTBOX_MAX_PENDING = 512;
const OUTBOX_MAX_SETTLED = 2_048;
const OUTBOX_SETTLED_TTL_MS = 24 * 60 * 60 * 1_000;

function requireNonEmptyString(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(field + ' required');
  return normalized;
}

function buildTerminalCompletionEnvelope(detail = {}) {
  const projectId = requireNonEmptyString(detail.projectId, 'projectId');
  const tabId = requireNonEmptyString(detail.tabId, 'tabId');
  const tabName = requireNonEmptyString(detail.tabName || 'Terminal', 'tabName').slice(0, 160);
  const firedAt = Number(detail.firedAt);
  if (!Number.isSafeInteger(firedAt) || firedAt <= 0) {
    throw new Error('firedAt must be a positive epoch-ms integer');
  }

  return {
    kind: 'terminal-completion',
    eventId: tabId + ':' + firedAt,
    projectId,
    tabId,
    tabName,
    firedAt,
    mode: detail.persistent === true ? 'persistent' : 'oneshot',
    unread: detail.fired === true,
  };
}

function terminalUserNotificationId(tabId, requestId) {
  return 'terminal-user:' + createHash('sha256').update(JSON.stringify([tabId, requestId])).digest('hex');
}

// Reserved producer identities, not user text. Retain compatibility with
// already-persisted operational notices when the automatic channel is disabled.
function isAutomaticResearchNotification(envelope) {
  return envelope?.kind === 'terminal-user' && typeof envelope.requestId === 'string'
    && /^(?:operational-human:research-operational:|research-browser-offline:)[a-f0-9]{64}$/.test(envelope.requestId);
}

function buildTerminalUserEnvelope(detail = {}) {
  const string = (value, field, limit) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > limit
      || (field === 'text' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
        : /[\u0000-\u001f\u007f]/).test(value)) {
      throw new Error(field + ' must be a non-empty string of at most ' + limit + ' characters');
    }
    return value.trim();
  };
  const tabId = string(detail.tabId, 'tabId', 512);
  const requestId = string(detail.requestId, 'requestId', 128);
  const createdAt = Number(detail.createdAt);
  const waitSeconds = detail.waitSeconds ?? 0;
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error('createdAt required');
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) {
    throw new Error('waitSeconds must be an integer from 0 to 60');
  }
  return {
    kind: 'terminal-user', eventId: terminalUserNotificationId(tabId, requestId),
    projectId: string(detail.projectId, 'projectId', 512), tabId, requestId,
    tabName: string(String(detail.tabName || 'Terminal').replace(/\s+/g, ' ').trim().slice(0, 160)
      || 'Terminal', 'tabName', 160),
    text: string(detail.text, 'text', 2000), createdAt, waitSeconds,
  };
}

function sameUserNotification(a, b) {
  return a.kind === b.kind && a.tabId === b.tabId && a.projectId === b.projectId
    && a.requestId === b.requestId && a.text === b.text && a.waitSeconds === b.waitSeconds;
}

function resolveNotificationTokenPath(explicitPath) {
  const configured = String(
    explicitPath || process.env.SC_DESKTOP_NOTIFICATION_TOKEN_PATH || '',
  ).trim();
  if (!configured) return DEFAULT_SC_DESKTOP_NOTIFICATION_TOKEN_PATH;
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/')) return path.join(os.homedir(), configured.slice(2));
  return path.resolve(configured);
}

async function readNotificationBearerToken(tokenPath) {
  let raw;
  try {
    raw = await fs.promises.readFile(resolveNotificationTokenPath(tokenPath), 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: 'auth_token_unavailable',
      errorCode: typeof error?.code === 'string' ? error.code : null,
    };
  }

  const token = raw.trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return { ok: false, reason: 'auth_token_invalid', errorCode: null };
  }
  return { ok: true, token };
}

async function readResponsePayload(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); }
    catch { return { error: text.slice(0, 240) }; }
  } catch {
    return null;
  }
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - Date.now());
}

async function postTerminalCompletionToScDesktop(
  envelope,
  {
    endpoint,
    timeoutMs = SC_DESKTOP_NOTIFICATION_TIMEOUT_MS,
    tokenPath,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'fetch_unavailable' };
  }

  const auth = await readNotificationBearerToken(tokenPath);
  if (!auth.ok) return auth;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(endpoint || (envelope.kind === 'terminal-user'
      ? SC_DESKTOP_TERMINAL_USER_URL : SC_DESKTOP_TERMINAL_COMPLETION_URL), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + auth.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    const payload = await readResponsePayload(response);
    if (!response.ok) {
      return {
        ok: false,
        reason: 'http_error',
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after')),
        error: payload?.error || payload?.message || null,
        code: payload?.code || (envelope.kind === 'terminal-user' && response.status === 404
          ? 'sc_desktop_update_required' : null),
      };
    }
    if (payload?.ok !== true) {
      return {
        ok: false,
        reason: 'invalid_success_response',
        status: response.status,
        error: payload?.error || payload?.message || null,
      };
    }
    const messageId = payload.deliveries?.[0]?.message_id ?? null;
    if (envelope.kind === 'terminal-user' && (payload.eventId !== envelope.eventId
      || !Number.isSafeInteger(messageId) || messageId <= 0
      || !Number.isSafeInteger(payload.sentAt) || payload.sentAt <= 0)) {
      return { ok: false, reason: 'invalid_delivery_receipt', status: response.status };
    }
    return {
      ok: true,
      status: response.status,
      duplicate: payload.duplicate === true,
      deliveryCount: Array.isArray(payload.deliveries) ? payload.deliveries.length : 0,
      messageId,
      ...(envelope.kind === 'terminal-user' ? { sentAt: payload.sentAt } : {}),
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || controller.signal.aborted;
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'request_error',
      error: timedOut ? null : String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isPermanentDeliveryFailure(result) {
  return result?.status === 400 || result?.status === 401 || result?.status === 403;
}

function retryDelayMs(attemptCount, initialRetryMs, maxRetryMs) {
  const exponent = Math.min(Math.max(0, attemptCount - 1), 16);
  return Math.min(maxRetryMs, initialRetryMs * (2 ** exponent));
}

function normalizeStoredEnvelope(value) {
  if (value?.kind === 'terminal-user') {
    try {
      const normalized = buildTerminalUserEnvelope(value);
      return normalized.eventId === value.eventId ? normalized : null;
    } catch { return null; }
  }
  if (!value || value.kind !== 'terminal-completion') return null;
  const eventId = String(value.eventId || '').trim();
  const projectId = String(value.projectId || '').trim();
  const tabId = String(value.tabId || '').trim();
  const tabName = String(value.tabName || '').trim();
  const firedAt = Number(value.firedAt);
  const mode = value.mode === 'persistent' ? 'persistent' : 'oneshot';
  if (!eventId || !projectId || !tabId || !tabName || !Number.isSafeInteger(firedAt) || firedAt <= 0) {
    return null;
  }
  if (eventId !== tabId + ':' + firedAt) return null;
  return {
    kind: 'terminal-completion',
    eventId,
    projectId,
    tabId,
    tabName: tabName.slice(0, 160),
    firedAt,
    mode,
    unread: value.unread === true,
  };
}

class ScDesktopNotificationOutbox {
  constructor({
    storagePath,
    transport = postTerminalCompletionToScDesktop,
    logger = console,
    initialRetryMs = OUTBOX_INITIAL_RETRY_MS,
    maxRetryMs = OUTBOX_MAX_RETRY_MS,
    maxPending = OUTBOX_MAX_PENDING,
    strictLoad = false,
    allowAutomaticResearchNotifications = false,
  } = {}) {
    if (!storagePath) throw new Error('storagePath required');
    this.storagePath = storagePath;
    this.transport = transport;
    this.logger = logger;
    this.initialRetryMs = Math.max(100, Number(initialRetryMs) || OUTBOX_INITIAL_RETRY_MS);
    this.maxRetryMs = Math.max(this.initialRetryMs, Number(maxRetryMs) || OUTBOX_MAX_RETRY_MS);
    this.maxPending = Math.max(1, Number(maxPending) || OUTBOX_MAX_PENDING);
    this.strictLoad = strictLoad;
    this.allowAutomaticResearchNotifications = allowAutomaticResearchNotifications === true;
    this.loadError = null;
    this.pending = new Map();
    this.settled = new Map();
    this.userReceipts = new Map();
    this.admissions = new Map();
    this.attemptPromise = null;
    this.attemptEventId = null;
    this.inFlight = false;
    this.retryTimer = null;
    this.immediateScheduled = false;
    this.stopped = false;
    this.persistSequence = 0;
    this.persistChain = Promise.resolve();
    this.initialized = false;
    this.ready = this.load().catch((error) => {
      this.loadError = error;
      this.warn('load failed; ' + (strictLoad ? 'delivery held' : 'continuing with an empty in-memory queue')
        + ' error=' + String(error?.message || error));
    }).finally(() => {
      this.initialized = true;
      this.schedule();
    });
  }

  warn(message) {
    this.logger?.warn?.('[TabNotification:SC] outbox ' + message);
  }

  info(message) {
    this.logger?.log?.('[TabNotification:SC] outbox ' + message);
  }

  pruneSettled(now = Date.now()) {
    for (const [eventId, settledAt] of this.settled) {
      if (!Number.isFinite(settledAt) || now - settledAt > OUTBOX_SETTLED_TTL_MS) {
        this.settled.delete(eventId);
        this.userReceipts.delete(eventId);
      }
    }
    if (this.settled.size <= OUTBOX_MAX_SETTLED) return;
    const oldest = [...this.settled.entries()].sort((a, b) => a[1] - b[1]);
    for (const [eventId] of oldest.slice(0, this.settled.size - OUTBOX_MAX_SETTLED)) {
      this.settled.delete(eventId);
      this.userReceipts.delete(eventId);
    }
  }

  async load() {
    let parsed;
    try {
      parsed = JSON.parse(await fs.promises.readFile(this.storagePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!parsed || parsed.version !== OUTBOX_VERSION) {
      if (this.strictLoad) throw new Error('unsupported user notification outbox version');
      return;
    }
    if (this.strictLoad && (!Array.isArray(parsed.pending) || !Array.isArray(parsed.settled))) {
      throw new Error('invalid user notification outbox');
    }

    const settledEntries = Array.isArray(parsed.settled) ? parsed.settled : [];
    for (const value of settledEntries) {
      const eventId = String(value?.eventId || '').trim();
      const settledAt = Number(value?.settledAt);
      if (eventId && Number.isFinite(settledAt)) {
        this.settled.set(eventId, settledAt);
        const receipt = value.userReceipt;
        const envelope = normalizeStoredEnvelope(receipt?.envelope);
        if (envelope?.kind === 'terminal-user' && envelope.eventId === eventId
          && ['sent', 'failed', 'suppressed'].includes(receipt.deliveryState)
          && (receipt.deliveryState !== 'sent' || Number.isSafeInteger(receipt.sentAt) && receipt.sentAt > 0
            && Number.isSafeInteger(receipt.messageId) && receipt.messageId > 0)) {
          this.userReceipts.set(eventId, { ...receipt, envelope, receiptDurable: true });
        }
      }
    }
    this.pruneSettled();

    const pendingEntries = Array.isArray(parsed.pending) ? parsed.pending : [];
    for (const value of pendingEntries.slice(0, this.maxPending)) {
      const envelope = normalizeStoredEnvelope(value?.envelope);
      if (this.strictLoad && envelope?.kind !== 'terminal-user') throw new Error('invalid saved user notification');
      if (!envelope || this.pending.has(envelope.eventId) || this.settled.has(envelope.eventId)) continue;
      this.pending.set(envelope.eventId, {
        envelope,
        enqueuedAt: Number(value.enqueuedAt) || Date.now(),
        attemptCount: Math.max(0, Number(value.attemptCount) || 0),
        nextAttemptAt: Math.max(0, Number(value.nextAttemptAt) || 0),
        ...(envelope.kind === 'terminal-user' ? { durable: true,
          deliveryState: value.deliveryState === 'unknown' ? 'unknown' : 'pending',
          ...(value.lastError ? { lastError: { code: String(value.lastError.code || '').slice(0, 80),
            message: String(value.lastError.message || '').slice(0, 240) } } : {}) } : {}),
      });
    }
    if (this.pending.size) this.info('restored pending=' + this.pending.size);
  }

  persist() {
    this.pruneSettled();
    const snapshot = JSON.stringify({
      version: OUTBOX_VERSION,
      pending: [...this.pending.values()],
      settled: [...this.settled.entries()].map(([eventId, settledAt]) => ({ eventId, settledAt,
        ...(this.userReceipts.has(eventId) ? { userReceipt: this.userReceipts.get(eventId) } : {}) })),
    });
    const sequence = ++this.persistSequence;
    const operation = async () => {
      await fs.promises.mkdir(path.dirname(this.storagePath), { recursive: true });
      const temporaryPath = this.storagePath + '.tmp-' + process.pid + '-' + sequence;
      try {
        await fs.promises.writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
        await fs.promises.rename(temporaryPath, this.storagePath);
      } catch (error) {
        try { await fs.promises.unlink(temporaryPath); } catch {}
        throw error;
      }
    };
    const write = this.persistChain.then(operation, operation);
    this.persistChain = write.catch(() => {});
    return write;
  }

  async persistSafely(context) {
    try {
      await this.persist();
      return true;
    } catch (error) {
      this.warn('persist failed context=' + context + ' error=' + String(error?.message || error));
      return false;
    }
  }

  async enqueue(envelope) {
    await this.ready;
    if (this.strictLoad && this.loadError) return { ok: false, reason: 'storage_unavailable' };
    const normalized = normalizeStoredEnvelope(envelope);
    if (!normalized) return { ok: false, reason: 'invalid_envelope' };
    if (normalized.kind === 'terminal-user') {
      const existing = this.pending.get(normalized.eventId)?.envelope
        || this.userReceipts.get(normalized.eventId)?.envelope;
      if (existing && !sameUserNotification(existing, normalized)) return { ok: false, reason: 'request_id_conflict' };
      if (this.admissions.has(normalized.eventId)) return this.admissions.get(normalized.eventId);
      const record = this.pending.get(normalized.eventId);
      if (record && record.durable !== true) return this.admitUserRecord(record);
    }
    if (this.pending.has(normalized.eventId)) {
      return { ok: true, queued: false, duplicate: true, state: 'pending' };
    }
    this.pruneSettled();
    if (this.settled.has(normalized.eventId)) {
      return { ok: true, queued: false, duplicate: true, state: 'settled' };
    }
    if (this.pending.size >= this.maxPending) {
      return { ok: false, reason: 'queue_full' };
    }

    const record = {
      envelope: normalized,
      enqueuedAt: Date.now(),
      attemptCount: 0,
      nextAttemptAt: 0,
      ...(normalized.kind === 'terminal-user' ? { durable: false, deliveryState: 'pending' } : {}),
    };
    this.pending.set(normalized.eventId, record);
    if (normalized.kind === 'terminal-user') return this.admitUserRecord(record);
    const durable = await this.persistSafely('enqueue');
    this.schedule();
    return { ok: true, queued: true, duplicate: false, durable };
  }

  async admitUserRecord(record) {
    const eventId = record.envelope.eventId;
    const admission = this.persistSafely('user-enqueue').then(durable => {
      record.durable = durable;
      if (durable) this.schedule();
      return { ok: durable, queued: durable, duplicate: false, durable,
        ...(!durable ? { reason: 'persistence_failed' } : {}) };
    });
    this.admissions.set(eventId, admission);
    try { return await admission; }
    finally { this.admissions.delete(eventId); }
  }

  async readUserNotification(tabId, requestId) {
    await this.ready;
    if (this.strictLoad && this.loadError) throw new Error('user notification storage unavailable');
    this.pruneSettled();
    const eventId = terminalUserNotificationId(tabId, requestId);
    const pending = this.pending.get(eventId);
    const receipt = this.userReceipts.get(eventId);
    const envelope = pending?.envelope || receipt?.envelope;
    if (envelope?.kind !== 'terminal-user') return null;
    const sentAt = receipt?.deliveryState === 'sent' ? receipt.sentAt : null;
    return { requestId, eventId, tabId, channel: 'telegram',
      accepted: pending ? pending.durable === true : true,
      durable: pending ? pending.durable === true : true,
      receiptDurable: pending ? pending.durable === true : receipt.receiptDurable === true,
      deliveryState: receipt?.deliveryState || pending.deliveryState,
      createdAt: envelope.createdAt, waitSeconds: envelope.waitSeconds,
      sentAt, messageId: receipt?.messageId ?? null,
      waitUntil: sentAt ? sentAt + envelope.waitSeconds * 1000 : null,
      error: receipt?.error || pending?.lastError?.message || null,
      errorCode: receipt?.errorCode || pending?.lastError?.code || null };
  }

  async attemptUserNotification(eventId) {
    await this.ready;
    if (this.inFlight) {
      if (this.attemptEventId === eventId) await this.attemptPromise;
      return;
    }
    const next = this.nextRecord();
    if (next?.envelope.eventId === eventId && next.nextAttemptAt <= Date.now()) await this.drain();
  }

  nextRecord() {
    let next = null;
    for (const record of this.pending.values()) {
      if (record.envelope.kind === 'terminal-user' && record.durable !== true) continue;
      if (!next || record.enqueuedAt < next.enqueuedAt) {
        next = record;
      }
    }
    return next;
  }

  schedule() {
    if (!this.initialized || this.stopped || this.inFlight || this.strictLoad && this.loadError) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const next = this.nextRecord();
    if (!next) return;
    const delay = Math.max(0, next.nextAttemptAt - Date.now());
    if (delay === 0) {
      if (this.immediateScheduled) return;
      this.immediateScheduled = true;
      setImmediate(() => {
        this.immediateScheduled = false;
        void this.drain();
      });
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, delay);
    this.retryTimer.unref?.();
  }

  async drain() {
    if (this.stopped || this.strictLoad && this.loadError) return;
    if (this.inFlight) return this.attemptPromise;
    const record = this.nextRecord();
    if (!record) return;
    if (record.nextAttemptAt > Date.now()) {
      this.schedule();
      return;
    }

    this.inFlight = true;
    this.attemptEventId = record.envelope.eventId;
    this.attemptPromise = this.deliverRecord(record);
    try { await this.attemptPromise; }
    finally {
      this.inFlight = false;
      this.attemptEventId = null;
      this.attemptPromise = null;
      this.schedule();
    }
  }

  async deliverRecord(record) {
    if (!this.allowAutomaticResearchNotifications && isAutomaticResearchNotification(record.envelope)) {
      const eventId = record.envelope.eventId;
      this.pending.delete(eventId);
      this.settled.set(eventId, Date.now());
      const receipt = { envelope: record.envelope, deliveryState: 'suppressed',
        error: 'Automatic Research Telegram notifications are disabled',
        errorCode: 'research_automatic_notifications_disabled',
        previousDeliveryState: record.deliveryState || 'pending', previousAttemptCount: record.attemptCount,
        ...(record.lastError ? { previousError: { ...record.lastError } } : {}) };
      this.userReceipts.set(eventId, receipt);
      receipt.receiptDurable = await this.persistSafely('research-notification-suppressed');
      return;
    }
    let result;
    try {
      result = await this.transport(record.envelope);
    } catch (error) {
      result = { ok: false, reason: 'transport_rejected', error: String(error?.message || error) };
    }
    if (record.envelope.kind === 'terminal-user' && result?.ok === true
      && (!Number.isSafeInteger(result.sentAt) || result.sentAt <= 0
        || !Number.isSafeInteger(result.messageId) || result.messageId <= 0)) {
      result = { ok: false, reason: 'invalid_delivery_receipt' };
    }

    if (result?.ok === true) {
      this.pending.delete(record.envelope.eventId);
      this.settled.set(record.envelope.eventId, Date.now());
      if (record.envelope.kind === 'terminal-user') this.userReceipts.set(record.envelope.eventId, {
        envelope: record.envelope, deliveryState: 'sent', sentAt: result.sentAt,
        messageId: result.messageId,
      });
      const receiptDurable = await this.persistSafely('delivered');
      if (record.envelope.kind === 'terminal-user') this.userReceipts.get(record.envelope.eventId).receiptDurable = receiptDurable;
      this.info('delivered eventId=' + record.envelope.eventId
        + ' status=' + (result.status || '-')
        + ' duplicate=' + (result.duplicate === true)
        + ' deliveries=' + (result.deliveryCount ?? '-')
        + ' messageId=' + (result.messageId ?? '-'));
    } else if (isPermanentDeliveryFailure(result)) {
      this.pending.delete(record.envelope.eventId);
      this.settled.set(record.envelope.eventId, Date.now());
      if (record.envelope.kind === 'terminal-user') this.userReceipts.set(record.envelope.eventId, {
        envelope: record.envelope, deliveryState: 'failed', error: result.error || result.reason || 'delivery_failed',
        errorCode: result.code || result.reason || 'delivery_failed',
      });
      const receiptDurable = await this.persistSafely('permanent-failure');
      if (record.envelope.kind === 'terminal-user') this.userReceipts.get(record.envelope.eventId).receiptDurable = receiptDurable;
      this.warn('dropped permanent eventId=' + record.envelope.eventId
        + ' status=' + result.status
        + ' reason=' + (result.reason || '-'));
    } else {
      record.attemptCount += 1;
      if (record.envelope.kind === 'terminal-user') {
        record.deliveryState = 'unknown';
        record.lastError = { code: result?.code || result?.reason || 'delivery_unknown',
          message: String(result?.error || result?.reason || 'delivery_unknown').slice(0, 240) };
      }
      const exponentialDelay = retryDelayMs(record.attemptCount, this.initialRetryMs, this.maxRetryMs);
      const requestedDelay = Number(result?.retryAfterMs);
      const delay = Math.min(
        this.maxRetryMs,
        Math.max(exponentialDelay, Number.isFinite(requestedDelay) ? requestedDelay : 0),
      );
      record.nextAttemptAt = Date.now() + delay;
      await this.persistSafely('retry');
      this.warn('retry scheduled eventId=' + record.envelope.eventId
        + ' attempt=' + record.attemptCount
        + ' delayMs=' + delay
        + ' reason=' + (result?.reason || 'unknown')
        + ' status=' + (result?.status || '-')
        + ' errorCode=' + (result?.errorCode || '-'));
    }

  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function createScDesktopNotificationOutbox(options) {
  return new ScDesktopNotificationOutbox(options);
}

module.exports = {
  SC_DESKTOP_TERMINAL_COMPLETION_URL,
  SC_DESKTOP_NOTIFICATION_TIMEOUT_MS,
  DEFAULT_SC_DESKTOP_NOTIFICATION_TOKEN_PATH,
  buildTerminalCompletionEnvelope,
  buildTerminalUserEnvelope,
  terminalUserNotificationId,
  isAutomaticResearchNotification,
  postTerminalCompletionToScDesktop,
  createScDesktopNotificationOutbox,
};
