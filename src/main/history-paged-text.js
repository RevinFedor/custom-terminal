'use strict';

// Reducer text values over immutable UTF-16 pages. A text owns an arena and
// page reference, never the full string. Public wire output is still a cursor.
const crypto = require('node:crypto');
const DATA = new WeakMap();
const SMALL_CHARS = 128;
const isText = value => typeof value === 'string' || DATA.has(value);
const isPagedText = value => DATA.has(value);
const info = value => DATA.get(value);
const whitespace = char => /\s/u.test(char);
function coerce(value) {
  if(isText(value))return value;
  if(Array.isArray(value)) {
    const arena=require('./history-projection-arena').projectionArenaOf(value);
    if(arena) {
      const id=arena.owner(value);
      // JSON may carry an enumerable own toString/join field in the legacy
      // object-feed API. Respect the same primitive conversion rules.
      if(arena.has(id,'toString'))return String(value);
      if(arena.has(id,'join'))return '[object Array]';
      return arrayJoin(arena,value,',');
    }
  }
  return String(value);
}

function arrayJoin(arena, value, separator = ',') {
  const store=arena.store;
  return build(arena,(function*(){
    let frame={owner:arena.owner(value),index:0,length:value.length,parent:0,depth:1,top:true};
    for(;;) {
      arena.metrics.maxArrayCoercionDepth=Math.max(arena.metrics.maxArrayCoercionDepth || 0,frame.depth);
      if(frame.index===frame.length) {
        if(!frame.parent)break;
        frame=store.json(frame.parent);continue;
      }
      if(frame.index)yield*chunks(frame.top?separator:',');
      const item=arena.get(frame.owner,String(frame.index++));
      if(item==null)continue;
      const child=Array.isArray(item)?arena.owner(item):null;
      if(child!==null&&!arena.has(child,'toString')&&!arena.has(child,'join')) {
        let cyclic=child===frame.owner;
        for(let at=frame.parent;at&&!cyclic;){const saved=store.json(at);cyclic=saved.owner===child;at=saved.parent;}
        if(cyclic)continue; // Native Array.join renders a cyclic child empty.
        const parent=store.put(frame,[frame.parent]);
        frame={owner:child,index:0,length:item.length,parent,depth:frame.depth+1,top:false};
      } else yield*chunks(coerce(item));
    }
  })());
}

// Only ASCII case folding is used for protocol markers. General Unicode
// lowercasing (notably contextual sigma) remains an explicit legacy operation.
function includesAsciiIgnoreCase(value, marker) {
  marker = marker.toLowerCase(); let tail = '';
  for (const part of chunks(coerce(value))) {
    const joined = tail + part.replace(/[A-Z]/g, char => char.toLowerCase());
    if (joined.includes(marker)) return true;
    tail = joined.slice(Math.max(0, joined.length - marker.length + 1));
  }
  return false;
}

function preview(value, max = 120) {
  value = coerce(value || ''); let out = '', pendingSpace = false;
  if (max <= 0) return '';
  for (const part of chunks(value)) for (const char of part) {
    if (whitespace(char)) { pendingSpace = !!out; continue; }
    if (pendingSpace) out += ' ';
    pendingSpace = false; out += char;
    if (out.length >= max) return out.slice(0, max);
  }
  return out;
}

function replaceLiteral(value, needle, replacement) {
  if (!isPagedText(value)) return value.split(needle).join(replacement);
  if (!needle || needle.length > SMALL_CHARS) throw new TypeError('history_text_literal_pattern');
  if (indexOf(value, needle) < 0) return value;
  return build(info(value).arena, (function* () {
    let tail = '';
    for (const part of chunks(value)) {
      let joined = tail + part, at = 0, match;
      while ((match = joined.indexOf(needle, at)) >= 0) {
        if (match > at) yield joined.slice(at, match);
        yield replacement; at = match + needle.length;
      }
      const safe = Math.max(at, joined.length - needle.length + 1);
      if (safe > at) yield joined.slice(at, safe);
      tail = joined.slice(safe);
    }
    if (tail) yield tail;
  })());
}

function* units(value, from = 0) {
  let offset = from;
  for (const part of chunks(value, from)) for (let at = 0; at < part.length; at++) {
    yield { char: part[at], offset: offset++ };
  }
}
function stripDataImages(value) {
  if (!isPagedText(value)) return value.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/g, '[image: base64 omitted]');
  const prefix = 'data:image/', marker = ';base64,';
  function find(from) {
    for (let start = indexOf(value, prefix, from); start >= 0; start = indexOf(value, prefix, start + 1)) {
      let mimeEnd = start + prefix.length;
      for (const next of units(value, mimeEnd)) {
        if (!/[a-zA-Z0-9.+-]/.test(next.char)) break;
        mimeEnd = next.offset + 1;
      }
      if (mimeEnd === start + prefix.length || !value.startsWith(marker, mimeEnd)) continue;
      const dataStart = mimeEnd + marker.length; let end = dataStart;
      for (const next of units(value, dataStart)) {
        if (!/[A-Za-z0-9+/=_-]/.test(next.char)) break;
        end = next.offset + 1;
      }
      if (end > dataStart) return { start, end };
    }
    return null;
  }
  const first = find(0); if (!first) return value;
  return build(info(value).arena, (function* () {
    let at = 0, match = first;
    do {
      yield* chunks(value, at, match.start); yield '[image: base64 omitted]';
      at = match.end; match = find(at);
    } while (match);
    yield* chunks(value, at);
  })());
}

function fromRef(arena, ref) {
  const meta = arena.store.json(ref.id);
  if (meta.kind !== 'text') throw new TypeError('history_text_reference');
  if (meta.totalChars <= SMALL_CHARS) {
    let out = ''; for (const part of arena.store.leafChunks(ref)) out += part;
    arena.metrics.maxDecodedTextChars = Math.max(arena.metrics.maxDecodedTextChars || 0,out.length);
    return out;
  }
  const text = new PagedText(); DATA.set(text,{ arena,ref,length:meta.totalChars });
  return Object.freeze(text);
}
function* chunks(value, from = 0, to = value.length) {
  const data = DATA.get(value);
  if (!data) {
    for (let i=from;i<to;i+=SMALL_CHARS) yield value.slice(i,Math.min(to,i+SMALL_CHARS));
    return;
  }
  data.arena.assertOpen();
  const source = from === 0 && to === value.length ? data.arena.store.leafChunks(data.ref)
    : data.arena.store.leafRange(data.ref,from,Math.max(0,to-from));
  for (const part of source) {
    data.arena.metrics.maxDecodedTextChars = Math.max(data.arena.metrics.maxDecodedTextChars || 0,part.length);
    yield part;
  }
}
function small(value, maximum = SMALL_CHARS) {
  if (!DATA.has(value)) return String(value);
  if (value.length > maximum) throw new RangeError('history_text_not_small');
  let out='';for(const part of chunks(value))out+=part;
  return out;
}
// Explicitly measured compatibility residue. It preserves the previous
// semantic operation where it has not yet been ported; it is NEVER bounded
// acceptance. Actual tests assert zero calls for the migrated leaf paths.
function materialize(value, reason = 'implicit-string') {
  const data=DATA.get(value);if(!data)return String(value);
  const metrics=data.arena.metrics;
  metrics.unboundedTextMaterializations=(metrics.unboundedTextMaterializations || 0)+1;
  metrics.maxUnboundedTextChars=Math.max(metrics.maxUnboundedTextChars || 0,value.length);
  metrics.lastUnboundedTextOperation=reason;
  let out='';for(const part of chunks(value))out+=part;
  return out;
}
function build(arena, pieces) {
  let ref;
  const write=()=>{const writer=arena.store.leafWriter();for(const part of pieces)writer.write(part);ref=writer.finish();};
  if (arena.inStep) write(); else arena.store.transaction(write);
  return fromRef(arena,ref);
}
function concat(values, separator = '', arena = null) {
  // Callers with a paged container supply its owner so there is no first-pass
  // materialization of a potentially wide iterator just to find an arena.
  if (!arena && Array.isArray(values)) for(const value of values)if(DATA.has(value)){arena=DATA.get(value).arena;break;}
  if(!arena)return Array.from(values).join(separator);
  return build(arena,(function*(){let first=true;for(const value of values){
    if(!first)yield* chunks(separator);first=false;
    if(value!=null)yield* chunks(coerce(value));
  }})());
}
function equal(left,right) {
  if(left===right)return true;if(!isText(left)||!isText(right)||left.length!==right.length)return false;
  const a=chunks(left)[Symbol.iterator](),b=chunks(right)[Symbol.iterator]();let av='',bv='',ad=false,bd=false;
  try{for(;;){if(!av&&!ad){const n=a.next();av=n.value||'';ad=!!n.done;}if(!bv&&!bd){const n=b.next();bv=n.value||'';bd=!!n.done;}
    if(ad&&bd)return !av&&!bv;const n=Math.min(av.length,bv.length);if(!n||av.slice(0,n)!==bv.slice(0,n))return false;
    av=av.slice(n);bv=bv.slice(n);
  }}finally{a.return?.();b.return?.();}
}
function slice(value, start = 0, end = value.length) {
  if(!DATA.has(value))return value.slice(start,end);
  const integer=n=>Number.isNaN(Number(n))?0:Math.trunc(Number(n));
  const norm=n=>Math.max(0,Math.min(value.length,n<0?value.length+n:n));
  const from=norm(integer(start)),to=Math.max(from,norm(integer(end)));
  if(from===0&&to===value.length)return value;
  const arena=DATA.get(value).arena;
  if(to-from<=SMALL_CHARS){let out='';for(const part of chunks(value,from,to))out+=part;return out;}
  return build(arena,chunks(value,from,to));
}
function trim(value, side = 'both') {
  if(!DATA.has(value))return side==='start'?value.trimStart():side==='end'?value.trimEnd():value.trim();
  let first=-1,last=0,offset=0;
  for(const part of chunks(value)){for(let i=0;i<part.length;i++)if(!whitespace(part[i])){if(first<0)first=offset+i;last=offset+i+1;}offset+=part.length;}
  if(first<0)return '';
  return slice(value,side==='end'?0:first,side==='start'?value.length:last);
}
function indexOf(value, needle, from = 0) {
  if(!DATA.has(value)&&!DATA.has(needle))return value.indexOf(needle,from);
  if(!isText(needle))needle=String(needle);
  from=Math.max(0,Math.min(value.length,Math.trunc(Number(from)||0)));
  if(!needle.length)return from;
  // A bounded rolling window for ordinary grammar markers. Long patterns
  // use exact range comparison without a pattern-sized failure table.
  if(needle.length<=SMALL_CHARS){needle=small(needle);let tail='',at=from;
    for(const part of chunks(value,from)){const joined=tail+part,found=joined.indexOf(needle);
      if(found>=0)return at-tail.length+found;tail=joined.slice(-(needle.length-1)||joined.length);at+=part.length;}
    return -1;
  }
  for(let at=from;at+needle.length<=value.length;at++)if(equalRange(value,at,needle))return at;
  return -1;
}
function equalRange(value,offset,other){if(offset<0||offset+other.length>value.length)return false;
  const data=DATA.get(value);if(!data)return equal(value.slice(offset,offset+other.length),other);
  const a=chunks(value,offset,offset+other.length),b=chunks(other);let av='',bv='',ad=false,bd=false;
  try{for(;;){if(!av&&!ad){const n=a.next();av=n.value||'';ad=!!n.done;}if(!bv&&!bd){const n=b.next();bv=n.value||'';bd=!!n.done;}
    if(ad&&bd)return !av&&!bv;const n=Math.min(av.length,bv.length);if(!n||av.slice(0,n)!==bv.slice(0,n))return false;av=av.slice(n);bv=bv.slice(n);
  }}finally{a.return?.();b.return?.();}}
function hash(value,algorithm='sha1') {
  const h=crypto.createHash(algorithm);let pending='';
  for(const part of chunks(value)){let s=pending+part;pending='';if(s.length&&/[\uD800-\uDBFF]/.test(s.at(-1))){pending=s.at(-1);s=s.slice(0,-1);}h.update(s,'utf8');}
  if(pending)h.update(pending,'utf8');return h.digest('hex');
}
function parseJson(value, fallback = null) {
  const data=DATA.get(value);if(!data){try{return JSON.parse(value);}catch{return fallback;}}
  const arena=data.arena;
  const parse=()=>{
    const {createPagedJsonProjection}=require('./history-paged-json');
    const parser=createPagedJsonProjection(arena.store,{selectedTokenBytes:64,jsonWhitespaceOnly:true});
    let escaped=false,quoted=false,pending='',offset=0;
    const flush=()=>{if(!pending)return;const bytes=Buffer.from(pending,'utf8');parser.write(bytes,offset);offset+=bytes.length;pending='';};
    const put=piece=>{if(pending.length+piece.length>64)flush();pending+=piece;};
    try{
      // JSON.parse receives UTF-16. Preserve raw lone surrogates inside JSON
      // strings rather than replacing them during a UTF-8 round trip.
      for(const part of chunks(value))for(let i=0;i<part.length;i++){
        const char=part[i],unit=part.charCodeAt(i);
        if(quoted&&!escaped&&unit>=128)put('\\u'+unit.toString(16).padStart(4,'0'));
        else put(char);
        if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}
        else if(char==='"')quoted=true;
      }
      flush();const result=parser.finish(offset);
      try{return result.valid?arena.own(result.lease.cursor()):fallback;}
      finally{result.lease?.release();}
    }finally{parser.abort();}
  };
  return arena.inStep?parse():arena.step(parse);
}
class PagedText {
  get length(){return DATA.get(this).length;}
  slice(start,end){return slice(this,start,end);}
  substring(start=0,end=this.length){start=Math.max(0,Math.min(this.length,Number(start)||0));end=Math.max(0,Math.min(this.length,Number(end)||0));return slice(this,Math.min(start,end),Math.max(start,end));}
  trim(){return trim(this);}
  trimStart(){return trim(this,'start');}
  trimEnd(){return trim(this,'end');}
  indexOf(needle,from){return indexOf(this,needle,from);}
  includes(needle,from){return indexOf(this,needle,from)>=0;}
  startsWith(needle,position=0){return equalRange(this,Math.max(0,Math.min(this.length,Number(position)||0)),needle);}
  endsWith(needle,position=this.length){const at=Math.min(this.length,Math.max(0,Number(position)||0));return equalRange(this,at-needle.length,needle);}
  charAt(index=0){index=Math.trunc(Number(index)||0);return index<0||index>=this.length?'':small(slice(this,index,index+1));}
  charCodeAt(index=0){return this.charAt(index).charCodeAt(0);}
  at(index){return this.charAt(index<0?this.length+index:index)||undefined;}
  toString(){return materialize(this,'toString');}
  toJSON(){return materialize(this,'JSON.stringify');}
  [Symbol.toPrimitive](){return materialize(this,'implicit-string');}
  replace(pattern,replacement){return materialize(this,'replace').replace(pattern,replacement);}
  match(pattern){return materialize(this,'match').match(pattern);}
  matchAll(pattern){return materialize(this,'matchAll').matchAll(pattern);}
  split(pattern,limit){return materialize(this,'split').split(pattern,limit);}
  toLowerCase(){return materialize(this,'toLowerCase').toLowerCase();}
  *[Symbol.iterator](){
    let high='';
    for(const part of chunks(this))for(let i=0;i<part.length;i++){
      const char=part[i],unit=part.charCodeAt(i);
      if(high){if(unit>=0xdc00&&unit<=0xdfff){yield high+char;high='';continue;}yield high;high='';}
      if(unit>=0xd800&&unit<=0xdbff)high=char;else yield char;
    }
    if(high)yield high;
  }
}

module.exports={SMALL_CHARS,isText,isPagedText,info,fromRef,chunks,small,materialize,build,concat,equal,slice,trim,indexOf,equalRange,hash,parseJson,
  coerce,includesAsciiIgnoreCase,preview,replaceLiteral,units,stripDataImages,arrayJoin};
