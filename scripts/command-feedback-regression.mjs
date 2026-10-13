#!/usr/bin/env node
// Actual Tooltip, modifier hook and hierarchy hint. Retained owners/data are a
// controlled fixture; this does not assign an installed application's CPU owner.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {fileURLToPath} from 'node:url';import {build} from 'esbuild';import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('..',import.meta.url)),artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-command-feedback-'));
const baseline=process.env.NOTED_FEEDBACK_BASELINE;
const result={artifact,baseline:baseline||null,cssHover:'controlled matches(:hover) prerequisite; real Tooltip/hook handlers, not OS hover acceptance',checks:[],errors:[],pass:false};let app,page;
try {
  await build({entryPoints:[path.join(repo,'scripts/fixtures/command-feedback.tsx')],outfile:path.join(artifact,'bundle.js'),bundle:true,
    platform:'browser',format:'iife',jsx:'automatic',target:'chrome120',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'},
    plugins:[{name:'measured-actual-inputs',setup(b){
      b.onLoad({filter:/(Tooltip\.tsx|useCmdHoverPopover\.tsx|commandHierarchyHint\.ts)$/},async args=>{
        const relative=path.relative(repo,args.path),input=baseline?path.join(baseline,relative):args.path;
        let contents=await fs.readFile(input,'utf8');
        if(args.path.endsWith('/Tooltip.tsx'))contents=contents.replace('  const [hovering, setHovering]', '  window.cmdFeedback.tooltipRenders++;\n  const [hovering, setHovering]');
        return {contents,loader:'tsx',resolveDir:path.dirname(args.path)};
      });
    }}]});
  await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><style>body{margin:15px;background:#191b21;color:#ddd;font:14px system-ui}section{width:720px}button{margin:3px}#root>[data-outline-host]{padding:12px;width:400px;border:1px solid #777}</style><div id="root"></div><script src="bundle.js"></script>');
  await fs.writeFile(path.join(artifact,'main.cjs'),`const{app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.setActivationPolicy('accessory');app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!d.url.startsWith('file:')}));const w=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{offscreen:true,backgroundThrottling:false}});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[path.join(artifact,'main.cjs')],cwd:artifact,env});result.pid=app.process().pid;
  page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));page.setDefaultTimeout(5000);
  // Offscreen CDP delivers pointer handlers, but Element.matches(':hover')
  // remains false (even with forced CSS pseudo-state). This component control
  // supplies only that predicate. Physical hit-testing is a separate boundary.
  await page.evaluate(()=>{const matches=Element.prototype.matches;Element.prototype.matches=function(selector){
    return selector===':hover'?this===window.fixtureHoverTarget:matches.call(this,selector);};});
  const hover=async selector=>{await page.evaluate(selector=>{window.fixtureHoverTarget=document.querySelector(selector);},selector);await page.locator(selector).hover();};
  const key=async(name,down)=>down?page.keyboard.down(name):page.keyboard.up(name);
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const counts=()=>page.evaluate(()=>({tooltips:window.cmdFeedback.tooltipRenders,owners:window.cmdFeedback.ownerRenders}));
  await page.locator('[data-outside]').waitFor();
  await hover('[data-hover-label]');await frames();
  const before=await counts(),begin=performance.now();await key('Meta',true);await frames();
  const after=await counts();result.idleMeta={tooltipRenders:after.tooltips-before.tooltips,ownerRenders:after.owners-before.owners,driverRoundtripMs:performance.now()-begin};
  assert.equal(await page.locator('[data-command-hierarchy-hint]').count(),1);await page.screenshot({path:path.join(artifact,'hint.png')});
  await key('Meta',false);await frames();assert.equal(await page.locator('[data-command-hierarchy-hint]').count(),0);
  if(!baseline){assert.equal(result.idleMeta.tooltipRenders,0);assert.equal(result.idleMeta.ownerRenders,0);}
  result.checks.push('actual hint appears on Meta; idle modifier render counts measured across32owners/1280actualTooltip instances');
  await hover('[data-tip="0:1"]');await key('Meta',true);await page.getByRole('tooltip').waitFor();
  assert.match(await page.getByRole('tooltip').innerText(),/Help 0:1/);await key('Meta',false);await page.getByRole('tooltip').waitFor({state:'detached'});
  await hover('[data-outside]');await key('Meta',true);await hover('[data-tip="0:2"]');await page.getByRole('tooltip').waitFor();
  assert.match(await page.getByRole('tooltip').innerText(),/Help 0:2/);await key('Meta',false);await page.getByRole('tooltip').waitFor({state:'detached'});
  result.checks.push('hover→Cmd and Cmd→hover preserve exact passive Tooltip and release');
  await hover('[data-tip="0:0"]');await key('Meta',true);await page.getByRole('tooltip').waitFor();
  await hover('[role="tooltip"]');assert.match(await page.getByRole('tooltip').innerText(),/Help 0:0/);await key('Meta',false);
  await page.getByRole('tooltip').waitFor({state:'detached'});result.checks.push('interactive tooltip bridge survives trigger→body; release closes');
  await hover('[data-pin-trigger]');await key('Meta',true);await key('Shift',true);await key('Shift',false);
  await key('Meta',false);await frames();assert.equal(await page.locator('[data-pin-body]').innerText(),'Pinned=true');
  await page.locator('[data-outside]').click();await page.locator('[data-pin-body]').waitFor({state:'detached'});
  result.checks.push('existing Cmd+Shift pin stays independent and outside click unlocks');
  // Fresh owner for the independent blur case. An unmounted interactive tip
  // cannot receive a later pointer-leave from this offscreen input channel.
  await page.evaluate(()=>window.cmdFeedback.reset());await frames();
  await hover('[data-tip="0:1"]');await key('Meta',true);await page.getByRole('tooltip').waitFor();
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByRole('tooltip').waitFor({state:'detached'});await key('Meta',false);
  result.checks.push('injected blur clears local and global feedback');
  assert.deepEqual(result.errors,[]);result.pass=true;
}catch(error){result.errors.push(error.stack||String(error));process.exitCode=1;if(page){result.failure=await page.evaluate(()=>({hover:[...document.querySelectorAll(':hover')].map(el=>({tag:el.tagName,tip:el.dataset.tip})),tips:[...document.querySelectorAll('[role="tooltip"]')].map(el=>el.textContent),metrics:window.cmdFeedback}));await page.screenshot({path:path.join(artifact,'failure.png')});}}
finally{if(app){await app.close();try{process.kill(result.pid,0);result.pidStopped=false;}catch(error){result.pidStopped=error.code==='ESRCH';}}
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
