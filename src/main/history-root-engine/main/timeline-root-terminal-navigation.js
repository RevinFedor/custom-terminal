'use strict';

// Read evidence for Timeline.tsx's plain Gemini/Codex terminal click. No
// xterm position, marker/cache, runtime or input authority lives in this file.
const {isHistoryPagedCursor}=require('./history-paged-store');
const {isTimelineAttributeEntry}=require('../shared/timeline-entry-facts.cjs');
const fail=code=>Object.assign(new Error(code),{code});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const whitespace=c=>/\s/.test(c);
const high=c=>c>=0xd800&&c<=0xdbff;
const low=c=>c>=0xdc00&&c<=0xdfff;

/** @typedef {Object} TerminalSearchAnchor
 * @property {number} logicalRank Zero-based rank in the FULL held logical cut.
 * @property {number|null} canonicalOrdinal Not a visual/window/clean-turn rank.
 * @property {string} [uuid]
 * @property {string} [type]
 * @property {boolean} isAttribute
 * @property {string[]} searchLines <=3, each <=50 UTF-16 code units (JS slice).
 * @property {number} occurrenceBefore Exact SAME-type/all-search-lines count.
 */
/** @typedef {TerminalSearchAnchor & {
 * kind:'timeline-terminal-navigation-v1', revision:string, logicalRevision:string,
 * logicalCount:number, navigable:boolean, previousBeforeRank:number,
 * previousAnchor:TerminalSearchAnchor|null, nextPreviousBeforeRank:number|null
 * }} TerminalNavigationFact
 */

function small(cursor,max){
 if(cursor.kind==='undefined')return undefined;
 if(cursor.kind!=='text'||cursor.length>max)throw fail('TIMELINE_TERMINAL_NAVIGATION_SCALAR');
 let value='';for(const part of cursor.textChunks())value+=part;return value;
}
const sameLines=(a,b)=>a.length===b.length&&a.every((line,i)=>line===b[i]);

// A scalar majority candidate replaces getSearchLines' per-line frequency Map.
// If any code point occurs >= .8 * UTF16-length, it is necessarily a strict
// code-point majority. A second exact pass tests the ORIGINAL denominator.
// The original /^(.)\1+$/ (non-u, non-s) is subsumed by that test for length>=3:
// a repeated single UTF16 unit has ratio 1; repeated astral symbols have .5.
// No line, character-frequency map or normalized copy is materialized.
function* codePoints(cursor,start,length){
 let pending='';
 for(const part of cursor.textRange(start,length)){
  let at=0;
  if(pending){
   if(part.length&&low(part.charCodeAt(0))){yield pending+part[0];at=1;}
   else yield pending;
   pending='';
  }
  for(;at<part.length;at++){
   const c=part.charCodeAt(at);
   if(high(c)){
    if(at+1===part.length){pending=part[at];break;}
    if(low(part.charCodeAt(at+1))){yield part.slice(at,at+2);at++;continue;}
   }
   yield part[at];
  }
 }
 if(pending)yield pending;
}
async function separator(cursor,start,length,checkpoint){
 if(length<3)return false;
 let candidate='',balance=0,n=0;
 for(const point of codePoints(cursor,start,length)){
  if(balance===0){candidate=point;balance=1;}
  else balance+=point===candidate?1:-1;
  if(++n%4096===0)await checkpoint();
 }
 if(balance===0)return false;
 let count=0;n=0;
 for(const point of codePoints(cursor,start,length)){
  if(point===candidate)count++;
  if(++n%4096===0)await checkpoint();
 }
 return count/length>=0.8;
}

// Same split('\n'), trim(), filtering, slice(0,50), first-nonempty fallback
// as the existing renderer. CR, NUL and lone surrogates are NOT normalized.
async function searchLines(cursor,checkpoint,check){
 if(cursor.kind!=='text')throw fail('TIMELINE_TERMINAL_NAVIGATION_CONTENT');
 const result=[];let first='',start=-1,last=0,prefix='',offset=0,units=0;
 const line=async()=>{
  if(start<0)return;
  const length=last-start,value=prefix.slice(0,Math.min(50,length));
  if(!first)first=value;
  if(!await separator(cursor,start,length,checkpoint))result.push(value);
  start=-1;last=0;prefix='';
 };
 for(const part of cursor.textChunks()){
  check();
  for(let i=0;i<part.length;i++,offset++){
   const c=part[i];
   if(c==='\n'){
    await line();if(result.length===3)return result;
   }else{
    if(!whitespace(c)){if(start<0)start=offset;last=offset+1;}
    if(start>=0&&prefix.length<50)prefix+=c;
   }
   if(++units%8192===0)await checkpoint();
  }
 }
 await line();check();
 if(result.length===0&&first)result.push(first);
 return result;
}

/**
 * @param {import('./timeline-root-logical').TimelineLogicalRoot} logicalRoot
 * @param {number} logicalRank
 * @param {{control?:Object, beforeLogicalRank?:number, ifRevision?:string}} options
 * @returns {Promise<TerminalNavigationFact>}
 *
 * Default previous search starts strictly before logicalRank. If that candidate
 * is absent in xterm, request again with beforeLogicalRank=nextPreviousBeforeRank
 * AND ifRevision=logicalRevision on the SAME retained view. null means exhausted.
 * Candidates exclude ONLY the existing attribute predicate and empty search keys;
 * service/MCP/plan rows are not newly filtered, duplicate counts include attributes.
 * Goal/dedup/pending projection already belongs to logicalRoot, never re-parsed.
 *
 * Parent route: readTimelineRootTerminalNavigation(p.view.logical, rank,{control}).
 * Return {terminalNavigation:fact} from 'terminal-navigation' (or attach to rewind).
 * Receiver must resolve candidates using findTextBufferRow(tabId,lines,count,-1),
 * backwards until found; then scrollToTextInBuffer(selected lines/count,row).
 * On anchored miss, retry selected once with -1, exactly as Timeline.tsx does.
 * This function deliberately DOES NOT return previousBufferRow: only xterm owns it.
 * Empty/non-user/attribute ranks are valid reads; rewind's user-only guard is not.
 */
async function readTimelineRootTerminalNavigation(logicalRoot,logicalRank,{control,beforeLogicalRank,ifRevision}={}){
 if(!logicalRoot||typeof logicalRoot.fork!=='function'||typeof logicalRoot.assert!=='function'
  ||!isHistoryPagedCursor(logicalRoot.entries)||logicalRoot.entries.kind!=='array')
  throw fail('TIMELINE_TERMINAL_NAVIGATION_ROOT');
 logicalRoot.assert();
 const revision=logicalRoot.revision;
 if(typeof revision!=='string'||revision.length>256)throw fail('TIMELINE_TERMINAL_NAVIGATION_REVISION');
 if(ifRevision!==undefined&&ifRevision!==revision)throw fail('TIMELINE_TERMINAL_NAVIGATION_STALE');
 if(!Number.isSafeInteger(logicalRank)||logicalRank<0||logicalRank>=logicalRoot.entries.length)
  throw fail('TIMELINE_TERMINAL_NAVIGATION_RANK');
 if(beforeLogicalRank!==undefined&&ifRevision!==revision)throw fail('TIMELINE_TERMINAL_NAVIGATION_STALE');
 const before=beforeLogicalRank===undefined?logicalRank:beforeLogicalRank;
 if(!Number.isSafeInteger(before)||before<0||before>logicalRank)throw fail('TIMELINE_TERMINAL_NAVIGATION_BEFORE');
 let held,primary;
 const check=()=>{
  if(control?.signal?.aborted)throw fail('HISTORY_READ_CONSUMER_REVOKED');
  control?.assertCurrent();held?.assert();
 };
 const checkpoint=async()=>{check();if(control?.checkpoint)await control.checkpoint();else await tick();check();};
 try{
  check();held=logicalRoot.fork();check();
  if(held.revision!==revision)throw fail('TIMELINE_TERMINAL_NAVIGATION_STALE');
  const rows=held.entries;
  const header=rank=>{
   const row=rows.at(rank),type=small(row.field('type'),128),uuid=small(row.field('uuid'),4096);
   const summary=row.field('isCompactSummary');
   // Preserve JS truthiness without materializing any optional object/array.
   const isCompactSummary=summary.kind==='text'?summary.length>0:
    ['undefined','scalar','number','scalar-root'].includes(summary.kind)?!!summary.scalar():true;
   const canonical=held.root.field('facts').at(rank).field('canonicalOrdinal').scalar();
   if(canonical!==null&&(!Number.isSafeInteger(canonical)||canonical<0))throw fail('TIMELINE_TERMINAL_NAVIGATION_ORDINAL');
   return{logicalRank:rank,canonicalOrdinal:canonical,...(uuid===undefined?{}:{uuid}),...(type===undefined?{}:{type}),
    isAttribute:isTimelineAttributeEntry({type,isCompactSummary})};
  };
  const selected=header(logicalRank);
  selected.searchLines=await searchLines(rows.at(logicalRank).field('content'),checkpoint,check);
  selected.occurrenceBefore=0;
  let previous=null;
  for(let rank=before-1;rank>=0;rank--){
   check();const h=header(rank);
   if(!h.isAttribute){
    const lines=await searchLines(rows.at(rank).field('content'),checkpoint,check);
    if(lines.length){previous={...h,searchLines:lines,occurrenceBefore:0};break;}
   }
   if(rank%32===0)await checkpoint();
  }
  // One forward scan, at most two counters and three bounded search signatures.
  // Exact equality, never a prefix-only/hash/preview or fabricated occurrence 0.
  for(let rank=0;rank<logicalRank;rank++){
   check();const row=rows.at(rank),type=small(row.field('type'),128);
   const selectedType=type===selected.type,previousType=previous&&rank<previous.logicalRank&&type===previous.type;
   if(selectedType||previousType){
    const lines=await searchLines(row.field('content'),checkpoint,check);
    if(selectedType&&sameLines(lines,selected.searchLines))selected.occurrenceBefore++;
    if(previousType&&sameLines(lines,previous.searchLines))previous.occurrenceBefore++;
   }
   if(rank%32===31)await checkpoint();
  }
  check();
  return Object.freeze({...selected,searchLines:Object.freeze(selected.searchLines),kind:'timeline-terminal-navigation-v1',
   revision,logicalRevision:revision,logicalCount:rows.length,navigable:!selected.isAttribute&&selected.searchLines.length>0,
   previousBeforeRank:before,previousAnchor:previous?Object.freeze({...previous,searchLines:Object.freeze(previous.searchLines)}):null,
   nextPreviousBeforeRank:previous?previous.logicalRank:null});
 }catch(error){primary=error;throw error;}
 finally{try{held?.release();}catch(error){if(!primary)throw error;}}
}
module.exports={readTimelineRootTerminalNavigation};
