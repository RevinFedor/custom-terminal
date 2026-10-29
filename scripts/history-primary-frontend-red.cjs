
// Explicit negative reference replay. Reads frozen V46 sources; never edits them.
// Only the named finite regressions execute. A nonzero result is the expected RED.
const fs = require('node:fs'), path = require('node:path');
const { registerHooks, syncBuiltinESMExports } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const staged=path.resolve(__dirname,'..'), reference=path.resolve(process.argv[2] || '');
if (!process.argv[2] || reference===staged) throw Error('Pass the read-only original V46 reference');
const oldRead=fs.readFileSync;
fs.readFileSync=(file,...args)=>{
  let target=file instanceof URL ? fileURLToPath(file) : file;
  if(typeof target==='string') {
    target=path.resolve(target);
    for(const relative of ['src/renderer/components/Workspace/HistoryPanel.tsx',
      'src/renderer/components/Workspace/HistoryPrimaryRootSurface.tsx']) {
      if(target===path.join(staged,relative)) return oldRead(path.join(reference,relative),...args);
    }
  }
  return oldRead(file,...args);
};
syncBuiltinESMExports();
registerHooks({load(url,context,nextLoad){
  const file=url.startsWith('file:') ? fileURLToPath(url) : '';
  const relative=path.relative(staged,file);
  if(['src/renderer/utils/historyPrimaryRootReadModel.mjs','src/renderer/utils/historyPrimaryPanelBindings.mjs',
    'src/renderer/utils/historyPrimaryItemAdmission.mjs','scripts/lib/history-virtuoso-measurement.mjs'].includes(relative)) {
    return nextLoad(pathToFileURL(path.join(reference,relative)).href,context);
  }
  const result=nextLoad(url,context);
  if(relative==='src/renderer/utils/historyPrimaryExternalPresentation.actual.test.mjs'
    ||relative==='scripts/lib/history-primary-panel-callbacks.test.mjs'){
    const source=String(result.source).replace("import test from 'node:test';",
      "import actualTest from 'node:test';\nconst test=(name,fn)=>/actual Surface\\/Hn full proof|actual plain UUID loop|successful late address continuation/.test(name)?actualTest(name,fn):undefined;");
    return {...result,source};
  }
  return result;
}});
(async()=>{
 console.log('Original reference '+reference+'; node '+process.version);
 await import(pathToFileURL(path.join(staged,'src/renderer/utils/historyPrimaryExternalPresentation.actual.test.mjs')).href);
 await import(pathToFileURL(path.join(staged,'scripts/lib/history-primary-panel-callbacks.test.mjs')).href);
})();
