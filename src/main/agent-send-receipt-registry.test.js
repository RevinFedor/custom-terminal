'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RECEIPT_STATES,
  classifyAgentSendRegistryReceipt,
  createAgentSendReceiptRegistry,
  fingerprintAgentSendRequest,
} = require('./agent-send-receipt-registry');

function identity(overrides = {}) {
  return {
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    requestFingerprint: 'request-a',
    provider: 'codex',
    sessionId: 'session-a',
    promptHash: 'hash-a',
    ...overrides,
  };
}

function exactAudit(overrides = {}) {
  return {
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    provider: 'codex',
    sessionId: 'session-a',
    actualHash: 'hash-a',
    expectedHash: 'hash-a',
    success: true,
    entryUuid: 'entry-a',
    ...overrides,
  };
}

test('request fingerprints are canonical and preserve meaningful differences', () => {
  const a = fingerprintAgentSendRequest({
    prompt: 'hello',
    queue: true,
    settings: { effort: 'high', model: 'gpt-5' },
  });
  const reordered = fingerprintAgentSendRequest({
    settings: { model: 'gpt-5', effort: 'high' },
    queue: true,
    prompt: 'hello',
  });
  const changed = fingerprintAgentSendRequest({
    prompt: 'hello',
    queue: false,
    settings: { effort: 'high', model: 'gpt-5' },
  });
  assert.equal(a, reordered);
  assert.notEqual(a, changed);
});

test('receipt classification keeps all four physical delivery outcomes distinct', () => {
  assert.equal(classifyAgentSendRegistryReceipt({ submitted: false, success: false }), 'not-submitted');
  assert.equal(classifyAgentSendRegistryReceipt({
    submitted: null,
    status: 'delivery-unknown',
    deliveryUnknown: true,
  }), 'delivery-unknown');
  assert.equal(classifyAgentSendRegistryReceipt({
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  }), 'audit-pending');
  assert.equal(classifyAgentSendRegistryReceipt({ submitted: true, success: true }), 'confirmed');
  assert.equal(
    classifyAgentSendRegistryReceipt({ success: true }),
    'delivery-unknown',
    'success without physical submit proof must remain unknown',
  );
});

test('same exact in-flight handoff joins one Promise and invokes one physical send', async () => {
  const registry = createAgentSendReceiptRegistry();
  let finish;
  let sends = 0;
  const send = () => {
    sends += 1;
    return new Promise((resolve) => { finish = resolve; });
  };
  const first = registry.run(identity(), send);
  const joined = registry.run(identity(), send);
  assert.strictEqual(joined, first);
  await Promise.resolve();
  assert.equal(sends, 1);
  finish({ success: true, submitted: true, status: 'sent' });
  const result = await first;
  assert.equal(result.state, RECEIPT_STATES.CONFIRMED);
  assert.equal(result.joined, true);
  assert.equal(result.attempt, 1);
});

test('same tab and handoff with changed immutable identity returns conflict', async () => {
  const registry = createAgentSendReceiptRegistry();
  let finish;
  let sends = 0;
  const first = registry.run(identity(), () => {
    sends += 1;
    return new Promise((resolve) => { finish = resolve; });
  });
  const conflict = await registry.run(identity({
    requestFingerprint: 'different-request',
    promptHash: 'different-hash',
  }), () => {
    sends += 1;
    return { success: true, submitted: true };
  });
  assert.equal(conflict.state, RECEIPT_STATES.CONFLICT);
  assert.equal(conflict.code, 'agent_send_handoff_conflict');
  assert.deepEqual(conflict.mismatchedFields, ['requestFingerprint', 'promptHash']);
  assert.equal(sends, 1);
  finish({ success: true, submitted: true });
  await first;
});

test('only proven not-submitted permits a same-identity retry', async () => {
  const registry = createAgentSendReceiptRegistry();
  let sends = 0;
  const first = await registry.run(identity(), async () => {
    sends += 1;
    return { success: false, submitted: false, code: 'terminal_draft_conflict' };
  });
  assert.equal(first.state, RECEIPT_STATES.NOT_SUBMITTED);

  const retried = await registry.run(identity(), async () => {
    sends += 1;
    return { success: true, submitted: true, status: 'sent' };
  });
  assert.equal(retried.state, RECEIPT_STATES.CONFIRMED);
  assert.equal(retried.attempt, 2);
  assert.equal(sends, 2);

  const mismatch = await registry.run(identity({ requestFingerprint: 'request-b' }), async () => {
    sends += 1;
    return { success: true, submitted: true };
  });
  assert.equal(mismatch.state, RECEIPT_STATES.CONFLICT);
  assert.equal(sends, 2);
});

test('proven not-submitted retry may bind a replacement session without weakening request identity', async () => {
  const registry = createAgentSendReceiptRegistry();
  let sends = 0;
  await registry.run(identity({ sessionId: 'failed-start-session' }), async () => {
    sends += 1;
    return { success: false, submitted: false, code: 'launch_not_accepted' };
  });
  const retry = await registry.run(identity({ sessionId: 'replacement-session' }), async () => {
    sends += 1;
    return { success: true, submitted: true, status: 'sent' };
  });
  assert.equal(retry.state, RECEIPT_STATES.CONFIRMED);
  assert.equal(retry.sessionId, 'replacement-session');
  assert.equal(sends, 2);

  const changedPrompt = await registry.run(identity({
    sessionId: 'third-session',
    requestFingerprint: 'changed-request',
  }), async () => {
    sends += 1;
    return { success: true, submitted: true };
  });
  assert.equal(changedPrompt.state, RECEIPT_STATES.CONFLICT);
  assert.equal(sends, 2);
});

test('proven not-submitted retry may clear a failed session before exact late binding', async () => {
  const registry = createAgentSendReceiptRegistry();
  await registry.run(identity({ sessionId: 'failed-start-session' }), async () => ({
    success: false,
    submitted: false,
    code: 'launch_not_accepted',
  }));
  const pending = await registry.run(identity({ sessionId: null }), async () => ({
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  }));
  assert.equal(pending.state, RECEIPT_STATES.AUDIT_PENDING);
  assert.equal(pending.sessionId, null);

  const promoted = registry.promoteFromAudit({
    success: true,
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    provider: 'codex',
    sessionId: 'replacement-session',
    promptHash: 'hash-a',
  });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.receipt.sessionId, 'replacement-session');
});

test('proven Codex canonical audit promotes the expected operation without equating both hashes', async () => {
  const registry = createAgentSendReceiptRegistry();
  await registry.run(identity(), async () => ({
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  }));
  const promoted = registry.promoteFromAudit(exactAudit({
    actualHash: 'provider-hash',
    expectedHash: 'hash-a',
    canonicalized: true,
    canonicalReason: 'codex_image_placeholder_canonical',
  }));
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.receipt.promptHash, 'hash-a');
  assert.equal(promoted.receipt.actualHash, 'provider-hash');
  assert.equal(promoted.receipt.canonicalized, true);
});

test('an unproven hash transformation cannot promote a receipt', async () => {
  const registry = createAgentSendReceiptRegistry();
  await registry.run(identity(), async () => ({
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  }));
  const rejected = registry.promoteFromAudit(exactAudit({
    actualHash: 'provider-hash',
    expectedHash: 'hash-a',
    canonicalized: true,
    canonicalReason: 'unknown-transform',
  }));
  assert.equal(rejected.promoted, false);
  assert.ok(rejected.mismatchedFields.includes('canonicalProof'));
});

for (const matrix of [
  {
    name: 'delivery-unknown',
    receipt: {
      success: null,
      submitted: null,
      status: 'delivery-unknown',
      deliveryUnknown: true,
    },
    state: RECEIPT_STATES.DELIVERY_UNKNOWN,
  },
  {
    name: 'audit-pending',
    receipt: {
      success: null,
      submitted: true,
      status: 'audit-pending',
      auditPending: true,
    },
    state: RECEIPT_STATES.AUDIT_PENDING,
  },
  {
    name: 'confirmed',
    receipt: { success: true, submitted: true, status: 'sent' },
    state: RECEIPT_STATES.CONFIRMED,
  },
]) {
  test(matrix.name + ' is cached and replayed without another send', async () => {
    const registry = createAgentSendReceiptRegistry();
    let sends = 0;
    const first = await registry.run(identity(), async () => {
      sends += 1;
      return matrix.receipt;
    });
    const replay = await registry.run(identity(), async () => {
      sends += 1;
      return { success: true, submitted: true };
    });
    assert.equal(first.state, matrix.state);
    assert.equal(replay.state, matrix.state);
    assert.equal(replay.replayed, true);
    assert.equal(sends, 1);
  });
}

test('executor failure is cached as delivery-unknown rather than enabling retry', async () => {
  const registry = createAgentSendReceiptRegistry();
  let sends = 0;
  const first = await registry.run(identity(), async () => {
    sends += 1;
    throw new Error('lost bridge callback');
  });
  const replay = await registry.run(identity(), async () => {
    sends += 1;
    return { success: true, submitted: true };
  });
  assert.equal(first.state, RECEIPT_STATES.DELIVERY_UNKNOWN);
  assert.equal(first.receipt.code, 'agent_send_executor_error');
  assert.equal(replay.state, RECEIPT_STATES.DELIVERY_UNKNOWN);
  assert.equal(sends, 1);
});

test('late exact audit promotes unknown and pending receipts to confirmed', async () => {
  for (const receipt of [
    { success: null, submitted: null, status: 'delivery-unknown', deliveryUnknown: true },
    { success: null, submitted: true, status: 'audit-pending', auditPending: true },
  ]) {
    const registry = createAgentSendReceiptRegistry();
    let sends = 0;
    await registry.run(identity(), async () => {
      sends += 1;
      return receipt;
    });
    const promotion = registry.promoteFromAudit(exactAudit());
    assert.equal(promotion.matched, true);
    assert.equal(promotion.promoted, true);
    assert.equal(promotion.state, RECEIPT_STATES.CONFIRMED);
    assert.equal(promotion.receipt.exactAuditConfirmed, true);

    const replay = await registry.run(identity(), async () => {
      sends += 1;
      return { success: false, submitted: false };
    });
    assert.equal(replay.state, RECEIPT_STATES.CONFIRMED);
    assert.equal(replay.receipt.sessionId, 'session-a');
    assert.equal(replay.receipt.entryUuid, 'entry-a');
    assert.equal(sends, 1);
  }
});

test('first prompt may bind provider session only when its exact late audit arrives', async () => {
  const registry = createAgentSendReceiptRegistry();
  const pendingIdentity = identity({ provider: null, sessionId: null });
  await registry.run(pendingIdentity, async () => ({
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  }));

  const promoted = registry.promoteFromAudit(exactAudit());
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.receipt.provider, 'codex');
  assert.equal(promoted.receipt.sessionId, 'session-a');

  const replay = await registry.run(pendingIdentity, () => {
    throw new Error('must not send');
  });
  assert.equal(replay.state, RECEIPT_STATES.CONFIRMED);
  assert.equal(replay.provider, 'codex');
  assert.equal(replay.sessionId, 'session-a');
});

test('clear removes all live receipts and tombstones at server shutdown', async () => {
  const registry = createAgentSendReceiptRegistry();
  await registry.run(identity(), async () => ({
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  }));
  assert.equal(registry.snapshot().length, 1);
  registry.clear();
  assert.equal(registry.snapshot().length, 0);
});

test('exact audit can win before the transport callback and cannot be rolled back', async () => {
  const registry = createAgentSendReceiptRegistry();
  let finish;
  let sends = 0;
  const first = registry.run(identity(), () => {
    sends += 1;
    return new Promise((resolve) => { finish = resolve; });
  });
  await Promise.resolve();
  const joined = registry.run(identity(), () => {
    sends += 1;
    return { success: false, submitted: false };
  });
  assert.strictEqual(joined, first);

  const promotion = registry.promoteFromAudit(exactAudit());
  assert.equal(promotion.promoted, true);
  assert.equal((await first).state, RECEIPT_STATES.CONFIRMED);
  finish({ success: false, submitted: false, error: 'late transport timeout' });
  await Promise.resolve();
  await Promise.resolve();

  const replay = await registry.run(identity(), () => {
    sends += 1;
    return { success: false, submitted: false };
  });
  assert.equal(replay.state, RECEIPT_STATES.CONFIRMED);
  assert.equal(replay.receipt.exactAuditConfirmed, true);
  assert.equal(sends, 1);
});

test('foreign tab, handoff, provider, session, and hash audits cannot promote', async () => {
  const variants = [
    { tabId: 'tab-foreign', reason: 'handoff-not-found' },
    { handoffId: 'handoff-foreign', reason: 'handoff-not-found' },
    { provider: 'claude', field: 'provider' },
    { sessionId: 'session-foreign', field: 'sessionId' },
    { actualHash: 'hash-foreign', field: 'promptHash' },
    { expectedHash: 'hash-foreign', field: 'expectedHash' },
  ];
  for (const variant of variants) {
    const registry = createAgentSendReceiptRegistry();
    await registry.run(identity(), async () => ({
      success: null,
      submitted: true,
      status: 'audit-pending',
      auditPending: true,
    }));
    const verdict = registry.promoteFromAudit(exactAudit(variant));
    assert.equal(verdict.promoted, false);
    if (variant.reason) assert.equal(verdict.reason, variant.reason);
    if (variant.field) assert.ok(verdict.mismatchedFields.includes(variant.field));
    assert.equal((await registry.run(identity(), () => {
      throw new Error('must not send');
    })).state, RECEIPT_STATES.AUDIT_PENDING);
  }
});

test('audit cannot contradict explicit not-submitted proof', async () => {
  const registry = createAgentSendReceiptRegistry();
  await registry.run(identity(), async () => ({ success: false, submitted: false }));
  const promotion = registry.promoteFromAudit(exactAudit());
  assert.equal(promotion.promoted, false);
  assert.equal(promotion.reason, 'not-submitted-cannot-be-promoted');
});

test('capacity is bounded per tab and unresolved eviction remains explicit', async () => {
  let time = 1_000;
  const events = [];
  const registry = createAgentSendReceiptRegistry({
    now: () => time,
    retentionMs: 1_000,
    maxPerTab: 2,
    onEvict: (event) => events.push(event),
  });
  let sends = 0;
  const unknown = async () => {
    sends += 1;
    return {
      success: null,
      submitted: null,
      status: 'delivery-unknown',
      deliveryUnknown: true,
    };
  };
  await registry.run(identity({ handoffId: 'h1', requestFingerprint: 'r1' }), unknown);
  time += 1;
  await registry.run(identity({ handoffId: 'h2', requestFingerprint: 'r2' }), unknown);
  time += 1;
  const saturated = await registry.run(
    identity({ handoffId: 'h3', requestFingerprint: 'r3' }),
    unknown,
  );
  assert.equal(saturated.state, RECEIPT_STATES.CAPACITY);
  assert.equal(sends, 2);

  assert.equal(registry.snapshot('tab-a').length, 2, 'records and tombstones share the hard per-tab bound');
  time += 1_001;
  registry.sweep('tab-a');
  const snapshot = registry.snapshot('tab-a');
  assert.equal(snapshot.filter((item) => item.kind === 'record').length, 0);
  assert.equal(snapshot.filter((item) => item.kind === 'tombstone').length, 2);
  assert.equal(snapshot.find((item) => item.handoffId === 'h1').state, RECEIPT_STATES.EVICTED_UNKNOWN);
  assert.ok(events.some((event) => event.handoffId === 'h1' && event.reason === 'retention-expired'));

  const evictedReplay = await registry.run(
    identity({ handoffId: 'h1', requestFingerprint: 'r1' }),
    unknown,
  );
  assert.equal(evictedReplay.state, RECEIPT_STATES.EVICTED_UNKNOWN);
  assert.equal(evictedReplay.code, 'agent_send_receipt_evicted_unresolved');
  assert.equal(sends, 2);

  const exact = registry.promoteFromAudit(exactAudit({ handoffId: 'h1' }));
  assert.equal(exact.promoted, true);
  const confirmedReplay = await registry.run(
    identity({ handoffId: 'h1', requestFingerprint: 'r1' }),
    unknown,
  );
  assert.equal(confirmedReplay.state, RECEIPT_STATES.CONFIRMED);
  assert.equal(sends, 2);

  await registry.run(identity({ handoffId: 'h3', requestFingerprint: 'r3' }), unknown);
  assert.equal(sends, 3);
  assert.equal(registry.snapshot('tab-a').length, 2, 'capacity eviction still respects the combined bound');

  await registry.run(identity({
    tabId: 'tab-b',
    handoffId: 'tab-b-h1',
    requestFingerprint: 'tab-b-r1',
  }), unknown);
  assert.equal(registry.snapshot('tab-b').filter((item) => item.kind === 'record').length, 1);
});

test('retention expiry keeps an unresolved tombstone until exact resolution', async () => {
  let time = 10;
  const events = [];
  const registry = createAgentSendReceiptRegistry({
    now: () => time,
    retentionMs: 10,
    maxPerTab: 2,
    onEvict: (event) => events.push(event),
  });
  let sends = 0;
  const request = identity();
  await registry.run(request, async () => {
    sends += 1;
    return { submitted: true, status: 'audit-pending', auditPending: true };
  });
  time = 21;
  registry.sweep('tab-a');
  const replay = await registry.run(request, async () => {
    sends += 1;
    return { success: true, submitted: true };
  });
  assert.equal(replay.state, RECEIPT_STATES.EVICTED_UNKNOWN);
  assert.equal(sends, 1);
  assert.ok(events.some((event) => (
    event.handoffId === 'handoff-a'
    && event.reason === 'retention-expired'
    && event.unresolved === true
  )));

  time = 32;
  registry.sweep('tab-a');
  const lateReplay = await registry.run(request, async () => {
    sends += 1;
    return { success: true, submitted: true };
  });
  assert.equal(lateReplay.state, RECEIPT_STATES.EVICTED_UNKNOWN);
  assert.equal(sends, 1);
  assert.equal(events.some((event) => (
    event.handoffId === 'handoff-a'
    && event.reason === 'tombstone-expired'
  )), false);
});

test('registry refuses new sends when all bounded slots carry unresolved proof', async () => {
  const registry = createAgentSendReceiptRegistry({ maxPerTab: 1 });
  let sends = 0;
  const unknown = async () => {
    sends += 1;
    return { submitted: null, status: 'delivery-unknown', deliveryUnknown: true };
  };
  await registry.run(identity({ handoffId: 'h1', requestFingerprint: 'r1' }), unknown);
  const firstSaturated = await registry.run(
    identity({ handoffId: 'h2', requestFingerprint: 'r2' }),
    unknown,
  );
  const saturated = await registry.run(
    identity({ handoffId: 'h3', requestFingerprint: 'r3' }),
    unknown,
  );
  assert.equal(firstSaturated.state, RECEIPT_STATES.CAPACITY);
  assert.equal(saturated.state, RECEIPT_STATES.CAPACITY);
  assert.equal(saturated.code, 'agent_send_receipt_registry_capacity');
  assert.equal(sends, 1);
  assert.equal(registry.snapshot('tab-a').length, 1, 'records and tombstones share one hard slot');
});

test('an in-flight slot is never evicted to make room for another physical send', async () => {
  const registry = createAgentSendReceiptRegistry({ maxPerTab: 1 });
  let finish;
  let sends = 0;
  const first = registry.run(identity(), () => {
    sends += 1;
    return new Promise((resolve) => { finish = resolve; });
  });
  const capacity = await registry.run(identity({
    handoffId: 'handoff-b',
    requestFingerprint: 'request-b',
  }), async () => {
    sends += 1;
    return { success: true, submitted: true };
  });
  assert.equal(capacity.state, RECEIPT_STATES.CAPACITY);
  assert.equal(sends, 1);
  finish({ success: true, submitted: true });
  await first;
});
