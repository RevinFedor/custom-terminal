// One ephemeral pending native menu per renderer. Retained panels keep only a
// source ref; listeners exist only for the pending request, never per panel.
let pending = null;
let sequence = 0;
const nonce=globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);

export function beginPromptNativeMenuIntent({tabId,projectId,kind,source,isPresented,isAlive,events=window}) {
  pending?.close();
  const intent={id:`native-prompt-${nonce}-${++sequence}`,tabId,projectId:projectId || null,kind};
  const close=()=>{
    if(pending?.intent!==intent)return;
    pending=null;
    events.removeEventListener('pointerdown',cancel,true);
    events.removeEventListener('keydown',key,true);
    events.removeEventListener('blur',cancel);
  };
  const cancel=()=>close();
  const key=event=>{if(!['Shift','Control','Alt','Meta'].includes(event.key))close();};
  const lease={intent,source,close,isCurrent:()=>pending===lease && isPresented() && isAlive()};
  pending=lease;
  events.addEventListener('pointerdown',cancel,true);
  events.addEventListener('keydown',key,true);
  events.addEventListener('blur',cancel);
  return lease;
}

export function invalidatePromptNativeMenuSource(source) {
  if(pending?.source===source)pending.close();
}

export function validatePromptNativeMenuIntent(intent) {
  return !!intent && !!pending && pending.intent.id===intent.id && pending.intent.tabId===intent.tabId
    && pending.intent.projectId===(intent.projectId || null) && pending.intent.kind===intent.kind && pending.isCurrent();
}

export function capturedPromptCommandTarget(payload,fallback) {
  if(payload?.sdk===true)return null;
  if(typeof payload?.tabId==='string' && payload.tabId){
    if(payload.intent && (payload.intent.tabId!==payload.tabId || payload.intent.projectId!==(payload.projectId || null)))return null;
    return payload.tabId;
  }
  return payload?.intent ? null : fallback();
}
