'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { inspectProdServer } = require('./noted-prod-api');
const { waitForIdle, runBuild } = require('./build-when-idle');
const turn = () => new Promise(resolve => setImmediate(resolve));
const mainCommand = '/Applications/Noted Terminal.app/Contents/MacOS/Noted Terminal';

function discovery(t, records, snapshot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-observer-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(records)) fs.writeFileSync(path.join(root, name), value);
  return options => inspectProdServer({ discoveryDir: root, processSnapshot: () => snapshot, ...options });
}

test('live production with a transient ps failure is unknown, never absent', t => {
  const inspect = discovery(t, { 'web-server-10.json': JSON.stringify({ pid:10, port:7878 }) }, '10 ' + mainCommand);
  assert.equal(inspect().status, 'found');
  assert.equal(inspect({ processSnapshot() { throw Object.assign(new Error('ps timeout'), { killed:true }); } }).status, 'unknown');
});
test('live production with missing/malformed discovery cannot approve installation', t => {
  for (const record of ['', '{', JSON.stringify({ pid:11, port:7878 })]) {
    const inspect = discovery(t, { 'web-server-10.json':record }, '10 ' + mainCommand);
    assert.equal(inspect().status, 'unknown');
  }
});
test('only successful process absence allows bootstrap; empty/failed snapshots remain unknown', t => {
  const inspect = discovery(t, { 'web-server-10.json':'{' }, '11 /usr/bin/node');
  assert.equal(inspect().status, 'absent');
  assert.equal(inspect({ processSnapshot: () => '' }).status, 'unknown');
  assert.equal(inspect({ fileSystem:{readdirSync() { throw Error('EACCES'); }} }).status, 'unknown');
});
test('helper and shared hub processes cannot masquerade as the production application', t => {
  const inspect = discovery(t, {}, `10 ${mainCommand} --type=renderer\n11 ${mainCommand} mcp-hub.js\n12 /usr/bin/node`);
  assert.equal(inspect().status, 'absent');
});
test('PORT override cannot approve a different dev/test server while production is live', t => {
  const inspect=discovery(t,{'web-server-10.json':JSON.stringify({pid:10,port:7878})},'10 '+mainCommand);
  assert.equal(inspect({forcePort:7979}).status,'unknown');
  assert.equal(inspect({forcePort:7878}).server.pid,10);
});

function observer(samples, inspections) {
  const scheduled = [], progress = [];
  let index = 0, inspectIndex = 0;
  const controller = new AbortController();
  const pending = waitForIdle('synthetic-token', {
    signal: controller.signal, report() {}, progress: value => progress.push(value),
    inspect: () => inspections?.[inspectIndex++] || {status:'found',server:{pid:10,port:7878}},
    read: async () => { const next = samples[index++]; if (next instanceof Error) throw next; return next; },
    setTimer: callback => { scheduled.push(callback); return callback; }, clearTimer() {},
  });
  return { pending, progress, controller, async next() { const callback=scheduled.shift(); assert.ok(callback); await callback(); } };
}
const idle = {idle:true,count:0,loaders:[]};
const busy = {idle:false,count:1,loaders:[{kind:'codex',tabId:'T',status:'busy',name:'work'}]};

test('unknown discovery after a single idle sample resets confirmation instead of launching a build', async () => {
  const f = observer([idle,idle,idle], [{status:'found',server:{pid:10,port:7878}}, {status:'unknown',reason:'ps timeout'},
    {status:'found',server:{pid:10,port:7878}}, {status:'found',server:{pid:10,port:7878}}]);
  let settled=false; f.pending.then(()=>settled=true); await turn();
  await f.next(); assert.equal(settled,false); assert.equal(f.progress.at(-1).status,'unknown');
  await f.next(); assert.equal(settled,false);
  await f.next(); assert.equal((await f.pending).status,'idle');
});
test('running Codex and inherited orchestration block; passive saved queue remains portable', async () => {
  const f=observer([busy,{idle:false,count:1,loaders:[{kind:'orchestration',tabId:'parent',status:'waiting'}]},
    {idle:false,count:1,loaders:[{kind:'prompt-queue',tabId:'T',status:'queued'}]},idle]);
  await turn(); assert.equal(f.progress.at(-1).status,'busy');
  await f.next(); assert.equal(f.progress.at(-1).status,'busy');
  await f.next(); assert.equal(f.progress.at(-1).status,'idle');
  await f.next(); assert.equal((await f.pending).status,'idle');
});
test('503 fail-safe and HTTP errors never count as confirmed idle', async () => {
  const f=observer([idle,{idle:false,error:'unavailable'},new Error('request timeout'),idle,idle]);
  let settled=false; f.pending.then(()=>settled=true); await turn();
  await f.next(); assert.equal(f.progress.at(-1).status,'unknown');
  await f.next(); assert.equal(settled,false);
  await f.next(); assert.equal(settled,false);
  await f.next(); assert.equal((await f.pending).status,'idle');
});

async function installer(t, observe) {
  const { buildInstallNotedTerminal, waitForInstallAck } = await import('./build-install-noted-terminal.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-observed-install-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const applicationsDir=path.join(root,'applications'), releaseApp=path.join(root,'release.app');
  fs.mkdirSync(applicationsDir);fs.mkdirSync(releaseApp);fs.writeFileSync(path.join(releaseApp,'candidate'),'new');
  const installed=path.join(applicationsDir,'Noted Terminal.app');fs.mkdirSync(installed);fs.writeFileSync(path.join(installed,'candidate'),'old');
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const steps=[], nonce='synthetic-observer';const controller=new AbortController();
  const pending=runBuild('synthetic-token',{nonce,signal:controller.signal,observe,report(){},stdout:{write(){}},stderr:{write(){}},
    spawnBuild(command,args,options) {
      assert.equal(command,'npm');assert.deepEqual(args,['run','build:install']);
      assert.equal(options.env.NOTED_INSTALL_IDLE_ACK_ID,nonce);
      queueMicrotask(async()=>{
        const result=await buildInstallNotedTerminal({projectDir:root,applicationsDir,releaseApp,log(){},validate:async()=>{},
          beforeQuit:()=>waitForInstallAck({nonce,input:child.stdin,output:child.stdout,timeoutMs:10000}),
          run:async(cmd,args)=>{steps.push({cmd,args});if(cmd==='/usr/bin/ditto')fs.cpSync(args[0],args[1],{recursive:true});return '';},
        }); child.emit('exit',result.ok?0:1);
      }); return child;
    }});
  return {steps,pending,controller,installed};
}
test('actual staged installer does not call Quit while new work is busy after preparation', async t => {
  let release;const fresh=new Promise(resolve=>release=resolve);
  let markStarted;const started=new Promise(resolve=>markStarted=resolve);
  const f=await installer(t,async()=>{markStarted();return fresh;});await started;
  assert.equal(f.steps.some(s=>s.cmd==='bash'),false);
  assert.equal(fs.readFileSync(path.join(f.installed,'candidate'),'utf8'),'old');
  release({status:'idle',pid:10});assert.equal(await f.pending,0);
  assert.equal(f.steps.filter(s=>s.cmd==='bash').length,1);
  assert.equal(fs.readFileSync(path.join(f.installed,'candidate'),'utf8'),'new');
});
test('cancelling the prepared installer leaves the old app intact and performs no Quit', async t => {
  let started;const ready=new Promise(resolve=>started=resolve);
  const f=await installer(t,async(_token,{signal})=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});}));
  await ready;f.controller.abort();assert.equal(await f.pending,1);
  assert.equal(f.steps.some(s=>s.cmd==='bash'),false);
  assert.equal(fs.readFileSync(path.join(f.installed,'candidate'),'utf8'),'old');
});
test('an invalid final idle proof cannot approve the canonical staged installer', async t => {
  const f=await installer(t,async()=>({status:'unknown'}));
  assert.equal(await f.pending,1);assert.equal(f.steps.some(s=>s.cmd==='bash'),false);
  assert.equal(fs.readFileSync(path.join(f.installed,'candidate'),'utf8'),'old');
});
