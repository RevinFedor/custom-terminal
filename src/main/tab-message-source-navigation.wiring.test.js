'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const {resolveTabMessageSourceLocation}=require('./tab-message-source-location');
const {handleTabMessageApi}=require('./tab-message-api');
const source=name => fs.readFileSync(require.resolve(name),'utf8');
test('actual Main source IPC reaches the exported Web owner and rechecks the exact read session',async () => {
  const web=source('./web-server'),ast=ts.createSourceFile('web.js',web,ts.ScriptTarget.Latest,true);
  const declaration=ast.statements.find(n => ts.isFunctionDeclaration(n)&&n.name?.text==='locateTabMessageSource');
  assert.ok(declaration);
  let reads=0,locations=0;
  const message={messageId:'M',sourceTabId:'source',sourceSessionId:'writer',sourceProvider:'codex',targetTabId:'target',kind:'question',requestId:'request'};
  const scope={resolveTabMessageSourceLocation,getTabMessageService:() => ({getMessage:id => {assert.equal(id,'M');return {message};}}),
    resolveHistorySessionInfo:async id => {reads++;assert.equal(id,'source');return {toolType:'codex',sessionId:'read-child',cwd:'/cwd'};},
    transcriptService:{getTabMessageSourceLocation:async payload => {locations++;assert.equal(payload.sessionId,'read-child');assert.equal(payload.message.sourceSessionId,'writer');return {success:true,location:{toolUseId:'call'}};}}};
  const locate=vm.runInNewContext(declaration.getText(ast)+'\nlocateTabMessageSource',scope);
  const main=source('./main'),mainAst=ts.createSourceFile('main.js',main,ts.ScriptTarget.Latest,true);
  let expression;
  const visit=node => {if(ts.isCallExpression(node)&&node.expression.getText(mainAst)==='ipcMain.handle'
    &&node.arguments[0]?.text==='tab-messages:source-location')expression=node.arguments[1];ts.forEachChild(node,visit);};
  visit(mainAst);assert.ok(expression);
  const handler=vm.runInNewContext('('+expression.getText(mainAst)+')',{webServer:{locateTabMessageSource:locate}});
  const result=await handler({}, {messageId:'M'});assert.equal(result.success,true);assert.equal(reads,2);assert.equal(locations,1);
  assert.equal((await handler({},{})).success,false);assert.equal(locations,1);
  assert.match(web,/locateTabMessageSource,\s/);
});
test('source GET unavailable/POST refusal cannot invent delivery/not-submitted facts or write a message',async () => {
  for(const [method,expected] of [['GET',503],['POST',405]]) {
    let response;
    const handled=await handleTabMessageApi({method},{},{pathname:'/api/tab-messages/M/source',query:{}},{
      service:new Proxy({}, {get(){throw Error('unexpected service write/read');}}),
      readBody:() => {throw Error('source reader must not parse a write body');},
      sendJson:(_res,status,body) => {response={status,body};},
    });
    assert.equal(handled,true);assert.equal(response.status,expected);assert.equal(response.body.deliveryState,undefined);
    assert.equal(response.body.submitted,undefined);assert.equal(response.body.accepted,undefined);
  }
});
