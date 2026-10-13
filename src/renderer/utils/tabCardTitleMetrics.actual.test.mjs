import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';

function loadMetrics(){
 const source=fs.readFileSync(process.env.NOTED_TITLE_METRICS_SOURCE||new URL('./tabCardTitleMetrics.ts',import.meta.url),'utf8');
 const code=transformSync(source+'\nexport {fontProfile};',{loader:'ts',format:'cjs'}).code;
 const module={exports:{}};
 vm.runInNewContext(code,{module,exports:module.exports,require:()=>({}),getComputedStyle:e=>e.computed});
 return module.exports;
}
function documentFixture(){
 const listeners=new Set(),counts={canvas:0,context:0,ink:0,fontSet:0,probe:0};
 const doc={epoch:0,failContext:0,contexts:[],counts,
  fonts:{addEventListener:(name,fn)=>{assert.equal(name,'loadingdone');listeners.add(fn)}},
  body:{append:()=>{counts.probe++}},
  createElement(tag){
   if(tag==='canvas'){
    counts.canvas++;
    return {getContext(kind){
     counts.context++;assert.equal(kind,'2d');if(doc.failContext-->0)return null;
     let font='10px sans-serif';const context={lost:false,isContextLost(){return this.lost},
      set font(value){if(Number.parseFloat(value)>0)font=value;counts.fontSet++},get font(){return font},
      measureText(text){counts.ink++;assert.equal(text,'HРрgjpqy');const size=Number.parseFloat(font);
       return {actualBoundingBoxAscent:size*.75+doc.epoch,actualBoundingBoxDescent:size*.25+doc.epoch};},
     };doc.contexts.push(context);return context;
    }};
   }
   assert.equal(tag,'span');
   const element={style:{},children:[],append(...values){this.children.push(...values)},remove(){},
    getBoundingClientRect(){return {top:this.children.length?0:14+doc.epoch,height:22+doc.epoch}}};
   return element;
  },
  loaded(){for(const fn of listeners)fn()},
 };
 return doc;
}
function title(doc,font='16px test-font'){
 return {isConnected:true,ownerDocument:doc,computed:{font,fontSize:'16px',lineHeight:'22px'}};
}
const plain=v=>JSON.parse(JSON.stringify(v));

test('retained titles share one document canvas while every ink measurement stays fresh',()=>{
 const {fontProfile}=loadMetrics(),doc=documentFixture();
 for(let i=0;i<90;i++)assert.deepEqual(plain(fontProfile(title(doc))),{ascent:12,descent:4,baseline:14,lineHeight:22});
 assert.equal(doc.counts.canvas,1,'same document does not allocate90canvases');
 assert.equal(doc.counts.probe,1,'same baseline profile remains reused');
 assert.equal(doc.counts.ink,90,'fresh ink is not replaced with cached ascent/descent');
 assert.equal(doc.counts.fontSet,180,'default and current font are explicitly resolved every time');
});

test('font change, pre-loadingdone ink change, and completed font load keep metric semantics',()=>{
 const {fontProfile,linkedTitleLayout}=loadMetrics(),doc=documentFixture();
 fontProfile(title(doc));doc.epoch=2;
 assert.deepEqual(plain(fontProfile(title(doc))),{ascent:14,descent:6,baseline:14,lineHeight:22});
 doc.loaded();
 const loaded=fontProfile(title(doc));
 assert.deepEqual(plain(loaded),{ascent:14,descent:6,baseline:16,lineHeight:22});
 assert.deepEqual(plain(fontProfile(title(doc,'20px other-font'))),{ascent:17,descent:7,baseline:16,lineHeight:22});
 assert.deepEqual(plain(linkedTitleLayout(loaded,{paddingY:2,gap:6,chipHeight:16})),{
  height:34,chipTop:22,titleOffset:-5,titleCenter:12,inkHeight:20,overhang:5,
 });
 assert.equal(doc.counts.canvas,1);assert.equal(doc.counts.probe,3);
});

test('contexts are document-owned and unavailable context is retried without caching failure',()=>{
 const {fontProfile}=loadMetrics(),a=documentFixture(),b=documentFixture();
 a.failContext=1;assert.equal(fontProfile(title(a)),null);assert.ok(fontProfile(title(a)));
 assert.ok(fontProfile(title(a)));assert.ok(fontProfile(title(b)));
 assert.equal(a.counts.canvas,2);assert.equal(b.counts.canvas,1);
 assert.notStrictEqual(a.contexts[0],b.contexts[0]);
 const detached=title(a);detached.isConnected=false;
 assert.equal(fontProfile(detached),null);assert.equal(a.counts.canvas,2);
});

test('lost canvas context is replaced while valid baseline geometry stays available',()=>{
 const {fontProfile}=loadMetrics(),doc=documentFixture();fontProfile(title(doc));
 doc.contexts[0].lost=true;doc.epoch=1;
 assert.deepEqual(plain(fontProfile(title(doc))),{ascent:13,descent:5,baseline:14,lineHeight:22});
 assert.equal(doc.counts.canvas,2);assert.equal(doc.counts.probe,1);
 assert.ok(fontProfile(title(doc)));assert.equal(doc.counts.canvas,2);
});

test('an ignored font assignment keeps the original fresh-context default, not a previous title font',()=>{
 const {fontProfile}=loadMetrics(),doc=documentFixture();
 fontProfile(title(doc,'20px other-font'));
 const invalid=fontProfile(title(doc,'unsupported-font-value'));
 assert.deepEqual(plain(invalid),{ascent:7.5,descent:2.5,baseline:14,lineHeight:22});
 assert.deepEqual(plain(fontProfile(title(doc))),{ascent:12,descent:4,baseline:14,lineHeight:22});
});
