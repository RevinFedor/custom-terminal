#!/usr/bin/env node
// Run in a persistent ordinary Terminal tab. The tester owns ONLY this lease.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const lease=path.resolve(process.argv[2] || '');
const manifest=JSON.parse(fs.readFileSync(path.join(lease,'manifest.json')));
if(manifest.lease!==lease)throw new Error('exact lease required');
const entry=path.join(manifest.source,'dist/main/main.js');
if(!fs.existsSync(entry))throw new Error('frozen build missing');
const executable=path.join(manifest.source,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const env={...process.env,...manifest.env};
for(const key of ['ELECTRON_RUN_AS_NODE','ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','CODEX_API_KEY'])delete env[key];
const runLog=path.join(lease,'run.log');
const fd=fs.openSync(runLog,'a',0o600);
const child=spawn(executable,[entry],{cwd:manifest.source,env,stdio:['ignore',fd,fd]});
const record={version:1,pid:child.pid,launcherPid:process.pid,executable,entry,cwd:manifest.source,runLog,
  startedAt:new Date().toISOString(),ports:{cdp:Number(env.NOTED_CDP_PORT),api:Number(env.NOTED_WEB_PORT)},
  userData:env.NOTED_USER_DATA_DIR,discovery:env.NOTED_DISCOVERY_DIR};
const file=path.join(lease,'process-lease.json');fs.writeFileSync(file,JSON.stringify(record,null,2),{mode:0o600});
console.log(JSON.stringify(record));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(child.exitCode===null)child.kill('SIGTERM');});
child.on('error',error=>{fs.writeFileSync(file,JSON.stringify({...record,error:error.message},null,2));process.exitCode=1;});
child.on('exit',(code,signal)=>{fs.closeSync(fd);fs.writeFileSync(file,JSON.stringify({...record,closedAt:new Date().toISOString(),exitCode:code,signal},null,2));
  console.log(JSON.stringify({closed:true,pid:child.pid,code,signal}));process.exitCode=code || 0;});
