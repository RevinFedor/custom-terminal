'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),ts=require('typescript');
function selected(source,names){const ast=ts.createSourceFile('source.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);return names.map(name=>{const n=ast.statements.find(n=>(ts.isFunctionDeclaration(n)&&n.name?.text===name)||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name)));assert(n,name);return n.getText(ast).replace(/^export /,'');}).join('\n');}
const icons=fs.readFileSync(path.join(__dirname,'../icons/index.tsx'),'utf8');
const card=fs.readFileSync(path.join(__dirname,'ToolCard.tsx'),'utf8');
const code=ts.transpileModule(selected(icons,['base','Loader2Icon','AlertTriangleIcon'])+'\n'+selected(card,['STATUS_CLASS','ColoredToolIcon']),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
const C=new Function('React',code+';return {ColoredToolIcon,Loader2Icon,AlertTriangleIcon};')(React);
const render=(status,icon=React.createElement('svg',{'data-original':'yes',className:'original','aria-label':'file'}))=>renderToStaticMarkup(React.createElement(C.ColoredToolIcon,{status,icon}));

test('running tool rotates an HTML carrier with the identical Loader2 vector, size and color class',()=>{
 const html=render('running');
 assert.match(html,/^<span class="cb-spin cb-tool-ic cb-c-running" style="width:14px;height:14px;will-change:transform">/);
 const glyph=renderToStaticMarkup(React.createElement(C.Loader2Icon,{size:14,strokeWidth:2.75,style:{display:'block'}}));
 assert.equal(html.slice(html.indexOf('>')+1,-7),glyph);
 assert.equal((html.match(/cb-spin/g)||[]).length,1);
 assert.doesNotMatch(glyph,/animation|cb-spin|aria-hidden|aria-label|role=/);
});

test('waiting, completed, failed and supplied-icon semantics retain their original branches',()=>{
 assert.equal(render('waiting'),renderToStaticMarkup(React.createElement(C.AlertTriangleIcon,{size:14,strokeWidth:2.5,className:'cb-tool-ic cb-c-waiting'})));
 for(const status of ['done','error']){
  const html=render(status);assert.match(html,/^<svg /);assert(html.includes('class="cb-tool-ic cb-c-'+status+' original"'));
  assert(html.includes('data-original="yes"')&&html.includes('aria-label="file"'));
  assert(!html.includes('cb-spin'));assert.equal(render(status,null),'<span class="cb-tool-ic cb-c-'+status+'"></span>');
 }
});

test('the existing named animation keeps its one-second cycle and hidden pause target',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../blocks.css'),'utf8');
 const pause=fs.readFileSync(path.join(__dirname,'../../../../src/renderer/styles/presentationAnimations.css'),'utf8');
 assert.match(css,/\.cb-spin\s*\{\s*animation:\s*cb-spin 1s linear infinite/);
 assert.match(css,/\.cb-tool-head \.cb-tool-ic\s*\{\s*margin-top:\s*3px/);
 assert.match(pause,/\.cb-spin,/);assert.match(pause,/animation-play-state:\s*paused\s*!important/);
});
