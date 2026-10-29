'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,user,answer,call,output,legacyRows,smallRows}=require('./test-helpers/codex-root-fixture.cjs');
const text=require('./history-paged-text');
const {HistoryProjectionArena}=require('./history-projection-arena');
const machine=require('./codex-root-machine-text');
const stamp='2026-10-22T00:00:00Z',long='Память 😀 \\ " '.repeat(80);
const responseUser=value=>({type:'response_item',timestamp:stamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:value}]}});
const scenarios=[
  ['CRLF aliases', [responseUser('a\r\n'+long),user('a\n\n'+long),answer('paired')]],
  ['boundary aliases', [responseUser('  '+long+' '),user(long.trim()),answer('paired')]],
  ['environment and goal envelopes', [user('<environment_context>'+long+'</environment_context>'),
    user('<codex_internal_context '+ ' '.repeat(200)+'source="goal\'> '+long+'</codex_internal_context>'),answer('goal answer')]],
  ['project instructions + interrupted carriers', [user('# CLAUDE.md instructions for /tmp\n<INSTRUCTIONS>'+long+'</INSTRUCTIONS>'),
    user('ordinary'),user('<TURN_ABORTED> '+long),{type:'event_msg',timestamp:stamp,payload:{type:'turn_aborted'}}]],
  ['native provider image placeholders', [{type:'event_msg',timestamp:stamp,payload:{type:'user_message',local_images:['/tmp/p.png'],
    message:'<image name="[Image #1]" path="/tmp/p.png">[Image #1]</image>'+long+'[Image #1]'}}]],
  ['large shell classification keeps complete command', [user('shell'),call('c','exec_command',{cmd:'echo '+long}),output('c','done')]],
  ['nested output JSON retains all text', [user('output'),call('c'),output('c',JSON.stringify({content:[{type:'text',text:long},{type:'text',text:'second'}]}))]],
  ['data image regex boundaries', [user('image output'),call('c'),output('c',long+' data:image/png;base64,'+'A'.repeat(1024)+' ! data:image/x;BASE64,AA end')]],
  ['unparsed long arguments remain raw', [user('bad args'),call('c','read_file','{invalid:'+long),output('c','result')]],
  ['nested reasoning content arrays', [user('reasoning'),{type:'response_item',timestamp:stamp,payload:{type:'reasoning',summary:[{content:[long,['x','y']]}]}},answer('done')]],
  ['long compact replacement history', [user('before'),{type:'compacted',timestamp:stamp,payload:{replacement_history:[{type:'message',role:'assistant',content:[{text:long}]}]}},answer('after')]],
  ['exec source with indexed/rejected emissions', [user('exec'),{type:'response_item',timestamp:stamp,payload:{type:'custom_tool_call',name:'exec',call_id:'e',
    input:'/*'+long+'*/\nconst a=tools.exec_command({cmd:"A"}); const b=tools.exec_command({cmd:"B"}); await Promise.allSettled([a,b]).then(text);'}},
    output('e',JSON.stringify([{status:'fulfilled',value:'first'},{status:'rejected',reason:'second'}]))]],
];
for(const [name,source] of scenarios)test('actual text semantics: '+name,async t=>{
  const f=fixture(t),records=source.map(f.append),expected=legacyRows(f.sessionId,records);
  const first=await f.read();try{
    assert.deepEqual(await smallRows(first),JSON.parse(JSON.stringify(expected)));
    const warm=await f.read();try{assert.deepEqual(await smallRows(warm),JSON.parse(JSON.stringify(expected)));assert.equal(warm.fedRecords,0);}finally{warm.release();}
  }finally{first.release();}
});

test('paged text operations preserve array cycles/holes/UTF16 coercion and exact machine grammar',t=>{
  const f=fixture(t),arena=new HistoryProjectionArena(f.store);
  try{arena.step(()=>{
    const value=[['a','b'],null,undefined,,[long]];value.push(value);
    const owned=arena.own(value),joined=owned.join('|');
    assert.equal(text.materialize(joined,'finite semantic oracle'),value.join('|'));
    const inner=[];inner.join=0;const nested=arena.own([inner]);
    assert.equal(text.materialize(nested.join(','),'finite semantic oracle'),String([inner]));
    const unicode=arena.own(long+'\ud83d\ude00\ud800');
    assert.deepEqual(Array.from(unicode),Array.from(long+'\ud83d\ude00\ud800'));
    for(const body of ['Script completed\n'+long+'\nOutput:\n','Script running with cell ID 123\n'+long+'\nOutput:',
      'Script completedword\n'+long+'\nOutput:',long+'\n Script running with cell ID 123\nOutput:\n',
      '  \nScript running with cell ID\n000123 \r\n'+long,'quote Script running with cell ID 123\n'+long,
      'Script running with cell ID 123abc\n'+long]){
      const leaf=arena.own(body);
      assert.equal(machine.outputHeader(leaf,'completed'),/^Script completed\b[\s\S]*\nOutput:\n?$/.test(body));
      assert.equal(machine.outputHeader(leaf,'running'),/^Script running\b[\s\S]*\nOutput:\n?$/.test(body));
      assert.equal(machine.outputHeader(leaf,'settled'),/^Script running with cell ID\s+\d+\b[\s\S]*\nOutput:\n?$/.test(body));
      const actual=machine.cellId(leaf),expected=/^\s*Script running with cell ID\s+(\d+)\s*$/m.exec(body)?.[1]||null;
      assert.equal(actual===null?null:text.materialize(actual,'finite semantic oracle'),expected);
    }
  });}finally{arena.close();}
});
