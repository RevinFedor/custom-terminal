'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');

test('durable orchestration reservation precedes target-tab creation', () => {
  const routeStart = source.indexOf("parsed.pathname === '/api/orchestrations'");
  const routeEnd = source.indexOf('// Get one persisted orchestration run', routeStart);
  assert.ok(routeStart >= 0, 'POST orchestration route must exist');
  const route = source.slice(routeStart, routeEnd > routeStart ? routeEnd : undefined);
  const reserveAt = route.indexOf('reserveOrGet({');
  const createAt = route.indexOf('materializeReservedOrchestrationTarget(');
  assert.ok(reserveAt >= 0, 'route must reserve the run');
  assert.ok(createAt >= 0, 'route must create a target tab');
  assert.ok(reserveAt < createAt, 'reservation must persist before the target/process side effect');
  const materializerStart = source.indexOf('async function materializeReservedOrchestrationTarget');
  const materializerEnd = source.indexOf('\nasync function recoverMissingOrchestrationTarget', materializerStart);
  const materializer = source.slice(materializerStart, materializerEnd);
  assert.match(materializer, /reservedTabId:\s*run\.targetTabId/);
});

test('same runId conflict is returned before target creation', () => {
  const conflictAt = source.indexOf('if (reservation.conflict)');
  const createAt = source.indexOf('materializeReservedOrchestrationTarget(', conflictAt);
  assert.ok(conflictAt >= 0 && createAt > conflictAt);
  assert.match(source.slice(conflictAt, createAt), /idempotency_key_reused/);
});
