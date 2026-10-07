import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabMessageSourceNavigation } from './tabMessageSourceNavigation.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const source = { messageId: 'm', sourceTabId: 'source', sourceProjectId: 'old' };
const location = { messageId: 'm', tabId: 'source', entryUuid: 'row', toolUseId: 'call', readSessionId: 'sid' };
function fixture() {
  const open = deferred(), locate = deferred(), wait = deferred(), calls = [];
  let placement = 'window-1', listener, id = 0;
  const navigation = createTabMessageSourceNavigation({
    open: s => {calls.push(['open',s]);return open.promise;},
    locate: id => {calls.push(['locate',id]);return locate.promise;},
    placement: () => placement,
    subscribePlacement: fn => {listener=fn;return () => {listener=null;};},
    requestId: () => 'jump-' + ++id,
    reveal: id => calls.push(['reveal',id]),
    scroll: (l,r) => {calls.push(['scroll',l,r]);return id;},
    cancelScroll: g => calls.push(['cancel',g]),
    waitForScroll: r => ({promise:wait.promise,cancel:() => wait.resolve({found:false,reason:'cancelled'})}),
  });
  return {navigation,open,locate,wait,calls,move() {placement='window-2';listener?.();},listener:() => listener};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('opens first, awaits true, then exact location and explicit scroll completion', async () => {
  const f = fixture(), result = f.navigation.jump(source);
  assert.deepEqual(f.calls.map(x => x[0]), ['open']);
  f.open.resolve(true); await tick();
  assert.deepEqual(f.calls.map(x => x[0]), ['open','locate']);
  f.locate.resolve({success:true,location}); await tick();
  assert.deepEqual(f.calls.map(x => x[0]), ['open','locate','reveal','scroll']);
  f.wait.resolve({found:true}); assert.equal(await result, true);
  assert.equal(f.listener(),null); assert.equal(f.calls.some(x => x[0]==='cancel'),false);
});
test('false navigation does not start IO or seek', async () => {
  const f=fixture(), result=f.navigation.jump(source);f.open.resolve(false);
  await assert.rejects(result,/source_tab_unavailable/);assert.equal(f.calls.length,1);
});
test('leaving the selected window during IO cancels instead of stealing focus back', async () => {
  const f=fixture(), result=f.navigation.jump(source);f.open.resolve(true);await tick();
  f.move();f.locate.resolve({success:true,location});assert.equal(await result,false);
  assert.equal(f.calls.some(x => x[0]==='scroll'),false);
});
test('name click cancellation while scrolling resolves and cancels only its generation', async () => {
  const f=fixture(), result=f.navigation.jump(source);f.open.resolve(true);await tick();
  f.locate.resolve({success:true,location});await tick();f.navigation.cancel();
  assert.equal(await result,false);assert.deepEqual(f.calls.at(-1),['cancel',1]);
});
test('superseding an IO request also ignores its late error', async () => {
  const f=fixture(), old=f.navigation.jump(source);f.open.resolve(true);await tick();
  f.navigation.cancel();f.locate.reject(Error('late IO'));assert.equal(await old,false);
});
test('foreign location fails without a reveal or scroll', async () => {
  const f=fixture(), result=f.navigation.jump(source);f.open.resolve(true);await tick();
  f.locate.resolve({success:true,location:{...location,tabId:'foreign'}});
  await assert.rejects(result,/identity_changed/);assert.equal(f.calls.length,2);
});
test('failed or timed out scroll never counts as a successful jump', async () => {
  const f=fixture(), result=f.navigation.jump(source);f.open.resolve(true);await tick();
  f.locate.resolve({success:true,location});await tick();f.wait.resolve({found:false,reason:'target-missing'});
  await assert.rejects(result,/target-missing/);assert.deepEqual(f.calls.at(-1),['cancel',1]);
});
