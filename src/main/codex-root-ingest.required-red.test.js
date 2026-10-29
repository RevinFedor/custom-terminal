'use strict';

// Positive required bounds, NOT expect-failure tests. These deliberately
// remain RED while the concrete legacy semantic operations below materialize
// their complete field. A green simple-leaf matrix cannot close this gate.
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {fixture,user,call,legacyRows,hashRoot}=require('./test-helpers/codex-root-fixture.cjs');
const {MARKER,writer,expected,pieces,observeInterval,assertBounded}=require('./test-helpers/codex-ingest-fixture.cjs');
const time='2026-10-22T00:00:00Z',chars=262144;

function templateFingerprint(value,chars,pattern) {
  const h=crypto.createHash('sha1'),at=value.indexOf(MARKER);assert.ok(at>=0);
  h.update(value.slice(0,at));for(const part of pieces(chars,pattern))h.update(part);h.update(value.slice(at+MARKER.length));
  return h.digest('hex').slice(0,16);
}
for(const kind of ['exec-source','provider-image-markup','native-question-title','tool-name']) {
  test(`REQUIRED whole rooted producer ${kind}/256Ki: full content AND zero whole-field materialization`,async t=>{
    const f=fixture(t,{indexBytes:0}),write=writer(f.filePath,f.line),records=[];
    let options={pattern:'x'},oracleChars=chars;
    if(kind!=='provider-image-markup')records.push(write.record(user('required owner')));
    if(kind==='exec-source')records.push(write.record({type:'response_item',timestamp:time,
      payload:{type:'custom_tool_call',name:'exec',call_id:'exec',input:'/*'+MARKER+'*/; text("done");'}},chars,options));
    if(kind==='provider-image-markup')records.push(write.record({type:'event_msg',timestamp:time,payload:{
      type:'user_message',message:'<image name="[Image #1]" path="/tmp/finite.png">[Image #1]</image>\n'+MARKER,
      local_images:['/tmp/finite.png']}},chars,options));
    if(kind==='native-question-title')records.push(write.record(call('question','request_user_input_async',
      {questions:[{title:MARKER}]}),chars,{...options,layers:2}));
    if(kind==='tool-name'){
      const marker='memorysevenfield';options={pattern:'a'};
      const record={type:'response_item',timestamp:time,payload:{type:'custom_tool_call',name:marker,call_id:'name',input:{}}};
      records.push(write.record(record,chars,{...options,marker}));oracleChars=chars-1;
    }
    const rows=legacyRows(f.sessionId,records);
    if(kind==='provider-image-markup')rows[0].promptPresentationTransportHash=templateFingerprint(rows[0].content,chars,'x');
    if(kind==='tool-name')rows[1].actions[0].rawTool.toolName='A'+MARKER;
    const oracle=expected(rows,oracleChars,options);
    const interval=await observeInterval(0,async hooks=>{
      const read=await f.read(hooks);try{
        assert.deepEqual(await hashRoot(read),oracle,'full content must pass before checking the memory bound');
        return {readMetrics:read.readMetrics,rootStats:read.rootStats};
      }finally{read.release();}
    });
    t.diagnostic(JSON.stringify({kind,chars,fullContent:'PASS',oracle,...interval}));
    assertBounded(interval);
  });
}
