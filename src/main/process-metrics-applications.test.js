'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupApplications } = require('./process-metrics-applications');
const row = (pid, ppid, execPath, bytes, commandLine = '') => ({ pid, ppid, execPath, name: execPath.split('/').pop(), footprintBytes: bytes, commandLine });
const snapshot = processes => ({ scannedAt: 1000, skipped: 2, processes });

test('outer app includes helpers, CLI tools and nested jobs once', () => {
  const processes = [row(1,0,'/Applications/Noted Terminal.app/Contents/MacOS/Noted Terminal',100),
    row(2,1,'/bin/zsh',10), row(3,2,'/bin/codex',200), row(4,3,'/bin/node',30),
    row(5,1,'/tmp/Dev.app/Contents/MacOS/Electron',40),
    row(6,0,'/Applications/Yandex.app/Contents/MacOS/Yandex',70),
    row(7,6,'/Applications/Yandex.app/Contents/Helpers/Renderer.app/Contents/MacOS/Helper (Renderer)',80)];
  const result = groupApplications({ snapshot: snapshot(processes) });
  assert.equal(result.totalBytes, 530);
  assert.equal(result.processCount, 7);
  assert.equal(result.apps.find(a=>a.label==='Noted Terminal').bytes, 380);
  assert.equal(result.apps.find(a=>a.label==='Yandex').bytes, 150);
  assert.equal(result.apps.length, 2);
  assert.equal(result.totalCpu, null);
});

test('reparented helper keeps its bundle; unknown services stay unassigned', () => {
  const result = groupApplications({ snapshot: snapshot([
    row(2,999,'/Applications/Browser.app/Contents/Helpers/Renderer.app/Contents/MacOS/Helper (Renderer)',80),
    row(3,999,'/bin/node',20), row(4,3,'/bin/python',10),
  ]) });
  assert.equal(result.apps.find(a=>a.label==='Browser').bytes,80);
  assert.equal(result.apps.find(a=>a.id==='unassigned').bytes,30);
  assert.equal(result.totalBytes,110);
});

test('cycles terminate and duplicate PID does not double count', () => {
  const result = groupApplications({ snapshot: snapshot([row(1,2,'/a.app/run',10),row(2,1,'/bin/node',20),row(2,1,'/bin/node',20)]) });
  assert.equal(result.totalBytes,30);
  assert.equal(result.processCount,2);
  assert.equal(result.apps[0].id,'unassigned');
});

test('memory and CPU preserve known zero, unavailable CPU and uncaptured new PIDs', () => {
  const s = snapshot([row(1,0,'/A.app/run',10),row(2,0,'/B.app/run',20)]);
  const first=groupApplications({ snapshot:s });
  assert.equal(first.hasCpu,false);
  assert.ok(first.apps.every(a=>a.cpu===null));
  const next=groupApplications({ snapshot:s,cpuByPid:new Map([[1,0]]) });
  assert.equal(next.apps.find(a=>a.label==='A').cpu,0);
  assert.equal(next.apps.find(a=>a.label==='B').cpu,null);
  assert.equal(next.totalCpu,0);
  assert.equal(groupApplications({snapshot:s,cpuByPid:new Map()}).totalCpu,null);
});

test('all rows and groups sum to the snapshot without changing source records', () => {
  const s=snapshot([row(1,0,'/A.app/run',12),row(2,1,'/A.app/helper',15),row(3,1,'/bin/node',5)]);
  const before=JSON.stringify(s);
  const r=groupApplications({ snapshot:s,cpuByPid:new Map([[1,20],[2,5],[3,3]]) });
  assert.equal(r.apps[0].cpu,28);
  assert.equal(r.apps[0].rows.reduce((n,x)=>n+x.bytes,0),32);
  assert.equal(JSON.stringify(s),before);
});
