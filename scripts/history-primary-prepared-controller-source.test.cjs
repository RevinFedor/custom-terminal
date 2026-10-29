'use strict';

// SOURCE only. Exact complete controller methods are selected from the AST.
// The production method bodies are evaluated literally, with no transforms.
// No modified predicates or reconstructed dispatch. Maintenance scheduling,
// source admission and diagnostic callbacks are named doubles; actual bundle,
// plane, SQLite and retain/release run against finite parsed source fixtures.
// node --max-old-space-size=64 --max-semi-space-size=2 --test --test-reporter=tap --test-isolation=none scripts/history-primary-prepared-controller-source.test.cjs
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { HISTORY_PRESENTATION_POSITION_PROFILE: POSITION_PROFILE,
  HISTORY_PRESENTATION_POSITION_QUERY_ENCODING: POSITION_QUERY_ENCODING } = require('../src/main/history-root-engine/main/history-presentation-position');
const source = fs.readFileSync(path.resolve(__dirname, '../src/main/history-root-engine/main/history-root-controller.js'), 'utf8');
const parser = require(process.env.NOTED_TEST_BABEL_PARSER || '@babel/parser');
const parsed = parser.parse(source, { sourceType: 'script' });
const declaration = parsed.program.body.find(node => node.type === 'ClassDeclaration' && node.id.name === 'HistoryRootController');
assert(declaration, 'actual source controller class');
const names = ['allocates', 'installedPositionRead', 'installedTextPinFork', 'dispatch', 'consumer', 'remember', 'retainRootCapability', 'dispatchOwned'];
const selected = names.map(name => {
  const node = declaration.body.body.find(item => item.type === 'ClassMethod' && item.key.name === name);
  assert(node, 'actual method ' + name); return source.slice(node.start, node.end);
});
const fail = code => Object.assign(new Error(code), { code });
const Controller = new Function('backingPhase', 'fail', 'POSITION_PROFILE', 'POSITION_QUERY_ENCODING',
  'return class ExactController {' + selected.join('\n') + '}')(() => () => {}, fail, POSITION_PROFILE, POSITION_QUERY_ENCODING);
function ctl(f) {
  const events = [], value = Object.assign(Object.create(Controller.prototype), {
    plane: f.plane, store: f.store, closed: false, initializedBacking: true, fullCollectionDepth: 0,
    sourceOptions: {}, sourceSchema: 'prepared-fixture', maintenanceMetrics: { cleanupErrors: 0 },
    maintenanceAdmission: { active: false, async acquire() { events.push('acquire'); return () => events.push('unlock'); } },
    ensurePlane() { events.push('ensure'); return f.plane; },
    async initializeBacking() { events.push('initialize'); },
    collectBounded(limit, why) { assert.equal(limit, 64); assert.equal(why, 'allocation-collection'); events.push('collect64'); },
    async makeRoom(method) { assert.equal(method, 'forkHistoryRootLeaf'); events.push('room'); },
    cleanupStep() { events.push('cleanup'); },
  }); return { value, events };
}
async function rig(t) {
  const f = await createPrimaryAddressFixture(t, { entries: [{ role: 'user', uuid: 'u', sessionId: 's', content: 'full' }] });
  const parent = await f.plane.open(f.payload, { consumerKey: f.consumerKey });
  const { leaseId, ownerKey, revision, generation, metadataIdentity, metadataSchema, semanticIdentity,
    semanticRevisionToken, viewRevisionToken, canonicalEntryCount, sourceEntryCount } = parent;
  const request = { leaseId, ownerKey, revision, generation, metadataIdentity, metadataSchema, semanticIdentity,
    semanticRevisionToken, viewRevisionToken, canonicalEntryCount, sourceEntryCount, ...parent.preparedPresentation,
    parentNodeToken: parent.root.nodeToken, nodeToken: parent.sourceMetadata.nodeToken,
    encoding: 'history-primary-prepared-presentation-v1', preparedRequestId: randomUUID(), _historyRootConsumerKey: f.consumerKey };
  return { f, parent, request, ...ctl(f) };
}
const control = { assertCurrent() {}, async checkpoint() { await new Promise(resolve => setImmediate(resolve)); } };

test('real controller keeps cold prepared creation on allocation/quota admission and records exact child cleanup', async t => {
  const x = await rig(t), cleanups = [];
  assert.equal(x.value.allocates('forkHistoryRootLeaf', x.request), true);
  assert.equal(x.value.installedPositionRead('forkHistoryRootLeaf', x.request), false);
  assert.equal(x.value.installedTextPinFork('forkHistoryRootLeaf', x.request), false);
  const result = await x.value.dispatch('forkHistoryRootLeaf', x.request, { control, retain: cleanup => cleanups.push(cleanup) });
  assert.equal(result.success, true); assert.equal(result.preparedRequestId, x.request.preparedRequestId);
  assert.deepEqual(x.events, ['acquire', 'ensure', 'initialize', 'collect64', 'room', 'ensure', 'cleanup', 'unlock']);
  assert.equal(x.f.plane.stats().roots, 2); assert.equal(cleanups.length, 1);
  cleanups[0](); cleanups[0](); assert.equal(x.f.plane.stats().roots, 1);
  assert.equal(x.f.plane.state(x.parent, x.f.consumerKey).released, false);
});

test('actual controller preserves UNKNOWN without replay and cancels only the newly issued child', async t => {
  const x = await rig(t), fork = x.f.plane.forkPreparedPresentation, unknown = fail('HISTORY_READER_TRANSPORT_UNKNOWN');
  let calls = 0;
  x.f.plane.forkPreparedPresentation = async () => { calls++; throw unknown; };
  await assert.rejects(x.value.dispatch('forkHistoryRootLeaf', x.request, { control }), error => error === unknown);
  assert.equal(calls, 1); assert.equal(x.f.plane.stats().roots, 1);
  x.f.plane.forkPreparedPresentation = fork;
  let revoked = false, cleanup;
  const cancelled = fail('HISTORY_READ_CANCELLED');
  await assert.rejects(x.value.dispatch('forkHistoryRootLeaf', x.request, {
    control: { assertCurrent() { if (revoked) throw cancelled; }, async checkpoint() { this.assertCurrent(); } },
    retain(release) { cleanup = release; revoked = true; },
  }), error => error === cancelled);
  cleanup(); assert.equal(x.f.plane.stats().roots, 1); assert.equal(x.value.maintenanceMetrics.cleanupErrors, 0);
  assert.equal(x.f.plane.state(x.parent, x.f.consumerKey).released, false);
});

for (const bridgePath of ['../src/main/history-root-ipc', '../src/main/history-root-engine/main/history-root-ipc']) {
  test('actual IPC final consumer gate releases only exact prepared allocation: ' + bridgePath, async t => {
    const { EventEmitter } = require('node:events'), { createHistoryRootIpcBridge } = require(bridgePath);
    const f = await createPrimaryAddressFixture(t, { entries: [{ role: 'user', uuid: 'u', sessionId: 's', content: 'whole' }] });
    const sender = new EventEmitter(); sender.isDestroyed = () => false;
    const events = [], gateFailure = fail('FINITE_FINAL_CONSUMER_REVOKED');
    let rejectGate = false, owner, actualChild, substitute;
    const bridge = createHistoryRootIpcBridge({
      reader: { async call(method, payload) {
        owner = payload._historyRootConsumerKey;
        if (method === 'openHistoryRoot') return f.plane.open(payload, { consumerKey: owner, control });
        actualChild = await f.plane.forkPreparedPresentation(payload, { consumerKey: owner, control });
        return substitute || actualChild;
      }, postWorkerEvent(event) {
        events.push(event);
        if (event.event === 'release-root-result') {
          try { f.plane.release(event.capability, { consumerKey: event.consumerKey }); }
          catch (error) { events.push({ refused: error.code }); }
        } else if (event.event === 'release-root-consumer') f.plane.releaseConsumer(event.consumerKey);
      } },
      demands: { async run(event, payload, read) { const result = await read(payload); if (rejectGate) throw gateFailure; return result; } },
    });
    t.after(() => bridge.close());
    const parent = await bridge.run({ sender }, f.payload, 'openHistoryRoot');
    const request = { ...parent.preparedPresentation,
      ...Object.fromEntries(['leaseId', 'ownerKey', 'revision', 'generation', 'metadataIdentity', 'metadataSchema', 'semanticIdentity',
        'semanticRevisionToken', 'viewRevisionToken', 'canonicalEntryCount', 'sourceEntryCount'].map(key => [key, parent[key]])),
      parentNodeToken: parent.root.nodeToken, nodeToken: parent.sourceMetadata.nodeToken,
      encoding: 'history-primary-prepared-presentation-v1', preparedRequestId: randomUUID() };
    rejectGate = true;
    await assert.rejects(bridge.run({ sender }, request, 'forkHistoryRootLeaf'), error => error === gateFailure);
    assert.equal(events[0].capability.preparedRequestId, request.preparedRequestId);
    assert.equal(f.plane.stats().roots, 1); assert.equal(f.plane.state(parent, owner).released, false);
    substitute = parent;
    await assert.rejects(bridge.run({ sender }, { ...request, preparedRequestId: randomUUID() }, 'forkHistoryRootLeaf'), error => error === gateFailure);
    assert.equal(events.at(-1).refused, 'HISTORY_PRIMARY_PREPARED_RELEASE_BINDING');
    assert.equal(f.plane.state(parent, owner).released, false, 'substituted shared parent cannot be revoked');
    // The malformed identity is UNKNOWN; only the test holding the actual
    // local fixture receipt can release it. The bridge never invents one.
    f.plane.release(actualChild, { consumerKey: owner });
  });
}

test('malformed prepared reply cannot select a pre-existing InputDocument for cleanup in either actual bridge', async () => {
  const { EventEmitter } = require('node:events');
  const { HistoryRootController } = require('../src/main/history-root-engine/main/history-root-controller.js');
  const repairRepository = path.resolve(__dirname, '..');
const cases=[];
for(const relative of ['src/main/history-root-ipc.js','src/main/history-root-engine/main/history-root-ipc.js']){
 const {createHistoryRootIpcBridge}=require(path.join(repairRepository,relative));
 const f=await createPrimaryAddressFixture(null,{entries:[{role:'user',uuid:'private-held-input-text',sessionId:'s',content:'finite body'}]});
 const controller=new HistoryRootController({store:f.store,cache:{maxBytes:28*1024**2,stats:()=>({diskBytes:0})},service:{},api:{projectCodexFullHistoryFromFile:async()=>{throw Error('NO_SOURCE_CALL_ALLOWED')}}});
 controller.plane=f.plane;controller.initializedBacking=true;
 const sender=new EventEmitter();sender.isDestroyed=()=>false;
 const gateError=Object.assign(Error('finite final consumer cancellation'),{code:'HISTORY_READ_CANCELLED'});
 let owner,child,heldInput,bad=false,bridge;
 const events=[];
 try{
  bridge=createHistoryRootIpcBridge({
   reader:{
    async call(method,payload){
     owner=payload._historyRootConsumerKey;
     if(method==='openHistoryRoot')return f.plane.open(payload,{consumerKey:owner,control});
     assert.equal(method,'forkHistoryRootLeaf');
     child=await f.plane.forkPreparedPresentation(payload,{consumerKey:owner,control});
     // One malformed extra field is sufficient. No identity forgery or peer
     // access is needed: it repeats this consumer's existing genuine receipt.
     return {...child,inputDocument:heldInput};
    },
    postWorkerEvent(event){
     events.push(event.event==='release-root-result'?{event:event.event,capabilityKind:event.capability.kind,hasPreparedRequestId:Object.hasOwn(event.capability,'preparedRequestId')}: {event:event.event});
     if(event.event==='release-root-result')controller.releaseResult(event.consumerKey,event.capability);
     if(event.event==='release-root-consumer')controller.releaseConsumer(event.consumerKey);
    }
   },
   demands:{async run(event,payload,read){const result=await read(payload);if(bad)throw gateError;return result;}}
  });
  const parent=await bridge.run({sender},f.payload,'openHistoryRoot');
  const state=f.plane.state(parent,owner),text=state.primaryPresentation.sourceMetadataCursor.at(0).field('uuid');
  const descriptor=f.plane.describe(state,text,{inline:false});
  const inputResult=await controller.input({operation:'prepare',source:descriptor},{consumerKey:owner,control});
  heldInput=inputResult.inputDocument;
  const actualInput=controller.documents.get(heldInput.documentId).document;
  assert.equal(actualInput.closed,false);assert.equal(controller.documents.size,1);
  const request={...Object.fromEntries(['leaseId','ownerKey','revision','generation','metadataIdentity','metadataSchema','semanticIdentity','semanticRevisionToken','viewRevisionToken','canonicalEntryCount','sourceEntryCount'].map(key=>[key,parent[key]])),
   ...parent.preparedPresentation,parentNodeToken:parent.root.nodeToken,nodeToken:parent.sourceMetadata.nodeToken,
   encoding:'history-primary-prepared-presentation-v1',preparedRequestId:randomUUID()};
  bad=true;
  await assert.rejects(bridge.run({sender},request,'forkHistoryRootLeaf'),error=>error===gateError);
  const observed={bridge:relative,primaryErrorPreserved:true,cleanup:events.find(event=>event.event==='release-root-result'),
   unrelatedInputClosed:actualInput.closed,inputStillRegistered:controller.documents.has(heldInput.documentId),
   truePreparedChildStillLive:f.plane.roots.has(child.leaseId),parentStillLive:f.plane.roots.has(parent.leaseId)};
  assert.equal(observed.cleanup.capabilityKind,'root');
  assert.equal(observed.cleanup.hasPreparedRequestId,true);
  assert.equal(observed.unrelatedInputClosed,false);
  assert.equal(observed.inputStillRegistered,true);
  assert.equal(observed.truePreparedChildStillLive,false);
  assert.equal(observed.parentStillLive,true);
  cases.push(observed);
  // Exact new prepared child was released by the bridge; no repeated cleanup.
 }finally{
  bridge?.close();controller.close();f.close();
 }
}
  assert.equal(cases.length, 2);
});
