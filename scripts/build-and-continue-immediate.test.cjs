'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { runBuildContinue, ENDPOINT } = require('./build-and-continue-immediate.cjs');
function fixture() {
  const events = [], operationId = 'test-operation-one';
  let closed = false;
  const options = { operationId, log() {}, inspect: () => closed ? { status: 'absent', server: null } : ({ status: 'found', server: { pid: 11, port: 1 } }),
    readToken: () => 'private-fixture-token',
    wait: async () => ({ pid: 22, port: 2 }),
    request: async request => {
      events.push(request);
      if (request.requestPath === '/api/me') return { statusCode: 200, body: { ok: true, capabilities: { buildContinue: { version: 2, proofRevision: 2 } } } };
      if (request.requestPath === ENDPOINT) closed = true;
      return { statusCode: request.requestPath.endsWith('/restore') ? 202 : 200,
        body: { ok: true, operation: { id: operationId, sourceMainPid: 11, capturedAt: 123 }, reportUrl: 'exact-report' } };
    }, maintenance: { installScope: id => { events.push({ quietOperation: id }); return { operationId: id }; } },
    install: async args => { assert.equal(args.quitBeforePrepare, true); await args.beforeQuit();
      events.push({ compiler: true }); await args.beforeReplace(); return { ok: true }; } };
  return { options, events };
}
test('build:i-c captures/quits exact old Main before compiler, restores same operation, no client Send', async () => {
  assert.equal(require('../package.json').scripts['build:i-c'], 'node scripts/build-and-continue-immediate.cjs');
  const h = fixture(), result = await runBuildContinue(h.options);
  assert.equal(result.ok, true);
  const capture = h.events.findIndex(e => e.requestPath === ENDPOINT);
  assert(capture < h.events.findIndex(e => e.compiler));
  assert.equal(h.events[capture].body.expectedMainPid, 11);
  assert.equal(h.events.find(e => e.quietOperation).quietOperation, 'install:noted:continue:test-operation-one');
  assert(h.events.some(e => e.port === 2 && e.requestPath === ENDPOINT + '/test-operation-one/restore'));
  assert.equal(h.events.some(e => String(e.requestPath).endsWith('/send')), false);
});
test('unsupported installed app refuses before Quit/build; exact resume never creates a new operation', async () => {
  let h = fixture(); h.options.request = async () => ({ statusCode: 200, body: { ok: true, capabilities: {} } });
  await assert.rejects(runBuildContinue(h.options), /coordinated normal update/);
  assert.equal(h.events.length, 0);
  h = fixture(); await runBuildContinue({ ...h.options, resume: true });
  assert.equal(h.events.some(e => e.compiler || e.requestPath === ENDPOINT), false);
});
test('failed build reopens old app and restores captured work without relabelling install success', async () => {
  const h = fixture(); h.options.install = async args => { await args.beforeQuit(); return { ok: false, recovery: { status: 'previous-app-reopened' } }; };
  const result = await runBuildContinue(h.options);
  assert.equal(result.ok, false); assert(result.continuation.ok);
  assert.equal(h.events.filter(e => e.requestPath === ENDPOINT).length, 1);
});

test('intermediate installed v2 without complete recovery proof refuses before capture/Quit/compiler', async () => {
  const h = fixture(), normal = h.options.request;
  h.options.request = async request => request.requestPath === '/api/me' ? { statusCode: 200,
    body: { ok: true, capabilities: { buildContinue: { version: 2 } } } } : normal(request);
  await assert.rejects(runBuildContinue(h.options), /coordinated normal update/);
  assert.equal(h.events.length, 0);
});

test('a newly opened or unknown app during compilation prevents replacing that new owner', async () => {
  const h = fixture();
  let reads = 0;
  h.options.inspect = () => ({ status: 'found', server: { pid: ++reads === 1 ? 11 : 99, port: 1 } });
  await assert.rejects(runBuildContinue(h.options), /during build/);
  assert.equal(h.events.filter(e => e.requestPath?.endsWith('/restore')).length, 0);
});
