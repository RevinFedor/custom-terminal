
// Source-only semantic check: no emit/build, real TS resolver and declarations.
const ts = require('typescript'), path = require('node:path');
const targets = ['src/renderer/components/Workspace/HistoryPrimaryRootSurface.tsx',
  'src/renderer/components/Workspace/HistoryPanel.tsx'].map(p => path.resolve(p));
const options = {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,
  moduleResolution:ts.ModuleResolutionKind.Bundler,jsx:ts.JsxEmit.ReactJSX,
  allowJs:true,checkJs:false,skipLibCheck:true,noEmit:true,esModuleInterop:true,
  allowSyntheticDefaultImports:true,types:['node'],
  lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts']};
const probe=path.resolve('scripts/__history-primary-types-probe__.mts');
const probeText="import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';\nimport { createHistoryPrimarySelectedAddress } from '../src/renderer/utils/historyPrimarySelectedAddress.mjs';\nimport { createHistoryPrimaryPanelInputTransaction } from '../src/renderer/utils/historyPrimaryPanelBindings.mjs';\ndeclare const model: HistoryPrimaryRootReadModel;\nconst scope = {ownerKey:'test',generation:1,visit:1,presented:true};\nconst snapshot=model.renderSnapshot()!, surface=model.attachSurface(scope);\nsurface.bootstrapWindow(snapshot,0,()=>true);\nsurface.commit(snapshot,{startIndex:0,endIndex:0,totalCount:1,stable:true,itemCount:1,admittedCount:1},()=>true,()=>true);\nsurface.commit(snapshot,{startIndex:0,endIndex:0,totalCount:1,stable:true},()=>false);\nmodel.matchesSnapshotUnit(snapshot,0,snapshot.window.get(0));model.hasCurrentPresentationCoverage(scope);\nmodel.finishPresentation({status:'superseded',requiredClass:'semantic'});\nmodel.addressAt(0)?.cut.leaseId;snapshot.addresses.get(0)?.physicalKey;\nmodel.resolveGroup('G');model.resolveKey('K');model.resolveIndex(0);model.resolveUuid('U');\nmodel.resolvePresentationTarget('I',{toolUseId:'T',messageReference:{physicalSessionId:'P'}});\nmodel.resolveAddress('target','I',{tool:null,owns:()=>true});\ncreateHistoryPrimarySelectedAddress({onError:(error:unknown)=>{void error;}});\ndeclare const read:Parameters<typeof createHistoryPrimaryPanelInputTransaction>[0];\nconst transaction=createHistoryPrimaryPanelInputTransaction(read,()=> 'fingerprint');\ntransaction.run(()=>transaction.current());\n// @ts-expect-error promise is not synchronous input proof\nsurface.bootstrapWindow(snapshot,0,()=>Promise.resolve(true));\n// @ts-expect-error promise is not an admitted row\nsurface.commit(snapshot,{startIndex:0,endIndex:0,totalCount:1,stable:true},()=>Promise.resolve(true));\n// @ts-expect-error numeric address\nmodel.resolveIndex('0');\n// @ts-expect-error transaction cannot lend proof across await\ntransaction.run(()=>Promise.resolve(true));";
const host=ts.createCompilerHost(options), originalRead=host.readFile.bind(host), originalExists=host.fileExists.bind(host);
host.readFile=file=>path.resolve(file)===probe?probeText:originalRead(file);
host.fileExists=file=>path.resolve(file)===probe||originalExists(file);
const program=ts.createProgram([...targets,probe],options,host);
const diagnostics = [...targets,probe].flatMap(file => program.getSemanticDiagnostics(program.getSourceFile(file))).map(d => {
  const p=d.file.getLineAndCharacterOfPosition(d.start), line=d.file.text.split('\n')[p.line];
  const message=ts.flattenDiagnosticMessageText(d.messageText,' ');
  const targeted=path.resolve(d.file.fileName)===probe || path.basename(d.file.fileName)==='HistoryPrimaryRootSurface.tsx'
    || d.code===2339 && /addressAt|hasCurrentPresentationCoverage|matchesSnapshotUnit|finishPresentation|resolveGroup|resolveKey|resolvePresentationTarget/.test(message)
    || d.code===2322 && /onError: reportPrimaryRootError/.test(line)
    || /primaryInputTransaction|inputTransaction/.test(line);
  return {file:path.relative(process.cwd(),d.file.fileName),line:p.line+1,column:p.character+1,
    code:d.code,message,targeted};
});
const result={scope:'SOURCE_SEMANTIC_ONLY',node:process.version,typescript:ts.version,
  targeted:diagnostics.filter(d=>d.targeted),unrelated:diagnostics.filter(d=>!d.targeted)};
console.log(JSON.stringify(result,null,2));
process.exitCode=result.targeted.length?1:0;
