import { readHistoryPrimaryEntryBody } from './historyPrimaryEntryBody.mjs';
// Primary History owns a view lease and a finite body window. The early
// all-action-stub compatibility index is deliberately a separate OPEN owner.
// It must never be populated by capturing/slicing a full History DTO.
import { createDocumentUtf16Digest } from './documentUtf16Digest.mjs';
import { readHistoryPrimaryPromptAdoption, prepareHistoryPrimaryPromptAdoption,
  prepareHistoryPrimarySparsePromptAdoption } from './historyPrimaryPromptAdoption.mjs';
import { createHistoryPrimaryPreparedOwner } from './historyPrimaryPreparedOwner.mjs';
import { registerHistoryPrimaryMetadataOrigin } from './historyPrimaryMetadataOrigin.mjs';
import { readHistoryPrimaryLaterCanonicalReceipt, readHistoryPrimaryTerminalPreviewMembership,
  readHistoryPrimaryConfirmedCanonicalReceipt } from './historyPrimaryCanonicalConsumers.mjs';
import { readHistoryPrimaryEffectiveSettings } from './historyPrimaryEffectiveSettings.mjs';
import { readHistoryPrimaryLiveIdentityCoverage, captureHistoryPrimaryLiveClaimWitness } from './historyPrimaryLiveIdentityCoverage.mjs';
import { HistoryRootClient, checkedHistoryPrimaryReuseHeader,
  checkedHistoryPrimaryCanonicalMetadataFact } from './historyRootReadClient.mjs';
import metadataRules from '../../shared/history-primary-metadata-rules.cjs';
import { readHistoryPrimaryPresentationAddresses, historyPrimaryAddressMatchesCut,
  requireHistoryPrimaryAddressCapability } from './historyPrimaryPresentationAddress.mjs';
export const HISTORY_PRIMARY_PROFILE = 'history-primary-v1';
// The shared reader returns at most three collection items per packet. A
// viewport spans several packets; its visible row count is not a page limit.
const HISTORY_PRIMARY_PAGE_ITEMS = 3;
// Keep only a small corridor of already-read bodies for reverse/nearby scroll.
// This is a row-retention bound, not a claim about one giant body's native size
// or the separate still-open prepared metadata owner. No speculative reads.
const HISTORY_PRIMARY_LOADED_MARGIN_ROWS = 6;
export const HISTORY_PRIMARY_FIELDS = Object.freeze([
  'kind', 'key', 'rank', 'firstUuid', 'lastUuid', 'entryCount', 'expanded',
]);
const identityFields = ['leaseId', 'ownerKey', 'revision', 'generation'];
const fail = code => Object.assign(new Error(code), { code });
const current = (signal, owns) => {
  if (signal?.aborted || owns() !== true) throw fail('HISTORY_READ_CANCELLED');
};
const same = (a, b) => identityFields.every(key => a?.[key] === b?.[key]);
const release = resource => Promise.resolve().then(() => resource?.close()).catch(error => {
  console.warn('[HistoryPrimary] release-failed code=' + String(error?.code || error?.message || error));
});
export const historyPrimaryUnitKey = unit => unit?.kind === 'group'
  ? 'group:' + unit.key : 'entry:' + (unit?.entry?.uuid || unit?.firstUuid || '');
export function historyPrimaryColdReadWakeAllowed({ enabled, toolType, supported, hasRoot, failure, ownerKey, record }) {
  return enabled && toolType === 'codex' && supported && !hasRoot
    && (!failure || failure.ownerKey !== ownerKey || failure.kind === 'source-changed')
    && Number.isSafeInteger(record?.sourceSequence) && record.sourceSequence >= 0
    && Number.isSafeInteger(record?.recordByteOffset) && record.recordByteOffset >= 0;
}

// The prepared read view already contains the captured local overlay. Never
// feed its thin copies back as new authoring rows. Current client-owned rows
// retain their text/status/sidecars; only genuinely late IDs need the existing
// causal merge. Canonical adoption and Rewind visibility stay with preparation.
function primaryLocalIndex(currentRows, isLocal) {
  const currentLocals = new Map();
  for (const row of currentRows) if (isLocal(row)) {
    const previous = currentLocals.get(row.uuid);
    if (previous && ['handoffId', 'sendOperationKey', 'sendAttemptId'].some(key =>
      previous[key] != null && row[key] != null && previous[key] !== row[key])) {
      throw fail('HISTORY_PRIMARY_LOCAL_IDENTITY_CONFLICT');
    }
    // An earlier bad view may have retained thin duplicate copies. They may
    // not displace the original authoring owner, even when encountered later.
    if (!previous || previous.rowStub || !row.rowStub) currentLocals.set(row.uuid, row);
  }
  return currentLocals;
}
export function selectHistoryPrimaryLocalRows(currentRows, isLocal) {
  return [...primaryLocalIndex(currentRows, isLocal).values()];
}
export function adoptHistoryPrimaryMetadata(prepared, currentRows, capturedLocalRows, { isLocal, mergeLate }) {
  const currentLocals = primaryLocalIndex(currentRows, isLocal);
  const captured = new Set(capturedLocalRows.map(row => row.uuid)), seen = new Set();
  const rows = [];
  for (const row of prepared) {
    if (!isLocal(row)) { rows.push(row); continue; }
    const owned = currentLocals.get(row.uuid);
    // Dismissal/current local state wins after awaits. A read cannot resurrect
    // a removed local card or turn a metadata stub into its authoring owner.
    if (!owned || seen.has(row.uuid)) continue;
    seen.add(row.uuid); rows.push(owned);
  }
  const late = [...currentLocals.values()].filter(row => !captured.has(row.uuid) && !seen.has(row.uuid));
  return late.length ? mergeLate(rows, late) : rows;
}

// Full typed SHA256(UTF16LE) binding to ONE current claim, never a body
// clone or a digest prefix. Mirrors the held overlay's existing graph digest.
// Strings use fixed scratch; object identity traversal is per current value,
// not a retained all-result/history inventory. Equality of durable values is
// decided separately by the producer's exact cursor predicate.
export function historyPrimaryToolClaimFingerprint(value) {
  const { createHash } = window.require('node:crypto');
  const hash = createHash('sha256'), bytes = new Uint8Array(4096), seen = new Map();
  const tag = v => hash.update(v + ';');
  function string(v) {
    tag('text');tag(v.length);
    for (let start=0;start<v.length;start+=2048) {
      const n=Math.min(2048,v.length-start);
      for(let i=0;i<n;i++){const c=v.charCodeAt(start+i);bytes[i*2]=c&255;bytes[i*2+1]=c>>>8;}
      hash.update(bytes.subarray(0,n*2));
    }
  }
  const index = k => /^(0|[1-9][0-9]*)$/.test(k) && Number(k)<0xffffffff;
  function* fields(v,kind) {
    if(kind==='array') {
      yield {tag:'length:'+v.length};
      for(const k in v)if(Object.hasOwn(v,k)&&index(k))yield {tag:'index:'+k,value:v[k],present:true};
    }
    if(kind==='map'||kind==='set')for(const pair of kind==='map'?v.entries():v.values()) {
      yield {tag:'key',value:kind==='map'?pair[0]:pair,present:true};
      if(kind==='map')yield {tag:'value',value:pair[1],present:true};
    }
    for(const k in v)if(Object.hasOwn(v,k)&&!(kind==='array'&&index(k))) {
      yield {tag:'field',value:k,present:true};yield {tag:'value',value:v[k],present:true};
    }
  }
  const stack=[{value}];
  while(stack.length) {
    const frame=stack.at(-1);
    if(frame.children){const n=frame.children.next();if(n.done){tag('end');stack.pop();continue;}
      if(n.value.tag!==undefined)tag(n.value.tag);if(n.value.present)stack.push({value:n.value.value});continue;}
    const v=frame.value,type=typeof v;
    if(type==='string'){string(v);stack.pop();continue;}
    if(!v||type!=='object') {
      const kind=type==='number'?'number':type==='bigint'?'bigint':v===undefined||type==='function'||type==='symbol'?'undefined':'scalar';
      tag(kind);tag(kind==='undefined'?'undefined':type==='number'&&Object.is(v,-0)?'-0':String(v));stack.pop();continue;
    }
    const kind=Array.isArray(v)?'array':v instanceof Map?'map':v instanceof Set?'set':'object';tag(kind);
    const proto=Object.getPrototypeOf(v);
    if(kind==='object'&&proto!==Object.prototype&&proto!==null)throw fail('HISTORY_PRIMARY_TOOL_CLAIM_PROTOTYPE');
    if(seen.has(v)){tag('ref:'+seen.get(v));stack.pop();continue;}
    seen.set(v,seen.size);tag('id:'+(seen.size-1));tag(proto===null?'null-prototype':'standard-prototype');
    frame.children=fields(v,kind);
  }
  return hash.digest('hex');
}
// Fresh native live identities/settings complement the existing graph witness
// for inherited/nonenumerable grammar inputs; tool coverage keeps its contract.
export function historyPrimaryLiveClaimFingerprint(value) {
  return historyPrimaryToolClaimFingerprint(captureHistoryPrimaryLiveClaimWitness(value));
}
// Called synchronously by the real Panel commit callback. Re-read the CURRENT
// value, including mutations within an unchanged Map/record/ID, before delete.
export function applyHistoryPrimaryToolCoverage(currentResults, proofs) {
  let next=currentResults;
  for(const proof of proofs) {
    if(!currentResults.has(proof.key)||historyPrimaryToolClaimFingerprint(currentResults.get(proof.key))!==proof.fingerprint)continue;
    if(next===currentResults)next=new Map(currentResults);
    next.delete(proof.key);
  }
  return next;
}

function assertThin(rows, { captionText = false } = {}) {
  if (!Array.isArray(rows)) throw fail('HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN');
  for (const row of rows) if (!metadataRules.nativeThinHistoryMetadataRow(row, captionText)) {
    throw fail('HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN');
  }
  return rows;
}

// An explicit, independently leased one-unit compatibility sink. No preview,
// truncation, newline normalization or JSON reviver may alter a visible body.
// UTF16 offsets and SHA256(UTF16LE) match the Source descriptor (the separate
// payload contentHash uses UTF8 and must not be substituted for this digest).
// leaf protocol. Native RichFull / one-row sink memory remains OPEN.
async function readPrimaryDocumentText(document, { signal, owns = () => true } = {}) {
  try {
    current(signal, owns);
    const hash = await createDocumentUtf16Digest();
    current(signal, owns);
    const parts = [];
    let length = 0;
    for await (const part of document.chunks({ signal })) {
      current(signal, owns);
      hash.update(part); parts.push(part); length += part.length;
    }
    if (length !== document.length) throw fail('HISTORY_PRIMARY_DOCUMENT_LENGTH');
    const text = parts.join('');
    const digest = hash.digest();
    current(signal, owns);
    if (digest !== document.digest) throw fail('HISTORY_PRIMARY_DOCUMENT_DIGEST');
    return text;
  } finally { await release(document); }
}
export async function readHistoryPrimaryUnitDocument(document, options = {}) {
  const text = await readPrimaryDocumentText(document, options);
  current(options.signal, options.owns || (() => true));
  const { deserialize } = window.require('node:v8');
  const { Buffer } = window.require('node:buffer');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) throw fail('HISTORY_PRIMARY_DOCUMENT_BASE64');
  return deserialize(bytes);
}

// Explicit early compatibility owner, not the body read plane. Decode only
// the signed sourceMetadata subtree, retaining old all-ID/action-stub fields.
// The native graph/identity table below is OPEN metadata memory. Unit bodies
// always use the independent V8 document instead of this decoder.
async function readActionMetadata(reader, descriptor, { signal, owns, metadataRowWindow }) {
  const profile = metadataRowWindow?.profile === 'primary-metadata-fields-v1'
    && Number.isSafeInteger(reader.pageBytes) && reader.pageBytes >= metadataRowWindow.minimumCreditBytes
    && typeof reader.rowWindow === 'function' ? metadataRowWindow.profile : undefined;
  const decoded = new Map(), pending = [];
  const value = async node => {
    current(signal, owns);
    if (!node || typeof node !== 'object' || !node.protocol) return node;
    if (decoded.has(node.nodeToken)) return decoded.get(node.nodeToken);
    if (node.kind === 'text') {
      const document = await reader.forkText(node, { signal });
      const result = await readPrimaryDocumentText(document, { signal, owns });
      decoded.set(node.nodeToken, result); return result;
    }
    if (!metadataRules.HISTORY_PRIMARY_METADATA_CONTAINER_KINDS.includes(node.kind)) throw fail('HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED');
    const result = node.kind === 'array' ? new Array(node.length) : {};
    decoded.set(node.nodeToken, result); pending.push({ node, result }); return result;
  };
  const result = await value(descriptor);
  while (pending.length) {
    const frame = pending.pop(); let offset = 0;
    for (;;) {
      current(signal, owns);
      const array=frame.node.kind==='array';
      const rootArray = profile && frame.node.nodeToken === descriptor.nodeToken;
      const page = array ? await reader.range(frame.node, { offset, limit: HISTORY_PRIMARY_PAGE_ITEMS, signal,
          ...(rootArray ? { profile } : {}) })
        : await reader.fields(frame.node, { offset, limit: HISTORY_PRIMARY_PAGE_ITEMS, signal });
      current(signal, owns);
      for (const item of page.items) {
        if(array&&item.present===false)continue;
        const name = array ? String(item.ordinal) : await value(item.name);
        if (typeof name !== 'string') throw fail('HISTORY_PRIMARY_METADATA_FIELD');
        let fields;
        if (rootArray && item.value?.kind === 'object' && !decoded.has(item.value.nodeToken)
          && Number.isSafeInteger(item.rowWindowCreditBytes) && item.rowWindowCreditBytes <= reader.pageBytes) {
          const row = await reader.rowWindow(frame.node, { offset: item.ordinal, limit: 1, profile, signal });
          current(signal, owns);
          if (row.rows[0]?.entry.nodeToken !== item.value.nodeToken) throw fail('HISTORY_PRIMARY_METADATA_ROW_IDENTITY');
          fields = row.rows[0].fields;
        }
        const selected = await value(item.value);
        if (fields) {
          // Consume this one packet now. Do not enqueue per-row wire arrays
          // until the all-ID root has finished: that would retain N packets.
          const rowFrame = pending.pop();
          if (rowFrame?.node.nodeToken !== item.value.nodeToken || rowFrame.result !== selected) {
            throw fail('HISTORY_PRIMARY_METADATA_ROW_IDENTITY');
          }
          for (const field of fields) {
            current(signal, owns);
            const fieldName = await value(field.name);
            if (typeof fieldName !== 'string') throw fail('HISTORY_PRIMARY_METADATA_FIELD');
            Object.defineProperty(selected, fieldName, { value: await value(field.value),
              enumerable: true, configurable: true, writable: true });
          }
        }
        Object.defineProperty(frame.result, name, { value: selected,
          enumerable: true, configurable: true, writable: true });
      }
      if (page.done) break;
      if (page.nextOffset <= offset) throw fail('HISTORY_PRIMARY_METADATA_PROGRESS');
      offset = page.nextOffset;
    }
  }
  // The independent selected owner uses this same decoder for ONE signed
  // metadata row. It never wraps or forges a shortened historical array.
  return descriptor.kind === 'array' ? assertThin(result) : assertThin([result])[0];
}

// Only server-decoded prepared Np containers enter this traversal. Canonical
// Nc is validated at its source owner and never decoded/frozen/retained here.
// Current authoring rows are substituted afterwards and remain owned/mutable.
function freezePreparedMetadata(metadata) {
  registerHistoryPrimaryMetadataOrigin(metadata.entries);
  const seen = new Set(), pending = [metadata];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) pending.push(child);
    Object.freeze(value);
  }
  return metadata;
}
function retainedMetadata(previous, header) {
  if (!previous?.serverMetadata || !header.metadataIdentity || !previous.header.metadataIdentity
    || previous.header.ownerKey !== header.ownerKey || previous.header.generation !== header.generation
    || previous.header.metadataIdentity !== header.metadataIdentity) return null;
  if (previous.header.metadataSchema !== header.metadataSchema
    || previous.header.semanticIdentity !== header.semanticIdentity
    || previous.header.canonicalEntryCount !== header.canonicalEntryCount
    || previous.header.sourceEntryCount !== header.sourceEntryCount
    || previous.header.sourceMetadata.length !== header.sourceMetadata.length
    || previous.header.durableMetadata.length !== header.durableMetadata.length) {
    throw fail('HISTORY_PRIMARY_METADATA_IDENTITY_CONFLICT');
  }
  return previous.serverMetadata;
}
const recomposeRequired = (requiredClass, reason) => ({ kind: 'recompose-required', requiredClass, reason });
function checkedRecompose(result) {
  if (result?.success !== false || result.error !== 'HISTORY_PRIMARY_VIEW_RECOMPOSE_REQUIRED') return null;
  if (!['semantic', 'source'].includes(result.requiredClass) || typeof result.reason !== 'string'
    || !result.reason || result.reason.length > 160 || /[\u0000-\u001f\u007f-\u009f]/u.test(result.reason)) {
    throw fail('HISTORY_PRIMARY_RECOMPOSE_INVALID');
  }
  return recomposeRequired(result.requiredClass, result.reason);
}

// A local, non-owning consumer of an already held signed lease. Generic
// page failures may abandon this probe, never release the shared parent.
// forkText still creates an ordinary independent child with its own close.
class HistoryPrimaryUuidProbeClient extends HistoryRootClient {
  close() { return this.abandon(); }
}
async function streamCanonicalUuid(model, view, uuid, { signal, owns, sequence }) {
  const header=view.header, root=view.root, parent=view.reader, durable=header.durableMetadata;
  const check=()=>{
    current(signal,()=>!model.closed&&model.view===view&&view.header===header&&view.root===root
      &&view.reader===parent&&model.sequence===sequence&&owns());
    parent.assertOpen();
  };
  check();
  const probe=new HistoryPrimaryUuidProbeClient((channel,payload)=>channel===parent.pageChannel
    ? model.transport.readHistoryThroughIpc(parent.invoke,channel,payload,{signal}) : parent.invoke(channel,payload),
  durable,{pageBytes:parent.pageBytes,pageItems:Math.min(HISTORY_PRIMARY_PAGE_ITEMS,parent.pageItems),
    pageChannel:parent.pageChannel,releaseChannel:parent.releaseChannel,forkChannel:parent.forkChannel});
  let answer=false, failed=false;
  try {
    for(let offset=0;offset<durable.length;) {
      check();
      const page=await probe.range(durable,{offset,limit:probe.pageItems});
      check();
      if(page.length!==durable.length||page.nextOffset!==offset+page.items.length
        ||page.nextOffset>durable.length||page.done!==(page.nextOffset===durable.length)) {
        throw fail('HISTORY_PRIMARY_CANONICAL_UUID_RANGE');
      }
      for(const item of page.items) {
        check();
        if(item.present===false)continue;
        if(item.present!==true||!same(header,item.value)||item.value?.kind!=='object') {
          throw fail('HISTORY_PRIMARY_CANONICAL_UUID_RANGE');
        }
        // Known producer field; do not enumerate/decode row metadata or IDs.
        const selected=await probe.project(item.value,['uuid'],{offset:0,limit:1});
        check();
        if(!selected.done||selected.length!==1||selected.nextOffset!==1||selected.items.length!==1
          ||selected.items[0].name!=='uuid')throw fail('HISTORY_PRIMARY_CANONICAL_UUID_FIELD');
        const candidate=selected.items[0].value;
        if(typeof candidate==='string')answer=candidate===uuid;
        else if(candidate?.kind==='text'&&candidate.length===uuid.length) {
          const document=await probe.forkText(candidate,{signal});
          try {
            check();
            const digest=await createDocumentUtf16Digest();
            check();
            let at=0, matches=true;
            while(at<document.length) {
              // Fixed scratch even when the credit or requested UUID is large.
              const part=await document.read(at,Math.min(1024,document.length-at),{signal});
              check();
              if(!part.text.length)throw fail('HISTORY_PRIMARY_CANONICAL_UUID_PROGRESS');
              if(part.text!==uuid.slice(at,part.nextOffset)){matches=false;break;}
              digest.update(part.text);at=part.nextOffset;
            }
            if(matches&&digest.digest()!==document.digest)throw fail('HISTORY_PRIMARY_DOCUMENT_DIGEST');
            answer=matches;
          } finally {
            await document.close();
            check();
          }
        }
        if(answer)break;
      }
      if(answer)break;
      offset=page.nextOffset;
    }
    check();
  } catch(error) { failed=true;throw error; }
  finally {
    await probe.abandon(); // No lease release, including after UNKNOWN/refusal.
    if(!failed)check();
  }
  return answer;
}

// Same non-owning probe as the UUID fallback, with the narrower prompt
// predicate. Keep bounded descriptor pages and one text chunk, never a native row,
// alias Set, candidate UUID copy or decoded metadata inventory.
async function findCanonicalPromptIdentity(model, view, exact, { signal, owns, sequence }) {
  const header=view.header, root=view.root, parent=view.reader, durable=header.durableMetadata;
  const check=()=>{
    current(signal,()=>!model.closed&&model.view===view&&view.header===header&&view.root===root
      &&view.reader===parent&&model.sequence===sequence&&owns());
    parent.assertOpen();
  };
  check();
  const probe=new HistoryPrimaryUuidProbeClient((channel,payload)=>channel===parent.pageChannel
    ? model.transport.readHistoryThroughIpc(parent.invoke,channel,payload,{signal}) : parent.invoke(channel,payload),
  root,{pageBytes:parent.pageBytes,pageItems:Math.min(HISTORY_PRIMARY_PAGE_ITEMS,parent.pageItems),
    pageChannel:parent.pageChannel,releaseChannel:parent.releaseChannel,forkChannel:parent.forkChannel});
  const rowItem=item=>{
    if(!Number.isSafeInteger(item?.ordinal)||item.ordinal<0||item.ordinal>=durable.length
      ||!same(header,item.value)||item.value?.kind!=='object')throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_RANGE');
    return {ordinal:item.ordinal,row:item.value};
  };
  const range=async(node,offset,limit=probe.pageItems)=>{
    check();
    // These generic parent-capability pulls have no lifetime-owning signal.
    const page=await probe.range(node,{offset,limit});
    check();
    if(page.length!==node.length||page.nextOffset!==offset+page.items.length||page.nextOffset>node.length
      ||page.done!==(page.nextOffset===node.length))throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_RANGE');
    return page;
  };
  const matches=async candidate=>{
    check();
    if(typeof candidate==='string')return candidate===exact;
    if(candidate?.kind!=='text'||candidate.length!==exact.length)return false;
    const document=await probe.forkText(candidate,{signal});
    try {
      check();
      const digest=await createDocumentUtf16Digest();
      check();
      let at=0;
      while(at<document.length) {
        const part=await document.read(at,Math.min(1024,document.length-at),{signal});
        check();
        if(!part.text.length)throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_PROGRESS');
        if(part.text!==exact.slice(at,part.nextOffset))return false;
        digest.update(part.text);at=part.nextOffset;
      }
      if(digest.digest()!==document.digest)throw fail('HISTORY_PRIMARY_DOCUMENT_DIGEST');
      return true;
    } finally { await document.close();check(); }
  };
  const aliasesMatch=async aliases=>{
    check();
    if(aliases?.kind!=='array')return false; // Array.isArray in the unchanged oracle.
    if(!Number.isSafeInteger(aliases.length)||aliases.length<0)throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_RANGE');
    for(let offset=0;offset<aliases.length;) {
      const page=await range(aliases,offset);
      for(const item of page.items) {
        check();
        if(item.present===false)continue;
        if(item.present!==true)throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_RANGE');
        if(await matches(item.value))return true;
      }
      offset=page.nextOffset;
    }
    return false;
  };
  const rowMatches=async row=>{
    const fields=['uuid','sourceIdentity','sourceIdentityAliases','sourceUuidAliases'];
    for(let offset=0;offset<fields.length;) {
      check();
      const page=await probe.project(row,fields,{offset,limit:probe.pageItems});
      check();
      if(page.length!==fields.length||page.nextOffset!==offset+page.items.length||page.nextOffset>fields.length
        ||page.done!==(page.nextOffset===fields.length)
        ||page.items.some((item,index)=>item.name!==fields[offset+index]))throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_FIELD');
      for(let index=0;index<page.items.length;index++) {
        const item=page.items[index];
        if(offset+index<2 ? await matches(item.value) : await aliasesMatch(item.value))return true;
      }
      offset=page.nextOffset;
    }
    return false;
  };
  let failed=false;
  try {
    // Mandatory dedicated producer proof, including before a long scan. An
    // older generic field scan cannot masquerade as an exact empty result.
    const point=exact.length<=2048&&new TextEncoder().encode(exact).byteLength<=4096;
    const proved=await probe.primaryPromptIdentity(durable,{header,mode:point?'point':'scan',value:point?exact:null});
    check();
    if(point)return proved.match;
    const canonical=proved.canonical;
    for(let offset=0;offset<canonical.length;) {
      const page=await range(canonical,offset);
      for(const item of page.items) {
        check();
        if(item.present===false)continue;
        if(item.present!==true)throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_RANGE');
        const candidate=rowItem(item);
        if(await rowMatches(candidate.row)) {
          // Compare complete semantic fields; return only the signed metadata
          // object at the same canonical ordinal, independent of stub fields.
          const selected=await range(durable,item.ordinal,1);
          check();
          if(selected.items.length!==1||selected.items[0].present!==true)throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_RANGE');
          return rowItem(selected.items[0]);
        }
      }
      offset=page.nextOffset;
    }
    check();return null;
  } catch(error) { failed=true;throw error; }
  finally { await probe.abandon();if(!failed)check(); }
}

/** No module-global pool. Independent panels never share cancellation. */
export class HistoryPrimaryRootReadModel {
  constructor(invoke, transport, { creditBytes = 65536 } = {}) {
    this.invoke = invoke; this.transport = transport;
    this.creditBytes = creditBytes; this.view = null; this.window = new Map(); this.addresses = new Map();
    this.listeners = new Set(); this.metadataListeners = new Set(); this.receiptWakeListeners = new Set();
    this.sequence = 0; this.windowSequence = 0; this.windowController = null; this.windowTask = null; this.closed = false;
    this.pageTask = null; this.requestedWindow = null;
    this.rangeRevision = 0; this.adoptionSequence = 0; this.surfaceSequence = 0;
    this.surface = null; this.presentation = null; this.activeWindow = null; this.pendingWindow = null;
  }
  get totalCount() { return this.view?.header.totalEntries || 0; }
  get header() { return this.view?.header || null; }
  get metadata() { return this.view?.metadata || null; }
  unitAt(index) { return this.window.get(index); }
  addressAt(index) { return this.addresses.get(index); }
  matchesSnapshotUnit(snapshot, index, unit) {
    const view = this.view, address = snapshot?.addresses?.get(index);
    return !this.closed && !!view && snapshot?.adoptionId === view.adoptionId
      && snapshot.header === view.header && snapshot.window.get(index) === unit
      && this.window.get(index) === unit && this.addresses.get(index) === address
      && !!unit && historyPrimaryAddressMatchesCut(address, view.header)
      && address.index === index && view.unitAddresses.get(unit) === address;
  }
  subscribe(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onMetadata(listener) { this.metadataListeners.add(listener); return () => { this.metadataListeners.delete(listener); }; }
  onReceiptReadWake(listener) { this.receiptWakeListeners.add(listener); return () => { this.receiptWakeListeners.delete(listener); }; }
  emitReceiptReadWake(kind, sequence, view) {
    const current = () => !this.closed && sequence === this.sequence && !!view?.receiptDataSubject && this.view === view;
    if (!current()) return;
    const event = Object.freeze({ kind, sequence, header: view.header, dataSubject: view.receiptDataSubject });
    for (const listener of [...this.receiptWakeListeners]) {
      if (!current()) break;
      if (!this.receiptWakeListeners.has(listener)) continue;
      try { listener(event); }
      catch (error) { console.warn('[HistoryPrimary] RECEIPT_WAKE_FAILED code=' + String(error?.code || 'UNKNOWN')); }
    }
  }
  getReceiptDataSubject() { return this.closed ? null : this.view?.receiptDataSubject || null; }
  retainPreparedPresentation(options) {
    if (this.closed || !this.view?.prepared) throw fail('HISTORY_PRIMARY_PREPARED_OWNER_REQUIRED');
    return this.view.prepared.retain(options);
  }
  notify() { for (const listener of this.listeners) listener(); }
  windowDiagnostic(event,fields={}) {
    console.log('[HistoryPrimary] ' + event + ' ' + JSON.stringify({tabId:this.view?.address?.tabId,
      leaseId:this.header?.leaseId,adoptionId:this.view?.adoptionId,rangeRevision:this.rangeRevision,...fields}));
  }
  renderSnapshot() {
    const view = this.view;
    return view ? Object.freeze({ header: view.header, adoptionId: view.adoptionId,
      totalCount: view.header.totalEntries, window: new Map(this.window), addresses: new Map(this.addresses) }) : null;
  }
  noteRange(start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw fail('HISTORY_PRIMARY_WINDOW_RANGE');
    if (!this.requestedWindow || this.requestedWindow.start !== start || this.requestedWindow.end !== end) {
      this.requestedWindow = { start, end }; ++this.rangeRevision;
      if (this.presentation) this.presentation.coveredSnapshot = null;
      this.windowDiagnostic('RANGE_REQUEST',{start,end});
    }
  }
  finishPresentation(outcome) {
    const p = this.presentation;
    if (!p) return;
    if (p.outcome) {
      if (!['covered','unpresented'].includes(p.outcome.status) || outcome.status !== 'covered') return;
      if (['surfaceId','ownerKey','generation','visit','rangeRevision','from','to'].every(key=>p.outcome[key]===outcome[key])) return;
    }
    p.outcome = Object.freeze({ ...outcome, adoptionId: p.adoptionId, leaseId: p.leaseId });
    this.windowDiagnostic('WINDOW_TERMINAL',{adoptionId:p.adoptionId,leaseId:p.leaseId,status:outcome.status,
      surfaceId:outcome.surfaceId,visit:outcome.visit,from:outcome.from,to:outcome.to,reason:outcome.reason,error:outcome.error?.code});
    for (const resolve of p.waiters) resolve(p.outcome);
    p.waiters.clear();
  }
  commitEmptyPresentation(scope) {
    const p = this.presentation;
    if (!this.view || this.totalCount !== 0 || !scope?.presented || p?.adoptionId !== this.view.adoptionId
      || p.scope && (p.scope.ownerKey !== scope.ownerKey || p.scope.generation !== scope.generation)) return null;
    const outcome = {status:'covered',...scope,rangeRevision:this.rangeRevision,from:0,to:0};
    this.finishPresentation(outcome);
    if (p.outcome?.status !== 'covered'
      || ['ownerKey','generation','visit','rangeRevision'].some(key => p.outcome[key] !== outcome[key])) return null;
    p.coveredSnapshot = null;
    return p.outcome;
  }
  hasCurrentPresentationCoverage(scope) {
    const p = this.presentation, view = this.view, outcome = p?.outcome;
    if (this.closed || !view || !scope?.presented || outcome?.status !== 'covered'
      || p.adoptionId !== view.adoptionId || p.leaseId !== view.header.leaseId
      || outcome.adoptionId !== view.adoptionId || outcome.leaseId !== view.header.leaseId
      || outcome.rangeRevision !== this.rangeRevision
      || ['ownerKey','generation','visit'].some(key => outcome[key] !== scope[key])) return false;
    if (view.header.totalEntries === 0) return outcome.from === 0 && outcome.to === 0;
    const surface = this.surface, snapshot = p.coveredSnapshot;
    if (!surface?.active || !surface.presented || outcome.surfaceId !== surface.id
      || ['ownerKey','generation','visit'].some(key => surface[key] !== scope[key])
      || !snapshot || snapshot.header !== view.header || outcome.to <= outcome.from) return false;
    for (let rank = outcome.from; rank < outcome.to; rank++) {
      if (!this.matchesSnapshotUnit(snapshot,rank,snapshot.window.get(rank))) return false;
    }
    return true;
  }
  attachSurface(scope) {
    if (!scope || typeof scope.ownerKey !== 'string' || !Number.isSafeInteger(scope.generation)
      || !Number.isSafeInteger(scope.visit) || typeof scope.presented !== 'boolean') throw fail('HISTORY_PRIMARY_SURFACE_SCOPE');
    const old = this.surface;
    if (old) {
      old.active = false;
      if (this.activeWindow?.ownerToken === old || this.pendingWindow?.ownerToken === old) this.cancelWindow();
    }
    const surface = { ...scope, id: ++this.surfaceSequence, active: true, demand: null };
    this.surface = surface;
    if (!scope.presented) this.finishPresentation({ status: 'unpresented' });
    const currentSurface = () => !this.closed && this.surface === surface && surface.active;
    return {
      noteRange: (start,end) => { if (currentSurface() && surface.presented) this.noteRange(start,end); },
      bootstrapWindow: (snapshot, index, inputsCurrent = () => true) => {
        // A virtualizer may initially commit its empty/probe list before it
        // has a measured range. Reading the selected real unit must not depend
        // on that range already matching the new root's logical count.
        const view = this.view, expected = this.presentation?.scope;
        const valid = () => currentSurface() && surface.presented && this.view === view
          && (!expected || expected.ownerKey === surface.ownerKey && expected.generation === surface.generation);
        if (!valid()) return Promise.resolve({status:'unpresented'});
        if (!view || !snapshot || snapshot.adoptionId !== view.adoptionId
          || snapshot.header?.leaseId !== view.header.leaseId
          || snapshot.totalCount !== view.header.totalEntries) return Promise.resolve({status:'superseded'});
        if (inputsCurrent() !== true) {
          const outcome = {status:'superseded',requiredClass:'semantic',reason:'surface-composition-moved'};
          this.finishPresentation(outcome); return Promise.resolve(outcome);
        }
        if (!snapshot.totalCount) return Promise.resolve({status:'empty'});
        if (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.totalCount) throw fail('HISTORY_PRIMARY_WINDOW_RANGE');
        if (surface.demand?.adoptionId === view.adoptionId) return Promise.resolve({status:'actual-demand'});
        if (surface.bootstrap?.adoptionId === view.adoptionId) return surface.bootstrap.promise;
        const bootstrap = surface.bootstrap = {adoptionId:view.adoptionId,promise:null};
        this.windowDiagnostic('WINDOW_BOOTSTRAP',{surfaceId:surface.id,visit:surface.visit,rank:index});
        bootstrap.promise = this.readWindow(index,index,{ownerToken:surface,owns:valid}).then(() => (
          valid() ? {status:'data-ready'} : {status:'superseded'}
        ), error => {
          if (!valid() || error?.code === 'HISTORY_READ_CANCELLED') return {status:'cancelled'};
          this.finishPresentation({status:'failed',error}); this.notify();
          return {status:'failed',error};
        });
        // Data readiness is deliberately not presentation/paint coverage.
        return bootstrap.promise;
      },
      commit: (snapshot, range, matches, inputsCurrent = () => true) => {
        if (!currentSurface() || !surface.presented) return { status:'unpresented' };
        const view = this.view;
        if (!snapshot || view?.adoptionId !== snapshot.adoptionId || view.header.leaseId !== snapshot.header.leaseId
          || range.totalCount !== snapshot.totalCount) return { status:'awaiting-layout' };
        const expected = this.presentation?.scope;
        if (expected && (expected.ownerKey !== surface.ownerKey || expected.generation !== surface.generation)) {
          return {status:'superseded',reason:'surface-owner-moved'};
        }
        if (inputsCurrent() !== true) {
          const outcome = {status:'superseded',requiredClass:'semantic',reason:'surface-composition-moved'};
          this.finishPresentation(outcome); return outcome;
        }
        const start = range.startIndex, end = range.endIndex;
        this.noteRange(start,end);
        const from = Math.min(snapshot.totalCount,start), to = Math.min(snapshot.totalCount,end + 1);
        const key = snapshot.adoptionId + ':' + this.rangeRevision + ':' + from + ':' + to;
        if (surface.demand?.key !== key) {
          surface.demand = {key,adoptionId:snapshot.adoptionId,rangeRevision:this.rangeRevision,started:false};
          this.windowDiagnostic('WINDOW_DEMAND',{demand:key,surfaceId:surface.id,visit:surface.visit,from,to,totalCount:snapshot.totalCount});
        }
        const missing = () => { for (let rank=from;rank<to;rank++) if (!this.window.has(rank)) return true; return false; };
        if (missing()) {
          if (!surface.demand.started) {
            const demand = surface.demand;
            demand.started = true;
            void this.readWindow(start,end,{ ownerToken:surface, owns:currentSurface }).catch(error => {
              if (currentSurface() && surface.demand === demand && this.view === view && error?.code !== 'HISTORY_READ_CANCELLED') {
                this.finishPresentation({ status:'failed',error }); this.notify();
              }
            });
          }
          return { status:'loading', adoptionId:snapshot.adoptionId, rangeRevision:this.rangeRevision };
        }
        for (let rank=from;rank<to;rank++) if (!snapshot.window.has(rank)) {
          this.notify(); return {status:'awaiting-commit'};
        }
        // Only CURRENT committed units are a paint/coverage proof. Do not
        // wait forever for keys that now belong to a stronger topology.
        for (let rank=from;rank<to;rank++) if (!this.matchesSnapshotUnit(snapshot,rank,snapshot.window.get(rank))
          || matches(rank,snapshot.window.get(rank)) !== true) {
          const outcome = {status:'superseded',requiredClass:'semantic',reason:'surface-topology-moved'};
          this.finishPresentation(outcome); return outcome;
        }
        // A loading representation was never admitted to the real synchronous
        // key/body callbacks, even if the virtualizer geometry was stable.
        if (!Number.isSafeInteger(range.itemCount) || range.itemCount !== to - from
          || !range.itemCount || range.admittedCount !== range.itemCount) return {status:'awaiting-commit'};
        if (range.stable !== true) return {status:'awaiting-layout'};
        const outcome = { status:'covered', surfaceId:surface.id, ownerKey:surface.ownerKey,
          generation:surface.generation,visit:surface.visit,rangeRevision:this.rangeRevision,from,to };
        this.finishPresentation(outcome);
        const terminal = this.presentation?.outcome;
        if (terminal?.status !== 'covered'
          || ['surfaceId','ownerKey','generation','visit','rangeRevision','from','to']
            .some(key => terminal[key] !== outcome[key])) return terminal || {status:'awaiting-commit'};
        this.presentation.coveredSnapshot = snapshot;
        return terminal;
      },
      dispose: () => {
        if (!currentSurface()) return;
        surface.active = false; this.surface = null;
        if (this.presentation) this.presentation.coveredSnapshot = null;
        if (this.activeWindow?.ownerToken === surface || this.pendingWindow?.ownerToken === surface) this.cancelWindow();
        this.finishPresentation({ status:'unpresented' });
      },
    };
  }
  async waitForPresentation({ signal, owns = () => true, scope } = {}) {
    current(signal, () => !this.closed && owns());
    const p = this.presentation;
    if (!p || p.adoptionId !== this.view?.adoptionId) return {status:'superseded',reason:'adoption-moved'};
    const actual = typeof scope === 'function' ? scope() : scope;
    if (!actual?.presented) return {status:'unpresented',adoptionId:p.adoptionId,leaseId:p.leaseId};
    if (p.scope && (p.scope.ownerKey !== actual.ownerKey || p.scope.generation !== actual.generation)) {
      return {status:'superseded',reason:'presentation-owner-moved'};
    }
    p.scope ||= actual;
    if (p.outcome?.status === 'unpresented' && actual.presented) p.outcome = null;
    if (p.outcome) {
      if (p.outcome.status !== 'covered' || p.outcome.ownerKey === actual.ownerKey
        && p.outcome.generation === actual.generation && p.outcome.visit === actual.visit
        && p.outcome.rangeRevision === this.rangeRevision) return p.outcome;
      // The same immutable root can be presented on a new visit. Its old
      // commit is not the new visit's coverage; no semantic work is needed.
      p.outcome = null;
    }
    return new Promise(resolve => {
      const finish = outcome => { p.waiters.delete(finish); signal?.removeEventListener('abort',abort); resolve(outcome); };
      const abort = () => finish({status:'cancelled',adoptionId:p.adoptionId,leaseId:p.leaseId});
      p.waiters.add(finish); signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort();
    });
  }
  hasEntry(uuid) {
    for (const unit of this.window.values()) if (unit.kind === 'entry' && unit.entry.uuid === uuid) return true;
    return false;
  }
  async open(payload, { signal, owns = () => true, beforeAdopt = async () => {}, prepareAdopt, adopt, presentationScope } = {}) {
    current(signal, () => !this.closed && owns());
    const open = this.transport.openHistoryRootThroughIpc;
    if (typeof open !== 'function') {
      throw fail('HISTORY_PRIMARY_TRANSPORT_UPDATE_REQUIRED');
    }
    const sequence = ++this.sequence;
    const retainedAtStart = this.view;
    const retainedHeaderAtStart = retainedAtStart?.header, retainedReaderAtStart = retainedAtStart?.reader;
    let adopted = false;
    try {
    const valid = () => !this.closed && sequence === this.sequence && owns();
    const requestClass = payload.primaryRequestClass;
    if (requestClass !== undefined && !['view', 'semantic', 'source'].includes(requestClass)) {
      throw fail('HISTORY_PRIMARY_REQUEST_CLASS_INVALID');
    }
    let request;
    if (requestClass === 'view') {
      if (!this.header || !checkedHistoryPrimaryReuseHeader(this.header)) {
        return recomposeRequired('semantic', 'legacy-primary-header');
      }
      const options = payload.primaryViewOptions || payload.primaryPresentation || {};
      request = { toolType: payload.toolType, sessionId: payload.sessionId, cwd: payload.cwd, tabId: payload.tabId,
        primaryRequestClass: 'view',
        localRootLease: Object.fromEntries(identityFields.map(key => [key, this.header[key]])),
        expectedSemanticIdentity: this.header.semanticIdentity,
        primaryViewOptions: { grouping: options.grouping, captionSelections: options.captionSelections } };
    } else {
      // Neither an explicit source read nor caller-supplied stale lease may
      // borrow. Omitted class retains the previous presentation-only route.
      const { localRootLease: _ignored, ...baseline } = payload;
      request = { ...baseline,
        ...(requestClass === 'semantic' ? { primaryPresentationOnly: true } : {}),
        ...(requestClass === 'source' ? { primaryPresentationOnly: false } : {}),
        ...(this.header && (requestClass === 'semantic' || (requestClass === undefined && payload.primaryPresentationOnly))
          ? { localRootLease: Object.fromEntries(identityFields.map(key => [key, this.header[key]])) } : {}) };
    }
    let opened, preparedCapability, preparedOwner, openError;
    const openPhases = [];
    let activeOpenPhase = null, openPhaseStart = 0;
    const openPhase = name => { try {
      const now = performance.now();
      if (activeOpenPhase) openPhases.push({stage:activeOpenPhase,
        startAbs:performance.timeOrigin+openPhaseStart,endAbs:performance.timeOrigin+now,elapsedMs:now-openPhaseStart});
      activeOpenPhase = name; openPhaseStart = now;
      if (name) console.log('[HistoryPrimary] OPEN_PHASE ' + JSON.stringify({tabId:payload.tabId,
        sequence,requestClass:requestClass || 'source',stage:name,startAbs:performance.timeOrigin+now}));
    } catch {} };
    try {
      openPhase('root-open');
      opened = await open(this.invoke, 'agent-transcript:get-history', {
        ...request, readTransport: 'root-v1', readProfile: HISTORY_PRIMARY_PROFILE,
      }, { signal, pageBytes: this.creditBytes, pageItems: HISTORY_PRIMARY_PAGE_ITEMS });
      current(signal, valid);
      if (opened?.kind === 'superseded-dependency') {
        const previous = this.view, result = opened.result;
        const sameAddress = previous?.address && ['toolType','sessionId','cwd','tabId'].every(key=>
          previous.address[key] === (payload[key] ?? ''));
        if (requestClass === 'view' || sameAddress && (previous.header.ownerKey !== result.ownerKey
          || previous.header.generation !== result.generation)) throw fail('HISTORY_PRIMARY_DEPENDENCY_OWNER');
        return {kind:'superseded-dependency',requiredClass:'source',domain:result.domain,
          generation:result.generation,ownerKey:result.ownerKey,witness:result.witness};
      }
      if (opened?.kind === 'legacy') {
        if (requestClass === 'view') {
          const required = checkedRecompose(opened.result);
          if (required) return required;
        }
        // Only an explicitly unsupported COMPOSITE belongs to the old path.
        if (requestClass !== 'view' && opened.result?.capability === 'legacy-composite'
          && opened.result?.error === 'HISTORY_ROOT_COMPOSITE_NOT_MIGRATED') return opened;
        throw fail(opened.result?.error || 'HISTORY_PRIMARY_PHYSICAL_ROOT_REQUIRED');
      }
      const header = opened?.header;
      if (opened?.kind !== 'root' || header?.readProfile !== HISTORY_PRIMARY_PROFILE
        || header.semanticSnapshotComplete !== true || !Number.isSafeInteger(header.canonicalEntryCount)
        || header.canonicalEntryCount < 0 || header.root?.length !== header.totalEntries
        || header.displayUnitCount !== header.totalEntries) {
        throw fail('HISTORY_PRIMARY_PROFILE_CONTRACT_REQUIRED');
      }
      const reuseHeader = checkedHistoryPrimaryReuseHeader(header);
      requireHistoryPrimaryAddressCapability(header);
      if (this.header?.leaseId === header.leaseId) throw fail('HISTORY_PRIMARY_VIEW_LEASE_INVALID');
      if (requestClass === 'view' && (!reuseHeader || header.primaryRequestClass !== 'view'
        || header.semanticIdentity !== request.expectedSemanticIdentity
        || header.ownerKey !== request.localRootLease.ownerKey
        || header.generation !== request.localRootLease.generation
        || header.leaseId === request.localRootLease.leaseId)) throw fail('HISTORY_PRIMARY_VIEW_IDENTITY_INVALID');
      if (!same(header, header.sourceMetadata) || header.sourceMetadata?.kind !== 'array') {
        throw fail('HISTORY_PRIMARY_ACTION_METADATA_REQUIRED');
      }
      if (!same(header, header.durableMetadata) || header.durableMetadata?.kind !== 'array'
        || header.durableMetadata.length !== header.canonicalEntryCount) throw fail('HISTORY_PRIMARY_DURABLE_METADATA_REQUIRED');
      const previous = retainedAtStart;
      const previousHeader = retainedHeaderAtStart, previousReader = retainedReaderAtStart;
      const metadataStartedAt = Date.now();
      const metadataCurrent = () => valid() && !this.closed && sequence === this.sequence && this.view === previous
        && (!previous || previous.header === previousHeader && previous.reader === previousReader);
      current(signal, metadataCurrent);
      const reusedMetadata = retainedMetadata(previous, header);
      // Cold opens must validate EVERY canonical row and reachable allowed
      // shape, including rows absent from the prepared projection. A checked
      // same-data rebind retains only the selected diagnostic row identity;
      // the branded fact is newly bound to this original opened capability.
      current(signal, metadataCurrent);
      if (reusedMetadata) previousReader.assertOpen();
      openPhase('canonical-validation');
      const canonicalMetadataFact = await opened.reader.canonicalMetadataValidation(header, {
          signal, owns: metadataCurrent,
          invoke: (channel, request) => this.transport.readHistoryThroughIpc(this.invoke, channel, request, { signal }),
          ...(reusedMetadata ? { reuseFact: reusedMetadata.canonicalMetadataFact, previousHeader } : {}),
        });
      current(signal, metadataCurrent);
      if (reusedMetadata) previousReader.assertOpen();
      current(signal, metadataCurrent);
      if (!checkedHistoryPrimaryCanonicalMetadataFact(canonicalMetadataFact, header)) {
        throw fail('HISTORY_PRIMARY_CANONICAL_METADATA_FACT_REQUIRED');
      }
      // Full prepared Np validation is a separate source-owner proof. It is
      // completed BEFORE the compatibility decoder or any selected caller.
      // The independently issued child is not revoked by closing this Root.
      openPhase('prepared-validation');
      preparedCapability = await opened.reader.retainPreparedPresentation(header, {
        signal, owns: metadataCurrent, transport: this.transport,
        ...(reusedMetadata && header.primaryRequestClass === 'view' && previous?.prepared
          ? { reuseSubject: previous.prepared.capability } : {}),
      });
      current(signal, metadataCurrent);
      let preparedMetadata = reusedMetadata;
      if (!preparedMetadata) {
        openPhase('compatibility-decode');
        const metadataEntries = await readActionMetadata(opened.reader, header.sourceMetadata,
          { signal, owns: metadataCurrent, metadataRowWindow: header.metadataRowWindow });
        openPhase('effective-settings');
        const effectiveSettings = await readHistoryPrimaryEffectiveSettings(opened.reader, header, {
          signal, owns: metadataCurrent,
          invoke: (channel, request) => this.transport.readHistoryThroughIpc(this.invoke, channel, request, { signal }),
        });
        preparedMetadata = freezePreparedMetadata({entries:metadataEntries,effectiveSettings});
      }
      openPhase('window-and-admission');
      current(signal, metadataCurrent);
      if (preparedMetadata.entries.length !== (header.sourceEntryCount ?? header.canonicalEntryCount)
        || canonicalMetadataFact.canonicalEntryCount !== header.canonicalEntryCount) throw fail('HISTORY_PRIMARY_METADATA_COUNT');
      const serverMetadata = Object.freeze({ preparedCompatibilityKind: 'prepared-metadata-compatibility',
        entries: preparedMetadata.entries, effectiveSettings: preparedMetadata.effectiveSettings, canonicalMetadataFact });
      const metadataDiagnostic = { tabId: payload.tabId, leaseId: header.leaseId, generation: header.generation,
        requestedClass: requestClass || 'source', effectiveClass: header.primaryRequestClass,
        semanticIdentity: header.semanticIdentity, metadataIdentity: header.metadataIdentity,
        reused: !!reusedMetadata, metadataStartedAt, metadataReadyAt: Date.now(),
        preparedEntries: serverMetadata.entries.length, canonicalRowsValidated: canonicalMetadataFact.canonicalEntryCount,
        canonicalInventory: 0, preparedMetadataOwner: 'OPEN' };
      console.log('[HistoryPrimary] METADATA_READY ' + JSON.stringify(metadataDiagnostic));
      const metadata = Object.freeze({ ...serverMetadata });
      const sameSuppressions = previous?.suppressions?.length === (payload.suppressions || []).length
        && previous.suppressions.every((entry, index) => entry === payload.suppressions[index]);
      const keepWindow = previous && previous.header.ownerKey === header.ownerKey
        && previous.header.generation === header.generation && previous.header.revision === header.revision
        && previous.header.semanticIdentity === header.semanticIdentity
        && previous.header.metadataIdentity === header.metadataIdentity
        && previous.header.semanticRevisionToken === header.semanticRevisionToken
        && previous.header.viewRevisionToken === header.viewRevisionToken
        && previous.header.totalEntries === header.totalEntries
        && previous.presentation === payload.primaryPresentation && sameSuppressions;
      // Only checked retainedMetadata plus the exact semantic revision can
      // carry this opaque data subject across a view/lease rebind. A new
      // preparation never inherits a commit from equal counts or aliases.
      const receiptDataSubject = reusedMetadata && previous?.receiptDataSubject
        && previous.header.semanticRevisionToken === header.semanticRevisionToken
        ? previous.receiptDataSubject : Object.freeze({});
      preparedOwner = createHistoryPrimaryPreparedOwner(preparedCapability, this.transport, {
        receiptDataSubject, compatibilityEntries: serverMetadata.entries, readMetadata: readActionMetadata, readText: readPrimaryDocumentText,
      });
      const nextView = { reader: opened.reader, root: opened.root, header, metadata, serverMetadata, receiptDataSubject,
        prepared: preparedOwner,
        unitAddresses: new WeakMap(),
        openSequence:sequence,
        address:Object.fromEntries(['toolType','sessionId','cwd','tabId'].map(key=>[key,payload[key] ?? ''])),
        presentation: payload.primaryPresentation, suppressions: payload.suppressions || [] };
      const nextWindow = new Map();
      const nextAddresses = new Map();
      if (keepWindow) {
        // A new lease never inherits an old address certificate. Re-prove only
        // the retained window before publication; unchanged physical strings
        // keep their React identity and bodies without an intermediate shell.
        for (;;) {
          const window = this.window, addresses = this.addresses, rangeRevision = this.rangeRevision;
          const capturedWindow = new Map(window), capturedAddresses = new Map(addresses);
          nextWindow.clear(); nextAddresses.clear(); nextView.unitAddresses = new WeakMap();
          for (const [rank, unit] of capturedWindow) {
            const selected = await readHistoryPrimaryPresentationAddresses(this,nextView,
              {mode:'range',offset:rank,limit:1,signal,owns:valid});
            current(signal,valid);
            const address = selected.addresses[0], old = capturedAddresses.get(rank);
            if (!address || !old || address.physicalKey !== old.physicalKey
              || address.kind !== old.kind || address.firstUuid !== old.firstUuid
              || address.lastUuid !== old.lastUuid || address.entryCount !== old.entryCount
              || address.expanded !== old.expanded) throw fail('HISTORY_PRIMARY_ADDRESS_REUSE_CONFLICT');
            nextAddresses.set(rank,address); nextWindow.set(rank,unit); nextView.unitAddresses.set(unit,address);
          }
          await beforeAdopt(); current(signal,valid);
          // Scrolling can replace the corridor or finish another body while
          // the new lease's addresses are being proved. Rebind that CURRENT
          // bounded window instead of failing or reviving an evicted one.
          if (this.window === window && this.addresses === addresses && this.rangeRevision === rangeRevision
            && window.size === capturedWindow.size && addresses.size === capturedAddresses.size
            && [...capturedWindow].every(([rank,unit]) => window.get(rank) === unit
              && addresses.get(rank) === capturedAddresses.get(rank))) break;
        }
      }
      if (!keepWindow && previous && this.requestedWindow && header.totalEntries) {
        // Keep the old immutable view visible until the replacement's current
        // corridor is complete. Publishing an empty body map on every live
        // revision otherwise flashes placeholders and can starve tool output.
        // Never copy old bodies under the new revision, rank or Rewind fence.
        const startedAt = Date.now();
        let from, to, rangeRevision;
        for (;;) {
          rangeRevision = this.rangeRevision;
          const requested = this.requestedWindow;
          from = Math.min(header.totalEntries - 1, requested.start);
          to = Math.min(header.totalEntries, Math.max(from, requested.end) + 1);
          for (const rank of nextWindow.keys()) if (rank < from || rank >= to) nextWindow.delete(rank);
          for (const rank of nextAddresses.keys()) if (rank < from || rank >= to) nextAddresses.delete(rank);
          await this.fillWindow(nextView,nextWindow,from,to,{signal,owns:valid,addresses:nextAddresses});
          current(signal,valid);
          await beforeAdopt();
          current(signal,valid);
          if (rangeRevision === this.rangeRevision) break;
        }
        console.log('[HistoryPrimary] WINDOW_PREPARED tab=' + String(payload.tabId || '').slice(-12)
          + ' startAbs=' + startedAt + ' endAbs=' + Date.now() + ' from=' + from
          + ' to=' + to + ' units=' + nextWindow.size + ' rangeRevision=' + rangeRevision);
      } else if (!keepWindow) await beforeAdopt();
      current(signal, valid);
      // A provisional read-only owner of THIS opened capability. Late local
      // matching happens before public view transfer. UNKNOWN/stale inputs
      // release only this provisional reader and retain the previous view.
      const provisionalCurrent = () => valid() && (this.view === previous || this.view === nextView);
      const provisional = {
        get closed() { return !provisionalCurrent(); },
        get sequence() { return sequence; },
        get view() { return nextView; },
        transport: this.transport,
        pull: operation => this.pull(operation),
        getReceiptDataSubject: () => provisionalCurrent() ? nextView.receiptDataSubject : null,
      };
      const candidate = Object.freeze({ header, metadata,
        preparePromptAdoption: (prepared, currentRows, capturedLocalRows, options = {}) =>
          prepareHistoryPrimaryPromptAdoption(provisional, nextView, prepared, currentRows, capturedLocalRows,
            { ...options, signal: options.signal || signal,
              owns: () => provisionalCurrent() && (options.owns ? options.owns() === true : true) }),
        preparePromptAdoptionSparse: async (currentLocalRows, capturedLocalRows, options = {}) => {
          const held = nextView.prepared;
          const proof = await prepareHistoryPrimarySparsePromptAdoption(held.model, held.view,
            currentLocalRows, capturedLocalRows, { ...options, signal: options.signal || signal,
              owns: () => provisionalCurrent() && !held.closed && (options.owns ? options.owns() === true : true) });
          return Object.freeze({ ...proof, prepared: held,
            // Only THIS decoded compatibility owner can supply ordinal data.
            // The sparse proof itself never captures this historical array.
            materializeCompatibility: entries => {
              if (entries !== nextView.serverMetadata.entries || !held.ownsCompatibilityMetadata(entries))
                throw fail('HISTORY_PRIMARY_SPARSE_COMPATIBILITY');
              return proof.materializeCompatibility(entries);
            } });
        },
      });
      openPhase('prompt-adoption');
      const promptAdoption = prepareAdopt ? await prepareAdopt(candidate) : undefined;
      current(signal, valid);
      if (prepareAdopt && (!promptAdoption || typeof promptAdoption.isCurrent !== 'function'
        || promptAdoption.isCurrent() !== true)) throw fail('HISTORY_READ_CANCELLED');
      current(signal, valid);
      openPhase('publication');
      this.cancelWindow();
      // An attempt owns its abort only until capability transfer. Later
      // reconciliation cannot close the retained frozen reader by that signal.
      if (signal) opened.reader.detachSignal?.(signal);
      this.finishPresentation({status:'superseded',reason:'new-adoption'});
      current(signal, valid);
      if (promptAdoption && !promptAdoption.isCurrent()) throw fail('HISTORY_READ_CANCELLED');
      current(signal, valid);
      nextView.adoptionId = ++this.adoptionSequence;
      this.view = nextView;
      this.presentation = {adoptionId:nextView.adoptionId,leaseId:header.leaseId,scope:presentationScope,outcome:null,waiters:new Set()};
      this.windowFailure = null;
      this.window = nextWindow; this.addresses = nextAddresses;
      adopted = true;
      // The caller reads its CURRENT local/live/draft refs here, after every
      // await. No read snapshot can replace a newer composer or local overlay.
      try { adopt?.(this, promptAdoption); }
      finally {
        if (previous?.reader !== opened.reader) void release(previous?.reader);
        if (previous?.prepared !== preparedOwner) void release(previous?.prepared);
      }
      // Dedicated adoption wake: body/range notify() cannot retry a failed
      // receipt read. Listeners read the freshly checked current cut.
      current(signal, () => valid() && this.view === nextView);
      for (const listener of [...this.metadataListeners]) {
        current(signal, () => valid() && this.view === nextView);
        if (!this.metadataListeners.has(listener)) continue;
        try { listener(); }
        catch (error) { console.warn('[HistoryPrimary] METADATA_LISTENER_FAILED code=' + String(error?.code || 'UNKNOWN')); }
      }
      current(signal, () => valid() && this.view === nextView);
      this.emitReceiptReadWake('adopted', sequence, nextView);
      current(signal, () => valid() && this.view === nextView);
      console.log('[HistoryPrimary] VIEW_ADOPTED ' + JSON.stringify({ ...metadataDiagnostic,
        adoptionId:nextView.adoptionId,rangeRevision:this.rangeRevision,adoptedAt: Date.now() }));
      return { kind: 'root', model: this };
    } catch (error) {
      openError = error;
      throw error;
    } finally {
      openPhase('provisional-cleanup');
      let cleanupCompleted = false;
      try {
      // A corrupt peer echoing the currently retained lease does not grant
      // permission to release it. Only a distinct provisional reader is ours
      // to discard; late/superseded readers otherwise clean up independently.
      if (!adopted && opened?.kind === 'root' && opened.reader !== this.view?.reader) {
        if (this.header && opened.header?.leaseId === this.header.leaseId) await opened.reader.abandon?.();
        else await release(opened.reader);
      }
      if (!adopted) await release(preparedOwner || preparedCapability?.reader);
      cleanupCompleted = true;
      } finally {
      openPhase(null);
      try { console.log('[HistoryPrimary] OPEN_PHASES ' + JSON.stringify({tabId:payload.tabId,
        sequence,requestClass:requestClass || 'source',leaseId:opened?.header?.leaseId,
        outcome:!cleanupCompleted ? 'cleanup-error' : openError ? 'error' : adopted ? 'adopted' : 'not-adopted',
        timing:'sequential-elapsed-wall-not-cpu',phases:openPhases})); } catch {}
      }
    }
    } finally {
      // Only an external open's CURRENT terminal settlement may wake a
      // receipt observation invalidated by its sequence. Query UNKNOWN/body
      // packets never enter this path; successful adoption already woke once.
      const sameAddress = retainedAtStart?.address && ['toolType','sessionId','cwd','tabId'].every(key =>
        retainedAtStart.address[key] === (payload[key] ?? ''));
      if (!adopted && sameAddress) this.emitReceiptReadWake('settled', sequence, retainedAtStart);
    }
  }
  settleWindowRequest(request, error) {
    if (!request || request.settled) return;
    request.settled = true;
    request.signal?.removeEventListener('abort', request.abort);
    if (error) request.reject(error); else request.resolve();
  }
  cancelWindow() {
    ++this.windowSequence;
    this.windowController?.abort();
    this.settleWindowRequest(this.activeWindow, fail('HISTORY_READ_CANCELLED'));
    this.settleWindowRequest(this.pendingWindow, fail('HISTORY_READ_CANCELLED'));
    this.pendingWindow = null;
  }
  startWindowPump() {
    if (this.windowTask) return;
    const task = Promise.resolve().then(async () => {
      while (this.pendingWindow) {
        const request = this.pendingWindow;
        this.pendingWindow = null; this.activeWindow = request;
        this.windowController = request.controller;
        const valid = () => !this.closed && this.view === request.view
          && request.sequence === this.windowSequence && request.owns();
        try {
          current(request.controller.signal,valid);
          const from = Math.min(request.view.header.totalEntries,request.start);
          const to = Math.min(request.view.header.totalEntries,request.end + 1);
          await this.fillWindow(request.view,this.window,from,to,{
            signal:request.controller.signal,owns:valid,addresses:this.addresses,
            publish:()=>{this.notify();request.publish(this);},
          });
          current(request.controller.signal,valid);
          this.settleWindowRequest(request);
        } catch (error) {
          this.settleWindowRequest(request,error);
          if (!request.controller.signal.aborted && valid() && error?.code !== 'HISTORY_READ_CANCELLED') {
            this.windowFailure = error; this.notify();
          }
        } finally {
          if (this.activeWindow === request) this.activeWindow = null;
          if (this.windowController === request.controller) this.windowController = null;
        }
      }
    });
    this.windowTask = task;
    void task.then(() => {
      if (this.windowTask === task) this.windowTask = null;
      if (this.pendingWindow) this.startWindowPump();
    }, error => {
      if (this.windowTask === task) this.windowTask = null;
      this.settleWindowRequest(this.pendingWindow,error); this.pendingWindow = null;
    });
  }
  async pull(operation) {
    const previous = this.pageTask;
    const task = (async () => { if (previous) await previous.catch(() => {}); return operation(); })();
    this.pageTask = task;
    try { return await task; }
    finally { if (this.pageTask === task) this.pageTask = null; }
  }
  async reconcileCommittedToolResults({ signal, owns = () => true, commitPage } = {}) {
    const view=this.view, sequence=this.sequence;
    if(!view)throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    const claimRevision=this.toolCoverageSequence=(this.toolCoverageSequence||0)+1;
    const valid=()=>!this.closed&&this.view===view&&this.sequence===sequence
      &&this.toolCoverageSequence===claimRevision&&owns(view.header);
    let offset=0,claims=0;
    for(;;) {
      current(signal,valid);
      const page=await this.pull(async()=>{
        current(signal,valid);
        // Demand cancellation does not close the shared parent. Do not pass a
        // signal to generic page/leaf paths that own their reader's lifetime.
        return view.reader.primaryToolCoverage(view.header.durableMetadata,{offset,limit:3,
          semanticIdentity:view.header.semanticIdentity,metadataIdentity:view.header.metadataIdentity,claimRevision,
          invoke:(channel,payload)=>this.transport.readHistoryThroughIpc(this.invoke,channel,payload,{signal})});
      });
      current(signal,valid);
      const proofs=[];
      for(const item of page.items) {
        if(!item.covered)continue;
        const key=await this.pull(async()=>{
          current(signal,valid);
          const document=await view.reader.forkText(item.key);
          return readPrimaryDocumentText(document,{signal,owns:valid});
        });
        current(signal,valid);proofs.push({key,fingerprint:item.fingerprint});
      }
      current(signal,valid);
      if(proofs.length)commitPage?.(proofs,view.header,claimRevision);
      claims+=page.items.length;
      if(page.done)return {status:'complete',claims,claimRevision,header:view.header};
      offset=page.nextOffset;
    }
  }
  async readPromptAdoption(localEntry, options = {}) {
    const view = this.view;
    if (!view) throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    return readHistoryPrimaryPromptAdoption(this, view, localEntry, options);
  }
  async preparePromptAdoption(prepared, currentRows, capturedLocalRows, options = {}) {
    const view = this.view;
    if (!view) throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    return prepareHistoryPrimaryPromptAdoption(this, view, prepared, currentRows, capturedLocalRows, options);
  }
  async preparePromptAdoptionSparse(currentLocalRows, capturedLocalRows, options = {}) {
    const view = this.view, sequence = this.sequence, held = view?.prepared;
    if (!view || !held) throw fail('HISTORY_PRIMARY_PREPARED_OWNER_REQUIRED');
    return prepareHistoryPrimarySparsePromptAdoption(held.model, held.view, currentLocalRows, capturedLocalRows,
      { ...options, owns: () => !this.closed && this.view === view && this.sequence === sequence && !held.closed
        && (options.owns ? options.owns() === true : true) });
  }
  async hasLaterCanonicalReceipt(record, options = {}) {
    const view = this.view;
    if (!view) throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    return readHistoryPrimaryLaterCanonicalReceipt(this, view, record, options);
  }
  async readConfirmedCanonicalReceipt(record, options = {}) {
    const view = this.view;
    if (!view) throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    return readHistoryPrimaryConfirmedCanonicalReceipt(this, view, record, options);
  }
  async readTerminalPreviewMembership(identity, options = {}) {
    const view = this.view;
    if (!view) throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    return readHistoryPrimaryTerminalPreviewMembership(this, view, identity, options);
  }
  async readLiveIdentityCoverage(claims, options = {}) {
    const view = this.view;
    if (!view) throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    return readHistoryPrimaryLiveIdentityCoverage(this, view, claims, options, historyPrimaryToolClaimFingerprint);
  }
  async findCanonicalPromptIdentity(identity, { signal, owns = () => true } = {}) {
    const view=this.view, sequence=this.sequence;
    if(!view)throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    const header=view.header,root=view.root,reader=view.reader,durable=header.durableMetadata;
    const valid=()=>!this.closed&&this.view===view&&view.header===header&&view.root===root
      &&view.reader===reader&&this.sequence===sequence&&owns();
    current(signal,valid);reader.assertOpen();
    if(!same(header,durable)||durable?.kind!=='array'
      ||!Number.isSafeInteger(header.canonicalEntryCount)||header.canonicalEntryCount<0
      ||durable.length!==header.canonicalEntryCount||!same(header,reader.identity)||!same(header,root)
      ||root.nodeToken!==header.root.nodeToken)throw fail('HISTORY_PRIMARY_DURABLE_METADATA_REQUIRED');
    const exact=typeof identity==='string'?identity.trim():'';
    if(!exact)return null;
    return this.pull(()=>findCanonicalPromptIdentity(this,view,exact,{signal,owns,sequence}));
  }
  async hasCanonicalUuid(uuid, { signal, owns = () => true } = {}) {
    const view = this.view;
    if (!view) throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    const header = view.header, durable = header.durableMetadata;
    const valid = () => !this.closed && this.view === view && view.header === header && owns();
    current(signal, valid);
    view.reader.assertOpen();
    if (!same(header, durable) || durable?.kind !== 'array'
      || !Number.isSafeInteger(header.canonicalEntryCount) || header.canonicalEntryCount < 0
      || durable.length !== header.canonicalEntryCount
      || !same(header, view.reader.identity) || !same(header, view.root)
      || view.root.nodeToken !== header.root.nodeToken) {
      throw fail('HISTORY_PRIMARY_DURABLE_METADATA_REQUIRED');
    }
    if (typeof uuid !== 'string') throw fail('HISTORY_ROOT_FIND_INVALID');
    if (!uuid) return false;
    // Find is limited to 2048 UTF16 code units and 4096 UTF8 wire bytes.
    // Oversized UUIDs scan signed durable fields without native metadata.
    if (uuid.length > 2048 || new TextEncoder().encode(uuid).byteLength > 4096) {
      const sequence=this.sequence;
      return this.pull(()=>streamCanonicalUuid(this,view,uuid,{signal,owns,sequence}));
    }
    const page = await this.pull(async () => {
      current(signal, valid);
      try {
        // A demand abort must not close the retained reader or its other users.
        return await view.reader.find(durable, 'uuid', uuid, { offset: 0, limit: 1 });
      } finally { current(signal, valid); }
    });
    current(signal, valid);
    view.reader.assertOpen();
    const item = page.items[0];
    if (!page.done || page.items.length > 1 || (item
      ? !Number.isSafeInteger(item.ordinal) || item.ordinal < 0 || item.ordinal >= durable.length
        || page.nextOffset !== item.ordinal + 1 || !same(header, item.value) || item.value?.kind !== 'object'
      : page.nextOffset !== durable.length)) throw fail('HISTORY_PRIMARY_CANONICAL_UUID_RANGE');
    return !!item;
  }
  async resolveUuid(uuid, { signal, owns = () => true } = {}) {
    return this.resolveAddress('uuid',uuid,{signal,owns});
  }
  resolveGroup(key, options = {}) { return this.resolveAddress('group',key,options); }
  resolveKey(key, options = {}) { return this.resolveAddress('key',key,options); }
  resolvePresentationTarget(identity, tool = null, options = {}) {
    return this.resolveAddress('target',identity,{...options,tool});
  }
  resolveIndex(index, options = {}) {
    return this.resolveAddress('range',null,{...options,offset:index});
  }
  async resolveAddress(mode, value, {signal,owns = () => true,tool = null,offset = 0} = {}) {
    const view = this.view;
    if (!view) throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    const valid = () => !this.closed && this.view === view && owns();
    const result = await readHistoryPrimaryPresentationAddresses(this,view,
      {mode,value,tool,offset,limit:1,signal,owns:valid});
    current(signal,valid);
    return result.addresses[0] || null;
  }
  async forkUnit(view, node, signal, owns) {
    current(signal, owns);
    if (typeof view.reader.forkViewUnit !== 'function' || typeof view.reader.borrowEntryBody !== 'function') throw fail('HISTORY_PRIMARY_UNIT_TRANSPORT_UPDATE_REQUIRED');
    const borrowed = await view.reader.borrowEntryBody(node, { signal });
    const unit = borrowed ? await readHistoryPrimaryEntryBody(borrowed, { signal, owns })
      : await readHistoryPrimaryUnitDocument(await view.reader.forkViewUnit(node, { signal }), { signal, owns });
    if (unit?.kind === 'group') {
      assertThin(unit.entries);
      // The service's caption profile carries exact visible caption text on
      // the otherwise thin row. Hidden member bodies/actions remain forbidden.
      if (unit.captionEntries) assertThin(unit.captionEntries, { captionText: true });
      if (unit.captionEntry) assertThin([unit.captionEntry], { captionText: true });
    } else if (unit?.kind !== 'entry' || !unit.entry?.uuid || unit.entry.rowStub) {
      throw fail('HISTORY_PRIMARY_FULL_ENTRY_REQUIRED');
    }
    return unit;
  }
  async fillWindow(view, window, from, to, { signal, owns, publish = () => {}, addresses = this.addresses }) {
    let offset = from;
    while (offset < to) {
      current(signal, owns);
      while (offset < to && window.has(offset)) offset++;
      if (offset === to) break;
      let gapEnd = Math.min(to,offset + HISTORY_PRIMARY_PAGE_ITEMS);
      for (let rank=offset+1;rank<gapEnd;rank++) if (window.has(rank)) {gapEnd=rank;break;}
      const page = await readHistoryPrimaryPresentationAddresses(this,view,
        {mode:'range',offset,limit:gapEnd-offset,signal,owns});
      current(signal, owns);
      if (page.nextOffset <= offset || page.nextOffset > to) throw fail('HISTORY_PRIMARY_WINDOW_PROGRESS');
      for (const address of page.addresses) {
        const rank = address.index;
        if (window.has(rank)) continue;
        this.windowDiagnostic('BODY_PULL_BEGIN',{tabId:view.address?.tabId,leaseId:view.header.leaseId,
          adoptionId:view.adoptionId ?? null,openSequence:view.openSequence,rank});
        const unit = await this.forkUnit(view, address.header, signal, owns);
        current(signal, owns);
        const expectedKey = unit.kind === 'entry' ? address.firstUuid : address.groupKey;
        if (unit.kind !== address.kind || (unit.kind === 'entry'
          ? unit.entry.uuid !== expectedKey : unit.key !== expectedKey)) {
          throw fail('HISTORY_PRIMARY_UNIT_HEADER_MISMATCH');
        }
        view.unitAddresses.set(unit,address); addresses.set(rank,address); window.set(rank,unit);
        this.windowDiagnostic('BODY_READY',{tabId:view.address?.tabId,leaseId:view.header.leaseId,
          adoptionId:view.adoptionId ?? null,openSequence:view.openSequence,rank,
          unitKey:String(historyPrimaryUnitKey(unit)).slice(0,160)});
        publish();
      }
      offset = page.nextOffset;
    }
  }
  async readWindow(start, end, { signal, owns = () => true, captionSelections = [], publish = () => {}, ownerToken = this } = {}) {
    const view = this.view;
    if (!view) throw fail('HISTORY_PRIMARY_VIEW_REQUIRED');
    if (this.windowFailure) throw this.windowFailure;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw fail('HISTORY_PRIMARY_WINDOW_RANGE');
    }
    current(signal,owns); this.noteRange(start,end);
    const matches = request => request && !request.settled && request.view === view
      && request.start === start && request.end === end && request.ownerToken === ownerToken && request.signal === signal;
    if (matches(this.pendingWindow)) return this.pendingWindow.promise;
    if (!this.pendingWindow && matches(this.activeWindow)) return this.activeWindow.promise;
    const from = Math.min(this.totalCount,start), to = Math.min(this.totalCount,end + 1);
    const visualOwner = this.surface === ownerToken && ownerToken?.active && ownerToken.presented;
    const margin = visualOwner ? HISTORY_PRIMARY_LOADED_MARGIN_ROWS : 0;
    const retainFrom = Math.max(0,from - margin), retainTo = Math.min(this.totalCount,to + margin);
    const selected = new Map([...this.window].filter(([rank]) => rank >= retainFrom && rank < retainTo));
    const selectedAddresses = new Map([...this.addresses].filter(([rank]) => selected.has(rank)));
    let covered = true;
    for (let rank=from;rank<to;rank++) if (!selected.has(rank) || !selectedAddresses.has(rank)) {covered=false;break;}
    this.cancelWindow(); this.window = selected; this.addresses = selectedAddresses;
    if (covered) return;
    let resolve,reject;
    const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});
    promise.catch(()=>{});
    const request = {view,start,end,ownerToken,signal,owns,publish,promise,resolve,reject,settled:false,
      sequence:this.windowSequence,controller:new AbortController(),abort:null};
    request.abort = () => {
      request.controller.abort(); this.settleWindowRequest(request,fail('HISTORY_READ_CANCELLED'));
      if (this.pendingWindow === request) this.pendingWindow = null;
    };
    signal?.addEventListener('abort',request.abort,{once:true});
    this.pendingWindow = request;
    if (signal?.aborted) request.abort();
    // One running read and ONE replaceable pending corridor. Superseded
    // requests settle immediately; no promise chain retains their old windows.
    this.startWindowPump();
    return promise;
  }
  // Cache adoption is local to this retained panel; no global root registry.
  // Immutable roots may be reused for composition, but never assert freshness.
  close() {
    if (this.closed) return;
    this.closed = true; ++this.sequence; this.cancelWindow();
    this.finishPresentation({status:'cancelled'});
    this.presentation = null;
    if (this.surface) this.surface.active = false;
    this.surface = null;
    const view = this.view; this.view = null; this.window.clear(); this.addresses.clear();
    this.listeners.clear(); this.metadataListeners.clear(); this.receiptWakeListeners.clear();
    return Promise.all([release(view?.reader), release(view?.prepared)]).then(() => undefined);
  }
}
