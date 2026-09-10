'use strict';

const crypto = require('node:crypto');

const {
  RECEIPT_STATES,
  classifyAgentSendRegistryReceipt,
  isExactProviderNotAcceptedReceipt,
} = require('./agent-send-receipt-registry');
const {
  classifyAgentPromptAuditIdentity,
} = require('./agent-prompt-audit-identity');

const TABLE_NAME = 'agent_send_receipts';
const DEFAULT_SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 10_000;

const STORE_STATES = Object.freeze({
  RESERVED: 'reserved',
  PREPARING: 'preparing',
  IN_FLIGHT: RECEIPT_STATES.IN_FLIGHT,
  ENTER_ARMED: 'enter-armed',
  NOT_SUBMITTED: RECEIPT_STATES.NOT_SUBMITTED,
  PROVIDER_NOT_ACCEPTED: RECEIPT_STATES.PROVIDER_NOT_ACCEPTED,
  DELIVERY_UNKNOWN: RECEIPT_STATES.DELIVERY_UNKNOWN,
  AUDIT_PENDING: RECEIPT_STATES.AUDIT_PENDING,
  CONFIRMED: RECEIPT_STATES.CONFIRMED,
});

const RESUMABLE_STATES = new Set([
  STORE_STATES.RESERVED,
  STORE_STATES.PREPARING,
  STORE_STATES.NOT_SUBMITTED,
]);

const ACTIVE_ATTEMPT_STATES = new Set([
  STORE_STATES.IN_FLIGHT,
  STORE_STATES.ENTER_ARMED,
]);

const STARTUP_UNCONFIRMED_STATES = new Set([
  STORE_STATES.DELIVERY_UNKNOWN,
  STORE_STATES.AUDIT_PENDING,
]);

// Dismissal changes only the desktop History presentation. It never changes
// delivery truth, retryability or the active PTY operation, so every durable
// receipt state is safe to hide. A canonical provider row may still appear at
// its real transcript position later.
const DISMISSIBLE_PRESENTATION_STATES = new Set(Object.values(STORE_STATES));

const REPLAY_STATES = new Set([
  STORE_STATES.IN_FLIGHT,
  STORE_STATES.ENTER_ARMED,
  STORE_STATES.DELIVERY_UNKNOWN,
  STORE_STATES.AUDIT_PENDING,
  STORE_STATES.PROVIDER_NOT_ACCEPTED,
  STORE_STATES.CONFIRMED,
]);

const SETTLED_PRUNABLE_STATES = new Set([
  STORE_STATES.CONFIRMED,
  STORE_STATES.NOT_SUBMITTED,
  STORE_STATES.PROVIDER_NOT_ACCEPTED,
]);

function requiredString(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(label + ' must be a non-empty string');
  return normalized;
}

function optionalString(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function optionalAuditTimestamp(value) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }
  if (Number.isFinite(value)) {
    const timestamp = new Date(Number(value));
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
  }
  return null;
}

function nonNegativeInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(label + ' must be a non-negative safe integer');
  }
  return normalized;
}

function normalizeIdentity(identity) {
  return {
    operationKey: requiredString(identity?.operationKey, 'operationKey'),
    surface: requiredString(identity?.surface, 'surface'),
    runId: optionalString(identity?.runId),
    tabId: optionalString(identity?.tabId),
    handoffId: optionalString(identity?.handoffId),
    requestFingerprint: requiredString(identity?.requestFingerprint, 'requestFingerprint'),
    provider: optionalString(identity?.provider),
    sessionId: optionalString(identity?.sessionId),
    promptHash: requiredString(identity?.promptHash, 'promptHash'),
    promptLength: nonNegativeInteger(identity?.promptLength, 'promptLength'),
  };
}

function normalizeAudit(audit) {
  const identity = classifyAgentPromptAuditIdentity(audit);
  return {
    operationKey: requiredString(audit?.operationKey, 'operationKey'),
    attemptId: requiredString(audit?.attemptId, 'attemptId'),
    provider: requiredString(audit?.provider || audit?.toolType, 'provider'),
    sessionId: requiredString(audit?.sessionId, 'sessionId'),
    promptHash: optionalString(identity.identityHash),
    actualHash: requiredString(identity.actualHash, 'actualHash'),
    expectedHash: requiredString(identity.expectedHash, 'expectedHash'),
    identityAccepted: identity.accepted === true,
    identityReason: identity.reason || null,
    canonicalized: identity.canonicalized === true,
    canonicalReason: identity.canonicalReason || null,
    entryUuid: optionalString(audit?.entryUuid),
    sourceIdentity: optionalString(audit?.sourceIdentity),
    recordByteOffset: Number.isSafeInteger(Number(audit?.recordByteOffset))
      && Number(audit.recordByteOffset) >= 0
      ? Number(audit.recordByteOffset)
      : null,
    transcriptBoundary: audit?.transcriptBoundary ?? null,
    auditTimestamp: optionalAuditTimestamp(audit?.auditTimestamp),
    success: audit?.success === true,
    raw: audit,
  };
}

function encodeJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function decodeJson(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    operationKey: row.operation_key,
    surface: row.surface,
    runId: row.run_id,
    tabId: row.tab_id,
    handoffId: row.handoff_id,
    requestFingerprint: row.request_fingerprint,
    provider: row.provider,
    sessionId: row.session_id,
    promptHash: row.prompt_hash,
    promptLength: row.prompt_length,
    state: row.state,
    attempt: row.attempt,
    attemptId: row.attempt_id,
    receipt: decodeJson(row.receipt_json),
    transcriptBoundary: decodeJson(row.transcript_boundary_json),
    auditIdentity: row.audit_attempt_id ? {
      attemptId: row.audit_attempt_id,
      provider: row.audit_provider,
      sessionId: row.audit_session_id,
      promptHash: row.audit_prompt_hash,
      entryUuid: row.audit_entry_uuid,
      sourceIdentity: row.audit_source_identity,
      auditTimestamp: row.audit_timestamp,
    } : null,
    presentation: row.presentation_at ? {
      attemptId: row.presentation_attempt_id,
      surface: row.presentation_surface,
      provider: row.presentation_provider,
      sessionId: row.presentation_session_id,
      entryUuid: row.presentation_entry_uuid,
      sourceIdentity: row.presentation_source_identity,
      acknowledgedAt: row.presentation_at,
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

function identityMismatches(record, identity, options = {}) {
  const mismatches = [];
  for (const field of ['surface', 'requestFingerprint', 'promptHash', 'promptLength']) {
    if (record[field] !== identity[field]) mismatches.push(field);
  }
  for (const field of ['runId', 'tabId', 'handoffId', 'provider']) {
    if (record[field] && identity[field] && record[field] !== identity[field]) {
      mismatches.push(field);
    }
  }
  if (
    !options.allowRetrySession
    && record.sessionId
    && identity.sessionId
    && record.sessionId !== identity.sessionId
  ) {
    mismatches.push('sessionId');
  }
  return mismatches;
}

function mergeReceiptForRestart(record, timestamp) {
  return {
    ...(record.receipt || {}),
    ok: false,
    success: null,
    submitted: null,
    status: STORE_STATES.DELIVERY_UNKNOWN,
    deliveryUnknown: true,
    auditPending: false,
    code: 'agent_send_restart_during_delivery',
    operationKey: record.operationKey,
    attemptId: record.attemptId,
    reconciledAt: timestamp,
  };
}

function mergeReceiptForPreEnterRestart(record, timestamp) {
  return {
    ...(record.receipt || {}),
    ok: false,
    success: false,
    submitted: false,
    status: STORE_STATES.NOT_SUBMITTED,
    deliveryUnknown: false,
    auditPending: false,
    code: 'agent_send_restart_before_enter',
    operationKey: record.operationKey,
    attemptId: record.attemptId,
    reconciledAt: timestamp,
  };
}

class AgentSendReceiptStore {
  constructor(db, options = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
      throw new TypeError('db must be an open better-sqlite3 Database');
    }
    this.db = db;
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : null;
    this.onDeliveryUnknown = typeof options.onDeliveryUnknown === 'function' ? options.onDeliveryUnknown : null;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.randomUUID = typeof options.randomUUID === 'function'
      ? options.randomUUID
      : crypto.randomUUID;
    this.settledRetentionMs = Number.isFinite(options.settledRetentionMs)
      ? Math.max(1, Number(options.settledRetentionMs))
      : DEFAULT_SETTLED_RETENTION_MS;
    this.maxRecords = Number.isInteger(options.maxRecords)
      ? Math.max(1, Number(options.maxRecords))
      : DEFAULT_MAX_RECORDS;
    this._initializeSchema();
    this._prepareStatements();
  }

  _initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        operation_key TEXT PRIMARY KEY,
        surface TEXT NOT NULL,
        run_id TEXT,
        tab_id TEXT,
        handoff_id TEXT,
        request_fingerprint TEXT NOT NULL,
        provider TEXT,
        session_id TEXT,
        prompt_hash TEXT NOT NULL,
        prompt_length INTEGER NOT NULL CHECK (prompt_length >= 0),
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        attempt_id TEXT,
        receipt_json TEXT,
        transcript_boundary_json TEXT,
        audit_attempt_id TEXT,
        audit_provider TEXT,
        audit_session_id TEXT,
        audit_prompt_hash TEXT,
        audit_entry_uuid TEXT,
        audit_source_identity TEXT,
        audit_timestamp TEXT,
        presentation_attempt_id TEXT,
        presentation_surface TEXT,
        presentation_provider TEXT,
        presentation_session_id TEXT,
        presentation_entry_uuid TEXT,
        presentation_source_identity TEXT,
        presentation_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_send_receipts_surface_run
        ON ${TABLE_NAME}(surface, run_id)
        WHERE run_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_agent_send_receipts_state_updated
        ON ${TABLE_NAME}(state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_agent_send_receipts_tab_handoff
        ON ${TABLE_NAME}(tab_id, handoff_id);
    `);
    const existingColumns = new Set(
      this.db.prepare(`PRAGMA table_info(${TABLE_NAME})`).all().map((row) => row.name),
    );
    const additiveColumns = [
      ['audit_source_identity', 'TEXT'],
      ['audit_timestamp', 'TEXT'],
      ['presentation_attempt_id', 'TEXT'],
      ['presentation_surface', 'TEXT'],
      ['presentation_provider', 'TEXT'],
      ['presentation_session_id', 'TEXT'],
      ['presentation_entry_uuid', 'TEXT'],
      ['presentation_source_identity', 'TEXT'],
      ['presentation_at', 'INTEGER'],
    ];
    for (const [column, type] of additiveColumns) {
      if (existingColumns.has(column)) continue;
      this.db.exec(`ALTER TABLE ${TABLE_NAME} ADD COLUMN ${column} ${type}`);
    }
  }

  _prepareStatements() {
    this.statements = {
      get: this.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE operation_key = ?`),
      getSurfaceRun: this.db.prepare(`
        SELECT * FROM ${TABLE_NAME}
        WHERE surface = ? AND run_id = ?
      `),
      count: this.db.prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAME}`),
      insert: this.db.prepare(`
        INSERT INTO ${TABLE_NAME} (
          operation_key, surface, run_id, tab_id, handoff_id,
          request_fingerprint, provider, session_id, prompt_hash, prompt_length,
          state, attempt, attempt_id, receipt_json, transcript_boundary_json,
          audit_attempt_id, audit_provider, audit_session_id, audit_prompt_hash,
          audit_entry_uuid, created_at, updated_at, settled_at
        ) VALUES (
          @operationKey, @surface, @runId, @tabId, @handoffId,
          @requestFingerprint, @provider, @sessionId, @promptHash, @promptLength,
          @state, 0, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL,
          NULL, @createdAt, @updatedAt, NULL
        )
      `),
      beginAttempt: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET run_id = COALESCE(run_id, @runId),
            tab_id = COALESCE(tab_id, @tabId),
            handoff_id = COALESCE(handoff_id, @handoffId),
            provider = COALESCE(provider, @provider),
            session_id = @sessionId,
            state = @state,
            attempt = attempt + 1,
            attempt_id = @attemptId,
            receipt_json = NULL,
            transcript_boundary_json = NULL,
            audit_attempt_id = NULL,
            audit_provider = NULL,
            audit_session_id = NULL,
            audit_prompt_hash = NULL,
            audit_entry_uuid = NULL,
            audit_source_identity = NULL,
            audit_timestamp = NULL,
            presentation_attempt_id = NULL,
            presentation_surface = NULL,
            presentation_provider = NULL,
            presentation_session_id = NULL,
            presentation_entry_uuid = NULL,
            presentation_source_identity = NULL,
            presentation_at = NULL,
            updated_at = @updatedAt,
            settled_at = NULL
        WHERE operation_key = @operationKey
          AND state IN ('reserved', 'preparing', 'not-submitted')
      `),
      markPreparing: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET state = 'preparing', updated_at = @updatedAt
        WHERE operation_key = @operationKey AND state = 'reserved'
      `),
      markAttemptState: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET state = @state, updated_at = @updatedAt
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state IN ('in-flight', 'enter-armed')
      `),
      stageAttemptContext: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET session_id = CASE
              WHEN @sessionId IS NULL THEN session_id
              ELSE @sessionId
            END,
            receipt_json = @receiptJson,
            transcript_boundary_json = COALESCE(@transcriptBoundaryJson, transcript_boundary_json),
            updated_at = @updatedAt
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state = 'in-flight'
      `),
      markProviderQueueAccepted: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET receipt_json = @receiptJson,
            updated_at = @updatedAt
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state IN ('enter-armed', 'audit-pending', 'delivery-unknown')
      `),
      settle: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET state = @state,
            receipt_json = @receiptJson,
            transcript_boundary_json = COALESCE(@transcriptBoundaryJson, transcript_boundary_json),
            updated_at = @updatedAt,
            settled_at = @settledAt
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state IN ('in-flight', 'enter-armed')
      `),
      settleAuditPendingFinal: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET state = @state,
            receipt_json = @receiptJson,
            transcript_boundary_json = COALESCE(@transcriptBoundaryJson, transcript_boundary_json),
            updated_at = @updatedAt,
            settled_at = @settledAt
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state IN ('audit-pending', 'delivery-unknown')
      `),
      promote: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET provider = COALESCE(provider, @provider),
            session_id = COALESCE(session_id, @sessionId),
            state = 'confirmed',
            receipt_json = @receiptJson,
            transcript_boundary_json = COALESCE(@transcriptBoundaryJson, transcript_boundary_json),
            audit_attempt_id = @attemptId,
            audit_provider = @provider,
            audit_session_id = @sessionId,
            audit_prompt_hash = @promptHash,
            audit_entry_uuid = @entryUuid,
            audit_source_identity = @sourceIdentity,
            audit_timestamp = @auditTimestamp,
            updated_at = @updatedAt,
            settled_at = @updatedAt
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state NOT IN ('reserved', 'preparing', 'not-submitted', 'provider-not-accepted')
      `),
      acknowledgePresentation: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET presentation_attempt_id = @attemptId,
            presentation_surface = @surface,
            presentation_provider = @provider,
            presentation_session_id = @sessionId,
            presentation_entry_uuid = @entryUuid,
            presentation_source_identity = @sourceIdentity,
            presentation_at = @acknowledgedAt
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state = 'confirmed'
          AND presentation_at IS NULL
      `),
      dismissPresentation: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET receipt_json = @receiptJson,
            updated_at = @dismissedAt
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state = @expectedState
      `),
      startupInFlight: this.db.prepare(`
        SELECT * FROM ${TABLE_NAME}
        WHERE state = 'in-flight'
      `),
      startupEnterArmed: this.db.prepare(`
        SELECT * FROM ${TABLE_NAME}
        WHERE state = 'enter-armed'
      `),
      reconcileInFlight: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET state = 'not-submitted', receipt_json = @receiptJson, updated_at = @updatedAt,
            settled_at = @updatedAt
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state = 'in-flight'
      `),
      reconcileEnterArmed: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET state = 'delivery-unknown', receipt_json = @receiptJson, updated_at = @updatedAt,
            settled_at = NULL
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state = 'enter-armed'
      `),
      markStartupUnconfirmed: this.db.prepare(`
        UPDATE ${TABLE_NAME}
        SET state = 'delivery-unknown', receipt_json = @receiptJson, updated_at = @updatedAt,
            settled_at = NULL
        WHERE operation_key = @operationKey
          AND attempt_id = @attemptId
          AND state IN ('audit-pending', 'delivery-unknown')
      `),
      pruneSettled: this.db.prepare(`
        DELETE FROM ${TABLE_NAME}
        WHERE state IN ('confirmed', 'not-submitted', 'provider-not-accepted')
          AND settled_at IS NOT NULL
          AND settled_at <= ?
      `),
    };
  }

  _record(operationKey) {
    return rowToRecord(this.statements.get.get(operationKey));
  }

  _conflict(record, identity, mismatchedFields, code = 'agent_send_receipt_conflict') {
    return {
      ok: false,
      action: 'conflict',
      code,
      operationKey: identity.operationKey,
      mismatchedFields,
      existingOperationKey: record?.operationKey || null,
      existingState: record?.state || null,
      record,
    };
  }

  _capacity(identity) {
    return {
      ok: false,
      action: 'capacity',
      code: 'agent_send_receipt_store_capacity',
      operationKey: identity.operationKey,
      maxRecords: this.maxRecords,
      record: null,
    };
  }

  _pruneAt(timestamp) {
    const cutoff = timestamp - this.settledRetentionMs;
    const info = this.statements.pruneSettled.run(cutoff);
    return Number(info.changes || 0);
  }

  _reserveOrGet(identity) {
    const existing = this._record(identity.operationKey);
    if (existing) {
      const mismatchedFields = identityMismatches(existing, identity, {
        allowRetrySession: existing.state === STORE_STATES.NOT_SUBMITTED,
      });
      if (mismatchedFields.length > 0) return this._conflict(existing, identity, mismatchedFields);
      return {
        ok: true,
        action: 'replay',
        created: false,
        replayed: true,
        retryable: RESUMABLE_STATES.has(existing.state),
        record: existing,
      };
    }

    if (identity.runId) {
      const sameRun = rowToRecord(this.statements.getSurfaceRun.get(identity.surface, identity.runId));
      if (sameRun) {
        return this._conflict(
          sameRun,
          identity,
          ['operationKey'],
          'agent_send_surface_run_conflict',
        );
      }
    }

    const timestamp = this.now();
    this._pruneAt(timestamp);
    if (Number(this.statements.count.get().count) >= this.maxRecords) {
      return this._capacity(identity);
    }
    try {
      this.statements.insert.run({
        ...identity,
        state: STORE_STATES.RESERVED,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const sameRun = identity.runId
          ? rowToRecord(this.statements.getSurfaceRun.get(identity.surface, identity.runId))
          : null;
        return this._conflict(
          sameRun,
          identity,
          ['operationKey'],
          'agent_send_surface_run_conflict',
        );
      }
      throw error;
    }
    return {
      ok: true,
      action: 'reserved',
      created: true,
      replayed: false,
      retryable: true,
      record: this._record(identity.operationKey),
    };
  }

  reserveOrGet(identityInput) {
    const identity = normalizeIdentity(identityInput);
    return this.db.transaction(() => this._reserveOrGet(identity))();
  }

  beginAttempt(identityInput) {
    const identity = normalizeIdentity(identityInput);
    return this._observeChange(this.db.transaction(() => {
      const reservation = this._reserveOrGet(identity);
      if (!reservation.ok) return reservation;
      const record = reservation.record;
      if (!RESUMABLE_STATES.has(record.state)) {
        return {
          ok: true,
          action: 'replay',
          created: reservation.created,
          replayed: true,
          retryable: false,
          record,
        };
      }

      const mismatchedFields = identityMismatches(record, identity, {
        allowRetrySession: record.state === STORE_STATES.NOT_SUBMITTED,
      });
      if (mismatchedFields.length > 0) return this._conflict(record, identity, mismatchedFields);
      if (identity.runId && !record.runId) {
        const sameRun = rowToRecord(this.statements.getSurfaceRun.get(identity.surface, identity.runId));
        if (sameRun && sameRun.operationKey !== identity.operationKey) {
          return this._conflict(
            sameRun,
            identity,
            ['operationKey'],
            'agent_send_surface_run_conflict',
          );
        }
      }
      const attemptId = requiredString(this.randomUUID(), 'attemptId');
      const updatedAt = this.now();
      const info = this.statements.beginAttempt.run({
        operationKey: identity.operationKey,
        runId: identity.runId,
        tabId: identity.tabId,
        handoffId: identity.handoffId,
        provider: identity.provider,
        // A proven pre-Enter failure may be retried through a replacement
        // session. `null` is meaningful here: it clears session A so the
        // exact late audit can bind session B after the retry crosses Enter.
        sessionId: identity.sessionId,
        state: STORE_STATES.IN_FLIGHT,
        attemptId,
        updatedAt,
      });
      if (info.changes !== 1) {
        return {
          ok: true,
          action: 'replay',
          created: false,
          replayed: true,
          retryable: false,
          record: this._record(identity.operationKey),
        };
      }
      return {
        ok: true,
        action: 'attempt-started',
        created: reservation.created,
        replayed: false,
        retryable: false,
        attemptId,
        record: this._record(identity.operationKey),
      };
    })());
  }

  markPreparing(operationKeyInput) {
    const operationKey = requiredString(operationKeyInput, 'operationKey');
    return this._observeChange(this.db.transaction(() => {
      const record = this._record(operationKey);
      if (!record) return { ok: false, applied: false, reason: 'not-found', record: null };
      if (record.state === STORE_STATES.PREPARING) {
        return { ok: true, applied: false, idempotent: true, record };
      }
      const info = this.statements.markPreparing.run({ operationKey, updatedAt: this.now() });
      return {
        ok: info.changes === 1,
        applied: info.changes === 1,
        reason: info.changes === 1 ? null : 'state-not-reserved',
        record: this._record(operationKey),
      };
    })());
  }

  markAttemptState(operationKeyInput, attemptIdInput, state) {
    const operationKey = requiredString(operationKeyInput, 'operationKey');
    const attemptId = requiredString(attemptIdInput, 'attemptId');
    if (!ACTIVE_ATTEMPT_STATES.has(state)) {
      throw new TypeError('state must be in-flight or enter-armed');
    }
    return this.db.transaction(() => {
      const record = this._record(operationKey);
      if (!record) return { ok: false, applied: false, reason: 'not-found', record: null };
      if (record.attemptId !== attemptId) {
        return { ok: false, applied: false, stale: true, reason: 'stale-attempt', record };
      }
      if (record.state === state) {
        return { ok: true, applied: false, idempotent: true, record };
      }
      if (state === STORE_STATES.IN_FLIGHT) {
        return {
          ok: false,
          applied: false,
          reason: 'non-monotonic-attempt-state',
          record,
        };
      }
      const info = this.statements.markAttemptState.run({
        operationKey,
        attemptId,
        state,
        updatedAt: this.now(),
      });
      return {
        ok: info.changes === 1,
        applied: info.changes === 1,
        reason: info.changes === 1 ? null : 'attempt-not-active',
        record: this._record(operationKey),
      };
    })();
  }

  stageAttemptContext(operationKeyInput, attemptIdInput, contextInput = {}) {
    const operationKey = requiredString(operationKeyInput, 'operationKey');
    const attemptId = requiredString(attemptIdInput, 'attemptId');
    const context = contextInput && typeof contextInput === 'object' ? contextInput : {};
    return this.db.transaction(() => {
      const record = this._record(operationKey);
      if (!record) return { ok: false, applied: false, reason: 'not-found', record: null };
      if (record.attemptId !== attemptId) {
        return { ok: false, applied: false, stale: true, reason: 'stale-attempt', record };
      }
      if (record.state !== STORE_STATES.IN_FLIGHT) {
        return {
          ok: false,
          applied: false,
          reason: 'attempt-not-pre-enter',
          record,
        };
      }
      const contextSessionId = optionalString(context.sessionId);
      const boundarySessionId = optionalString(context.transcriptBoundary?.sessionId);
      if (contextSessionId && boundarySessionId && contextSessionId !== boundarySessionId) {
        return {
          ok: false,
          applied: false,
          reason: 'attempt-context-session-boundary-mismatch',
          record,
        };
      }
      // The pre-Enter transcript boundary is the first exact writer identity.
      // It intentionally replaces an earlier History/session hint (for example
      // after Resume), while a first-turn send can remain unbound until its
      // exact post-Enter transcript record is observed.
      const exactTargetSessionId = boundarySessionId || contextSessionId || null;
      const receipt = {
        ...(record.receipt || {}),
        ...context,
        operationKey,
        attemptId,
        sessionId: exactTargetSessionId || record.sessionId || null,
        status: STORE_STATES.IN_FLIGHT,
        submitted: false,
      };
      const info = this.statements.stageAttemptContext.run({
        operationKey,
        attemptId,
        sessionId: exactTargetSessionId,
        receiptJson: encodeJson(receipt),
        transcriptBoundaryJson: encodeJson(context.transcriptBoundary),
        updatedAt: this.now(),
      });
      return {
        ok: info.changes === 1,
        applied: info.changes === 1,
        reason: info.changes === 1 ? null : 'attempt-not-pre-enter',
        record: this._record(operationKey),
      };
    })();
  }

  markProviderQueueAccepted(operationKeyInput, attemptIdInput, evidenceInput = {}) {
    const operationKey = requiredString(operationKeyInput, 'operationKey');
    const attemptId = requiredString(attemptIdInput, 'attemptId');
    const evidence = evidenceInput && typeof evidenceInput === 'object'
      ? evidenceInput
      : {};
    const provider = requiredString(evidence.provider, 'provider');
    return this._observeChange(this.db.transaction(() => {
      const record = this._record(operationKey);
      if (!record) return { ok: false, applied: false, reason: 'not-found', record: null };
      if (record.attemptId !== attemptId) {
        return { ok: false, applied: false, stale: true, reason: 'stale-attempt', record };
      }
      if (record.provider && record.provider !== provider) {
        return { ok: false, applied: false, reason: 'provider-mismatch', record };
      }
      if (record.state === STORE_STATES.CONFIRMED) {
        return {
          ok: true,
          applied: false,
          idempotent: true,
          reason: 'already-confirmed',
          record,
        };
      }

      const updatedAt = this.now();
      const acceptedAt = optionalAuditTimestamp(evidence.acceptedAt)
        || new Date(updatedAt).toISOString();
      const sessionId = optionalString(evidence.sessionId);
      const entryUuid = optionalString(evidence.entryUuid);
      const sourceIdentity = optionalString(evidence.sourceIdentity);
      const recordByteOffset = evidence.recordByteOffset !== null
        && evidence.recordByteOffset !== undefined
        && Number.isSafeInteger(Number(evidence.recordByteOffset))
        && Number(evidence.recordByteOffset) >= 0
        ? Number(evidence.recordByteOffset)
        : null;
      const previousReceipt = record.receipt && typeof record.receipt === 'object'
        ? record.receipt
        : {};
      const previousQueue = previousReceipt.providerQueue
        && typeof previousReceipt.providerQueue === 'object'
        ? previousReceipt.providerQueue
        : null;
      if (previousQueue?.accepted === true) {
        const conflicts = [];
        if (previousQueue.provider && previousQueue.provider !== provider) conflicts.push('provider');
        if (previousQueue.sessionId && sessionId && previousQueue.sessionId !== sessionId) {
          conflicts.push('sessionId');
        }
        if (previousQueue.entryUuid && entryUuid && previousQueue.entryUuid !== entryUuid) {
          conflicts.push('entryUuid');
        }
        if (
          previousQueue.sourceIdentity
          && sourceIdentity
          && previousQueue.sourceIdentity !== sourceIdentity
        ) {
          conflicts.push('sourceIdentity');
        }
        if (
          previousQueue.recordByteOffset !== null
          && previousQueue.recordByteOffset !== undefined
          && Number.isSafeInteger(Number(previousQueue.recordByteOffset))
          && recordByteOffset !== null
          && Number(previousQueue.recordByteOffset) !== recordByteOffset
        ) {
          conflicts.push('recordByteOffset');
        }
        if (conflicts.length > 0) {
          return {
            ok: false,
            applied: false,
            reason: 'provider-queue-identity-conflict',
            mismatchedFields: conflicts,
            record,
          };
        }
        return {
          ok: true,
          applied: false,
          idempotent: true,
          reason: 'provider-queue-already-recorded',
          record,
        };
      }
      if (
        record.state !== STORE_STATES.ENTER_ARMED
        && record.state !== STORE_STATES.AUDIT_PENDING
        && record.state !== STORE_STATES.DELIVERY_UNKNOWN
      ) {
        return {
          ok: false,
          applied: false,
          reason: 'attempt-not-awaiting-provider-proof',
          record,
        };
      }

      const providerQueue = {
        accepted: true,
        provider,
        operationKey,
        attemptId,
        promptHash: record.promptHash,
        acceptedAt,
        observedAt: updatedAt,
        ...(sessionId ? { sessionId } : {}),
        ...(entryUuid ? { entryUuid } : {}),
        ...(sourceIdentity ? { sourceIdentity } : {}),
        ...(recordByteOffset !== null ? { recordByteOffset } : {}),
        ...(evidence.evidence && typeof evidence.evidence === 'object'
          ? { evidence: evidence.evidence }
          : {}),
      };
      const receipt = {
        ...previousReceipt,
        providerQueue,
      };
      const info = this.statements.markProviderQueueAccepted.run({
        operationKey,
        attemptId,
        receiptJson: encodeJson(receipt),
        updatedAt,
      });
      return {
        ok: info.changes === 1,
        applied: info.changes === 1,
        reason: info.changes === 1 ? null : 'attempt-state-changed',
        record: this._record(operationKey),
      };
    })());
  }

  settleAttempt(operationKeyInput, attemptIdInput, receiptInput) {
    const operationKey = requiredString(operationKeyInput, 'operationKey');
    const attemptId = requiredString(attemptIdInput, 'attemptId');
    const nextReceipt = receiptInput && typeof receiptInput === 'object'
      ? receiptInput
      : {
        success: null,
        submitted: null,
        status: STORE_STATES.DELIVERY_UNKNOWN,
        deliveryUnknown: true,
        code: 'agent_send_invalid_receipt',
      };
    return this._observeDeliveryUnknown(this.db.transaction(() => {
      const record = this._record(operationKey);
      if (!record) return { ok: false, applied: false, reason: 'not-found', record: null };
      if (record.attemptId !== attemptId) {
        return { ok: false, applied: false, stale: true, reason: 'stale-attempt', record };
      }
      if (record.state === STORE_STATES.CONFIRMED) {
        return {
          ok: true,
          applied: false,
          idempotent: true,
          reason: 'already-confirmed',
          record,
        };
      }
      const mergedReceipt = {
        ...(record.receipt || {}),
        ...nextReceipt,
      };
      const nextState = classifyAgentSendRegistryReceipt(mergedReceipt);
      if (
        (record.state === STORE_STATES.AUDIT_PENDING
          || record.state === STORE_STATES.DELIVERY_UNKNOWN)
        && nextState === STORE_STATES.PROVIDER_NOT_ACCEPTED
        && isExactProviderNotAcceptedReceipt(mergedReceipt)
      ) {
        const updatedAt = this.now();
        const receipt = {
          ...mergedReceipt,
          accepted: false,
          submitted: true,
          status: STORE_STATES.PROVIDER_NOT_ACCEPTED,
          receiptState: STORE_STATES.PROVIDER_NOT_ACCEPTED,
          auditPending: false,
          deliveryUnknown: false,
        };
        const info = this.statements.settleAuditPendingFinal.run({
          operationKey,
          attemptId,
          state: STORE_STATES.PROVIDER_NOT_ACCEPTED,
          receiptJson: encodeJson(receipt),
          transcriptBoundaryJson: encodeJson(receipt.transcriptBoundary),
          updatedAt,
          settledAt: updatedAt,
        });
        return {
          ok: info.changes === 1,
          applied: info.changes === 1,
          state: this._record(operationKey)?.state || null,
          record: this._record(operationKey),
        };
      }
      if (!ACTIVE_ATTEMPT_STATES.has(record.state)) {
        return {
          ok: true,
          applied: false,
          idempotent: true,
          reason: 'attempt-already-settled',
          record,
        };
      }
      const state = nextState;
      const receipt = state === STORE_STATES.PROVIDER_NOT_ACCEPTED
        ? {
            ...mergedReceipt,
            accepted: false,
            submitted: true,
            status: STORE_STATES.PROVIDER_NOT_ACCEPTED,
            receiptState: STORE_STATES.PROVIDER_NOT_ACCEPTED,
            auditPending: false,
            deliveryUnknown: false,
          }
        : mergedReceipt;
      const updatedAt = this.now();
      const settledAt = SETTLED_PRUNABLE_STATES.has(state) ? updatedAt : null;
      const info = this.statements.settle.run({
        operationKey,
        attemptId,
        state,
        receiptJson: encodeJson(receipt),
        transcriptBoundaryJson: encodeJson(receipt.transcriptBoundary),
        updatedAt,
        settledAt,
      });
      return {
        ok: info.changes === 1,
        applied: info.changes === 1,
        state: this._record(operationKey)?.state || null,
        record: this._record(operationKey),
      };
    })());
  }

  _observeDeliveryUnknown(result) {
    this._observeChange(result);
    if (result?.applied === true && result.record?.state === STORE_STATES.DELIVERY_UNKNOWN) {
      try { this.onDeliveryUnknown?.(result.record); }
      catch (error) { console.warn('[AgentSendReceipt] diagnostic observer failed', error?.message); }
    }
    return result;
  }

  _observeChange(result) {
    if (result?.ok && result.record) {
      try { this.onChanged?.(result.record); }
      catch (error) { console.warn('[AgentSendReceipt] activity observer failed', error?.message); }
    }
    return result;
  }

  markDeliveryUnknown(operationKeyInput, attemptIdInput, reconciliationInput = {}) {
    const operationKey = requiredString(operationKeyInput, 'operationKey');
    const attemptId = requiredString(attemptIdInput, 'attemptId');
    const reconciliation = reconciliationInput && typeof reconciliationInput === 'object'
      ? reconciliationInput
      : {};
    return this._observeDeliveryUnknown(this.db.transaction(() => {
      const record = this._record(operationKey);
      if (!record) return { ok: false, applied: false, reason: 'not-found', record: null };
      if (record.attemptId !== attemptId) {
        return { ok: false, applied: false, stale: true, reason: 'stale-attempt', record };
      }
      if (record.state === STORE_STATES.CONFIRMED) {
        return {
          ok: true,
          applied: false,
          idempotent: true,
          reason: 'already-confirmed',
          record,
        };
      }
      if (!STARTUP_UNCONFIRMED_STATES.has(record.state)) {
        return {
          ok: true,
          applied: false,
          idempotent: true,
          reason: 'attempt-already-final',
          record,
        };
      }
      const reconciledAt = this.now();
      const previousReceipt = record.receipt && typeof record.receipt === 'object'
        ? record.receipt
        : {};
      const reconciliationSource = optionalString(reconciliation.source) || 'runtime';
      const reconciliationDetail = {
        source: reconciliationSource,
        decision: optionalString(reconciliation.decision) || 'unknown',
        reason: optionalString(reconciliation.reason) || 'unspecified',
        evidence: reconciliation.evidence && typeof reconciliation.evidence === 'object'
          ? reconciliation.evidence
          : null,
        reconciledAt,
      };
      const receipt = {
        ...previousReceipt,
        ok: false,
        success: null,
        accepted: reconciliationSource === 'startup'
          ? null
          : (typeof previousReceipt.accepted === 'boolean'
            ? previousReceipt.accepted
            : null),
        submitted: typeof previousReceipt.submitted === 'boolean'
          ? previousReceipt.submitted
          : null,
        status: STORE_STATES.DELIVERY_UNKNOWN,
        receiptState: STORE_STATES.DELIVERY_UNKNOWN,
        deliveryUnknown: true,
        auditPending: false,
        exactAuditConfirmed: false,
        code: optionalString(reconciliation.code)
          || 'agent_send_delivery_unconfirmed',
        deliveryReconciliation: reconciliationDetail,
        ...(reconciliationSource === 'startup'
          ? { startupReconciliation: reconciliationDetail }
          : {}),
      };
      const info = this.statements.markStartupUnconfirmed.run({
        operationKey,
        attemptId,
        receiptJson: encodeJson(receipt),
        updatedAt: reconciledAt,
      });
      return {
        ok: info.changes === 1,
        applied: info.changes === 1,
        state: this._record(operationKey)?.state || null,
        record: this._record(operationKey),
      };
    })());
  }

  markStartupUnconfirmed(operationKeyInput, attemptIdInput, reconciliationInput = {}) {
    return this.markDeliveryUnknown(operationKeyInput, attemptIdInput, {
      ...(reconciliationInput && typeof reconciliationInput === 'object'
        ? reconciliationInput
        : {}),
      source: 'startup',
      code: 'agent_send_startup_reconciliation_unconfirmed',
    });
  }

  promoteFromAudit(auditInput) {
    let audit;
    try {
      audit = normalizeAudit(auditInput);
    } catch (error) {
      return { ok: false, matched: false, promoted: false, reason: 'invalid-audit', error: error.message };
    }
    return this._observeChange(this.db.transaction(() => {
      const record = this._record(audit.operationKey);
      if (!record) return { ok: false, matched: false, promoted: false, reason: 'not-found' };
      if (!audit.success) {
        return { ok: true, matched: true, promoted: false, reason: 'audit-not-successful', record };
      }
      const mismatchedFields = [];
      if (record.attemptId !== audit.attemptId) mismatchedFields.push('attemptId');
      if (record.provider && record.provider !== audit.provider) mismatchedFields.push('provider');
      if (record.sessionId && record.sessionId !== audit.sessionId) mismatchedFields.push('sessionId');
      if (!audit.identityAccepted) mismatchedFields.push('canonicalProof');
      if (record.promptHash !== audit.promptHash) mismatchedFields.push('promptHash');
      if (record.promptHash !== audit.expectedHash) {
        mismatchedFields.push('expectedHash');
      }
      if (mismatchedFields.length > 0) {
        return {
          ok: false,
          matched: true,
          promoted: false,
          reason: 'audit-identity-mismatch',
          mismatchedFields,
          record,
        };
      }
      if (record.state === STORE_STATES.NOT_SUBMITTED) {
        return {
          ok: false,
          matched: true,
          promoted: false,
          reason: 'not-submitted-cannot-be-promoted',
          record,
        };
      }
      if (record.state === STORE_STATES.PROVIDER_NOT_ACCEPTED) {
        return {
          ok: false,
          matched: true,
          promoted: false,
          reason: 'provider-not-accepted-cannot-be-promoted',
          record,
        };
      }
      if (record.state === STORE_STATES.CONFIRMED && record.auditIdentity) {
        const sameExactRow = record.auditIdentity.entryUuid
          ? record.auditIdentity.entryUuid === audit.entryUuid
            && (!record.auditIdentity.sourceIdentity
              || !audit.sourceIdentity
              || record.auditIdentity.sourceIdentity === audit.sourceIdentity)
          : !!record.auditIdentity.sourceIdentity
            && record.auditIdentity.sourceIdentity === audit.sourceIdentity;
        const sameAuditIdentity = record.auditIdentity.attemptId === audit.attemptId
          && record.auditIdentity.provider === audit.provider
          && record.auditIdentity.sessionId === audit.sessionId
          && record.auditIdentity.promptHash === audit.actualHash
          && (record.receipt?.recordByteOffset == null
            || audit.recordByteOffset == null
            || Number(record.receipt.recordByteOffset) === audit.recordByteOffset)
          && sameExactRow;
        return {
          ok: sameAuditIdentity,
          matched: true,
          promoted: false,
          idempotent: sameAuditIdentity,
          reason: sameAuditIdentity ? 'already-confirmed' : 'confirmed-audit-identity-conflict',
          record,
        };
      }
      if (record.state === STORE_STATES.RESERVED || record.state === STORE_STATES.PREPARING) {
        return {
          ok: false,
          matched: true,
          promoted: false,
          reason: 'attempt-not-started',
          record,
        };
      }
      const updatedAt = this.now();
      const auditTimestamp = audit.auditTimestamp || new Date(updatedAt).toISOString();
      const historyOnly = audit.raw?.historyOnly === true;
      const receipt = {
        ...(record.receipt || {}),
        ok: true,
        success: true,
        accepted: true,
        submitted: !historyOnly,
        ...(historyOnly
          ? { historyOnly: true, historyRecorded: true, modelTurnStarted: false }
          : {}),
        status: 'sent',
        deliveryUnknown: false,
        auditPending: false,
        exactAuditConfirmed: true,
        operationKey: record.operationKey,
        attemptId: record.attemptId,
        tabId: record.tabId,
        handoffId: record.handoffId,
        provider: record.provider || audit.provider,
        // The transcript record owns the final writer session. A reservation
        // can still carry the pre-Resume session while the accepted record is
        // written by its child.
        sessionId: audit.sessionId,
        promptHash: record.promptHash,
        actualHash: audit.actualHash,
        expectedHash: audit.expectedHash,
        canonicalized: audit.canonicalized,
        canonicalReason: audit.canonicalReason,
        auditTimestamp,
        entryUuid: audit.entryUuid,
        sourceIdentity: audit.sourceIdentity,
        recordByteOffset: audit.recordByteOffset,
      };
      const info = this.statements.promote.run({
        operationKey: record.operationKey,
        attemptId: audit.attemptId,
        provider: audit.provider,
        sessionId: audit.sessionId,
        promptHash: audit.actualHash,
        entryUuid: audit.entryUuid,
        sourceIdentity: audit.sourceIdentity,
        auditTimestamp,
        receiptJson: encodeJson(receipt),
        transcriptBoundaryJson: encodeJson(audit.transcriptBoundary),
        updatedAt,
      });
      return {
        ok: info.changes === 1,
        matched: true,
        promoted: info.changes === 1,
        reason: info.changes === 1 ? null : 'state-changed',
        record: this._record(record.operationKey),
      };
    })());
  }

  acknowledgePresentation(input = {}) {
    let operationKey;
    let attemptId;
    let surface;
    let tabId;
    let handoffId;
    let provider;
    let sessionId;
    let entryUuid;
    let sourceIdentity;
    try {
      operationKey = requiredString(input.operationKey, 'operationKey');
      attemptId = requiredString(input.attemptId, 'attemptId');
      surface = requiredString(input.surface, 'surface');
      tabId = requiredString(input.tabId, 'tabId');
      handoffId = requiredString(input.handoffId, 'handoffId');
      provider = requiredString(input.provider, 'provider');
      sessionId = requiredString(input.sessionId, 'sessionId');
      entryUuid = optionalString(input.entryUuid);
      sourceIdentity = optionalString(input.sourceIdentity);
    } catch (error) {
      return { ok: false, applied: false, reason: 'invalid-presentation-ack', error: error.message };
    }
    // `record.surface` is immutable send provenance (Project API, Inbox,
    // orchestration, desktop History). `surface` here is the canonical
    // presentation that consumed the optimistic row. They intentionally may
    // differ; exact attempt/transcript identity below is the safety boundary.
    return this.db.transaction(() => {
      const record = this._record(operationKey);
      if (!record) return { ok: false, applied: false, reason: 'not-found', record: null };
      if (record.attemptId !== attemptId) {
        return { ok: false, applied: false, stale: true, reason: 'stale-attempt', record };
      }
      if (record.tabId !== tabId || record.handoffId !== handoffId) {
        return { ok: false, applied: false, reason: 'handoff-identity-mismatch', record };
      }
      if (record.state !== STORE_STATES.CONFIRMED) {
        return { ok: false, applied: false, reason: 'delivery-not-confirmed', record };
      }
      if (record.provider && record.provider !== provider) {
        return { ok: false, applied: false, reason: 'provider-mismatch', record };
      }
      const exactAuditSessionId = optionalString(record.auditIdentity?.sessionId)
        || optionalString(record.sessionId);
      if (exactAuditSessionId && exactAuditSessionId !== sessionId) {
        return { ok: false, applied: false, reason: 'session-mismatch', record };
      }

      const auditEntryUuid = optionalString(record.auditIdentity?.entryUuid);
      const auditSourceIdentity = optionalString(record.auditIdentity?.sourceIdentity);
      if (!auditEntryUuid && !auditSourceIdentity) {
        return { ok: false, applied: false, reason: 'exact-audit-identity-missing', record };
      }
      if (auditEntryUuid && entryUuid !== auditEntryUuid) {
        return { ok: false, applied: false, reason: 'entry-uuid-mismatch', record };
      }
      if (!auditEntryUuid && auditSourceIdentity && sourceIdentity !== auditSourceIdentity) {
        return { ok: false, applied: false, reason: 'source-identity-mismatch', record };
      }
      if (auditEntryUuid && auditSourceIdentity && sourceIdentity
        && sourceIdentity !== auditSourceIdentity) {
        return { ok: false, applied: false, reason: 'source-identity-mismatch', record };
      }

      if (record.presentation) {
        const sameIdentity = record.presentation.attemptId === attemptId
          && (!record.presentation.surface || record.presentation.surface === surface)
          && record.presentation.provider === provider
          && record.presentation.sessionId === sessionId
          && (record.presentation.entryUuid || null) === (entryUuid || null)
          && (record.presentation.sourceIdentity || null) === (sourceIdentity || null);
        return {
          ok: sameIdentity,
          applied: false,
          idempotent: sameIdentity,
          reason: sameIdentity ? 'already-acknowledged' : 'presentation-identity-conflict',
          record,
        };
      }

      const acknowledgedAt = this.now();
      const info = this.statements.acknowledgePresentation.run({
        operationKey,
        attemptId,
        surface,
        provider,
        sessionId,
        entryUuid,
        sourceIdentity,
        acknowledgedAt,
      });
      return {
        ok: info.changes === 1,
        applied: info.changes === 1,
        reason: info.changes === 1 ? null : 'presentation-state-changed',
        record: this._record(operationKey),
      };
    })();
  }

  dismissPresentation(input = {}) {
    let operationKey;
    let attemptId;
    let surface;
    let tabId;
    let handoffId;
    try {
      operationKey = requiredString(input.operationKey, 'operationKey');
      attemptId = requiredString(input.attemptId, 'attemptId');
      surface = requiredString(input.surface, 'surface');
      tabId = requiredString(input.tabId, 'tabId');
      handoffId = requiredString(input.handoffId, 'handoffId');
    } catch (error) {
      return { ok: false, applied: false, reason: 'invalid-presentation-dismiss', error: error.message };
    }
    return this.db.transaction(() => {
      const record = this._record(operationKey);
      if (!record) return { ok: false, applied: false, reason: 'not-found', record: null };
      if (record.attemptId !== attemptId) {
        return { ok: false, applied: false, stale: true, reason: 'stale-attempt', record };
      }
      if (record.tabId !== tabId || record.handoffId !== handoffId) {
        return { ok: false, applied: false, reason: 'presentation-identity-mismatch', record };
      }
      const previousReceipt = record.receipt && typeof record.receipt === 'object'
        ? record.receipt
        : {};
      if (
        Number.isFinite(Number(previousReceipt.presentationDismissedAt))
        && previousReceipt.presentationDismissedSurface === surface
      ) {
        return {
          ok: true,
          applied: false,
          idempotent: true,
          reason: 'already-dismissed',
          record,
        };
      }
      if (!DISMISSIBLE_PRESENTATION_STATES.has(record.state)) {
        return { ok: false, applied: false, reason: 'presentation-not-dismissible', record };
      }
      const dismissedAt = this.now();
      const receipt = {
        ...previousReceipt,
        presentationDismissedAt: dismissedAt,
        presentationDismissedSurface: surface,
      };
      const info = this.statements.dismissPresentation.run({
        operationKey,
        attemptId,
        expectedState: record.state,
        receiptJson: encodeJson(receipt),
        dismissedAt,
      });
      return {
        ok: info.changes === 1,
        applied: info.changes === 1,
        reason: info.changes === 1 ? null : 'presentation-state-changed',
        record: this._record(operationKey),
      };
    })();
  }

  get(operationKeyInput) {
    return this._record(requiredString(operationKeyInput, 'operationKey'));
  }

  list(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.surface) {
      clauses.push('surface = ?');
      params.push(requiredString(filters.surface, 'surface'));
    }
    if (filters.runId) {
      clauses.push('run_id = ?');
      params.push(requiredString(filters.runId, 'runId'));
    }
    if (filters.tabId) {
      clauses.push('tab_id = ?');
      params.push(requiredString(filters.tabId, 'tabId'));
    }
    if (filters.handoffId) {
      clauses.push('handoff_id = ?');
      params.push(requiredString(filters.handoffId, 'handoffId'));
    }
    if (filters.state) {
      clauses.push('state = ?');
      params.push(requiredString(filters.state, 'state'));
    }
    const limit = Number.isInteger(filters.limit) ? Math.max(1, filters.limit) : null;
    const sql = `SELECT * FROM ${TABLE_NAME}`
      + (clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '')
      + ' ORDER BY created_at ASC, operation_key ASC'
      + (limit ? ` LIMIT ${limit}` : '');
    return this.db.prepare(sql).all(...params).map(rowToRecord);
  }

  reconcileStartup() {
    return this.db.transaction(() => {
      const inFlightRows = this.statements.startupInFlight.all().map(rowToRecord);
      const enterArmedRows = this.statements.startupEnterArmed.all().map(rowToRecord);
      const timestamp = this.now();
      let changed = 0;
      for (const record of inFlightRows) {
        const receipt = mergeReceiptForPreEnterRestart(record, timestamp);
        const info = this.statements.reconcileInFlight.run({
          operationKey: record.operationKey,
          attemptId: record.attemptId,
          receiptJson: encodeJson(receipt),
          updatedAt: timestamp,
        });
        changed += Number(info.changes || 0);
      }
      for (const record of enterArmedRows) {
        const receipt = mergeReceiptForRestart(record, timestamp);
        const info = this.statements.reconcileEnterArmed.run({
          operationKey: record.operationKey,
          attemptId: record.attemptId,
          receiptJson: encodeJson(receipt),
          updatedAt: timestamp,
        });
        changed += Number(info.changes || 0);
      }
      return { changed, records: this.list() };
    })();
  }

  prune(timestamp = this.now()) {
    if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be finite');
    return this.db.transaction(() => {
      const deleted = this._pruneAt(Number(timestamp));
      return { deleted, remaining: Number(this.statements.count.get().count) };
    })();
  }
}

function createAgentSendReceiptStore(db, options = {}) {
  return new AgentSendReceiptStore(db, options);
}

module.exports = {
  AgentSendReceiptStore,
  DEFAULT_MAX_RECORDS,
  DEFAULT_SETTLED_RETENTION_MS,
  STORE_STATES,
  TABLE_NAME,
  createAgentSendReceiptStore,
};
