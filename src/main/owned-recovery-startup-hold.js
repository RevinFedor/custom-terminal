'use strict';
// Explicit private E2E inspection only. Keeps the real interrupted snapshot;
// suppresses its automatic renderer restore without inventing a Stop/receipt.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fail=message=>Object.assign(new Error(message),{code:'OWNED_RECOVERY_STARTUP_HOLD_REFUSED'});
function physical(p,directory){
 if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p)throw fail('physical absolute path required');
 for(let q=p;;q=path.dirname(q)){
  const s=fs.lstatSync(q);if(s.isSymbolicLink())throw fail('symlink component');
  if(q===p?directory?!s.isDirectory():!s.isFile():!s.isDirectory())throw fail('path kind');
  if(q===path.dirname(q))break;
 }
 if(fs.realpathSync(p)!==p)throw fail('physical path mismatch');
 return fs.lstatSync(p);
}
function readRequest(env,{isPackaged,userData,bundle}={}){
 const file=env.NOTED_E2E_RECOVERY_HOLD_REQUEST;if(!file)return null;
 if(env.NOTED_E2E_TEST!=='true'||isPackaged!==true)throw fail('private packaged E2E required');
 const root=env.NOTED_E2E_CLI_ISOLATION_ROOT;
 if(typeof root!=='string'||!root.endsWith('/data')||env.NOTED_USER_DATA_DIR!==root+'/user-data'
  ||userData!==root+'/user-data'||env.HOME!==path.dirname(root)+'/home')throw fail('private profile binding');
 physical(root,true);physical(userData,true);physical(env.HOME,true);physical(bundle,true);
 const before=physical(file,false);
 if(before.nlink!==1||before.size<2||before.size>16384)throw fail('request bound');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let bytes,after;try{const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino)throw fail('request replaced');
  bytes=fs.readFileSync(fd);after=fs.fstatSync(fd);}finally{fs.closeSync(fd);}
 for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])if(before[key]!==after[key])throw fail('request changed');
 const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
 if(!/^[a-f0-9]{64}$/.test(env.NOTED_E2E_RECOVERY_HOLD_SHA256||'')||sha256!==env.NOTED_E2E_RECOVERY_HOLD_SHA256)throw fail('request digest');
 const r=JSON.parse(bytes.toString('utf8'));
 if(r.version!==1||r.purpose!=='inspect-interrupted-test-actors'||r.profile!==path.dirname(root)||r.bundle!==bundle
  ||typeof r.runId!=='string'||!/^[a-zA-Z0-9._-]{1,160}$/.test(r.runId)
  ||!Array.isArray(r.targets)||r.targets.length<1||r.targets.length>8)throw fail('request binding');
 const targets=r.targets.map(t=>{
  if(t?.provider!=='codex'||typeof t.tabId!=='string'||!t.tabId||t.tabId.length>512
   ||(t.sessionId!==null&&(typeof t.sessionId!=='string'||!t.sessionId||t.sessionId.length>128)))throw fail('target binding');
  return Object.freeze({tabId:t.tabId,sessionId:t.sessionId,provider:t.provider});
 });
 if(new Set(targets.map(t=>t.tabId)).size!==targets.length)throw fail('duplicate target');
 return Object.freeze({runId:r.runId,sha256,targets:Object.freeze(targets)});
}
function holdSnapshot(snapshot,request,{pid,now=Date.now()}={}){
 if(!request)return snapshot;
 if(snapshot?.version!==1||!Array.isArray(snapshot.targets)||!Array.isArray(snapshot.unresolved)
  ||snapshot.unresolved.length||snapshot.source==='capture-failed')throw fail('startup snapshot incomplete');
 for(const target of snapshot.targets)if(!request.targets.some(t=>t.tabId===target.tabId
  &&t.provider===target.provider&&t.sessionId===target.sessionId))throw fail('unexpected interrupted owner');
 return {...snapshot,automaticRestoreHold:Object.freeze({version:1,kind:'owned-e2e-recovery',runId:request.runId,
  requestSHA256:request.sha256,mainPid:pid,appliedAt:now,targetCount:snapshot.targets.length})};
}
module.exports={readRequest,holdSnapshot};
