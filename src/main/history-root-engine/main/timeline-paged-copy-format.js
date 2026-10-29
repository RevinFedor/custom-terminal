'use strict';

// Storage port of codex-data::formatCodexToolForExport and copy-action-format.
// No packet DTO or implicit PagedText coercion. The native export specification
// (including its existing output limits) remains the differential oracle.
const text=require('./history-paged-text');
const ops=require('./history-root-operations');
const rx=require('./history-paged-pattern');
const shell=require('./codex-root-shell');
const grammar=require('../shared/history-action-grammar.cjs');
const {actionDetailsEnabled}=require('./copy-action-format');
const truth=v=>text.isText(v)?v.length>0:!!v;
const str=v=>text.coerce(truth(v)?v:'');
const eq=(a,b)=>text.isText(a)&&text.isText(b)?text.equal(a,b):a===b;
const any=(v,values)=>values.some(x=>eq(v,x));
const icons={read:'📄',search:'🔍',edit:'✏️',run:'🖥',git:'🌿',mcp:'🔌',web:'🌐',plan:'📋',agent:'🧵',other:'⚙️'};

function createPagedCopyFormatter(arena,api,check=()=>{}){
 const cat=(parts,sep='')=>text.concat(parts,sep,arena);
 const build=parts=>text.build(arena,(function*(){for(const part of parts){check();yield part;}})());
 const json=(v,space=0)=>ops.stringifyPaged(v,arena,space);
 const cleanArgs=args=>{
  if(!args||typeof args!=='object'||Array.isArray(args)||text.isText(args))return args||{};
  const copy=arena.make('object');
  for(const key of ops.keys(args))if(!eq(key,'caller'))arena.set(arena.owner(copy),key,ops.get(args,key));
  return copy;
 };
 const base=v=>{let from=0;for(let at=v.indexOf('/');at>=0;at=v.indexOf('/',at+1))from=at+1;return v.slice(from);};
 const unquote=v=>v.length>=2&&any(v.charAt(0),['"',"'"])&&eq(v.charAt(0),v.at(-1))?v.slice(1,-1):v;
 function replace(v,pattern,fn){
  return build((function*(){let at=0;for(const m of rx.matches(pattern,v)){yield*text.chunks(v.slice(at,m.index));yield*text.chunks(fn(m));at=m.end;}yield*text.chunks(v.slice(at));})());
 }
 function displayPath(v){
  v=replace(str(v).trim(),/^['"]|['"]$/g,()=> '');
  v=text.replaceLiteral(v,'\\','/');
  v=replace(v,/\/{2,}/g,()=>'/');
  if(!truth(v))return '';
  let last='';
  for(const part of text.splitLiteral(v,'/'))if(truth(part))last=part;
  let offset=0,docsOffset=-1;
  for(const part of text.splitLiteral(v,'/')){
   if(truth(part)&&docsOffset<0&&eq(part.toLowerCase(),'docs'))docsOffset=offset;
   offset+=part.length+1;
  }
  if(docsOffset>=0){let end=v.length;while(end>docsOffset&&v.charAt(end-1)==='/')end--;return v.slice(docsOffset,end);}
  return truth(last)?last:v;
 }
 const pathLike=v=>truth(v)&&!v.startsWith('-')&&(v.includes('/')||rx.test(/\.[A-Za-z0-9]{1,6}$/,v));
 function mcpName(name){
  if(!name.startsWith('mcp__'))return null;
  const rest=name.slice(5),at=rest.indexOf('__');
  if(at<=0)return{server:truth(rest)?rest:'mcp',method:''};
  const server=rest.slice(0,at);let method=rest.slice(at+2),prefix=cat([server.toLowerCase(),'_']);
  if(method.toLowerCase().startsWith(prefix))method=method.slice(prefix.length);
  return{server,method};
 }
 function classify(action,name){
  if(truth(action.mcpServer))return{family:'mcp',mcpServer:str(action.mcpServer),mcpMethod:str(action.mcpMethod)};
  const mcp=mcpName(name);if(mcp)return{family:'mcp',mcpServer:mcp.server,mcpMethod:mcp.method};
  if(eq(name,'Bash')&&text.isPagedText(action.args?.command))return shell.classifyRootShell(action.args.command);
  // Protocol vocabulary is finite; arbitrary tool names remain text leaves.
  if(text.isPagedText(name))return{family:'other'};
  return grammar.classifyHistoryAction({toolName:name,args:action.args});
 }
 function shellSubject(command,family,word){
  if(!truth(command.trim()))return{subject:'',detail:''};
  const assignments=arena.make('map');let stage=null,first=null;
  for(const candidate of shell.stages(command)){
   first??=candidate;let lead='';
   for(const token of shell.tokens(candidate)){
    const m=rx.exec(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/,token);
    if(m){if(stage===null)assignments.set(m[1],unquote(m[2]));continue;}
    lead=base(unquote(token)).toLowerCase();break;
   }
   if(stage===null&&truth(word)&&eq(lead,word))stage=candidate;
  }
  stage??=first||command;
  const substitute=(v,depth=0)=>replace(v,/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,m=>{
   if(depth<3&&assignments.has(m[1]))return substitute(assignments.get(m[1]),depth+1);
   return eq(m[1],'HOME')?'~':m[0];
  });
  const tokens=arena.make('array');
  for(const token of shell.tokens(stage))tokens.push(substitute(unquote(token)));
  let detail='';
  if(family==='read'){
   for(const token of tokens){const m=rx.exec(/^'?(\d+)\s*,\s*(\d+)\s*p'?$/,token);if(m){detail=cat([m[1],'–',m[2]]);break;}}
   if(!truth(detail)&&any(word,['head','tail']))for(let i=0;i<tokens.length;i++){
    const token=tokens[i],m=rx.exec(/^-n?(\d+)$/,token);
    if(m){detail=cat([eq(word,'head')?'first ':'last ',m[1]]);break;}
    if(eq(token,'-n')&&truth(tokens[i+1])&&rx.test(/^\d+$/,tokens[i+1])){detail=cat([eq(word,'head')?'first ':'last ',tokens[i+1]]);break;}
   }
  }
  if(family==='git'){for(let i=2;i<tokens.length;i++)if(pathLike(tokens[i])&&!eq(tokens[i],'--'))return{subject:tokens[i],detail:''};return{subject:'',detail:''};}
  if(family==='search'){
   const positional=arena.make('array');let flagPattern='',end=false;
   const short='ABCmefgdtT';
   const longs=['after-context','before-context','context','max-count','regexp','file','glob','iglob','type','type-not','type-add','max-depth','maxdepth','threads','include','exclude','exclude-dir','color','colour','replace','sort','sortr','pre','path-separator','max-filesize','ignore-file'];
   for(let i=1;i<tokens.length;i++){
    const token=tokens[i];
    if(end||!token.startsWith('-')||eq(token,'-')){positional.push(token);continue;}
    if(eq(token,'--')){end=true;continue;}
    if(token.startsWith('--')){
     const at=token.indexOf('='),name=(at>=0?token.slice(2,at):token.slice(2)).toLowerCase();
     if(!any(name,longs))continue;
     const value=at>=0?token.slice(at+1):i+1<tokens.length?tokens[++i]:'';
     if(any(name,['regexp','file'])&&!truth(flagPattern)&&truth(value))flagPattern=value;
     continue;
    }
    let consumes='';
    for(let k=1;k<token.length;k++){
     const letter=token.charAt(k);if(!short.includes(letter))continue;
     consumes=letter;const glued=token.slice(k+1);
     if(truth(glued)){if(any(letter,['e','f'])&&!truth(flagPattern))flagPattern=glued;consumes='';}break;
    }
    if(!consumes)continue;
    const value=i+1<tokens.length?tokens[++i]:'';
    if(any(consumes,['e','f'])&&!truth(flagPattern)&&truth(value))flagPattern=value;
   }
   const pattern=truth(flagPattern)?flagPattern:positional[0]||'';let scope='',path='';
   for(let i=0;i<positional.length;i++)if(pathLike(positional[i])){if(!truth(path))path=positional[i];if(!truth(scope)&&(truth(flagPattern)||i>0))scope=positional[i];}
   return any(word,['ls','find','tree','fd'])?{subject:truth(path)?path:pattern,detail:''}:{subject:pattern,detail:scope};
  }
  let path='';for(let i=1;i<tokens.length;i++)if(pathLike(tokens[i]))path=tokens[i];
  if(family==='read'&&truth(path)&&rx.test(/[|;{}()+]/,path))path='';
  return{subject:path,detail};
 }
 function shortRun(command,word){
  if(!truth(command.trim()))return '';
  let tokens=null,start=0;
  for(const stage of shell.stages(command)){
   if(stage.trim().startsWith('#'))continue;
   const candidate=arena.make('array');
   for(const token of shell.tokens(stage)){
    const v=replace(token,/^\(+/,()=> '');if(truth(v))candidate.push(v);
   }
   let lead=0;while(lead<candidate.length&&(rx.test(/^[A-Za-z_][A-Za-z0-9_]*=/,candidate[lead])||eq(candidate[lead],'cd')))lead++;
   if(lead<candidate.length){tokens=candidate;start=lead;break;}
  }
  const program=tokens&&truth(tokens[start])?base(unquote(tokens[start])):word||'';
  if(!truth(program))return '';
  const parts=arena.make('array');parts.push(program);
  // Deliberately identical native loop bound (it grows with parts.length).
  if(tokens)for(let i=start+1;i<parts.length+start+2&&i<tokens.length;i++){
   const token=unquote(tokens[i]);if(!rx.test(/^[a-z][a-z0-9-]*$/,token))break;parts.push(token);
  }
  return cat(parts,' ');
 }
 function label(action,family,name,classified){
  const args=action.args||{};
  if(family==='agent'){const subject=str(action.description||args.description||args.task_name).trim();return cat(['🧵 Agent',truth(subject)?cat([' ',subject]):'']);}
  let verb=name||'Tool',subject='',detail='';
  if(classified.family==='mcp'||eq(name,'MCP')||name.startsWith('mcp__')){
   const m=truth(action.mcpServer)?{server:action.mcpServer,method:action.mcpMethod||''}:mcpName(name)||{server:'mcp',method:''};
   verb=m.server||'MCP';subject=m.method;
  }else if(eq(name,'Read')){
   verb='Read';subject=displayPath(args.file_path||args.path);
   if(typeof args.offset==='number'&&args.offset>0)detail=typeof args.limit==='number'&&args.limit>0?args.offset+'–'+(args.offset+args.limit):'from '+args.offset;
  }else if(eq(name,'Patch')){verb='Patch';subject=str(args.summary||'not applied');}
  else if(eq(name,'Script')){verb='Run';subject='script';}
  else if(any(name,['Edit','Write','MultiEdit','Update'])||classified.family==='edit'&&!eq(name,'Bash')){verb='Edit';subject=displayPath(args.file_path||args.path);}
  else if(eq(name,'Grep')){verb='Search';subject='grep';detail=displayPath(args.path||args.glob);}
  else if(eq(name,'Glob')){verb='Search';subject='glob';detail=displayPath(args.path);}
  else if(any(name,['WebSearch','WebFetch'])){verb='Web';subject=str(args.query||args.url);}
  else if(eq(name,'Bash')){
   const command=text.isText(args.command)?args.command:'';
   if(!text.isPagedText(command)){
    const h=grammar.historyActionHeadline({toolName:'Bash',args,family:classified.family,bashWord:classified.bashWord,bashDetail:classified.bashDetail});
    ({verb,subject,detail}=h);
   }else{
    const word=classified.bashWord||shell.effectiveWord(command),edit=shell.editInfo(command,word,arena);
    const fam=classified.family||(edit.isEdit?'edit':grammar.bashFamily(word));
    if(fam==='edit'){verb='Edit';subject=displayPath(edit.target);}
    else{
     const h=shellSubject(command,fam,word);
     if(fam==='git'){verb='Git';const sub=classified.bashDetail||shell.classifyRootShell(command).bashDetail||'';subject=cat([sub,truth(h.subject)?base(h.subject):''].filter(truth),' · ');}
     else if(fam==='read'){verb='Read';subject=displayPath(h.subject);detail=h.detail;}
     else if(fam==='search'){verb='Search';subject=truth(word)?word:'search';detail=displayPath(h.detail);}
     else if(fam==='web'){verb='Web';subject=truth(word)?word:'request';}
     else{verb='Bash';subject=shortRun(command,word);}
    }
   }
  }
  if(family==='plan'){verb=({question:'Question',wait:'Wait',toolsearch:'Tools'})[classified.family]||'Plan';subject=truth(subject)?subject:str(args.summary||args.explanation);}
  const tail=cat([subject,detail].filter(truth),' · ');
  return cat([icons[family]||icons.other,' ',verb,truth(tail)?cat([' ',tail]):'']);
 }
 function resultText(value){
  if(value==null)return '';
  const content=value&&typeof value==='object'&&!text.isText(value)&&'content' in value?value.content:value;
  if(text.isText(content))return text.stripDataImages(content);
  if(Array.isArray(content)){
   return text.stripDataImages(build((function*(){let first=true;for(const block of content){
    check();if(!truth(block))continue;let part;
    if(text.isText(block))part=block;
    else if(eq(block.type,'text')&&text.isText(block.text))part=block.text;
    else if(eq(block.type,'image')&&block.source){
     const kb=Math.round(str(block.source.data).length/1024);
     part=cat(['[image: ',block.source.media_type||'image/?',kb?', ~'+kb+'KB':'',' base64 omitted]']);
    }else part=json(block);
    if(part===undefined)continue;if(!first)yield '\n';first=false;yield*text.chunks(part);
   }})()));
  }
  return text.stripDataImages(json(content,2));
 }
 function fence(value,language=''){
  value=str(value).trimEnd();return truth(value)?cat(['\n```',language,'\n',value,'\n```']):'';
 }
 function diff(action){
  const args=action.args||{};
  if(Array.isArray(action.diffHunks)&&action.diffHunks.length)return build((function*(){
   let firstH=true;for(const hunk of action.diffHunks){
    if(!firstH)yield '\n';firstH=false;let first=true;
    for(const row of hunk.entries||[]){if(!first)yield '\n';first=false;yield eq(row.tag,'add')?'+':eq(row.tag,'del')?'-':' ';yield*text.chunks(str(row.line));}
   }
  })());
  if(args.old_string!=null||args.new_string!=null)return cat([
   text.replaceLiteral(cat(['-',str(args.old_string)]),'\n','\n-'),'\n',
   text.replaceLiteral(cat(['+',str(args.new_string)]),'\n','\n+')]);
  return text.isText(args.content)?args.content:'';
 }
 function formatAction(action,filters){
  if(filters.includeActions===false||filters.includeClaude===false)return '';
  let name=str(action.toolName||'Tool');
  if(eq(name,'NotebookRead'))name='Read';else if(eq(name,'NotebookEdit'))name='Edit';else if(eq(name,'Monitor'))name='Bash';
  const agent=any(action.toolName,['Task','Agent','Subagent']),classified=classify(action,name);
  let family=agent?'agent':any(classified.family,['question','wait','toolsearch'])?'plan':classified.family==='task'?'agent':classified.family;
  if(!Object.hasOwn(icons,family))family='other';
  const header=label(action,family,name,classified);
  if(!actionDetailsEnabled(family,filters))return header;
  const args=cleanArgs(action.args||{}),response=resultText(action.result);
  let detail='';
  if(family==='agent'){
   if(filters.includeSubagentResult&&truth(response))detail=cat(['\n> **Result:** ',text.replaceLiteral(response,'\n','\n> ')]);
   // codex export passes no progressEntries; exact existing request fallback.
   if(filters.includeSubagentHistory){const body={request:args};if(truth(response))body.response=response;detail=cat([detail,fence(json(body,2),'json')]);}
  }else if(family==='read')detail=fence(response);
  else if(family==='edit'){
   const value=diff(action);
   if(truth(value))detail=fence(value,Array.isArray(action.diffHunks)||action.args?.old_string!=null?'diff':'');
   else if(truth(action.args?.command))detail=fence(cat([cat(['$ ',str(action.args.command)]),response].filter(truth),'\n\n'));
   else detail=fence(response);
  }else if(any(family,['run','git','search'])&&truth(action.args?.command))detail=fence(cat([cat(['$ ',str(action.args.command)]),response].filter(truth),'\n\n'));
  else{const body={request:args};if(truth(response))body.response=response;if(action.isError)body.isError=true;detail=fence(json(body,2),'json');}
  return cat([header,detail]);
 }
 function compact(value,max=60000){
  const valueText=value==null?'':text.isText(value)?value:json(value,2);
  return valueText.length<=max?valueText:cat([valueText.slice(0,max),'\n\n[truncated '+(valueText.length-max)+' chars]']);
 }
 function normalizeOutput(payload){
  if(!payload)return '';
  if(eq(payload.type,'tool_search_output')){
   const tools=Array.isArray(payload.tools)?payload.tools:[];
   if(!tools.length)return compact(payload.output||payload,10000);
   const stack=arena.make('array'),lines=arena.make('array');
   // Paged explicit DFS, identical namespace ordering; no recursive JS stack.
   for(let i=tools.length-1;i>=0;i--)stack.push({node:tools[i],prefix:''});
   while(stack.length){check();const {node,prefix}=stack.pop();if(!node||typeof node!=='object'||text.isText(node))continue;
    if(eq(node.type,'namespace')&&truth(node.name)){
     lines.push(cat([prefix,node.name,'/']));const children=Array.isArray(node.tools)?node.tools:[];
     for(let i=children.length-1;i>=0;i--)stack.push({node:children[i],prefix:cat([prefix,'  '])});
    }else if(truth(node.name))lines.push(cat([prefix,node.name]));
   }
   return lines.length?cat(lines,'\n'):'[tool_search returned '+tools.length+' tools]';
  }
  return text.stripDataImages(compact(payload.output!=null?payload.output:payload.result));
 }
 function compactLine(packet){
  const last=packet.latest?.last_token_usage||packet.latest?.total_token_usage||{};
  const pre=text.number(last.total_tokens||last.input_tokens||0);
  const p=packet.record.payload||{},n=text.number(p.post_tokens??p.postTokens??p.compacted_tokens??p.compactedTokens);
  const post=Number.isFinite(n)&&n>0?Math.floor(n):undefined;
  const count=v=>{if(!Number.isFinite(v)||v<=0)return '';if(v<1000)return String(Math.floor(v));return String(v>=10000?Math.round(v/1000):Math.round(v/100)/10).replace(/\.0$/,'')+'k';};
  const a=count(pre),b=count(post),reduced=pre>post?count(pre-post):'';
  return a&&b?'Context compacted · '+a+' → '+b+' tokens'+(reduced?', −'+reduced:'')+' (encrypted)':b?'Context compacted · '+b+' tokens (encrypted)':'Context compacted (encrypted)';
 }
 return function formatPacket(packet,options){
  return arena.step(()=>{
   check();const p=packet.record.payload||{};
   if(eq(packet.record.type,'compacted')||eq(packet.record.type,'event_msg'))return compactLine(packet);
   let call=packet.call?.record?.payload,output=p;
   if(eq(p.type,'web_search_call')){call=p;output=null;}
   else if(!call)call=eq(p.type,'tool_search_output')?{type:'tool_search_call',arguments:{}}:{type:p.type,name:p.name||'tool'};
   let name=any(call.type,['web_search_call'])?'web_search':any(call.type,['tool_search_call','tool_search_output'])?'tool_search':call.toolName||call.name||call.tool_name||call.type||'tool';
   const parsedArgs=eq(call.type,'web_search_call')?call.action||{}:eq(call.type,'tool_search_call')?call.arguments||{}:
    call.args&&typeof call.args==='object'&&!text.isText(call.args)?call.args:call.arguments!=null?text.isText(call.arguments)?text.parseJson(call.arguments,{raw:call.arguments}):call.arguments:
     call.input!=null&&!text.isText(call.input)?call.input:{};
   // Even a short native JSON argument must give the existing action decoder
   // a paged owner: tiny patch input can own a growing patch-event action list.
   const args=arena.own(parsedArgs);
   const result=normalizeOutput(output),namespace=call.namespace||'';
   if(any(namespace,['multi_agent_v1','collaboration'])||any(name,['spawn_agent','resume_agent','wait_agent','send_input','close_agent','send_message','followup_task','interrupt_agent','list_agents'])){
    const subject=str(args.task_name||args.label||args.target||args.agent_id||(eq(name,'wait_agent')?'result':'subagent')).trim();
    return formatAction({toolName:'Subagent',description:subject,args,result:options.includeSubagentHistory||eq(name,'wait_agent')?result:'',isError:!!output?.is_error},options);
   }
   let actions;
   if(eq(call.type,'web_search_call')||eq(name,'web_search'))actions=[{toolName:'WebSearch',args,result,isError:!!output?.is_error}];
   else if(any(call.type,['tool_search_call','tool_search_output'])||eq(name,'tool_search'))actions=[{toolName:'Tool Search',args,result,isError:!!output?.is_error}];
   else actions=api.codexHistoryActionsForCall({callId:call.call_id||call.id||'',toolName:name,args,namespace,patchApplyEvents:packet.call?.patches},result,!!output?.is_error).actions||[];
   const formatted=arena.make('array');
   for(const action of actions){
    check();const mapped=eq(action?.tool,'Task')?{toolName:'Subagent',description:action.description,args:action.args||{},result:action.result,isError:action.isError}:action.rawTool||action;
    const value=formatAction(mapped,options);if(truth(value))formatted.push(value);
   }
   return formatted.length?cat(formatted,'\n\n'):'';
  });
 };
}
module.exports={createPagedCopyFormatter};
