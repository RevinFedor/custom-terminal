'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const SQLite=require('better-sqlite3');
const DatabaseManager=require('./database');
const origin=Date.parse('2026-09-29T11:15:00.000Z');
function fixture(t){
  const db=new SQLite(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE tab_history(id INTEGER PRIMARY KEY,project_id TEXT,tab_id TEXT,tab_type TEXT,closed_at TEXT,restore_placement TEXT)');
  const add=(id,{project='p',space='main',window='w',order=origin+id,closedAt=origin+id,raw}={})=>db.prepare('INSERT INTO tab_history VALUES(?,?,?,?,?,?)').run(
    id,project,'tab-'+id,'terminal',new Date(closedAt).toISOString(),raw??JSON.stringify({version:1,closedOrder:order,window:{kind:'pane',spaceId:space,windowId:window}}));
  const read=(patch={})=>DatabaseManager.prototype.getLatestWindowTabHistory.call({db},{spaceId:'main',windowId:'w',projectIds:['p','q'],...patch});
  return{db,add,read};
}
test('actual SQLite picker is window/workflow/project scoped and does not consume archive rows',t=>{
  const f=fixture(t);f.add(1);f.add(2,{project:'q'});f.add(3,{window:'other'});f.add(4,{space:'other'});f.add(5,{project:'closed-project'});
  assert.equal(f.read().id,2);assert.equal(f.read().id,2);assert.equal(f.read({projectIds:['p']}).id,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tab_history').get().n,5);
  assert.equal(f.read({windowId:'missing'}),null);assert.equal(f.read({projectIds:[]}),null);
});
test('explicit action order wins over asynchronous archive completion order',t=>{
  const f=fixture(t);f.add(1,{order:origin+20,closedAt:origin+100});f.add(2,{order:origin+10,closedAt:origin+200});
  assert.equal(f.read().id,1);
  assert.equal(f.read({beforeOrder:origin+15}).id,2);
  assert.equal(f.read({beforeOrder:origin+5}),null);
});
test('legacy timestamps remain usable, invalid placement is ignored, invalid order cannot win as SQL text',t=>{
  const f=fixture(t);f.add(1,{order:undefined,raw:JSON.stringify({window:{kind:'pane',spaceId:'main',windowId:'w'}}),closedAt:origin+50});
  f.add(2,{raw:'invalid JSON'});f.add(3,{order:'corrupt',closedAt:origin+40});
  assert.equal(f.read().id,1);assert.equal(f.read().closedOrder,origin+50);
});
test('project fallback keeps legacy archives but still excludes closes after the keypress',t=>{
  const f=fixture(t);f.add(1,{raw:'invalid JSON'});f.add(2,{raw:'null'});f.add(3,{window:'other'});
  assert.equal(f.read({projectOnly:true}).id,3);
  assert.equal(f.read({projectOnly:true,beforeOrder:origin+2}).id,2);
  assert.equal(f.read({projectOnly:true,beforeOrder:origin+1}).id,1);
});
