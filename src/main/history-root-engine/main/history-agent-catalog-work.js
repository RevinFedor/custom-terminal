'use strict';

// Catalog-private cooperative operations. Canonical/full-reader arena grammar
// remains unchanged. A work unit is one container/field/index/loop visit or one
// bounded UTF-16 window (at most128 code units). Existing vector/page operations
// are one bounded backing operation; arbitrary native getters and runtime sink
// allocations belong to the CURRENT continuation, not this work counter.
const { HistoryProjectionArena } = require('./history-projection-arena');
const text = require('./history-paged-text');
const { numericValue, parsePagedDate } = require('./history-agent-catalog-scalars');
const vector = () => ({ page: 0, depth: 0, length: 0 });
const fail = code => Object.assign(new Error(code), {code});
const fieldNames = Object.freeze(['toString','valueOf','join','uuid','role','rowStub','content','thinking','compactSummary','actions','actionSummary',
  'sourceIdentity','sourceIdentityAliases','sessionId','timestamp','recordByteOffset','queueStatus','statusAtSend','settingsFact','version','provider','kind','value',
  'viewOwnerSessionId','tool','rawTool','toolName','family','description','toolUseId','subagentStatus','agentSessionId','agentId','taskPrompt','startedAt',
  'completedAt','durationMs','launchSettings','result','history','length','processGeneration','captionTextComplete',
  'args','command','label','entryUuid','acceptance','taskId','run_in_background','success','error','text',
  'isTurnBusy','agentProcessAlive','currentSessionId','currentProcessGeneration','chipToolType',
  'exactActiveSubagentsSlot','exactActiveBackgroundTasksSlot','terminalBackgroundTaskCallsSlot','terminalFactsSlot',
  'segments','replacements','exclusions','insertions','live','context','rowSlot','start','end','ordinal']);
const fieldIds = new Map(fieldNames.map((key, index) => [key,index])); // fixed schema only
class CatalogArena extends HistoryProjectionArena {
  refAt(meta, key) {
    if (meta.catalogLookup && fieldIds.has(key)) {
      const at=this.store.vectorGet(meta.catalogLookup,fieldIds.get(key));
      return at ? this.store.json(at).value : null;
    }
    return super.refAt(meta,key);
  }
  writeNode(id, meta) {
    // The extra reference is in the ordinary paged ownership tree. No native
    // per-row field dictionary or prototype graph survives normalization.
    this.requireStep();
    const at=this.store.put(meta,[meta.items.page,meta.fields.page,meta.numeric?.page||0,meta.lookup?.page||0,meta.catalogLookup?.page||0]);
    this.owners=this.store.vectorSet(this.owners,id,at);
  }
}
class CatalogWork {
  *work(kind='loop') {
    this.metrics.workUnits++;
    this.metrics.workSinceYield++;
    this.metrics.lastWorkKind=kind;
    if(this.metrics.workSinceYield===64)yield* this.checkpoint();
  }
  *normalizeThin(source) {
    const pending=this.array();
    this.push(pending,source);
    while(pending.length) {
      yield* this.work('thin-node');
      const value=pending.pop(),id=this.arena.owner(value);
      if(id===null)continue;
      let meta=this.arena.node(id);if(meta.catalogThin)continue;
      meta.catalogThin=true;
      if(!['object','array'].includes(meta.kind))throw fail('HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED');
      delete meta.prototype;delete meta.nullPrototype;
      const items=meta.items,fields=meta.fields;
      meta.catalogLookup=vector();
      if(meta.kind==='array'){meta.fields=vector();delete meta.numeric;}
      this.arena.writeNode(id,meta);this.metrics.normalizationNodes++;
      // Native decoder reads indexed arrays only, including holes and length;
      // custom fields/prototypes on arrays are never decoded or traversed.
      const visits=meta.kind==='array'?this.store.vectorPresent(items):this.store.vectorValues(fields);
      for(const visit of visits) {
        if(this.metrics.workSinceYield===63)this.arena.writeNode(id,meta);
        yield* this.work('thin-field');
        const at=meta.kind==='array'?visit.page:visit;
        if(meta.kind==='array'&&visit.ordinal>=meta.length)continue;
        const field=this.store.json(at);if(field.deleted)continue;
        if(meta.kind==='object') {
          const keyMeta=this.store.json(field.key.id);
          if(keyMeta.totalChars<=32) {
            const key=text.small(text.fromRef(this.arena,field.key),32),known=fieldIds.get(key);
            if(known!==undefined)meta.catalogLookup=this.store.vectorSet(meta.catalogLookup,known,at);
          }
        }
        const childMeta=field.value?.type==='page'?this.store.json(field.value.id):field.value?.type==='owner'?this.arena.node(field.value.id):null;
        if(childMeta&&['map','set'].includes(childMeta.kind))throw fail('HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED');
        const child=this.arena.decode(field.value);
        if(child&&typeof child==='object'&&!text.isPagedText(child))this.push(pending,child);
      }
      this.arena.writeNode(id,meta);
    }
  }
  *importNative(value,seen=new WeakMap()) {
    yield* this.work('recipe-import');
    if(text.isPagedText(value)||this.arena.owner(value)!==null)return value;
    if(typeof value==='string')return yield* this.copyText(value);
    if(!value||typeof value!=='object')return value;
    if(seen.has(value))return seen.get(value);
    const proto=Object.getPrototypeOf(value),array=Array.isArray(value),map=value instanceof Map,set=value instanceof Set;
    if(!array&&!map&&!set&&proto!==Object.prototype&&proto!==null)throw fail('history_projection_input_prototype');
    const result=this.arena.make(array?'array':map?'map':set?'set':'object');seen.set(value,result);
    const id=this.arena.owner(result);let meta=this.arena.node(id);
    if(array)meta.length=value.length;else if(!map&&!set)meta.catalogLookup=vector();
    if(proto===null&&!array)meta.nullPrototype=true;
    this.arena.writeNode(id,meta);
    if(map)for(const [key,item]of value){yield* this.work('recipe-map');yield* this.put(result,yield* this.importNative(key,seen),yield* this.importNative(item,seen));}
    if(set)for(const item of value){yield* this.work('recipe-set');yield* this.add(result,yield* this.importNative(item,seen));}
    for(const key in value) {
      yield* this.work('recipe-field');
      if(!Object.hasOwn(value,key))continue;
      const imported=yield* this.importNative(value[key],seen),ref=this.arena.encode(imported);
      meta=this.arena.node(id);
      if(array&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<0xffffffff) {
        meta.items=this.store.vectorSet(meta.items,Number(key),this.store.put({value:ref},[ref.type==='page'?ref.id:0]));
      } else {
        const keyRef=this.arena.encode(yield* this.copyText(key));
        const propertyIndex=/^(0|[1-9]\d{0,9})$/.test(key)&&Number(key)<0xffffffff?Number(key):null;
        const at=this.store.put({key:keyRef,value:ref,propertyIndex},[keyRef.id,ref.type==='page'?ref.id:0]);
        meta.fields=this.store.vectorSet(meta.fields,meta.fields.length,at);
        if(meta.catalogLookup&&fieldIds.has(key))meta.catalogLookup=this.store.vectorSet(meta.catalogLookup,fieldIds.get(key),at);
        if(propertyIndex!==null)meta.numeric=this.store.vectorSet(meta.numeric||vector(),propertyIndex,at);
      }
      this.arena.writeNode(id,meta);
    }
    return result;
  }
  // A draft is only paged immutable roots plus a fixed-width text buffer/hash.
  // It owns no SQL transaction or store builder between checkpoints. Its page
  // references are pinned in the arena owners vector before every suspension.
  draft() {
    const id=this.arena.allocate('array');
    return {id,tree:vector(),length:0,pending:'',digest:this.store.textDigestFactory()};
  }
  draftFlush(draft) {
    if(!draft.pending)return;
    const bytes=Buffer.from(draft.pending,'utf16le');draft.digest.update(bytes);
    draft.length+=draft.pending.length;draft.pending='';
    draft.tree=this.store.vectorSet(draft.tree,draft.tree.length,this.store.put(bytes));
    const meta=this.arena.node(draft.id);meta.items=draft.tree;meta.length=draft.length;
    this.arena.writeNode(draft.id,meta);
  }
  draftWrite(draft,part) {
    const width=this.store.pageBytes/2;
    for(let offset=0;offset<part.length;) { // part is bounded128, width>=128
      const take=Math.min(width-draft.pending.length,part.length-offset);
      draft.pending+=part.slice(offset,offset+take);offset+=take;
      if(draft.pending.length===width)this.draftFlush(draft);
    }
  }
  draftFinish(draft) {
    this.draftFlush(draft);
    const ref={type:'page',id:this.store.put({kind:'text',chunks:draft.tree,totalChars:draft.length,digest:draft.digest.digest('hex')},[draft.tree.page])};
    return text.fromRef(this.arena,ref);
  }
  *copyText(value) {
    if(text.isPagedText(value))return value;
    if(value.length<=128)return value;
    const draft=this.draft();
    for(let at=0;at<value.length;at+=128){yield* this.work('text-import-window');this.draftWrite(draft,value.slice(at,at+128));}
    return this.draftFinish(draft);
  }
  *concat(values,separator='') {
    const draft=this.draft();let first=true;
    for(const value of values) {
      yield* this.work('text-concat-value');
      if(!first)for(const part of text.chunks(separator)){yield* this.work('text-concat-window');this.draftWrite(draft,part);}
      first=false;
      if(value!=null)for(const part of text.chunks(yield* this.primitive(value,'string'))) {
        for(let at=0;at<part.length;at+=128){yield* this.work('text-concat-window');this.draftWrite(draft,part.slice(at,at+128));}
      }
    }
    return this.draftFinish(draft);
  }
  *slice(value,start=0,end=value.length) {
    const norm=n=>Math.max(0,Math.min(value.length,n<0?value.length+n:n));
    const from=norm(Math.trunc(Number(start)||0)),to=Math.max(from,norm(Math.trunc(Number(end)||0)));
    if(from===0&&to===value.length)return value;
    if(to-from<=128)return text.slice(value,from,to);
    const draft=this.draft();
    for(const part of text.chunks(value,from,to))for(let at=0;at<part.length;at+=128){yield* this.work('text-slice-window');this.draftWrite(draft,part.slice(at,at+128));}
    return this.draftFinish(draft);
  }
  *materialize(value) {
    if(!text.isPagedText(value))return value;
    let out='';
    for(const part of text.chunks(value))for(let at=0;at<part.length;at+=128){yield* this.work('native-key-window');out+=part.slice(at,at+128);}
    return out;
  }
  *sameValue(left,right) {
    if(left===right)return true;
    if(!text.isText(left)||!text.isText(right))return this.arena.same(left,right);
    if(left.length!==right.length)return false;
    const a=text.reader(left),b=text.reader(right);
    for(let at=0;at<left.length;at+=128){yield* this.work('text-equality-window');for(let i=at;i<Math.min(at+128,left.length);i++)if(a.at(i)!==b.at(i))return false;}
    return true;
  }
  *indexOf(value,needle,from=0) {
    if(!needle.length)return Math.max(0,Math.min(value.length,from));
    const a=text.reader(value),b=text.reader(needle);
    // Exact bounded-memory search. No pattern-sized native failure table.
    for(let at=from;at+needle.length<=value.length;at++) {
      yield* this.work('text-search-position');let matched=true;
      for(let i=0;i<needle.length;i+=128){yield* this.work('text-search-window');for(let j=i;j<Math.min(i+128,needle.length);j++)if(a.at(at+j)!==b.at(j)){matched=false;break;}if(!matched)break;}
      if(matched)return at;
    }
    return -1;
  }
  *copyField(value,key,nextValue) {
    const original=this.arena.node(this.arena.owner(value)),target=this.arena.make('object'),id=this.arena.owner(target);
    let meta={...original};this.arena.writeNode(id,meta);let ordinal=-1,index=0;
    for(const at of this.store.vectorValues(meta.fields)){
      yield* this.work('object-spread-field');const field=this.store.json(at);
      if(!field.deleted&&(yield* this.sameValue(text.fromRef(this.arena,field.key),key)))ordinal=index;
      index++;
    }
    const keyRef=this.arena.encode(key),valueRef=this.arena.encode(nextValue),at=this.store.put({key:keyRef,value:valueRef,propertyIndex:null},[keyRef.id,valueRef.type==='page'?valueRef.id:0]);
    meta.fields=this.store.vectorSet(meta.fields,ordinal<0?meta.fields.length:ordinal,at);
    this.arena.writeNode(id,meta);return target;
  }
  *queueHash(raw) {
    // The literal sequence is strip paired system-reminder regions, strip
    // bracket markers, trim/collapse whitespace, then FNV over UTF-16 units.
    const regions=this.array();let from=0;
    for(;;){
      yield* this.work('queue-region');const open=yield* this.indexOf(raw,'<system-reminder>',from);
      if(open<0)break;const close=yield* this.indexOf(raw,'</system-reminder>',open+17);
      if(close<0)break;
      this.push(regions,this.record({start:from,end:open}));from=close+18;
    }
    this.push(regions,this.record({start:from,end:raw.length}));
    const draft=this.draft();
    for(const region of regions)for(const part of text.chunks(raw,region.start,region.end))for(let at=0;at<part.length;at+=128){yield* this.work('queue-region-window');this.draftWrite(draft,part.slice(at,at+128));}
    let stripped=this.draftFinish(draft);
    for(const marker of ['[200~','~]']){const next=this.draft();for(let at=0;at<stripped.length;){yield* this.work('queue-marker-unit');if(stripped.startsWith(marker,at)){at+=marker.length;continue;}this.draftWrite(next,text.small(text.slice(stripped,at,++at)));}stripped=this.draftFinish(next);}
    const scan=text.reader(stripped);let hash=0x811c9dc5,seen=false,space=false;
    for(let at=0;at<stripped.length;){
      yield* this.work('queue-normalize-unit');
      const char=scan.at(at++);
      if(/\s/u.test(char)){space=seen;continue;}
      if(space){hash=Math.imul(hash^32,0x01000193)>>>0;space=false;}
      hash=Math.imul(hash^char.charCodeAt(0),0x01000193)>>>0;seen=true;
    }
    return seen?hash:null;
  }
  *primitive(value,hint='string') {
    if(text.isText(value)||value===null||typeof value!=='object')return value;
    const id=this.arena.owner(value);if(id===null)return hint==='string'?String(value):Number(value);
    for(const name of hint==='string'?['toString','valueOf']:['valueOf','toString']) {
      yield* this.work('primitive-method');
      const method=this.arena.resolveProperty(id,name);if(typeof method!=='function')continue;
      let result;
      if(method===Object.prototype.valueOf)result=value;
      else if(method===Array.prototype.toString) {
        const join=this.arena.resolveProperty(id,'join');
        result=join===Array.prototype.join?yield* this.arrayString(value):typeof join==='function'?Reflect.apply(join,value,[]):Object.prototype.toString.call(value);
      } else result=Reflect.apply(method,value,[]);
      if(text.isText(result)||result===null||typeof result!=='object'&&typeof result!=='function')return result;
    }
    throw new TypeError('Cannot convert object to primitive value');
  }
  *arrayString(value) {
    const draft=this.draft(),stack=this.array();let frame=this.record({owner:this.arena.owner(value),index:0,length:value.length});
    for(;;) {
      yield* this.work('array-coercion-slot');
      if(frame.index===frame.length){if(!stack.length)break;frame=stack.pop();continue;}
      if(frame.index)this.draftWrite(draft,',');
      const item=this.arena.get(frame.owner,String(frame.index++));if(item==null)continue;
      const child=Array.isArray(item)?this.arena.owner(item):null;
      if(child!==null&&this.arena.resolveProperty(child,'toString')===Array.prototype.toString&&this.arena.resolveProperty(child,'join')===Array.prototype.join) {
        let cyclic=child===frame.owner;
        for(const old of stack){yield* this.work('array-coercion-ancestor');if(old.owner===child){cyclic=true;break;}}
        if(cyclic)continue;
        this.push(stack,frame);frame=this.record({owner:child,index:0,length:item.length});
      } else {
        const string=yield* this.primitive(item,'string'),converted=text.isText(string)?string:String(string);
        for(const part of text.chunks(converted))for(let at=0;at<part.length;at+=128){yield* this.work('array-coercion-window');this.draftWrite(draft,part.slice(at,at+128));}
      }
    }
    return this.draftFinish(draft);
  }
  *numeric(value) {return yield* numericValue.call(this,yield* this.primitive(value,'number'));}
  *parseDate(value) {const string=yield* this.primitive(value,'string');return text.isPagedText(string)?yield* parsePagedDate.call(this,string):Date.parse(string);}
  *hashKey(key) {
    const id=this.arena.owner(key);
    if(id!==null)key='owner:'+id;
    else if(!text.isText(key))key=typeof key+':'+String(key===0?0:key);
    const digest=this.store.textDigestFactory();
    for(const part of text.chunks(key))for(let at=0;at<part.length;at+=128){yield* this.work('map-key-window');digest.update(Buffer.from(part.slice(at,at+128),'utf16le'));}
    return parseInt(digest.digest('hex').slice(0,8),16)>>>0;
  }
  *find(map,key) {
    const id=this.arena.owner(map),meta=this.arena.node(id),hash=yield* this.hashKey(key);
    let at=this.store.vectorGet(meta.lookup,hash);
    while(at) {
      yield* this.work('map-key-collision');
      const link=this.store.json(at),value=this.store.json(this.store.vectorGet(meta.items,link.ordinal));
      const prior=this.arena.decode(value.key);
      if(!value.deleted&&(yield* this.sameValue(prior,key)||Number.isNaN(prior)&&Number.isNaN(key)))return {ordinal:link.ordinal,value,hash};
      at=link.next;
    }
    return {ordinal:-1,hash};
  }
  *lookup(map,key){const found=yield* this.find(map,key);return found.ordinal<0?undefined:this.arena.decode(found.value.value);}
  *contains(map,key){return (yield* this.find(map,key)).ordinal>=0;}
  *put(map,key,value) {
    yield* this.work('map-set');
    key=typeof key==='string'?yield* this.copyText(key):key;
    const found=yield* this.find(map,key),id=this.arena.owner(map),keyRef=this.arena.encode(key),valueRef=this.arena.encode(value),meta=this.arena.node(id);
    const ordinal=found.ordinal<0?meta.items.length:found.ordinal;
    const at=this.store.put({key:keyRef,value:valueRef},[keyRef.type==='page'?keyRef.id:0,valueRef.type==='page'?valueRef.id:0]);
    meta.items=this.store.vectorSet(meta.items,ordinal,at);
    if(found.ordinal<0){const next=this.store.vectorGet(meta.lookup,found.hash),link=this.store.put({ordinal,next},[next]);meta.lookup=this.store.vectorSet(meta.lookup,found.hash,link);meta.size++;}
    this.arena.writeNode(id,meta);return map;
  }
  *add(map,key){return yield* this.put(map,key,key);}
  *remove(map,key) {
    const found=yield* this.find(map,key);if(found.ordinal<0)return false;
    const id=this.arena.owner(map),meta=this.arena.node(id),at=this.store.put({...found.value,deleted:true},[found.value.key.type==='page'?found.value.key.id:0]);
    meta.items=this.store.vectorSet(meta.items,found.ordinal,at);meta.size--;this.arena.writeNode(id,meta);return true;
  }
}
module.exports={CatalogWork,CatalogArena};
