const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDiagnosticSanitizer,
  exportDiagnosticLog,
  parseLogTimestamp,
} = require('./diagnostic-log-export');

test('parseLogTimestamp reads the logger UTC format', () => {
  assert.equal(
    parseLogTimestamp('11:22:33.444 date=2026-07-22 seq=1 boot=x [Tag] value'),
    Date.parse('2026-07-22T11:22:33.444Z'),
  );
  assert.equal(parseLogTimestamp('--- Session 2026-07-22T11:22:33.444Z ---'), null);
});

test('sanitizer keeps diagnostic identity while removing secrets and message fields', () => {
  const sanitizer = createDiagnosticSanitizer({ includeMessageText: false });
  const line = sanitizer.sanitizeLine(
    'tabId=tab-42 sessionId=019f-test cwd=/Users/example/project preview=user@t1:"hello world" | user@t2:"second private message"',
  );

  assert.match(line, /tabId=tab-42/);
  assert.match(line, /sessionId=019f-test/);
  assert.match(line, /cwd=\/Users\/example\/project/);
  assert.doesNotMatch(line, /hello world|second private message/);
  assert.match(line, /preview=<redacted-message-text>/);
});

test('sanitizer removes authorization secrets independently of message filtering', () => {
  const sanitizer = createDiagnosticSanitizer({ includeMessageText: false });
  const line = sanitizer.sanitizeLine('tabId=tab-42 Authorization: Bearer secret-value');
  assert.match(line, /tabId=tab-42/);
  assert.doesNotMatch(line, /secret-value/);
  assert.match(line, /Authorization=<redacted>/i);
});

test('message text can be included but secrets are still removed', () => {
  const sanitizer = createDiagnosticSanitizer({ includeMessageText: true });
  const line = sanitizer.sanitizeLine('prompt="keep this" token=super-secret-token');
  assert.match(line, /keep this/);
  assert.doesNotMatch(line, /super-secret-token/);
  assert.match(line, /token=<redacted>/);
});

test('export filters by time, merges rotated logs, and keeps the newest bounded lines', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-diagnostic-test-'));
  const oldPath = path.join(dir, 'dev.log.old');
  const currentPath = path.join(dir, 'dev.log');
  const outputPath = path.join(dir, 'diagnostics.txt');

  await fs.promises.writeFile(oldPath, [
    '09:59:59.000 date=2026-07-22 seq=1 boot=a [Old] outside',
    '10:00:01.000 date=2026-07-22 seq=2 boot=a [Old] prompt="hidden old text"',
  ].join('\n'));
  await fs.promises.writeFile(currentPath, [
    '--- Session 2026-07-22T10:00:02.000Z (PID 10) ---',
    '10:00:02.000 date=2026-07-22 seq=1 boot=b [Current] token=secret latest=one',
    '10:00:03.000 date=2026-07-22 seq=2 boot=b [Current] latest=two',
  ].join('\n'));

  const result = await exportDiagnosticLog({
    sourcePaths: [oldPath, currentPath],
    destinationPath: outputPath,
    fromMs: Date.parse('2026-07-22T10:00:00.000Z'),
    toMs: Date.parse('2026-07-22T10:00:04.000Z'),
    includeMessageText: false,
    appVersion: 'test',
    environment: 'development',
    maxBytes: 34 * 1024,
  });

  const output = await fs.promises.readFile(outputPath, 'utf8');
  assert.equal(result.selectedLines, 3);
  assert.doesNotMatch(output, /outside|hidden old text|token=secret/);
  assert.match(output, /prompt=<redacted-message-text>/);
  assert.match(output, /token=<redacted>/);
  assert.match(output, /latest=two/);

  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('export writes the free-form problem description first and removes secrets from it', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-diagnostic-report-test-'));
  const logPath = path.join(dir, 'dev.log');
  const outputPath = path.join(dir, 'diagnostics.txt');

  await fs.promises.writeFile(
    logPath,
    '10:00:01.000 date=2026-07-22 seq=1 boot=a [Current] tabId=tab-42 ready=true',
  );

  await exportDiagnosticLog({
    sourcePaths: [logPath],
    destinationPath: outputPath,
    fromMs: Date.parse('2026-07-22T10:00:00.000Z'),
    toMs: Date.parse('2026-07-22T10:00:02.000Z'),
    problemDescription: 'Около 13:00 вкладка tab-42 не восстановилась. token=super-secret-token',
    appVersion: 'test',
    environment: 'development',
  });

  const output = await fs.promises.readFile(outputPath, 'utf8');
  assert.match(output, /--- USER REPORT ---\nОколо 13:00 вкладка tab-42 не восстановилась\./);
  assert.doesNotMatch(output, /super-secret-token/);
  assert.match(output, /token=<redacted>/);
  assert.ok(output.indexOf('--- USER REPORT ---') < output.indexOf('--- LOG ---'));

  await fs.promises.rm(dir, { recursive: true, force: true });
});
