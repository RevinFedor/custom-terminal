import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowCreationVisibility} from './workflowCreationVisibility.mjs';

function fixture(limit=32) {
  const events=[];let clock=100;
  const probe=createWorkflowCreationVisibility({limit,now:()=>clock++,log:line=>events.push(JSON.parse(line.slice(line.indexOf('{'))))});
  const sample={state:{activeSpaceId:'other',tabWorkflowMembership:{child:{workflowId:'source'}}},
    model:{catalog:new Map(),reserve:[],placed:new Set()},outlineIds:new Set(),rowIds:new Set(),element:null};
  probe.allocated({tabId:'child',workflowId:'source',namespace:'execution',sourceTabId:'parent',background:true,revision:5});
  return {probe,events,sample,observe:()=>probe.observe(sample)};
}
test('one creation trace distinguishes persistence, renderer hydration, workflow and committed DOM',()=>{
  const f=fixture();f.observe();assert.equal(f.events.at(-1).stage,'renderer-tab-missing');
  f.sample.model.catalog.set('child',{active:true});f.observe();assert.equal(f.events.at(-1).stage,'other-workflow');
  f.sample.state.activeSpaceId='source';f.observe();assert.equal(f.events.at(-1).stage,'reserve-filtered');
  f.sample.model.reserve=[{tabId:'child'}];f.observe();assert.equal(f.events.at(-1).stage,'outline-missing');
  f.sample.outlineIds.add('child');f.observe();assert.equal(f.events.at(-1).stage,'row-hidden-or-pending');
  f.sample.rowIds.add('child');f.observe();assert.equal(f.events.at(-1).stage,'row-ready');
  f.sample.element={querySelectorAll:()=>[{getAttribute:()=> 'child'}]};f.observe();
  assert.equal(f.events.at(-1).stage,'dom-mounted');assert.equal(f.probe.hasPending(),false);
  const count=f.events.length;f.observe();assert.equal(f.events.length,count);
  assert.equal(f.events[0].tabId,'child');assert.equal(f.events.at(-1).workflowId,'source');
});
test('placement and inherited inactive filtering are distinct; stable updates produce no repeated records',()=>{
  const f=fixture();f.sample.model.catalog.set('child',{active:false});f.observe();
  assert.equal(f.events.at(-1).stage,'presentation-inactive');
  const count=f.events.length;for(let i=0;i<100;i++)f.observe();assert.equal(f.events.length,count);
  f.sample.model.catalog.get('child').active=true;f.sample.model.placed.add('child');f.observe();
  assert.equal(f.events.at(-1).stage,'placed');assert.equal(f.probe.hasPending(),false);
});
test('lost membership and diagnostic capacity remain explicit, without retaining names or content',()=>{
  const f=fixture(2);delete f.sample.state.tabWorkflowMembership.child;f.observe();
  assert.equal(f.events.at(-1).stage,'membership-missing');
  for(const tabId of ['second','third'])f.probe.allocated({tabId,workflowId:'source',namespace:'execution',name:'private',content:'private'});
  assert.ok(f.events.some(e=>e.tabId==='child'&&e.stage==='evicted'&&e.reason==='trace-capacity'));
  assert.equal(JSON.stringify(f.events).includes('private'),false);
  const before=structuredClone(f.sample);f.observe();assert.deepEqual(f.sample,before);
});
