'use strict';

// Actual Main initializer/publication callback, existing broadcast scheduler,
// organization API/SQL and Web snapshot/broadcast functions. No Electron boot.
// BrowserWindow, physical runtime and the existing80ms timer are controlled.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const ts=require('typescript'),mainDir=path.resolve(__dirname,'..');
function host(database,{mainSource=fs.readFileSync(path.join(mainDir,'main.js'),'utf8'),
  webSource=fs.readFileSync(path.join(mainDir,'web-server.js'),'utf8'),duringConstruction}={}){
  const ast=ts.createSourceFile('main.js',mainSource,ts.ScriptTarget.Latest,true);
  const webAst=ts.createSourceFile('web.js',webSource,ts.ScriptTarget.Latest,true);
  const variable=name=>ast.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name));
  const fn=(tree,name)=>{const n=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!n)throw Error('Missing actual function '+name);return n.getText(tree);};
  const timers=[],frames=[],browserFrames=[],sinks=new Set(),errors=[];
  let rendererAvailable=true,idleRefreshes=0,webAvailable=true,bootBound=false;
  const idle={refresh(){idleRefreshes++;}};
  const web=vm.createContext({console:{warn(){},log(){}},publicTabActivity:null,
    computeProjectActivity:()=>({projects:[],layoutChangedProjectIds:[],projectOrderChanged:false}),
    readWorkflowPublication:null,workspaceSwitcherWake:()=>({version:1,available:false}),runAfterWake:()=>({version:1,revalidate:true}),
    PROJECT_ACTIVITY_TOPIC:'__project_activity__',subscribers:new Map([['__project_activity__',sinks]]),publishTabTiming(){},
    stampPublicRuntimeSnapshot:(_id,value)=>value,
    webBroadcast:(_topic,payload)=>{frames.push(JSON.parse(JSON.stringify(payload)));for(const sink of sinks)sink.send(JSON.stringify(payload));}});
  for(const name of ['projectActivitySnapshot','sendProjectActivitySnapshot','broadcastProjectActivity'])vm.runInContext(fn(webAst,name),web);
  const scope=vm.createContext({require,path,crypto,srcMainDir:mainDir,projectManager:{db:database},
    createWorkflowOrganizationApi:options=>{const api=require('../workflow-organization-api').createWorkflowOrganizationApi(options);
      duringConstruction?.(api);return api;},
    BrowserWindow:{getAllWindows:()=>rendererAvailable?[{isDestroyed:()=>false,webContents:{send:(...args)=>browserFrames.push(args)}}]:[]},
    console:{log(){},warn:(...a)=>errors.push(a.join(' '))},projectActivityBroadcastTimer:null,
    projectLayoutChangedIds:new Set(),projectOrderChanged:false,projectCardSignals:null,
    appRuntimeIdentity:{instanceId:'fixture-main-epoch'},
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},
  });
  scope.require=name=>name===path.join(mainDir,'web-server')?{
    invalidateTabActivity(){if(!webAvailable)throw Error('controlled unavailable web');},
    broadcastProjectActivity:reason=>{if(!webAvailable)throw Error('controlled unavailable web');return web.broadcastProjectActivity(reason);},
  }:require(name);
  if(variable('workflowPublicationWake'))vm.runInContext(variable('workflowPublicationWake').getText(ast),scope);
  vm.runInContext(variable('idleSessionStopService').getText(ast),scope);
  vm.runInContext(variable('workflowOrganization').getText(ast),scope);
  vm.runInContext('projectManager.workflowOrganization=workflowOrganization; this.api=workflowOrganization;',scope);
  vm.runInContext(fn(ast,'scheduleProjectActivityBroadcast'),scope);
  vm.runInContext('idleSessionStopService=idlePort;',Object.assign(scope,{idlePort:idle}));
  const helper=variable('workflowPublicationWake')?vm.runInContext('workflowPublicationWake',scope):null;
  // Execute the real late bootstrap statement, not a reimplemented activation.
  // AST traversal below deliberately selects by exact receiver, not source offsets.
  let boot;
  function find(n){if(ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)
    &&n.expression.expression.getText(ast)==='workflowPublicationWake.start')boot=n;ts.forEachChild(n,find);}
  find(ast);
  const bind=()=>{
    if(boot){vm.runInContext(boot.getText(ast),scope);bootBound=true;}
    web.readWorkflowPublication=()=>helper?.snapshot()||null;
  };
  const commit=(layout,mutationId='layout-'+crypto.randomUUID())=>{
    const read=scope.api.read();return scope.api.service.commitWorkspace({mutationId,expectedRevision:read.publication.revision,
      spaces:read.workflows.map(w=>({...w.metadata,id:w.id,version:1,layout:w.id==='main'?layout:w.layout})),
      tabWorkflowMembership:Object.fromEntries(read.tabs.map(t=>[t.tabId,{workflowId:t.membership.workflowId,expectedMembershipRevision:t.membership.revision}]))});
  };
  return{scope,web,helper,bind,commit,timers,frames,browserFrames,sinks,errors,
    renderer:value=>{rendererAvailable=value;},channel:value=>{webAvailable=value;},
    idleRefreshes:()=>idleRefreshes,bootBound:()=>bootBound,replaceOwner:()=>{scope.projectManager.workflowOrganization={replacement:true};},
    flush:()=>{for(const timer of timers.splice(0)){if(timer.ms!==80)throw Error('new unexpected timer');timer.fn();}},
    publication:()=>scope.api.service.getPublication()};
}
module.exports={host};
