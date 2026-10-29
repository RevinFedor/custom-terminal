'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readRequest,holdSnapshot}=require('./owned-recovery-startup-hold');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync('/private/tmp/noted-recovery-hold-'),profile=root+'/profile',bundle=root+'/Owned.app';
 for(const dir of [profile+'/data/user-data',profile+'/home',bundle])fs.mkdirSync(dir,{recursive:true});
 const request={version:1,purpose:'inspect-interrupted-test-actors',runId:'owned-one',profile,bundle,
  targets:[{tabId:'A',sessionId:'original-S',provider:'codex'},{tabId:'B',sessionId:null,provider:'codex'}]};
 const file=root+'/request.json';fs.writeFileSync(file,JSON.stringify(request));
 const env={NOTED_E2E_TEST:'true',NOTED_E2E_CLI_ISOLATION_ROOT:profile+'/data',NOTED_USER_DATA_DIR:profile+'/data/user-data',
  HOME:profile+'/home',NOTED_E2E_RECOVERY_HOLD_REQUEST:file,NOTED_E2E_RECOVERY_HOLD_SHA256:sha(fs.readFileSync(file))};
 const options={isPackaged:true,userData:env.NOTED_USER_DATA_DIR,bundle};
 t.after(()=>fs.rmSync(root,{recursive:true}));return{root,profile,bundle,file,request,env,options};
}
test('ordinary startup without explicit request remains unchanged',()=>{
 assert.equal(readRequest({},{}),null);const snapshot={anything:true};assert.equal(holdSnapshot(snapshot,null),snapshot);
});
test('physical private request annotates the actual snapshot without clearing interrupted evidence',t=>{
 const f=fixture(t),hold=readRequest(f.env,f.options),targets=[{tabId:'A',sessionId:'original-S',provider:'codex',projectId:'namespace'}];
 const before={version:1,source:'shutdown-snapshot',targets,unresolved:[],capturedAt:100};
 const after=holdSnapshot(before,hold,{pid:42,now:200});assert.equal(after.targets,targets);assert.equal(before.automaticRestoreHold,undefined);
 assert.equal(after.capturedAt,100);assert.deepEqual(after.automaticRestoreHold,{version:1,kind:'owned-e2e-recovery',runId:'owned-one',requestSHA256:f.env.NOTED_E2E_RECOVERY_HOLD_SHA256,mainPid:42,appliedAt:200,targetCount:1});
});
test('non-test, unpackaged, other profile and changed request refuse before restore',t=>{
 const f=fixture(t);
 for(const env of [{...f.env,NOTED_E2E_TEST:'false'},{...f.env,HOME:f.root},{...f.env,NOTED_USER_DATA_DIR:f.root},
  {...f.env,NOTED_E2E_RECOVERY_HOLD_SHA256:'0'.repeat(64)}])assert.throws(()=>readRequest(env,f.options));
 assert.throws(()=>readRequest(f.env,{...f.options,isPackaged:false}));
 assert.throws(()=>readRequest(f.env,{...f.options,userData:f.root}));
 fs.writeFileSync(f.file,JSON.stringify({...f.request,targets:[{tabId:'A',sessionId:'other',provider:'codex'}]}));
 assert.throws(()=>readRequest(f.env,f.options),/digest/);
});
test('symlink, hardlink, oversize and unknown snapshot subjects refuse',t=>{
 const f=fixture(t),hold=readRequest(f.env,f.options),link=f.root+'/link';fs.symlinkSync(f.file,link);
 assert.throws(()=>readRequest({...f.env,NOTED_E2E_RECOVERY_HOLD_REQUEST:link},f.options),/symlink/);
 fs.linkSync(f.file,f.root+'/hard');assert.throws(()=>readRequest(f.env,f.options),/bound/);fs.unlinkSync(f.root+'/hard');
 fs.writeFileSync(f.file,' '.repeat(16385));assert.throws(()=>readRequest(f.env,f.options),/bound/);
 for(const s of [{version:1,source:'capture-failed',targets:[],unresolved:[]},
  {version:1,targets:[],unresolved:[{reason:'unknown'}]},
  {version:1,targets:[{tabId:'A',sessionId:'other',provider:'codex'}],unresolved:[]},
  {version:1,targets:[{tabId:'user-tab',sessionId:'original-S',provider:'codex'}],unresolved:[]}])assert.throws(()=>holdSnapshot(s,hold,{pid:42}));
});
test('actual App restore branch completes diagnostic bootstrap without calling Resume; normal branch continues',async()=>{
 const src=fs.readFileSync(path.join(__dirname,'../renderer/App.tsx'),'utf8');
 const a=src.indexOf("            const startupSnapshot = await ipcRenderer.invoke('app:get-startup-interrupted-snapshot');");
 const b=src.indexOf('            const resolvedRestore =',a);assert(a>=0&&b>a);
 const body=src.slice(a,b); // this exact App block is plain JS inside its async closure
 const run=new Function('ipcRenderer','completeStartupRestore','console','return(async()=>{'+body+'return "normal-restore";})();');
 let completed=0;const targets=[{tabId:'A',sessionId:'S',provider:'codex'}];
 const held={targets,automaticRestoreHold:{version:1,kind:'owned-e2e-recovery',runId:'finite'}};
 assert.equal(await run({invoke:async()=>held},()=>completed++,{warn(){}}),undefined);assert.equal(completed,1);assert.equal(held.targets,targets);
 assert.equal(await run({invoke:async()=>({targets})},()=>completed++,{warn(){}}),'normal-restore');assert.equal(completed,1);
});
