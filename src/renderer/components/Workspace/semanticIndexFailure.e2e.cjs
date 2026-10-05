// Real indexing button, toast store and ToastCard in a private Electron profile.
// IPC simulates provider failure; no production state, index or clipboard writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');

test('index failure stays after 2.5 seconds, expands and copies; start rejection uses the same notice', { timeout: 30000 }, async () => {
  const repo = path.resolve(__dirname, '../../../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-index-toast-'));
  const toastSource = fs.readFileSync(path.join(repo, 'src/renderer/components/UI/Toast.tsx'), 'utf8');
  fs.writeFileSync(path.join(root, 'ToastCard.tsx'),
    "import React from 'react'; import {ChevronDown,ChevronRight,Github} from 'lucide-react';\n" +
    toastSource.slice(toastSource.indexOf('function ToastCard(')) + '\nexport default ToastCard;');
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
    import Button from './src/renderer/components/Workspace/SemanticIndexButton';
    import {useUIStore} from './src/renderer/store/useUIStore';
    import Card from ${JSON.stringify(path.join(root, 'ToastCard.tsx'))};
    function App(){const {toasts,removeToast}=useUIStore();const [expanded,setExpanded]=React.useState(new Set());const ids=React.useRef(new Set());
      return <><div style={{height:32}}><Button compact/></div><div style={{position:'fixed',top:52,right:16,width:420}}>{toasts.map(toast=><Card key={toast.id} toast={toast} removeToast={removeToast}
        expanded={expanded.has(toast.id)} toggleToastDetails={()=>setExpanded(previous=>{const next=new Set(previous);next.has(toast.id)?next.delete(toast.id):next.add(toast.id);return next;})} animatedToastIdsRef={ids}/>)}</div></>}
    createRoot(document.getElementById('root')).render(<App/>);`;
  await build({ stdin: { contents: entry, resolveDir: repo, loader: 'tsx' }, outfile: path.join(root, 'ui.js'),
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(repo, 'node_modules')],
    plugins: [{ name: 'workspace-only-fixture', setup(b) {
      b.onResolve({ filter: /useWorkspaceStore$/ }, () => ({ path: 'workspace', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
        "import {create} from 'zustand'; export const useWorkspaceStore=create(()=>({activeProjectId:'P'}));", resolveDir: repo }));
    } }] });
  fs.writeFileSync(path.join(root, 'input.css'), `@import ${JSON.stringify(path.join(repo, 'node_modules/tailwindcss/index.css'))};\n@source ${JSON.stringify(path.join(root, 'ToastCard.tsx'))};`);
  execFileSync(process.execPath, [path.join(repo, 'node_modules/@tailwindcss/cli/dist/index.mjs'), '-i', path.join(root, 'input.css'), '-o', path.join(root, 'style.css')], { stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'index.html'), '<link rel="stylesheet" href="./style.css"><body style="background:#202020;color:white;font-family:sans-serif"><div id="root"></div><script src="./ui.js"></script></body>');
  fs.writeFileSync(path.join(root, 'app.cjs'), `
    const {app,BrowserWindow,ipcMain}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.setActivationPolicy('accessory');
    let count=0;global.copied=[];
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,focusable:false,width:1000,height:640,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
      ipcMain.handle('semantic-index:get-status',()=>({success:true,status:{fresh:0,stale:1,new:0,removed:0,docsTotal:1,indexedTotal:1,indexExists:true}}));
      ipcMain.handle('semantic-index:rebuild',()=>{if(++count>1)throw Error('IPC unavailable — synthetic');
        setTimeout(()=>win.webContents.send('semantic-index:rebuild-done',{projectId:'P',projectPath:'/project/custom-terminal',success:false,
          provider:'codex',model:'gpt-5.4-mini',error:'codex reindex completed with 1 indexing errors',
          stats:{sawSummary:true,summaryErrors:1,failedFiles:['docs/one.md: model is not supported with ChatGPT account']}}),20);
        return{success:true};});
      await win.loadFile(${JSON.stringify(path.join(root, 'index.html'))});
    });`);
  const app = await _electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [path.join(root, 'app.cjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(() => { const electron = window.require('electron');
      const original = window.require; window.__copied = [];
      window.require = name => name === 'electron' ? { ...electron, clipboard: { writeText: text => window.__copied.push(text) } } : original(name);
    });
    await page.getByRole('button').first().click();
    const error = page.getByRole('alert');
    await error.waitFor();
    await page.waitForTimeout(3100); // deliberately exceeds the old toast's 2500ms lifetime
    assert.equal(await error.count(), 1);
    await error.locator('[data-toast-message]').click();
    assert.match(await error.textContent(), /docs\/one.md: model is not supported/);
    await error.getByText('copy', { exact: true }).click();
    const copied = await page.evaluate(() => window.__copied);
    assert.equal(copied.length, 1);
    assert.match(copied[0], /Модель: gpt-5.4-mini/);
    assert.match(copied[0], /docs\/one.md/);
    assert.equal(await error.count(), 1, 'copy must not dismiss the error');
    await page.screenshot({ path: path.join(root, 'index-failure.png') });
    await error.getByText('✕', { exact: true }).click();
    assert.equal(await error.count(), 0);
    await page.getByRole('button').first().click();
    await error.waitFor();
    await error.locator('[data-toast-message]').click();
    assert.match(await error.textContent(), /IPC unavailable/);
    assert.equal(await error.getByText('copy', { exact: true }).count(), 1);
    console.log('Index toast artifacts: ' + root);
  } finally { await app.close(); }
});
