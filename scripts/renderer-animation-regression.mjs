#!/usr/bin/env node
// Isolated Electron 28 renderer proof, with GPU acceleration enabled. No Noted
// main, CDP port, API, agent, account, production user-data or native input.
// Actual component/CSS sources are snapshotted before bundling; no HMR.
// Optional A/B: --baseline-dir /path/to/snapshot (same repo-relative paths).
// The snapshot and complete traces remain in the printed artifact directory.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const baselineDir = option('--baseline-dir', null);
const durationMs = Number(option('--duration-ms', 2000));
const rounds = Number(option('--rounds', 2));
const runPerf = !process.argv.includes('--skip-perf');
assert.ok(durationMs >= 1000 && rounds >= 1);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-renderer-animation-'));
const iconPath = 'packages/claude-blocks/src/components/TerminalActivityIcon.tsx';
const cssPath = 'packages/claude-blocks/src/blocks.css';
const gatePath = 'src/renderer/styles/presentationAnimations.css';
const proof = { artifacts: dir, durationMs, rounds, runPerf, sources: {}, samples: [], errors: [] };
const snapshot = async (sourceRoot, name, destination) => {
  const source = await fs.readFile(path.join(sourceRoot, name), 'utf8');
  proof.sources[destination] = { path: path.join(sourceRoot, name), sha256: createHash('sha256').update(source).digest('hex') };
  await fs.writeFile(path.join(dir, destination), source);
  return source;
};
await snapshot(root, iconPath, 'CurrentIcon.tsx');
await snapshot(root, cssPath, 'current.css');
await snapshot(root, gatePath, 'gate.css');
await snapshot(root, 'packages/claude-blocks/src/components/ComposerFrame.tsx', 'ComposerFrame.tsx');
await snapshot(root, 'scripts/renderer-animation-regression.mjs', 'driver.mjs');
if (baselineDir) {
  await snapshot(baselineDir, iconPath, 'BaselineIcon.tsx');
  await snapshot(baselineDir, cssPath, 'baseline.css');
}
// Extract the actual HistorySpinner and its actual keyframes without importing
// the whole application and triggering IPC. Its inline SVG animation is part
// of the production evidence, independent of the busy terminal icon.
const history = await fs.readFile(path.join(root, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const spinnerStart = history.indexOf('function HistorySpinner(');
assert.ok(spinnerStart >= 0);
const spinner = history.slice(spinnerStart, history.indexOf('\n}', spinnerStart) + 2);
await fs.writeFile(path.join(dir, 'HistorySpinner.tsx'), `import React from 'react';\nexport ${spinner}`);
const globals = await fs.readFile(path.join(root, 'src/renderer/styles/globals.css'), 'utf8');
const keyframeStart = globals.indexOf('@keyframes spinner-rotate {');
assert.ok(keyframeStart >= 0);
const spinnerCss = globals.slice(keyframeStart, globals.indexOf('\n}', keyframeStart) + 2);
const completionCss = ['@keyframes tab-awaiting-spin {', '@keyframes tab-completion-notification-dismiss {',
  '.tab-completion-notification-alert {', '.tab-completion-notification-alert--dismiss {'].map(marker => {
  const at = globals.indexOf(marker); assert.ok(at >= 0, marker);
  return globals.slice(at, globals.indexOf('\n}', at) + 2);
}).join('\n');
proof.sources.HistorySpinner = { sha256: createHash('sha256').update(spinner + spinnerCss).digest('hex') };
assert.match(globals, /@import "\.\/presentationAnimations\.css";/);

await fs.writeFile(path.join(dir, 'fixture.tsx'), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {TerminalActivityIcon as CurrentIcon} from './CurrentIcon';
import {ComposerRuntimeControl} from './ComposerFrame';
${baselineDir ? "import {TerminalActivityIcon as BaselineIcon} from './BaselineIcon';" : 'const BaselineIcon = CurrentIcon;'}
import {HistorySpinner} from './HistorySpinner';
const root = createRoot(document.getElementById('fixture'));
window.mountFixture = ({baseline=false, dense=false, gate=true, paused=false, allHidden=false, gallery=false, control=false}={}) => {
  document.getElementById('current-css').disabled = baseline;
  const old = document.getElementById('baseline-css'); if (old) old.disabled = !baseline;
  document.getElementById('gate-css').disabled = !gate;
  document.getElementById('fixture').toggleAttribute('data-fixture-paused', paused);
  const Icon = baseline ? BaselineIcon : CurrentIcon;
  flushSync(() => root.render(gallery
    ? <div className="gallery">{[14,20,32,64].map(size => <div key={size}><p>{size}px</p><Icon size={size} busy color="#d97706"/><Icon size={size} color="#4ade80"/></div>)}</div>
    : control ? <div className="control-fixture"><ComposerRuntimeControl action="stop" compact tone="#aaa"
        aria-label="Stop agent" onClick={() => { window.controlClicks = (window.controlClicks || 0) + 1; }}
        icon={<Icon size={20} busy color="#d97706"/>}
        style={{width:24,height:22,borderRadius:5,fontSize:12,fontWeight:650,flexShrink:0}}/></div>
    : <main>{Array.from({length:dense ? 47 : 1}, (_,i) => <section key={i} data-fixture-owner={i}
        data-terminal-pane-wrapper={'fixture-'+i} data-terminal-surface-presented={i===0&&!allHidden ? '1':'0'}
        data-pane-focus-isolated={i===0&&!allHidden ? '0':'1'} aria-hidden={i!==0||allHidden||undefined}
        style={{position:'absolute',inset:'50px 24px 20px',opacity:i===0&&!allHidden ? 1:0,willChange:'opacity',overflow:'hidden'}}>
      <div data-history-owner={'history-'+i} data-history-presented="1">
        <header><Icon busy color="#d97706"/><span>Agent busy · retained history {i} · visible without focus</span>
          {i>0 && <HistorySpinner/>}</header>
        <textarea defaultValue="Unsent local draft" aria-label={'Draft '+i}/>
        <div className="scroller">{Array.from({length:dense ? 180 : 2}, (_,j) => <article key={j}>
          <p>Retained response {j} with <b>formatted content</b> and <span>background data</span></p>
          <pre><code>const answer = await work();</code></pre><footer>Response · Saved</footer>
        </article>)}</div>
      </div>
    </section>)}</main>));
};
document.getElementById('toggle').addEventListener('click', () => {
  const owner = document.querySelector('[data-fixture-owner="0"]');
  const shown = owner.getAttribute('data-terminal-surface-presented') !== '1';
  owner.setAttribute('data-terminal-surface-presented', shown ? '1' : '0');
  owner.setAttribute('data-pane-focus-isolated', shown ? '0' : '1');
  owner.style.opacity = shown ? '1' : '0';
});
window.mountFixture();
`);
await build({ entryPoints: [path.join(dir, 'fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true,
  nodePaths: [path.join(root, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'">
<link id="current-css" rel="stylesheet" href="current.css">
${baselineDir ? '<link id="baseline-css" rel="stylesheet" href="baseline.css" disabled>' : ''}
<link id="gate-css" rel="stylesheet" href="gate.css">
<style>${spinnerCss}\n${completionCss}
@keyframes fixture-one-shot { to { transform: translateX(1px); } }
body{margin:0;background:#18181b;color:#ccc;font:13px sans-serif;overflow:hidden}
#toggle{margin:10px 24px;background:#333;color:#ccc;border:1px solid #555;padding:6px}
.control-fixture{margin:30px}
header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
textarea{width:70%;height:40px;color:#ccc;background:#252526;border:1px solid #444}
.scroller{height:450px;overflow:auto}article{contain:layout style;padding:4px;border:1px solid #333}
.gallery{display:flex;gap:48px;margin:30px}.gallery>div{display:flex;flex-direction:column;gap:24px}
[data-fixture-paused] .cb-terminal-perimeter-loader-dot{animation-play-state:paused!important}
</style><button id="toggle">Toggle presentation</button><div id="fixture"></div><script src="fixture.js"></script>`);
await fs.writeFile(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(dir, 'user-data'))});
app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();global.focusEvents=[];
 const win=global.fixture=new BrowserWindow({width:1000,height:740,show:false,focusable:false,
  webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});
 win.on('focus',()=>focusEvents.push(Date.now()));win.webContents.on('paint',()=>{});win.webContents.setFrameRate(60);
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.loadFile(${JSON.stringify(path.join(dir, 'index.html'))});
});app.on('window-all-closed',()=>app.quit());`);

const metricNames = ['ThreadTime', 'ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'];
const traceNames = ['ProxyMain::BeginMainFrame', 'LocalFrameView::RunPaintLifecyclePhase', 'Layerize', 'Layout', 'Paint', 'UpdateLayoutTree'];
let app;
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: dir, env });
  const page = await app.firstWindow();
  page.on('pageerror', error => proof.errors.push(error.message));
  await page.waitForFunction(() => typeof window.mountFixture === 'function');
  proof.engine = await app.evaluate(({ app }) => ({ electron: process.versions.electron, chrome: process.versions.chrome,
    pid: process.pid, gpu: app.getGPUFeatureStatus(), userData: app.getPath('userData') }));
  assert.match(proof.engine.electron, /^28\./);
  assert.equal(proof.engine.gpu.gpu_compositing, 'enabled', 'this experiment requires hardware compositing');
  proof.document = await page.evaluate(() => ({ visibility: document.visibilityState, dpr: devicePixelRatio }));
  assert.equal(proof.document.visibility, 'visible', 'offscreen renderer must actually animate');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
  const animations = () => page.evaluate(() => {
    const list = document.getAnimations();
    return { nodes: document.querySelectorAll('*').length, running: list.filter(a => a.playState === 'running').length,
      paused: list.filter(a => a.playState === 'paused').length,
      names: [...new Set(list.map(a => a.animationName))] };
  });
  const mount = async options => {
    await page.evaluate(options => window.mountFixture(options), options);
    // Deliberate measurement warmup, not an application readiness heuristic.
    await page.waitForTimeout(500);
  };
  const measure = async (name, options) => {
    await mount(options);
    const state = await animations();
    await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { recordMode: 'recordContinuously',
      includedCategories: ['toplevel', 'devtools.timeline', 'blink', 'cc', 'gpu'] } });
    const before = await cdp.send('Performance.getMetrics');
    await page.waitForTimeout(durationMs);
    const after = await cdp.send('Performance.getMetrics');
    const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await complete;
    let raw = '';
    try {
      for (;;) {
        const part = await cdp.send('IO.read', { handle: stream, size: 1048576 });
        raw += part.base64Encoded ? Buffer.from(part.data, 'base64').toString('utf8') : part.data;
        if (part.eof) break;
      }
    } finally { await cdp.send('IO.close', { handle: stream }); }
    await fs.writeFile(path.join(dir, name + '.trace.json'), raw);
    const { traceEvents } = JSON.parse(raw);
    const rendererThread = traceEvents.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
    assert.ok(rendererThread, 'complete trace contains renderer main thread');
    const totals = Object.fromEntries(traceNames.map(name => [name, { count: 0, sumMs: 0, maxMs: 0 }]));
    for (const event of traceEvents) {
      if (event.ph !== 'X' || event.pid !== rendererThread.pid || event.tid !== rendererThread.tid || !totals[event.name]) continue;
      const metric = totals[event.name]; metric.count++; metric.sumMs += event.dur / 1000; metric.maxMs = Math.max(metric.maxMs, event.dur / 1000);
    }
    const delta = Object.fromEntries(after.metrics.filter(m => metricNames.includes(m.name))
      .map(m => [m.name, m.value - before.metrics.find(b => b.name === m.name).value]));
    const sample = { name, options, state, delta, traceComplete: true, nestedTraceMetricsDoNotSum: totals };
    proof.samples.push(sample); console.log(JSON.stringify(sample));
  };
  const scenarios = [
    ['single-current-moving', {}], ['single-current-static', { paused: true }],
    ['dense-current-ungated', { dense: true, gate: false }],
    ['dense-current-gated', { dense: true }],
    ['dense-current-all-hidden', { dense: true, allHidden: true }],
  ];
  if (baselineDir) scenarios.unshift(
    ['single-baseline-moving', { baseline: true, gate: false }],
    ['single-baseline-static', { baseline: true, gate: false, paused: true }],
    ['dense-baseline-ungated', { baseline: true, dense: true, gate: false }],
    ['dense-baseline-gated', { baseline: true, dense: true }],
  );
  for (let round = 0; runPerf && round < rounds; round++) {
    for (const [name, options] of round % 2 ? [...scenarios].reverse() : scenarios) await measure(`${name}-${round + 1}`, options);
  }
  // Real presentation changes through a trusted click in this fixture. No
  // global OS cursor/input. The same mounted DOM, draft and scroll survive.
  await mount({ dense: true });
  await page.screenshot({ path: path.join(dir, 'retained-visible.png') });
  await page.evaluate(() => {
    const owner = document.querySelector('[data-fixture-owner="0"]');
    const scroller = owner.querySelector('.scroller'); scroller.scrollTop = 340;
    owner.querySelector('textarea').value = 'Draft survives hidden data updates';
    window.savedOwner = owner; window.savedScroller = scroller;
    window.savedDot = owner.querySelector('.cb-terminal-perimeter-loader-dot');
    window.savedAnimation = window.savedDot.getAnimations()[0];
  });
  await page.click('#toggle');
  await page.waitForFunction(() => window.savedAnimation.playState === 'paused');
  const pausedAt = await page.evaluate(() => window.savedAnimation.currentTime);
  // Simulate a background data delivery without changing agent busy status.
  await page.evaluate(() => {
    const entry = document.createElement('article'); entry.textContent = 'Background response received while hidden';
    window.savedScroller.append(entry);
    const lateSpinner = document.createElement('span'); lateSpinner.className = 'cb-composer-runtime-spinner';
    window.savedOwner.querySelector('header').append(lateSpinner);
    const lateInline = document.createElement('span');
    lateInline.className = 'noted-infinite-animation';
    lateInline.style.animation = 'spinner-rotate 0.85s linear infinite';
    window.savedOwner.querySelector('header').append(lateInline);
    window.lateInlineAnimation = lateInline.getAnimations()[0];
    const handoff = document.createElement('span');
    handoff.style.animation = 'fixture-one-shot 20ms linear';
    handoff.addEventListener('animationend', () => { window.oneShotFinished = true; });
    window.savedOwner.append(handoff);
  });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.savedAnimation.currentTime), pausedAt, 'hidden animation clock is frozen');
  assert.equal((await animations()).running, 0, 'even an indicator inserted while hidden is paused');
  assert.equal(await page.evaluate(() => window.lateInlineAnimation.playState), 'paused', 'marked inline feedback inserted while hidden also pauses');
  assert.equal(await page.evaluate(() => window.oneShotFinished), true, 'finite animationend handoffs still complete while hidden');
  await page.evaluate(() => {
    const mixed = document.createElement('span');
    mixed.className = 'tab-completion-notification-alert tab-completion-notification-alert--dismiss';
    mixed.style.cssText = 'position:absolute;width:30px;height:20px';
    mixed.addEventListener('animationend', event => {
      if (event.animationName === 'tab-completion-notification-dismiss') window.mixedDismissFinished = true;
    });
    window.savedOwner.append(mixed); window.mixedDismiss = mixed;
  });
  await page.waitForFunction(() => window.mixedDismissFinished === true);
  proof.mixedDismiss = await page.evaluate(() => window.mixedDismiss.getAnimations().map(a => ({
    name: a.animationName, playState: a.playState,
  })));
  assert.ok(proof.mixedDismiss.some(a => a.name === 'tab-awaiting-spin' && a.playState === 'paused'));
  assert.ok(proof.mixedDismiss.some(a => a.name === 'tab-completion-notification-dismiss' && a.playState === 'finished'));
  await page.evaluate(() => window.mixedDismiss.remove());
  await page.click('#toggle');
  await page.waitForFunction(time => window.savedAnimation.playState === 'running' && window.savedAnimation.currentTime > time + 50, pausedAt);
  proof.retention = await page.evaluate(() => ({
    sameOwner: window.savedOwner === document.querySelector('[data-fixture-owner="0"]'),
    sameDot: window.savedDot === window.savedOwner.querySelector('.cb-terminal-perimeter-loader-dot'),
    sameAnimation: window.savedAnimation === window.savedDot.getAnimations()[0],
    sameScroller: window.savedScroller === window.savedOwner.querySelector('.scroller'),
    scrollTop: window.savedScroller.scrollTop, draft: window.savedOwner.querySelector('textarea').value,
    backgroundDataVisible: window.savedScroller.lastElementChild.textContent,
    busy: window.savedOwner.querySelector('[data-terminal-perimeter-loader]').dataset.terminalPerimeterLoader,
  }));
  assert.deepEqual(proof.retention, { sameOwner: true, sameDot: true, sameAnimation: true, sameScroller: true,
    scrollTop: 340, draft: 'Draft survives hidden data updates', backgroundDataVisible: 'Background response received while hidden', busy: 'true' });
  // Measure presentation edges too: the gate must not introduce a full-tree
  // style invalidation on every click over this retained ~60k-node fixture.
  const edgeBefore = await cdp.send('Performance.getMetrics');
  for (let index = 0; index < 12; index++) await page.click('#toggle');
  const edgeAfter = await cdp.send('Performance.getMetrics');
  proof.presentationEdges = { clicks: 12, delta: Object.fromEntries(edgeAfter.metrics.filter(m => metricNames.includes(m.name))
    .map(m => [m.name, m.value - edgeBefore.metrics.find(b => b.name === m.name).value])) };
  // Independently exercise every real presentation owner, including a hidden
  // outer owner with locally presented History and a visible unfocused pane.
  proof.owners = [];
  for (const [attribute, hidden, shown, identity] of [
    ['data-terminal-surface-presented', '0', '1', 'data-terminal-pane-wrapper'],
    ['data-history-presented', '0', '1', 'data-history-owner'],
    ['aria-hidden', 'true', 'false', 'data-terminal-pane-chrome-host'],
    ['aria-hidden', 'true', 'false', 'data-single-center-focus-boundary'],
  ]) {
    await mount({});
    const value = await page.evaluate(({attribute, hidden, shown, identity}) => {
      const owner = document.querySelector('[data-fixture-owner="0"]');
      owner.setAttribute(identity, 'fixture'); owner.setAttribute(attribute, hidden);
      const animation = owner.querySelector('.cb-terminal-perimeter-loader-dot').getAnimations()[0];
      const stopped = animation.playState;
      owner.setAttribute(attribute, shown);
      owner.setAttribute('data-pane-focused', 'false');
      return { stopped, resumed: owner.querySelector('.cb-terminal-perimeter-loader-dot').getAnimations()[0].playState };
    }, {attribute, hidden, shown, identity});
    assert.deepEqual(value, { stopped: 'paused', resumed: 'running' });
    proof.owners.push({ identity, ...value });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mount({ gallery: true });
  assert.equal((await animations()).running, 4, 'busy feedback remains available with reduced motion');
  const gallery = page.locator('.gallery');
  await gallery.screenshot({ path: path.join(dir, 'icons-moving-a.png') });
  await page.waitForTimeout(250);
  await gallery.screenshot({ path: path.join(dir, 'icons-moving-b.png') });
  assert.notDeepEqual(await fs.readFile(path.join(dir, 'icons-moving-a.png')), await fs.readFile(path.join(dir, 'icons-moving-b.png')),
    'rendered pixels change; an animation name alone is not motion proof');
  proof.iconGeometry = await page.evaluate(() => [...document.querySelectorAll('.cb-terminal-activity-icon')].map(icon => {
    const rect = icon.getBoundingClientRect();
    return { width: rect.width, height: rect.height, busy: icon.dataset.terminalPerimeterLoader === 'true',
      svgPaths: icon.querySelectorAll('svg path').length };
  }));
  assert.deepEqual(proof.iconGeometry.map(x => x.width), [14,14,20,20,32,32,64,64]);
  assert.ok(proof.iconGeometry.every(x => x.width === x.height && x.svgPaths === 2));
  // Actual runtime control + actual busy icon + actual package CSS. The host
  // supplies a busy icon, not ComposerRuntimeControl.busy (a different loader).
  await mount({ control: true });
  const button = page.locator('.cb-composer-runtime-action');
  await page.mouse.move(0, 0);
  const controlState = () => button.evaluate(button => {
    const rect = button.getBoundingClientRect();
    const idle = button.querySelector('[data-agent-status-idle-glyph]');
    const stop = button.querySelector('[data-agent-status-hover-glyph]');
    const dot = button.querySelector('.cb-terminal-perimeter-loader-dot');
    return { rect: {x:rect.x,y:rect.y,width:rect.width,height:rect.height},
      idleDisplay: getComputedStyle(idle).display, stopDisplay: getComputedStyle(stop).display,
      dotRects: dot.getClientRects().length, svgRects: idle.querySelector('svg').getClientRects().length,
      stopWidth: stop.getBoundingClientRect().width,
      centerHitsButton: document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('button')===button,
    };
  });
  const resting = await controlState();
  assert.equal(resting.rect.width, 24); assert.equal(resting.rect.height, 22);
  assert.equal(resting.dotRects, 1); assert.equal(resting.svgRects, 1); assert.equal(resting.stopDisplay, 'none');
  await button.screenshot({ path: path.join(dir, 'composer-resting.png') });
  await button.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-agent-status-idle-glyph]')).display === 'none');
  const hovering = await controlState();
  proof.composerControl = { resting, hovering };
  assert.deepEqual(hovering.rect, resting.rect, 'hover must not move or resize the 24x22 hit area');
  assert.equal(hovering.dotRects, 0, 'the HTML dot cannot leak past the hidden idle glyph');
  assert.equal(hovering.svgRects, 0); assert.equal(hovering.stopWidth, 9);
  // Flex items blockify inline-flex to flex in getComputedStyle().
  assert.match(hovering.stopDisplay, /^(inline-)?flex$/);
  assert.equal(hovering.centerHitsButton, true);
  await button.screenshot({ path: path.join(dir, 'composer-hover-stop.png') });
  await button.click();
  assert.equal(await page.evaluate(() => window.controlClicks), 1, 'the same action still receives the click');
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector('.cb-terminal-perimeter-loader-dot').getClientRects().length === 1);
  const restored = await controlState();
  assert.deepEqual(restored, resting);
  assert.equal(await button.evaluate(button => button.querySelector('.cb-terminal-perimeter-loader-dot').getAnimations()[0].playState), 'running');
  proof.composerControl = { resting, hovering, restored, clicks: 1 };
  // Functional perf regression thresholds concern repeated layout, not a
  // machine-specific total CPU budget. Trace totals are nested, never summed.
  for (const sample of proof.samples.filter(s => /current-(?:moving|gated|all-hidden)-/.test(s.name))) {
    assert.ok(sample.delta.LayoutCount <= 2, `${sample.name}: no per-frame layout`);
    assert.ok(sample.nestedTraceMetricsDoNotSum['ProxyMain::BeginMainFrame'].count <= Math.ceil(durationMs / 1000 * 12) + 2,
      `${sample.name}: compositor motion must not schedule a 60Hz renderer main-frame loop`);
  }
  for (const sample of proof.samples.filter(s => s.name.startsWith('dense-current-all-hidden'))) assert.equal(sample.state.running, 0);
  for (const sample of proof.samples.filter(s => s.name.startsWith('dense-current-gated'))) {
    assert.equal(sample.state.running, 1); assert.equal(sample.state.paused, 92);
  }
  proof.isolation = await app.evaluate(() => ({ visible: global.fixture.isVisible(), focused: global.fixture.isFocused(),
    focusEvents: global.focusEvents }));
  assert.deepEqual(proof.isolation, { visible: false, focused: false, focusEvents: [] });
  assert.deepEqual(proof.errors, []); proof.status = 'pass';
} catch (error) { proof.status = 'fail'; proof.failure = error.stack || String(error); process.exitCode = 1; }
finally {
  await app?.close();
  proof.ownedProcessClosed = true;
  await fs.writeFile(path.join(dir, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ status: proof.status, artifacts: dir, failure: proof.failure }));
}
