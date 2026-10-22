'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fork}=require('node:child_process');
const {createCausalJournal}=require('./perf-causal-journal');
const {createArtifactStore}=require('./perf-flight-recorder');
for(const mode of ['send','drop'])test('finite actual IPC + abrupt inside-callback exit: '+mode,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noted-sql-abrupt-')),identity=fs.lstatSync(dir);
  t.after(()=>{const current=fs.lstatSync(dir);assert.ok(current.isDirectory()&&!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino,'owned fixture replaced');fs.rmSync(dir,{recursive:true});});
  const store=createArtifactStore(dir),journal=createCausalJournal({artifacts:store});let messages=0,stderr='';
  const child=fork(path.join(__dirname,'perf-sql-abrupt-producer.fixture.cjs'),[mode],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.on('data',b=>{stderr+=b.toString();});
  await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.on('message',m=>{if(m.t==='causal'){messages++;journal.record(m.record,{pid:child.pid,kind:'main'});}});
    child.once('close',(code,signal)=>{try{assert.equal(code,0,stderr);assert.equal(signal,null);journal.flush(true);resolve();}catch(error){reject(error);}});
  });
  const names=store.entries().filter(entry=>entry.name.startsWith('causal-'));
  if(mode==='send'){
    // This observed delivery survives without finally; IPC is still best effort.
    assert.equal(messages,1);assert.equal(names.length,1);
    const saved=JSON.parse(fs.readFileSync(store.file(names[0].name),'utf8').trim());
    assert.equal(saved.sqlWitness.active.siteId,'private.abort-inside');
    assert.equal(saved.sqlWitness.totals.attempted,1);assert.equal(saved.sqlWitness.totals.completed,0);
    assert.equal(journal.snapshot().sqlWitnesses[0].currentState,'UNKNOWN');
    assert.equal(journal.snapshot().sqlWitnesses[0].persistence,'append-confirmed');
  }else{
    assert.equal(messages,0);assert.equal(names.length,0);
    assert.deepEqual(journal.snapshot().sqlWitnesses,[],'no evidence cannot become completion or culprit proof');
  }
});
