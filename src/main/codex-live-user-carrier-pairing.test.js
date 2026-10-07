'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CARRIER_EVENT,
  CARRIER_RESPONSE,
  createCodexLiveUserCarrierPairer,
} = require('./codex-live-user-carrier-pairing');

function projection(kind, index, text = 'same prompt', extras = {}) {
  const response = kind === CARRIER_RESPONSE;
  const offset = Number(extras.byteOffset ?? index * 100);
  const sourceIdentity = `codex-user-source-session-a-${offset}`;
  return {
    sessionId: extras.sessionId || 'session-a',
    timestamp: `2026-08-19T02:03:26.${String(index).padStart(3, '0')}Z`,
    sourceSequence: index,
    recordByteOffset: offset,
    promptOwner: extras.promptOwner || null,
    message: {
      type: 'user',
      uuid: `codex-live-session-a-${index}-${response ? 'response' : 'event'}-user`,
      sourceIdentity,
      sessionId: extras.sessionId || 'session-a',
      ...(extras.imagePaths ? { imagePaths: extras.imagePaths } : {}),
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  };
}

function accept(pairer, kind, index, text = 'same prompt', extras = {}) {
  const value = projection(kind, index, text, extras);
  return pairer.accept({
    kind,
    text,
    byteOffset: value.recordByteOffset,
    projection: value,
    publish: extras.publish !== false,
  });
}

test('response then event across separate appends upgrades one live row with exact alias', () => {
  const pairer = createCodexLiveUserCarrierPairer();
  const response = accept(pairer, CARRIER_RESPONSE, 1, 'same prompt', {
    promptOwner: { handoffId: 'handoff-a' },
  });
  assert.equal(response.paired, false);
  assert.equal(response.projections.length, 1);

  const event = accept(pairer, CARRIER_EVENT, 2);
  assert.equal(event.paired, true);
  assert.equal(event.projections.length, 1);
  assert.match(event.projections[0].message.uuid, /event-user$/);
  assert.equal(
    event.projections[0].message.sourceIdentity,
    'codex-user-source-session-a-200',
  );
  assert.equal(event.projections[0].recordByteOffset, 200);
  assert.deepEqual(event.projections[0].promptOwner, { handoffId: 'handoff-a' });
  assert.deepEqual(event.projections[0].message.sourceIdentityAliases, [
    'codex-user-source-session-a-100',
  ]);
  assert.deepEqual(pairer.snapshot(), { pendingResponses: [], pendingEvents: [] });
});

test('same-append suppressed response is still remembered for the canonical event', () => {
  const pairer = createCodexLiveUserCarrierPairer();
  const response = accept(pairer, CARRIER_RESPONSE, 1, 'prompt', { publish: false });
  assert.deepEqual(response.projections, []);
  const event = accept(pairer, CARRIER_EVENT, 2, 'prompt');
  assert.equal(event.paired, true);
  assert.deepEqual(event.projections[0].message.sourceIdentityAliases, [
    'codex-user-source-session-a-100',
  ]);
});

test('event then response retains the event identity and adds the later response alias', () => {
  const pairer = createCodexLiveUserCarrierPairer();
  const event = accept(pairer, CARRIER_EVENT, 1);
  assert.equal(event.projections.length, 1);
  const response = accept(pairer, CARRIER_RESPONSE, 2);
  assert.equal(response.paired, true);
  assert.equal(response.projections[0].message.uuid, event.projections[0].message.uuid);
  assert.equal(
    response.projections[0].message.sourceIdentity,
    event.projections[0].message.sourceIdentity,
  );
  assert.deepEqual(response.projections[0].message.sourceIdentityAliases, [
    'codex-user-source-session-a-200',
  ]);
});

test('first task start can follow a response fallback, but the next start cannot borrow it', () => {
  const beforeStart = createCodexLiveUserCarrierPairer();
  accept(beforeStart, CARRIER_RESPONSE, 1);
  beforeStart.observeBoundary('task_started');
  assert.equal(accept(beforeStart, CARRIER_EVENT, 2).paired, true);

  const consecutiveStarts = createCodexLiveUserCarrierPairer();
  consecutiveStarts.observeBoundary('task_started');
  accept(consecutiveStarts, CARRIER_RESPONSE, 1);
  consecutiveStarts.observeBoundary('task_started');
  assert.equal(accept(consecutiveStarts, CARRIER_EVENT, 2).paired, false);
  consecutiveStarts.observeBoundary('task_complete');
  accept(consecutiveStarts, CARRIER_RESPONSE, 3);
  consecutiveStarts.observeBoundary('task_started');
  assert.equal(accept(consecutiveStarts, CARRIER_EVENT, 4).paired, true);
});

test('two byte-identical sends pair FIFO and remain two canonical events', () => {
  const pairer = createCodexLiveUserCarrierPairer();
  accept(pairer, CARRIER_RESPONSE, 1);
  accept(pairer, CARRIER_RESPONSE, 2);
  const first = accept(pairer, CARRIER_EVENT, 3);
  const second = accept(pairer, CARRIER_EVENT, 4);
  assert.deepEqual(
    [first, second].map((result) => ({
      event: result.eventSourceIdentity,
      response: result.responseSourceIdentity,
    })),
    [
      {
        event: 'codex-user-source-session-a-300',
        response: 'codex-user-source-session-a-100',
      },
      {
        event: 'codex-user-source-session-a-400',
        response: 'codex-user-source-session-a-200',
      },
    ],
  );
});

test('image carrier equivalence keeps one canonical image list and both source identities', () => {
  const pairer = createCodexLiveUserCarrierPairer();
  accept(pairer, CARRIER_RESPONSE, 1, '[Image #1] inspect', {
    imagePaths: [{ path: '/tmp/incident.png', source: 'response' }],
  });
  const event = accept(pairer, CARRIER_EVENT, 2, '[Image] inspect', {
    imagePaths: [{ path: '/tmp/incident.png', source: 'event' }],
  });
  assert.equal(event.paired, true);
  assert.equal(event.projections[0].message.imagePaths.length, 1);
  assert.equal(event.projections[0].message.imagePaths[0].source, 'event');
  assert.deepEqual(event.projections[0].message.sourceIdentityAliases, [
    'codex-user-source-session-a-100',
  ]);
});

test('same text alone never merges same-kind, cross-session, or boundary-separated carriers', () => {
  const pairer = createCodexLiveUserCarrierPairer();
  accept(pairer, CARRIER_RESPONSE, 1);
  const secondResponse = accept(pairer, CARRIER_RESPONSE, 2);
  assert.equal(secondResponse.paired, false);

  const otherSession = accept(pairer, CARRIER_EVENT, 3, 'same prompt', {
    sessionId: 'session-b',
  });
  assert.equal(otherSession.paired, false);

  pairer.observeBoundary('task_complete');
  const laterEvent = accept(pairer, CARRIER_EVENT, 4);
  assert.equal(laterEvent.paired, false);
  assert.deepEqual(pairer.snapshot(), {
    pendingResponses: [],
    pendingEvents: ['codex-user-source-session-a-400'],
  });
});
