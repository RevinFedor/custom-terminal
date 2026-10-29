'use strict';

// Byte framing for the existing paged JSON sink on the existing rooted file
// producer. No complete line, JSON record or partial tail is held in RAM.
const fs = require('node:fs');
const { createPagedJsonProjection } = require('./history-paged-json');
const text = require('./history-paged-text');
const { currentReadControl } = require('./history-read-control');
const fault = (code,message=code) => Object.assign(new Error(message),{code});

function* frozenSourceBytes(arena, from, to) {
  const proof=arena.state().sourceProof;
  let offset=0;
  for(let i=0;offset<to&&i<(proof?.length||0);i++) {
    const encoded=proof[i];
    // v6/v7 proof leaves are independently bounded base64 source pages.
    const bytes=Buffer.from(text.small(encoded,arena.store.pageBytes*2),'base64');
    const end=offset+bytes.length;
    if(end>from)yield bytes.subarray(Math.max(0,from-offset),Math.min(bytes.length,to-offset));
    offset=end;
  }
  if(offset<to)throw fault('codex_root_source_proof_missing');
}
function partialStart(file) {
  if(!file)return 0;
  if(file.partial)return file.partial.fromByte;
  // A persisted v6 continuation may contain a paged base64 tail. Its length
  // gives the raw address; the tail itself is replayed from frozen raw pages.
  const value=file.leftover || '';
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0;
  return file.fileSize-(Math.floor(value.length/4)*3-padding);
}

async function readRootedJsonlRange(filePath,startByte,endByte,options) {
  const {arena,sourceStat:expected,oldFile}=options;
  const store=arena.store,demand=options._readControl || options.control || currentReadControl();
  const inputBytes=Math.max(1,Number(options.highWaterMark)||Math.min(store.pageBytes,64*1024));
  const assertCurrent=()=>{demand?.assertCurrent();options.assertCurrent?.();};
  const checkpoint=async()=>{assertCurrent();if(demand?.checkpoint)await demand.checkpoint();else await new Promise(resolve=>setImmediate(resolve));assertCurrent();};
  const metrics=options.metrics || {};
  Object.assign(metrics,{bytes:0,chunks:0,parsed:0,errors:0,replayedPartialBytes:0,maxRecordBytes:0,
    maxInputChunkBytes:0,maxBufferedBytes:0,maxRawCarryBytes:0,maxTokenBytes:0,maxNumericTokenChars:0,
    maxNumericScratchChars:0,maxParserFrames:0,residentParserFrames:0,maxCollectedRecords:0,maxConsumerRecords:0,
    canonicalReducerRouted:true,wholeLineStrings:0,wholeRecordGraphs:0});
  let parser,offset=startByte,line=oldFile?.lineCount || 0,start=oldFile?partialStart(oldFile):startByte;
  const rawBuffer=Buffer.alloc(store.pageBytes);let rawUsed=0;
  let handle,primaryError;
  const openParser=()=>createPagedJsonProjection(store,{selectedTokenBytes:64,canonicalReducerRouted:true});
  const measure=phase=>{
    const stats=parser?.stats();
    if(stats)for(const key of ['maxTokenBytes','maxNumericTokenChars','maxNumericScratchChars','maxParserFrames','residentParserFrames'])
      metrics[key]=Math.max(metrics[key],stats[key]||0);
    options.observe?.({phase,...metrics});
  };
  const flushRaw=()=>{if(rawUsed){options.onChunk(rawBuffer.subarray(0,rawUsed));rawUsed=0;}};
  const retainRaw=bytes=>{for(let at=0;at<bytes.length;){const n=Math.min(rawBuffer.length-rawUsed,bytes.length-at);
    bytes.copy(rawBuffer,rawUsed,at,at+n);rawUsed+=n;at+=n;
    metrics.maxRawCarryBytes=Math.max(metrics.maxRawCarryBytes,rawUsed);
    if(rawUsed===rawBuffer.length)flushRaw();
  }};
  const consume=async(bytes,base,replay=false)=>{
    let at=0;
    while(at<bytes.length){assertCurrent();parser ||= openParser();
      const newline=bytes.indexOf(10,at),end=newline<0?bytes.length:newline;
      parser.write(bytes.subarray(at,end),base+at);measure('parse');
      if(newline<0)break;
      flushRaw();
      const result=parser.finish(base+end);measure('record');
      metrics.maxRecordBytes=Math.max(metrics.maxRecordBytes,base+end-start);
      try{
        if(result.valid){
          metrics.parsed++;metrics.maxConsumerRecords=1;
          await options.onRecord(result.lease.cursor(),{filePath,fromByte:start,toByte:base+end+1,startLine:line});
          assertCurrent();
        }else if(!result.empty){
          metrics.errors++;
          throw fault('CODEX_JSONL_RECORD_INVALID','Invalid committed Codex JSONL record at byte '+start);
        }
      }finally{result.lease?.release();}
      parser=null;line++;start=base+end+1;at=end+1;
    }
    if(replay)metrics.replayedPartialBytes+=bytes.length;
    metrics.maxBufferedBytes=Math.max(metrics.maxBufferedBytes,bytes.length+rawUsed+metrics.maxTokenBytes);
  };
  const assertSource=actual=>{
    if(expected&&(actual.dev!==expected.dev||actual.ino!==expected.ino||actual.size<expected.size
      ||actual.size===expected.size&&(actual.mtimeMs!==expected.mtimeMs||actual.ctimeMs!==expected.ctimeMs)))
      throw fault('CODEX_SOURCE_READ_INVALIDATED');
  };
  try{
    assertCurrent();
    // Replaying only the unfinished record is a bounded restart mechanism,
    // not a history rebuild and not a read from a possibly rewritten inode.
    if(start<startByte){let at=start;for(const bytes of frozenSourceBytes(arena,start,startByte)){
      for(let i=0;i<bytes.length;i+=inputBytes){const part=bytes.subarray(i,i+inputBytes);
        await consume(part,at,true);at+=part.length;await checkpoint();}
    }}
    if(endByte>=startByte){
      handle=await fs.promises.open(filePath,'r');assertCurrent();assertSource(await handle.stat());
      const stream=fs.createReadStream(filePath,{fd:handle.fd,autoClose:false,start:startByte,end:endByte,
        highWaterMark:inputBytes});
      for await(const bytes of stream){assertCurrent();retainRaw(bytes);metrics.maxInputChunkBytes=Math.max(metrics.maxInputChunkBytes,bytes.length);
        await consume(bytes,offset);offset+=bytes.length;metrics.bytes+=bytes.length;metrics.chunks++;
        options.onProgress?.(offset-startByte);await checkpoint();
      }
      assertCurrent();assertSource(await handle.stat());assertSource(await fs.promises.stat(filePath));
      if(offset-startByte!==endByte-startByte+1)throw fault('CODEX_SOURCE_READ_INVALIDATED');
    }
    flushRaw();measure('partial');assertCurrent();
    return {parsed:metrics.parsed,errors:metrics.errors,lineCount:line,
      partial:{fromByte:start,toByte:offset,startLine:line},partialBytes:offset-start};
  }catch(error){primaryError=error;throw error;}
  finally{parser?.abort();try{await handle?.close();}catch(error){if(!primaryError)throw error;}}
}

// Locator fallback on this SAME store/parser. Filename matches remain the
// existing fast path. A long header on a differently named rollout must not
// be joined by the legacy metadata reader before the rooted ingest starts.
// Discovery returns only exact identity, not a materialized metadata record.
async function matchesRootedSessionHead(filePath, sessionId, store, options = {}) {
  const demand=options.control || currentReadControl();
  const assertCurrent=()=>{demand?.assertCurrent();options.assertCurrent?.();};
  let parser,offset=0,lines=0;
  const open=()=>createPagedJsonProjection(store,{selectedTokenBytes:64,canonicalReducerRouted:true});
  const equals=(cursor,expected)=>{
    if(cursor.kind!=='text'||cursor.length!==expected.length)return false;
    let at=0;for(const part of cursor.textChunks()){if(expected.slice(at,at+part.length)!==part)return false;at+=part.length;}
    return at===expected.length;
  };
  const take=end=>{
    const result=parser.finish(end);parser=null;
    try{
      if(!result.valid)return null;
      const root=result.lease.cursor();
      if(root.kind!=='object'||!equals(root.field('type'),'session_meta'))return null;
      const payload=root.field('payload');
      if(payload.kind==='undefined'||payload.kind==='scalar'&&!payload.scalar())return null;
      return payload.kind==='object'&&equals(payload.field('id'),sessionId);
    }finally{result.lease?.release();}
  };
  try{
    for await(const bytes of fs.createReadStream(filePath,{highWaterMark:options.highWaterMark||Math.min(store.pageBytes,64*1024)})){
      assertCurrent();let at=0;
      while(at<bytes.length){parser ||= open();const newline=bytes.indexOf(10,at),end=newline<0?bytes.length:newline;
        parser.write(bytes.subarray(at,end),offset+at);
        options.observe?.({phase:'locate',...parser.stats(),maxInputChunkBytes:bytes.length});
        if(newline<0)break;
        const match=take(offset+end);
        if(match!==null)return match;
        if(++lines>=16)return false;
        at=end+1;
      }
      offset+=bytes.length;
      if(demand?.checkpoint)await demand.checkpoint();else await new Promise(resolve=>setImmediate(resolve));
    }
    assertCurrent();return parser?take(offset)===true:false;
  }finally{parser?.abort();}
}

module.exports={readRootedJsonlRange,frozenSourceBytes,partialStart,matchesRootedSessionHead};
