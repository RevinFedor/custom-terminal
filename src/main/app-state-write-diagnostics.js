'use strict';

const { performance } = require('node:perf_hooks');

const SLOW_WRITE_MS = 16;
const MAX_FIELD_LENGTH = 96;

function readProperty(value, key) {
  try {
    return value == null ? undefined : value[key];
  } catch {
    return undefined;
  }
}

function boundedField(value, maxLength = MAX_FIELD_LENGTH) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '-';
  const text = String(value).slice(0, maxLength * 2)
    .replace(/[\s\u0000-\u001f\u007f]+/g, '_')
    .slice(0, maxLength);
  return text || '-';
}

function getElapsedMs(startedAt, clock) {
  if (!Number.isFinite(startedAt)) return null;
  try {
    const elapsedMs = clock() - startedAt;
    return Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? Math.round(elapsedMs * 10) / 10
      : null;
  } catch {
    return null;
  }
}

function emitDiagnostic(options, level, outcome, key, metadata, elapsedMs, error) {
  try {
    const event = readProperty(options, 'event');
    const sender = readProperty(event, 'sender');
    const senderId = readProperty(sender, 'id');
    const fields = [
      '[AppStateWrite]',
      `outcome=${outcome}`,
      `kind=${boundedField(readProperty(options, 'kind'), 24)}`,
      `sender=${boundedField(senderId, 32)}`,
      `key=${boundedField(key, MAX_FIELD_LENGTH)}`,
      `code=${boundedField(readProperty(error, 'code'), 48)}`,
      `name=${boundedField(readProperty(error, 'name'), 48)}`,
      `reason=${boundedField(readProperty(metadata, 'reason'))}`,
      `source=${boundedField(readProperty(metadata, 'source'))}`,
      'timing=elapsed-wait-work',
      `elapsedMs=${Number.isFinite(elapsedMs) ? elapsedMs : 'unknown'}`,
    ];
    const logger = readProperty(options, level);
    const fallback = level === 'warn' ? console.warn : console.log;
    const writeLog = typeof logger === 'function' ? logger : fallback;
    Reflect.apply(writeLog, console, [fields.join(' ')]);
  } catch {
    // Diagnostics must never change a database result or replace its exception.
  }
}

function writeAppStateWithDiagnostics(db, key, value, metadata, options = {}) {
  let clock = () => performance.now();
  try {
    const configuredClock = readProperty(options, 'now');
    if (typeof configuredClock === 'function') clock = configuredClock;
  } catch {
    // Ignore a broken diagnostic clock and still perform the write.
  }

  let startedAt = null;
  try {
    startedAt = clock();
  } catch {
    // A clock failure must not prevent the storage operation.
  }

  let result;
  try {
    result = db.setAppState(key, value, metadata);
  } catch (error) {
    emitDiagnostic(options, 'warn', 'thrown', key, metadata, getElapsedMs(startedAt, clock), error);
    throw error;
  }

  const elapsedMs = getElapsedMs(startedAt, clock);
  let rejected = false;
  try {
    rejected = result?.success === false;
  } catch {
    // Preserve the result for the caller; its existing handling remains authoritative.
  }
  if (rejected) {
    emitDiagnostic(options, 'warn', 'success-false', key, metadata, elapsedMs, null);
  } else if (elapsedMs !== null && elapsedMs >= SLOW_WRITE_MS) {
    emitDiagnostic(options, 'log', 'slow-success', key, metadata, elapsedMs);
  }
  return result;
}

module.exports = { writeAppStateWithDiagnostics };
