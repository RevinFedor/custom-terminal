'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { writeAppStateWithDiagnostics } = require('./app-state-write-diagnostics');

test('passes the original database receiver and argument references through unchanged', () => {
  const key = 'state-key';
  const value = { toJSON() { throw new Error('value must not be serialized'); } };
  const metadata = { reason: 'shutdown', source: 'renderer' };
  const result = { success: true, persisted: true };
  const calls = [];
  const db = {
    setAppState(...args) {
      assert.strictEqual(this, db);
      calls.push(args);
      return result;
    },
  };
  let tick = 10;

  const actual = writeAppStateWithDiagnostics(db, key, value, metadata, {
    now: () => tick++,
    log() { assert.fail('fast successful write should not log'); },
    warn() { assert.fail('fast successful write should not warn'); },
  });

  assert.strictEqual(actual, result);
  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0][0], key);
  assert.strictEqual(calls[0][1], value);
  assert.strictEqual(calls[0][2], metadata);
});

test('reports and returns the exact success:false result', () => {
  const result = { success: false, error: 'workspace_space_missing', missingSpaceIds: ['space-1'] };
  const warnings = [];
  let tick = 1;
  const actual = writeAppStateWithDiagnostics(
    { setAppState: () => result },
    'workspace-state',
    { secret: 'must not appear' },
    { reason: 'workspace-save', source: 'renderer' },
    { kind: 'async', event: { sender: { id: 42 } }, now: () => tick++, warn: line => warnings.push(line) },
  );

  assert.strictEqual(actual, result);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /outcome=success-false/);
  assert.match(warnings[0], /kind=async sender=42 key=workspace-state/);
  assert.match(warnings[0], /reason=workspace-save source=renderer timing=elapsed-wait-work elapsedMs=1/);
  assert.doesNotMatch(warnings[0], /secret/);
  assert.doesNotMatch(warnings[0], /workspace_space_missing/);
});

test('logs SQLite error identity and rethrows the same exception object', () => {
  const error = Object.assign(new Error('database is locked'), {
    name: 'SqliteError',
    code: 'SQLITE_BUSY',
  });
  const warnings = [];
  let tick = 100;
  let thrown;
  try {
    writeAppStateWithDiagnostics(
      { setAppState() { throw error; } },
      'notes',
      'private body',
      { reason: 'notes-save', source: 'renderer' },
      { kind: 'sync', event: { sender: { id: 7 } }, now: () => tick += 25, warn: line => warnings.push(line) },
    );
  } catch (caught) {
    thrown = caught;
  }

  assert.strictEqual(thrown, error);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /outcome=thrown kind=sync sender=7 key=notes/);
  assert.match(warnings[0], /code=SQLITE_BUSY name=SqliteError/);
  assert.match(warnings[0], /reason=notes-save source=renderer timing=elapsed-wait-work elapsedMs=25/);
  assert.doesNotMatch(warnings[0], /private body|database is locked/);
});

test('never inspects or serializes the stored value', () => {
  const value = new Proxy({}, {
    get() { throw new Error('stored value was inspected'); },
    ownKeys() { throw new Error('stored value was serialized'); },
  });
  let received;
  let tick = 0;

  const result = writeAppStateWithDiagnostics(
    { setAppState(_key, actualValue) { received = actualValue; return { success: true }; } },
    'opaque',
    value,
    { reason: 'opaque-write', source: 'test' },
    { now: () => tick++, log() { assert.fail('write should not be slow'); } },
  );

  assert.strictEqual(received, value);
  assert.deepEqual(result, { success: true });
});

test('bounds logged metadata and reports slow success as elapsed duration', () => {
  const logs = [];
  let tick = 0;
  const key = 'k'.repeat(500);
  const metadata = {
    reason: `reason\n${'r'.repeat(500)}`,
    source: 'source with spaces',
  };
  const result = { success: true };

  const actual = writeAppStateWithDiagnostics(
    { setAppState: () => result }, key, 'unlogged value', metadata,
    { kind: 'sync', event: { sender: { id: 9 } }, now: () => (tick++ === 0 ? 0 : 16), log: line => logs.push(line) },
  );

  assert.strictEqual(actual, result);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /outcome=slow-success/);
  assert.match(logs[0], /elapsedMs=16/);
  assert.ok(logs[0].length < 500);
  assert.equal(logs[0].includes('\n'), false);
  assert.doesNotMatch(logs[0], /unlogged value/);
});

test('logger failures cannot alter a stored result or mask the original exception', () => {
  let tick = 0;
  const result = { success: true, exact: true };
  const returned = writeAppStateWithDiagnostics(
    { setAppState: () => result }, 'slow', null, {},
    { now: () => (tick++ === 0 ? 0 : 20), log() { throw new Error('logger failed'); } },
  );
  assert.strictEqual(returned, result);

  const original = new Error('write failed');
  let errorTick = 0;
  let caught;
  try {
    writeAppStateWithDiagnostics(
      { setAppState() { throw original; } }, 'failing', null, {},
      { now: () => errorTick++, warn() { throw new Error('logger failed'); } },
    );
  } catch (error) {
    caught = error;
  }
  assert.strictEqual(caught, original);
});

test('both authorized Main handlers use the helper exactly once without duplicate registration', () => {
  const mainPath = path.join(__dirname, 'main.js');
  const source = fs.readFileSync(mainPath, 'utf8');
  assert.match(source, /require\(path\.join\(srcMainDir, 'app-state-write-diagnostics'\)\)/);

  for (const [registration, channel, kind] of [
    ['handle', 'app:setState', 'async'],
    ['on', 'app:setStateSync', 'sync'],
  ]) {
    const registrationPattern = new RegExp(`ipcMain\\.${registration}\\(['"]${channel}['"]`, 'g');
    assert.equal([...source.matchAll(registrationPattern)].length, 1, `${channel} should register once`);
    const start = source.indexOf(`ipcMain.${registration}('${channel}'`);
    const nextRegistration = source.indexOf('\nipcMain.', start + 1);
    const body = source.slice(start, nextRegistration === -1 ? source.length : nextRegistration);
    assert.equal((body.match(/writeAppStateWithDiagnostics\(/g) || []).length, 1, `${channel} should call the helper once`);
    assert.match(body, new RegExp(`kind: '${kind}'`));
  }
});
