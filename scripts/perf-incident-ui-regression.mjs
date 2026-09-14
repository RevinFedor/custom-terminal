#!/usr/bin/env node
// Tiny standalone Electron 28 proof. No Noted main, production connection,
// native input, live APIs or user state. The actual collector modules are
// copied into this run's immutable temp directory and invoked by its own main.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-incident-ui-'));
const canary = 'PRIVATE_INPUT_TEXT_TITLE_URL_CANARY_a79b';
const manifest = {};
for (const name of ['perf-incident-profile.js', 'perf-incident-ui.js']) {
  const source = await fs.readFile(path.join(root, 'src/main', name));
  manifest[name] = createHash('sha256').update(source).digest('hex');
  await fs.writeFile(path.join(dir, name), source);
}
const svg = owner => `<section data-terminal-pane-wrapper="${owner}" data-terminal-pane-chrome-host="fixture-space:${owner}"
    data-history-owner="fixture-history-${owner}" ${owner === 'hidden' ? 'data-pane-focus-isolated="1" style="opacity:0"' : ''}>
  <svg class="fixture-terminal-activity-icon" data-insp-path="src/fixture/TerminalActivityIcon.tsx:1:1:svg"
      width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-label="${canary}">
    <title>${canary}</title><rect x="1" y="2" width="18" height="16" rx="2"/>
    <path d="m5 7 2.5 2L5 11 M10 12h5"/>
    <circle class="cb-terminal-perimeter-loader-dot" data-insp-path="src/fixture/TerminalActivityIcon.tsx:5:1:circle"
      r="1.1" fill="orange" stroke="none"/>
  </svg></section>`;
await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>body{background:#18181b;color:#ddd}section{width:48px;height:48px}
@keyframes fixture-terminal-perimeter-travel{from{offset-distance:0%}to{offset-distance:100%}}
.cb-terminal-perimeter-loader-dot{offset-path:path("M10 3 H16 Q18 3 18 5 V15 Q18 17 16 17 H4 Q2 17 2 15 V5 Q2 3 4 3 H10 Z");offset-rotate:0deg;animation:fixture-terminal-perimeter-travel 1.45s linear infinite}
</style>${svg('visible')}${svg('hidden')}
<input id="private-input" value="${canary}" title="${canary}"><p id="private-text">${canary}</p>
<a href="https://invalid.example/${canary}" title="${canary}">Private link</a>
<script>window.framesSeen=0;requestAnimationFrame(function tick(){window.framesSeen++;requestAnimationFrame(tick)});</script>`);
await fs.writeFile(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(dir, 'user-data'))});
app.setActivationPolicy?.('accessory');app.disableHardwareAcceleration();
global.runFixtureCapture=async()=>{
 const {captureIncidentProfile}=require('./perf-incident-profile.js');
 const id='incident-'+Date.now()+'-'+process.pid;
 await captureIncidentProfile({request:{id,requestedWallMs:Date.now(),pid:global.fixture.webContents.getOSProcessId()},
  webContents:global.fixture.webContents,directory:${JSON.stringify(dir)},durationMs:500,
  inspector:{url:()=> 'fixture-driver-inspector'},log(){}});
 return id;
};
app.whenReady().then(()=>{app.dock?.hide();global.focusEvents=[];
 const win=global.fixture=new BrowserWindow({width:640,height:480,show:false,focusable:false,
  webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
 win.on('focus',()=>global.focusEvents.push(Date.now()));win.webContents.on('paint',()=>{});win.webContents.setFrameRate(60);
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.loadFile(${JSON.stringify(path.join(dir, 'index.html'))});
});app.on('window-all-closed',()=>app.quit());`);

let app;
const proof = { artifacts: dir, sourceSha256: manifest, errors: [] };
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: dir, env });
  const page = await app.firstWindow(); page.on('pageerror', error => proof.errors.push(error.message));
  await page.waitForFunction(() => window.framesSeen >= 3);
  proof.engine = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, pid: process.pid }));
  assert.match(proof.engine.electron, /^28\./);
  await app.evaluate(() => global.fixture.webContents.setZoomFactor(2));
  const before = await page.evaluate(() => {
    document.querySelector('#private-input').setSelectionRange(2, 8);
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#private-text'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    return { selection: getSelection().toString(), inputStart: document.querySelector('#private-input').selectionStart,
      inputEnd: document.querySelector('#private-input').selectionEnd,
      styles: [...document.querySelectorAll('style')].map(node => node.textContent),
      animationCount: document.getAnimations().length };
  });
  proof.requestId = await app.evaluate(() => global.runFixtureCapture());
  const filename = suffix => path.join(dir, proof.requestId + suffix);
  const uiText = await fs.readFile(filename('.ui.json'), 'utf8');
  const ui = JSON.parse(uiText), status = JSON.parse(await fs.readFile(filename('.profile.json'), 'utf8'));
  const after = await page.evaluate(() => ({ selection: getSelection().toString(),
    inputStart: document.querySelector('#private-input').selectionStart, inputEnd: document.querySelector('#private-input').selectionEnd,
    styles: [...document.querySelectorAll('style')].map(node => node.textContent),
    animationCount: document.getAnimations().length, states: document.getAnimations().map(animation => animation.playState) }));
  assert.deepEqual({ ...after, states: undefined }, { ...before, states: undefined }, 'collector preserves selection, CSS and animations');
  assert.ok(after.states.every(state => state === 'running'));
  assert.equal(ui.status, 'complete', JSON.stringify(ui.errors)); assert.equal(ui.zoomFactor, 2);
  assert.equal(ui.objectGroupRelease, 'confirmed'); assert.ok(Buffer.byteLength(uiText) <= 65536);
  assert.ok(!uiText.includes(canary), 'secret input/text/title/URL are absent from metadata');
  const mapped = ui.roots.filter(item => item.node?.tag === 'svg'
    && item.node.classes.includes('fixture-terminal-activity-icon')
    && item.node.inspector?.includes('TerminalActivityIcon')
    && item.subtreeAnimations.some(animation => animation.cssName === 'fixture-terminal-perimeter-travel'));
  assert.ok(mapped.length >= 1, 'real motion-path SVG layout root resolves to its class and source inspector path');
  assert.ok(mapped.some(item => item.node.owners.tab === 'hidden' && item.node.isolatedPane && item.node.inlineOpacityZero),
    'real hidden SVG layout root maps to its retained owner and inline opacity');
  assert.ok(ui.animations.some(animation => animation.target?.owners.tab === 'hidden' && animation.target.isolatedPane));
  assert.ok(ui.startedWallMs >= status.rendererStoppedWallMs && ui.startedWallMs >= status.traceStoppedWallMs);
  proof.metadata = { status: ui.status, bytes: Buffer.byteLength(uiText), elapsedMs: ui.elapsedMs,
    rootIds: ui.trace.roots, mapped, animationCount: ui.animations.length, objectGroupRelease: ui.objectGroupRelease };
  proof.canaryAbsent = true; proof.selectionAndCssPreserved = true;
  proof.isolation = await app.evaluate(() => ({ visible: global.fixture.isVisible(), focused: global.fixture.isFocused(),
    focusEvents: global.focusEvents, debuggerAttached: global.fixture.webContents.debugger.isAttached() }));
  assert.deepEqual(proof.isolation, { visible: false, focused: false, focusEvents: [], debuggerAttached: false });
  assert.deepEqual(proof.errors, []); proof.status = 'pass';
} catch (error) { proof.status = 'fail'; proof.failure = error.stack || String(error); process.exitCode = 1; }
finally {
  await app?.close();
  await fs.writeFile(path.join(dir, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
}
