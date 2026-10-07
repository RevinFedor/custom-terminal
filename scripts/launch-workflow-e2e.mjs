#!/usr/bin/env node
// Run in the tester's persistent foreground PTY. It owns ONLY this lease.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const lease=path.resolve(process.argv[2] || '');
const manifest=JSON.parse(fs.readFileSync(path.join(lease,'manifest.json')));
if(manifest.lease!==lease)throw new Error('exact lease required');
const entry=path.join(manifest.source,'dist/main/main.js');
if(!fs.existsSync(entry))throw new Error('frozen build missing');
const argument=flag=>{const at=process.argv.indexOf(flag);return at<0?null:process.argv[at+1];};
const attemptId=argument('--attempt');
if(process.argv.includes('--attempt') && (!attemptId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(attemptId)))throw new Error('invalid attempt id');
const output=attemptId?path.join(lease,'attempts',attemptId):lease;
const assetDir=path.join(manifest.source,'dist/renderer/assets');
const buildPaths=['dist/main/main.js','dist/renderer/index.html',
  ...fs.readdirSync(assetDir).filter(name=>/^App-.*\.js$/.test(name)).map(name=>'dist/renderer/assets/'+name)];
const buildFiles=Object.fromEntries(buildPaths.sort().map(relative=>[relative,
  createHash('sha256').update(fs.readFileSync(path.join(manifest.source,relative))).digest('hex')]));
const buildFingerprint=createHash('sha256').update(JSON.stringify(buildFiles)).digest('hex');
const expectedBuild=argument('--expect-build');
if(process.argv.includes('--expect-build') && expectedBuild!==buildFingerprint)throw new Error('frozen build fingerprint changed');
if(process.argv.includes('--check-build')){
  console.log(JSON.stringify({lease,source:manifest.source,entry,attemptId,output,buildFingerprint,buildFiles},null,2));
  process.exit(0);
}
const executable=path.join(manifest.source,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const env={...process.env,...manifest.env};
if(process.argv.includes('--visible'))env.NOTED_E2E_VISIBLE='1';
for(const key of ['ELECTRON_RUN_AS_NODE','ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','CODEX_API_KEY'])delete env[key];
fs.mkdirSync(output,{recursive:true});
const runLog=path.join(output,'run.log');
// A named attempt never appends to a previous run's evidence.
const fd=fs.openSync(runLog,attemptId?'wx':'a',0o600);
const child=spawn(executable,[entry],{cwd:manifest.source,env,stdio:['ignore',fd,fd]});
const record={version:1,pid:child.pid,launcherPid:process.pid,executable,entry,cwd:manifest.source,runLog,
  startedAt:new Date().toISOString(),ports:{cdp:Number(env.NOTED_CDP_PORT),api:Number(env.NOTED_WEB_PORT)},
  userData:env.NOTED_USER_DATA_DIR,discovery:env.NOTED_DISCOVERY_DIR,visible:env.NOTED_E2E_VISIBLE==='1',
  attemptId,buildFingerprint,buildFiles};
const file=path.join(output,'process-lease.json'),latestFile=path.join(lease,'process-lease.json');
const persist=(value,initial=false)=>{
  const text=JSON.stringify(value,null,2);fs.writeFileSync(file,text,{mode:0o600});
  if(file!==latestFile){
    const latest=fs.existsSync(latestFile)?JSON.parse(fs.readFileSync(latestFile,'utf8')):null;
    if(initial || (latest?.pid===record.pid && latest?.startedAt===record.startedAt))fs.writeFileSync(latestFile,text,{mode:0o600});
  }
};
persist(record,true);fs.writeSync(fd,'[WorkflowE2E:launch] '+JSON.stringify(record)+'\n');
console.log(JSON.stringify(record));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(child.exitCode===null)child.kill('SIGTERM');});
child.on('error',error=>{persist({...record,error:error.message});process.exitCode=1;});
child.on('exit',(code,signal)=>{fs.closeSync(fd);persist({...record,closedAt:new Date().toISOString(),exitCode:code,signal});
  console.log(JSON.stringify({closed:true,pid:child.pid,code,signal}));process.exitCode=code || 0;});
