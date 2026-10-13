#!/usr/bin/env node
// Presentation-only native Electron preview. No provider, app state, shared CDP,
// clipboard or global input. This is not a native-question lifecycle E2E.
import { _electron as electron } from 'playwright';
import postcss from 'postcss';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-question-blue-ring-'));
const globals = await fs.readFile(path.join(repo, 'src/renderer/styles/globals.css'), 'utf8');
const gate = await fs.readFile(path.join(repo, 'src/renderer/styles/presentationAnimations.css'), 'utf8');
const rules = postcss.parse(globals).nodes.filter(n => n.type === 'rule' && n.selector.includes('.tab-codex-question-ring')
  || n.type === 'atrule' && (n.name === 'keyframes' && n.params === 'codex-question-glow'
    || n.name === 'media' && n.nodes?.some(n => n.selector?.includes('.tab-codex-question-ring')))).map(n => n.clone());
for (const node of rules) {
  const scope = rule => { if (rule.type === 'rule' && rule.selector.includes('.tab-codex-question-ring')) rule.selector = '#after ' + rule.selector; };
  scope(node); node.walkRules?.(scope);
}
const current = rules.map(n => n.toString()).join('\n');
const old = `#before .tab-codex-question-ring {position:absolute;inset:0;border-radius:inherit;pointer-events:none;box-shadow:inset 0 0 0 1px rgba(167,139,250,.38)}
#before .tab-codex-question-ring::after {content:'';position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px rgba(192,159,255,.48),inset 0 0 5px rgba(139,92,246,.15);animation:question-before 2.6s ease-in-out infinite;animation-play-state:inherit}
@keyframes question-before {0%,100%{opacity:.18}50%{opacity:1}}`;
const caseMarkup = () => `<div class="row"><button data-case="workflow" class="chip workflow">custom-terminal<span data-workflow-codex-question-ring aria-hidden="true" class="tab-codex-question-ring noted-infinite-animation"></span></button></div>
<div class="row"><button data-case="tab" class="chip">Оптимизация History<span data-tab-codex-question-ring aria-hidden="true" class="tab-codex-question-ring noted-infinite-animation"></span></button></div>
<div class="row"><button data-case="shown-tab" class="chip shown">Текущая вкладка<span data-tab-codex-question-ring aria-hidden="true" class="tab-codex-question-ring noted-infinite-animation"></span></button></div>`;
await fs.writeFile(path.join(artifact, 'index.html'), `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:20px;background:#141414;color:#ddd;font:14px system-ui}
h2{font-size:14px;font-weight:500;color:#999;margin:0 0 18px}.gallery{display:flex;gap:40px}
.row{height:58px}.chip{position:relative;width:240px;height:34px;padding:4px 9px;color:#ccc;background:#252526;border:1px solid #555;border-radius:5px;font:inherit;text-align:left}
.workflow{width:170px;height:30px}.shown{background:#23483e}.label{font-size:12px;color:#999}
.tab-codex-question-ring{z-index:3}.phase-paused .tab-codex-question-ring,.phase-paused .tab-codex-question-ring::after{animation-play-state:paused!important}
</style><style>${old}\n${current}\n${gate}</style><h2>Вопрос Codex — было / стало</h2>
<div class="gallery" data-terminal-pane-wrapper="fixture" data-terminal-surface-presented="1" id="owner">
<section id="before"><h2>Было</h2>${caseMarkup()}</section><section id="after"><h2>Стало</h2>${caseMarkup()}</section></div>`);
await fs.writeFile(path.join(artifact, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact, 'profile'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();global.win=new BrowserWindow({width:600,height:285,show:false,focusable:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true}});win.webContents.on('paint',()=>{});win.webContents.setFrameRate(60);win.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
const result = { artifact, mode: 'presentation-only', cssSha256: createHash('sha256').update(globals).digest('hex'), assertions: [], frames: [], cleanup: {} };
let app;
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], cwd: artifact, env });
  result.pid = app.process().pid;
  const page = await app.firstWindow(); await page.waitForSelector('#after .tab-codex-question-ring');
  result.engine = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, visible: win.isVisible(), focused: win.isFocused() }));
  assert.equal(result.engine.visible, false); assert.equal(result.engine.focused, false);
  const geometry = () => page.evaluate(() => [...document.querySelectorAll('.chip')].map(el => ({ arm: el.closest('section').id, kind: el.dataset.case,
    width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, hit: document.elementFromPoint(el.getBoundingClientRect().x + 5, el.getBoundingClientRect().y + 5) === el,
    opacity: getComputedStyle(el).opacity, ring: getComputedStyle(el.querySelector('span')).boxShadow })));
  const initial = await geometry();
  const capture = async name => {
    let previous, png, stable = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await app.evaluate(() => new Promise((resolve, reject) => {
        const contents = win.webContents;
        const finish = error => { clearTimeout(timer); contents.removeListener('paint', paint); error ? reject(error) : resolve(true); };
        const paint = () => finish(); const timer = setTimeout(() => finish(new Error('native paint timeout')), 3000);
        contents.once('paint', paint); try { contents.invalidate(); } catch (error) { finish(error); }
      }));
      png = await page.screenshot({ animations: 'allow' });
      if (previous?.equals(png)) { stable = true; break; } previous = png;
    }
    assert.ok(stable, 'two consecutive acknowledged native frames: ' + name);
    await fs.writeFile(path.join(artifact, name + '.png'), png); result.frames.push(name + '.png');
  };
  for (const [name, phase] of [['dim', 0], ['bright', .5]]) {
    await page.evaluate(async phase => {
      document.getElementById('owner').classList.add('phase-paused'); const animations = document.getAnimations();
      for (const a of animations) a.pause(); await Promise.all(animations.map(a => a.ready));
      for (const a of animations) a.currentTime = a.effect.getTiming().duration * phase;
    }, phase);
    await capture(name);
  }
  const final = await geometry();
  assert.deepEqual(final, initial); assert.ok(final.every(x => x.hit && x.opacity === '1'));
  result.assertions.push('constant geometry, opaque labels and unchanged underlying hit targets at both phases');
  // Exact phase screenshots use WAAPI pause/seek, which overrides CSS playback.
  // Use fresh animations for behavior checks; never force play() past the gate.
  await page.evaluate(() => {
    const owner = document.getElementById('owner'); owner.classList.remove('phase-paused');
    for (const section of owner.querySelectorAll('section')) section.replaceChildren(...[...section.children].map(el => el.cloneNode(true)));
    window.retainedRings = [...owner.querySelectorAll('.tab-codex-question-ring')];
  });
  await page.evaluate(() => document.getElementById('owner').dataset.terminalSurfacePresented = '0');
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState === 'paused'));
  await page.evaluate(() => { const late = document.querySelector('#after .chip').cloneNode(true); late.dataset.case = 'late'; document.getElementById('after').append(late); });
  await page.waitForFunction(() => document.getAnimations().length === 7 && document.getAnimations().every(a => a.playState === 'paused'));
  result.assertions.push('hidden owner and freshly inserted hidden indicator paused');
  await page.evaluate(() => document.getElementById('owner').dataset.terminalSurfacePresented = '1');
  await page.waitForFunction(() => document.getAnimations().length === 7 && document.getAnimations().every(a => a.playState === 'running'));
  assert.equal(await page.evaluate(() => retainedRings.every(el => el.isConnected)), true);
  result.assertions.push('visible unfocused owner resumes all seven animations');
  await page.evaluate(() => document.querySelector('[data-case="late"]').remove());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => [...document.querySelectorAll('#after .tab-codex-question-ring')].every(el => getComputedStyle(el, '::after').animationName === 'none'));
  await page.evaluate(async () => { const animations = document.getAnimations(); for (const a of animations) a.pause(); await Promise.all(animations.map(a => a.ready)); for (const a of animations) a.currentTime = 0; });
  await capture('reduced-motion');
  result.assertions.push('reduced-motion candidate remains statically blue'); result.geometry = final; result.status = 'PASS';
} catch (error) { result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1; }
finally {
  if (app) { await app.close(); result.cleanup.electronClosed = true; }
  try { process.kill(result.pid, 0); result.cleanup.pidGone = false; } catch { result.cleanup.pidGone = true; }
  await fs.writeFile(path.join(artifact, 'RESULT.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, artifact, assertions: result.assertions, cleanup: result.cleanup, error: result.error }));
}
