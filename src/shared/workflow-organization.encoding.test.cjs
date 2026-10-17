'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const before=fs.readFileSync(__dirname+'/fixtures/workflow-organization.8aeec6ef.before.cjs.txt','utf8');
const after=fs.readFileSync(__dirname+'/workflow-organization.cjs','utf8');
function load(source){let calls=0;const module={exports:{}};vm.runInNewContext(source,{module,JSON:{parse:JSON.parse,stringify(value){calls++;return JSON.stringify(value);}}});return{encode:module.exports.stableJson,calls:()=>calls};}
const old=load(before),candidate=load(after),actual=process.env.NOTED_ENCODING_SOURCE==='oracle'?old:candidate;
const equal=v=>assert.equal(actual.encode(v),old.encode(v));
const outcome=(encoder,value)=>{try{return{value:encoder(value)}}catch(e){return{error:e.name,code:e.code}}};
test('complete pinned oracle',()=>assert.equal(crypto.createHash('sha256').update(before).digest('hex'),'8aeec6ef0392f542ee71ba944ace25a8df1e6d45b2a44bf20b4d285c32e3b8f5'));
test('canonical keys, Unicode, escaping, numeric names and unknown fields keep exact bytes',()=>{
 const value=Object.create(null);for(const key of ['2','10','1','__proto__','constructor','a','"','\n','𝌆','\ud800'])value[key]={future:['same','"\\\u0000\udfff',null,0,-0,2.5,true,false],text:key};equal(value);equal([,,null]);equal(Buffer.from([0,255,3]));equal(new Uint16Array([4,5]));equal(new Date(0));equal(new String('abc'));
});
test('fresh getter order, mutations, exceptions and recovery are unchanged',()=>{
 function run(encoder,fail=false){const log=[],data={b:'initial'};Object.defineProperty(data,'a',{enumerable:true,get(){log.push('a');data.b='fresh';if(fail)throw Error('getter');return'same';}});Object.defineProperty(data,'c',{enumerable:true,get(){log.push('c');return encoder({nested:'same'});}});return{result:outcome(encoder,data),log};}
 assert.deepEqual(run(actual.encode),run(old.encode));assert.deepEqual(run(actual.encode,true),run(old.encode,true));equal({same:'fresh after throw'});
 const v={x:'old',child:{x:'same'}};equal(v);v.x='new';v.child.x='changed';equal(v);
});
test('unsupported values and typed toJSON retain errors and read order',()=>{
 for(const v of [undefined,NaN,Infinity,-Infinity,Symbol('x'),1n,()=>{}])assert.deepEqual(outcome(actual.encode,v),outcome(old.encode,v));
 function typed(encoder){const log=[],v=new Uint8Array([1]);Object.defineProperty(v,'toJSON',{get(){log.push('get');return function(){log.push('call');return{type:'same',data:['same']};}}});return{value:encoder(v),log};}assert.deepEqual(typed(actual.encode),typed(old.encode));
 const cyclic={};cyclic.self=cyclic;assert.deepEqual(outcome(actual.encode,cyclic),outcome(old.encode,cyclic));
});
test('3000 deterministic nested JSON values match exactly',()=>{
 let seed=719;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 const value=depth=>{const n=next();if(!depth)return [null,Boolean(n&1),n/3,'text:'+n,'same','\ud800'][n%6];if(n%3===0)return Array.from({length:n%5},()=>value(depth-1));const o=Object.create(null);for(let i=0;i<n%6;i++)o[['10','2','future','same','\n','𝌆'][i]]=value(depth-1);return o;};
 for(let i=0;i<3000;i++)equal(value(4));
});
test('repeat encoding is removed inside one call, never across calls',()=>{
 const value=Array.from({length:200},()=>({same:'same',second:'same'}));const a=actual.calls(),b=old.calls();assert.equal(actual.encode(value),old.encode(value));const newCalls=actual.calls()-a,oldCalls=old.calls()-b;
 assert.ok(newCalls<=2,'only two distinct string encodings, got '+newCalls);assert.ok(oldCalls>=800);const c=actual.calls();actual.encode({same:'same',second:'same'});assert.equal(actual.calls()-c,2,'per-call encoding storage is discarded');
});
