'use strict';

const crypto = require('crypto');
const { waitForCommittedSemanticFrame } = require('./committed-semantic-frame-wait');
const ESC = String.fromCharCode(27);
const KEYS = { open: ESC + '[1;2D', back: ESC + '[1;2C', down: ESC + '[B',
  up: ESC + '[A', skip: String.fromCharCode(29), clear: String.fromCharCode(21), enter: '\r' };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
// Codex 0.162 displays macOS modifier glyphs for the same physical chords.
// Match only control hints; never normalize question/option/draft content.
const QUESTION_SKIP_HINT_RE = /(?:ctrl\+|⌃|\^)\]\s+skip/u;
const QUESTION_MAIN_PROMPT_HINT_RE = /(?:shift\+|⇧)→\s+main prompt/u;
const QUESTION_ANSWER_HINT_RE = /(?:shift\+|⇧)←\s+to answer/u;
const QUESTION_OPTION_RE = /^\s*([›❯>]?)\s*(\d+)\.\s+(.*)$/u;
const QUESTION_QUEUE_HEADER_RE = /^\s*(?:[•·]\s*)?Queued follow-up inputs\s*$/;
const nativeRowSeparator = row => row?.wrapped ? '' : ' ';
const isBoldQuestionRow = row => /(?:^|,)bold(?:,|$)/.test(String(row?.firstTextStyle || ''))
  && !/(?:^|,)dim(?:,|$)/.test(String(row?.firstTextStyle || ''));
const isNativeTitleRow = row => (row?.hasNonDefaultBg || row?.hasNonDefaultFg)
  && isBoldQuestionRow(row);

// A painted selection in a sequential native list anchors the title ABOVE
// that list. Do not let a later bold fragment replace it. The caller also
// requires the current question section boundary, not a transcript list.
function findNativeChoiceGroup(choices, rows, lines) {
  let group=null, found=null;
  const finish=()=>{
    if(group?.size>=2 && group.selections===1 && group.painted)found=group;
  };
  for(const choice of choices) {
    if(choice.number===1) {
      finish();
      group={first:choice.row,last:choice.row,size:0,selections:0,painted:false};
    } else if(!group || choice.number!==group.size+1) {
      finish();group=null;
    }
    if(!group)continue;
    group.size++;group.last=choice.row;
    if(QUESTION_OPTION_RE.exec(lines[choice.row])?.[1]) {
      group.selections++;
      const row=rows[choice.row];
      group.painted ||= row?.hasInverse===true || !!(row?.hasNonDefaultBg && isNativeTitleRow(row));
    }
  }
  finish();
  return found;
}

// Current committed screen only. Never search scrollback/raw PTY history for
// a question, and never let an ordinary quoted help example own keyboard input.
function inspectCodexNativeQuestions(frame) {
  if (!frame?.success || frame.source !== 'headless-main'
    || frame.authoritativeFrameCommitted !== true) return { kind:'unknown' };
  const rows = frame.lines || [];
  const lines = rows.map(row => String(row.text || ''));
  const text = lines.join('\n');
  let lastPrompt = -1, footer = -1;
  for (let i=0;i<lines.length;i++) {
    if (/^\s*[›❯]/u.test(lines[i]) && !QUESTION_OPTION_RE.test(lines[i])) lastPrompt=i;
    if (QUESTION_SKIP_HINT_RE.test(lines[i])) {
      for(let start=Math.max(0,i-2);start<=i;start++) {
        if (/(?:enter|tab)\s+submit/.test(lines[start])) { footer=start;break; }
      }
    }
  }
  if (footer >= 0 && lastPrompt <= footer) {
    let progress=-1, current=0, count=0;
    for (let i=footer-1;i>=0;i--) {
      const match=/^\s*(\d+)\s+of\s+(\d+)\s*$/.exec(lines[i]);
      if (match) { progress=i;current=Number(match[1]);count=Number(match[2]);break; }
    }
    if (progress<0) {
      // The native one-question layout deliberately omits "1 of 1".
      // A cropped multi-question panel must not be guessed as one question.
      const hints=lines.slice(footer,footer+4).join(' ');
      if (!QUESTION_MAIN_PROMPT_HINT_RE.test(hints) || /prev question|next question/.test(hints))return {kind:'unknown'};
      current=1;count=1;
    }
    if (!current || current>count)return {kind:'unknown'};
    let sectionStart=Math.max(0,progress+1), sectionKnown=progress>=0;
    for(let i=sectionStart;i<footer;i++) {
      if(QUESTION_QUEUE_HEADER_RE.test(lines[i]) && !isBoldQuestionRow(rows[i])) {
        sectionStart=i+1;sectionKnown=true;
      }
    }
    const choices=[];
    let optionIndex=null, editorRow=-1;
    const titleRows=[];
    let optionBlock=false;
    for (let i=sectionStart;i<footer;i++) {
      if(!lines[i].trim())optionBlock=false;
      const match=QUESTION_OPTION_RE.exec(lines[i]);
      const previousChoice=choices[choices.length-1];
      const previousMatch=previousChoice && QUESTION_OPTION_RE.exec(lines[previousChoice.row]);
      // Native option continuations keep their hanging indent (or xterm soft
      // wrap), including after an empty paragraph. Unrelated text after a
      // blank row must not be absorbed into the last option.
      const continuation=!match && previousMatch && lines[i].trim()
        && (optionBlock || rows[i]?.wrapped
          || /^\s*/.exec(lines[i])[0].length>=previousMatch[0].length-previousMatch[3].length);
      if(match || continuation)optionBlock=true;
      // Native themes may leave accent at the terminal default colour. That
      // bold-only form needs the current native section, not arbitrary bold
      // transcript text. Numbered options/continuations still cannot be title.
      if ((isNativeTitleRow(rows[i]) || sectionKnown && isBoldQuestionRow(rows[i]))
        && !optionBlock) titleRows.push(i);
      if (match) {
        const item={number:Number(match[2]),label:match[3],row:i,lineCount:1};
        choices.push(item);
        if (match[1]) optionIndex=item.number-1;
      } else if (/^\s*[›❯]\s*/u.test(lines[i])) editorRow=i;
      else if (continuation) {
        choices[choices.length-1].label+=nativeRowSeparator(rows[i])+lines[i].trim();
        choices[choices.length-1].lineCount++;
      }
    }
    const nativeGroup=sectionKnown ? findNativeChoiceGroup(choices,rows,lines) : null;
    if(nativeGroup)while(titleRows.length && titleRows[titleRows.length-1]>=nativeGroup.first)titleRows.pop();
    if (!titleRows.length)return {kind:'unknown',reason:'native-question-title-unproven',
      diagnostic:{sectionKnown,footerRow:footer,choices:choices.length,
        boldRows:rows.slice(sectionStart,footer).filter(isBoldQuestionRow).length,
        accentRows:rows.slice(sectionStart,footer).filter(isNativeTitleRow).length}};
    // Native titles are one contiguous bold/accent block. Earlier transcript
    // text is not part of the currently focused question.
    let titleIndex=titleRows.length-1;
    const titleLast=titleRows[titleIndex];
    let titleFirst=titleLast;
    while(titleIndex>0 && titleRows[titleIndex-1]===titleFirst-1) {
      titleFirst--;titleIndex--;
    }
    const titleStyle=rows.slice(titleFirst,titleLast+1).some(isNativeTitleRow) ? 'accent-bold' : 'default-bold';
    if(titleStyle==='default-bold' && choices.length && !nativeGroup)return {kind:'unknown',
      reason:'native-question-selection-unproven',diagnostic:{sectionKnown,choices:choices.length}};
    const title=lines.slice(titleFirst,titleLast+1).reduce((value,line,index)=>value
      +(index ? nativeRowSeparator(rows[titleFirst+index]) : '')+line.trim(),'');
    // Ignore numbered transcript rows above the last native accent block.
    const ownChoices=choices.filter(item=>item.row>titleLast
      && (!nativeGroup || item.row>=nativeGroup.first && item.row<=nativeGroup.last));
    choices.splice(0,choices.length,...ownChoices);
    optionIndex=choices.find(item=>QUESTION_OPTION_RE.exec(lines[item.row])?.[1])?.number-1;
    if (!Number.isInteger(optionIndex)) optionIndex=null;
    const totalMatch=/option\s+\d+\/(\d+)/.exec(lines.slice(footer,footer+4).join(' '));
    const optionCount=totalMatch ? Number(totalMatch[1]) : choices.reduce((n,item)=>Math.max(n,item.number),0);
    const selected=choices.find(item=>item.number-1===optionIndex);
    const otherSelected=!!selected && selected.number===optionCount;
    let draft='',draftUncertain=false;
    if (!choices.length) {
      // The free-answer editor has NO prompt glyph. Use its cursor and native
      // dim placeholder, rather than treating the placeholder as title text.
      const cursorRow=Number(frame.baseY)+Number(frame.cursorY);
      const cursorIndex=rows.findIndex(row=>Number(row.row)===cursorRow);
      if(cursorIndex<=titleLast || cursorIndex>=footer)return {kind:'unknown'};
      editorRow=titleLast+1;
      while(editorRow<cursorIndex && !lines[editorRow].trim())editorRow++;
      const inputRows=lines.slice(editorRow,footer);
      while(inputRows.length && !inputRows[inputRows.length-1].trim())inputRows.pop();
      draft=inputRows.map(line=>line.replace(/^\s{2}/,'')).join('\n');
      if (normalize(draft)==='Type your answer' && rows[editorRow]?.allTextDim)draft='';
      draftUncertain=inputRows.length>1;
    } else if(otherSelected) {
      draft=selected.label;
      if (/^Other(?: \(write an answer\))?$|^Type your answer$/.test(draft)
        && rows[selected.row]?.hasDim)draft='';
      draftUncertain=selected.lineCount>1;
    }
    draftUncertain ||= /\[Pasted (?:Text|text)\b/.test(draft);
    return { kind:'expanded', count,current:current-1,title,choices,optionIndex,optionCount,
      otherSelected,draft,draftUncertain,titleStyle,writeSeq:frame.writeSeq };
  }
  for(let i=Math.max(0,lines.length-15);i<lines.length;i++) {
    const match=/^\s*\?\s+(\d+)\s+questions?(?:\s*·\s*(\d+s))?\s*$/.exec(lines[i]);
    if (!match)continue;
    const hint=lines.slice(i+1,i+4).join(' ');
    if (!QUESTION_ANSWER_HINT_RE.test(hint) || lastPrompt<=i || lastPrompt-i>6)continue;
    const nativeHeader=lines.slice(Math.max(0,i-3),i).some(line=>QUESTION_QUEUE_HEADER_RE.test(line));
    if (!nativeHeader || rows[i]?.hasDim!==true || rows[i]?.allTextDim!==false
      || !rows.slice(i+1,i+4).some(row=>row.hasDim===true))continue;
    return {kind:'collapsed',count:Number(match[1]),current:null,countdown:match[2] || null,writeSeq:frame.writeSeq};
  }
  if (lastPrompt>=0 && lastPrompt>footer)return {kind:'none',count:0,writeSeq:frame.writeSeq};
  return {kind:'unknown'};
}

function createCodexNativeQuestionMirror({ readFrame, readOwner, subscribeFrames, withWriter, publish, log }) {
  const states=new Map();
  const pendingActions=new Map();
  const stateFor=tabId=>{
    const owner=readOwner(tabId);
    if (!owner)return null;
    let state=states.get(tabId);
    if (!state || state.ownerKey!==owner.key) {
      if (state?.public) publish(tabId,null);
      state={ownerKey:owner.key,candidates:[],epoch:0,closed:false,public:null};
      states.set(tabId,state);
    }
    return state;
  };
  const publishState=(tabId,state,next)=>{
    if (JSON.stringify(state.public)===JSON.stringify(next))return;
    state.public=next;
    publish(tabId,next);
  };
  const refresh=(tabId,provided)=>{
    const state=stateFor(tabId);
    if (!state) { clear(tabId,'owner-ended');return null; }
    const owner=readOwner(tabId);
    const native=inspectCodexNativeQuestions(provided || readFrame(tabId));
    if (native.kind==='unknown')return state.public;
    if (state.closed || native.kind==='none' || !native.count) {
      publishState(tabId,state,null);return null;
    }
    let candidate=null;
    if(native.kind==='expanded') {
      const matches=state.candidates.filter(item=>item.accepted!==false && normalize(item.title)===normalize(native.title));
      if(matches.length===1)candidate=matches[0];
      else if(matches.length && state.candidates.length===native.count
        && matches.includes(state.candidates[native.current]))candidate=state.candidates[native.current];
      else if(matches.length && matches.every(item=>JSON.stringify(item.options)===JSON.stringify(matches[0].options))) {
        // Content is unambiguous but the call link is not. Native navigation
        // owns the focused item; do not invent an ID from matching words.
        candidate={...matches[0],id:null};
      }
    }
    const choices=candidate?.options || [];
    const targetId=digest([owner.key,state.epoch,native.kind==='expanded'
      ? [native.current,native.count,normalize(native.title),candidate?.id || ''] : [native.count]]);
    const next={source:'codex-pty',tabId,sessionId:owner.sessionId || null,
      lifecycleGeneration:owner.lifecycleGeneration,count:native.count,expanded:native.kind==='expanded',
      current:native.current,targetId,questionId:candidate?.id || null,
      optionIndex:native.optionIndex ?? null,title:candidate?.title || native.title || '',
      options:choices,draft:native.draft || '',countdown:native.countdown || null};
    if(native.kind==='expanded' && state.public?.targetId!==targetId) {
      const definitions=state.candidates.filter(item=>item.accepted!==false);
      log('title-frame',tabId,{writeSeq:native.writeSeq,current:native.current,count:native.count,
        titleStyle:native.titleStyle,
        titleChars:native.title.length,titleHash:digest(native.title),
        nativeChoices:native.choices.length,definitions:definitions.length,matched:!!candidate,
        ...(definitions.length===1 ? {definitionTitleChars:definitions[0].title.length,
          definitionTitleHash:digest(definitions[0].title)} : {})});
    }
    publishState(tabId,state,next);
    return next;
  };
  function clear(tabId,reason) {
    const old=states.get(tabId);
    states.delete(tabId);
    if(old?.public) { publish(tabId,null); log('clear',tabId,{reason}); }
  }
  function observeRecord(tabId,record) {
    const state=stateFor(tabId);
    if(!state)return;
    const payload=record?.payload || {};
    if(record.type==='event_msg' && ['task_complete','turn_aborted'].includes(payload.type)) {
      state.closed=true;state.candidates=[];state.lastQuestionSignature=null;state.epoch++;
      publishState(tabId,state,null);
      return;
    }
    if(record.type==='response_item' && payload.type==='function_call_output') {
      const callId=String(payload.call_id || '');
      if(!callId || !state.candidates.some(candidate=>candidate.callId===callId))return;
      let output=payload.output;
      if(typeof output==='string') {try {output=JSON.parse(output);}catch {output=null;} }
      if(output?.accepted===true) for(const candidate of state.candidates) {
        if(candidate.callId===callId)candidate.accepted=true;
      }
      else state.candidates=state.candidates.filter(candidate=>candidate.callId!==callId);
      refresh(tabId);return;
    }
    let id='',questions=null,accepted=true;
    if(record.type==='response_item' && payload.type==='function_call' && payload.name==='request_user_input_async') {
      let args=payload.arguments;
      if(typeof args==='string') { try {args=JSON.parse(args);}catch{return;} }
      questions=args?.questions;id=String(payload.call_id || payload.id || '');accepted=false;
    } else if(record.type==='event_msg') {
      const item=['item_started','item_completed'].includes(payload.type) ? payload.item : payload;
      if((item?.type==='agent_message' || item?.type==='AgentMessage') && item.delivery==='async') {
        questions=item.questions;id=String(item.id || '');
      }
    }
    if(Array.isArray(questions) && questions.length
      && questions.every(question=>typeof question?.title==='string' && question.title.trim()
        && (question.options==null || Array.isArray(question.options) && question.options.every(option=>typeof option==='string')))) {
      const signature=JSON.stringify(questions);
      const ids=id ? questions.map((_question,index)=>JSON.stringify(['request_user_input_async',id,index])) : [];
      if(ids.length && ids.every(questionId=>state.candidates.some(candidate=>candidate.id===questionId)))return;
      if(!id && state.lastQuestionSignature===signature)return;
      state.lastQuestionSignature=signature;
      // The call carries content, not acceptance. Native frames decide whether
      // it is currently actionable; no durable independent pending state exists.
      state.candidates=[...state.candidates,...questions.slice(0,64).map((question,index)=>({
        id:id ? ids[index] : null,callId:id || null,accepted,
        title:String(question.title || ''),
        options:Array.isArray(question.options) ? question.options : [],
      }))].slice(-64);
      state.closed=false;state.epoch++;
      refresh(tabId);
    }
  }
  const sameQuestion=(first,next)=>next?.kind==='expanded' && first.count===next.count
    && first.current===next.current && normalize(first.title)===normalize(next.title);
  async function control(tabId,args={}) {
    const requestId=String(args.requestId || '');
    if(!requestId)return {success:false,error:'question_request_id_required'};
    if(pendingActions.has(tabId))return {success:false,error:'question_control_in_progress'};
    const current=refresh(tabId);
    if(!current || current.targetId!==args.targetId)return {success:false,error:'question_state_changed'};
    const action=String(args.action || '');
    if(!['open','close','next','previous','skip','answer'].includes(action))return {success:false,error:'question_action_unknown'};
    pendingActions.set(tabId,requestId); // synchronous admission before await
    let inputWritten=false, submitWritten=false;
    try {
      return await withWriter(tabId,async writer=>{
        const state=stateFor(tabId), ownerKey=state?.ownerKey, epoch=state?.epoch;
        const read=()=>inspectCodexNativeQuestions(readFrame(tabId));
        const abort=()=>{
          const owner=readOwner(tabId);
          return !owner || owner.key!==ownerKey || states.get(tabId)?.closed
            || states.get(tabId)?.epoch!==epoch ? 'question_owner_changed' : writer.abortReason();
        };
        async function step(keys,predicate,submitting=false) {
          const before=readFrame(tabId);
          const observed=await waitForCommittedSemanticFrame({
            subscribe:callback=>subscribeFrames(tabId,callback),
            readSnapshot:()=>readFrame(tabId), inspectSnapshot:inspectCodexNativeQuestions,
            acceptInspection:predicate, afterWriteSeq:before?.writeSeq,
            timeoutMs:4000,getAbortReason:abort,
            trigger:()=>{
              if(abort())throw new Error(abort());
              writer.write(keys);inputWritten=true;if(submitting)submitWritten=true;
            },
          });
          log('frame-result',tabId,{requestId,action,ready:observed.ready===true,
            reason:observed.reason,frames:observed.observedFrames,elapsedMs:observed.elapsedMs,
            kind:observed.lastInspection?.kind || 'unknown',writeSeq:observed.lastSnapshot?.writeSeq ?? null,
            count:observed.lastInspection?.count ?? null,
            titleStyle:observed.lastInspection?.titleStyle || null,
            inspectionReason:observed.lastInspection?.reason || null,
            diagnostic:observed.lastInspection?.diagnostic || null});
          if(!observed.ready)throw new Error(observed.reason || 'question_frame_unconfirmed');
          refresh(tabId,observed.lastSnapshot);
          return observed.lastInspection;
        }
        let native=read();
        if(native.kind!=='expanded') {
          if(action==='close')return {success:true,requestId,inputWritten:false};
          if(native.kind!=='collapsed')throw new Error('question_not_actionable');
          native=await step(KEYS.open,next=>next.kind==='expanded');
        }
        const target=native;
        if(action==='open')return {success:true,requestId,inputWritten,state:refresh(tabId)};
        if(action==='next' || action==='previous' || action==='close') {
          const moves=action==='close' ? native.current+1 : 1;
          if(action==='next' && native.current>=native.count-1)throw new Error('question_is_last');
          for(let i=0;i<moves;i++) {
            const old=native;
            native=await step(action==='next' ? KEYS.open : KEYS.back,next=>
              action!=='next' && old.current===0 ? next.kind==='collapsed'
                : next.kind==='expanded' && next.current===old.current+(action==='next'?1:-1));
          }
          return {success:true,requestId,inputWritten,state:refresh(tabId)};
        }
        if(action==='skip') {
          await step(KEYS.skip,next=>next.kind==='none'
            || (next.count===target.count-1 && (next.kind==='collapsed' || next.kind==='expanded')));
          log('skip-native',tabId,{requestId});
          return {success:true,requestId,inputWritten,handledLocally:true,providerConfirmed:null};
        }
        const answer=String(args.answer || '');
        if(!answer.trim())throw new Error('question_answer_empty');
        if(native.draftUncertain)throw new Error('question_draft_not_fully_readable');
        if(native.draft && native.draft!==String(args.baseDraft || '') && native.draft!==answer)throw new Error('question_draft_changed');
        if(args.optionIndex!=null) {
          const index=args.optionIndex, currentQuestion=refresh(tabId);
          if(!Number.isInteger(index) || index<0 || currentQuestion?.expanded!==true
            || currentQuestion.options[index]!==answer)throw new Error('question_option_changed');
          const choice=native.choices.find(item=>item.number===index+1);
          if(!choice || normalize(choice.label)!==normalize(answer)
            || !Number.isInteger(native.optionIndex))throw new Error('question_option_not_fully_readable');
          // The native last/Other entry is a text editor, not a selectable
          // answer. Do not submit its placeholder as a fabricated choice.
          if(index===native.optionCount-1)throw new Error('question_option_requires_text');
          while(native.optionIndex!==index) {
            const old=native, delta=index>native.optionIndex ? 1 : -1;
            native=await step(delta>0 ? KEYS.down : KEYS.up,next=>sameQuestion(target,next)
              && next.optionIndex===old.optionIndex+delta);
          }
          await step(KEYS.enter,next=>next.kind==='none'
            || (next.count===target.count-1 && (next.kind==='collapsed' || next.kind==='expanded')),true);
          log('answer-native-choice',tabId,{requestId,optionIndex:index});
          return {success:true,requestId,inputWritten,handledLocally:true,providerConfirmed:null};
        }
        if(native.optionCount && !native.otherSelected) {
          for(let i=native.optionIndex ?? 0;i<native.optionCount-1;i++) {
            const old=native;
            native=await step(KEYS.down,next=>sameQuestion(target,next) && next.optionIndex===old.optionIndex+1);
          }
        }
        // Like normal Codex submit, paste has no pre-Enter ACK. Keep bytes
        // ordered on the exact proven question editor, including large paste chips.
        const submitKeys=native.draft===answer ? KEYS.enter
          : (native.draft ? KEYS.clear : '')+ESC+'[200~'+answer+ESC+'[201~'+KEYS.enter;
        await step(submitKeys,next=>next.kind==='none'
          || (next.count===target.count-1 && (next.kind==='collapsed' || next.kind==='expanded')),true);
        log('answer-native',tabId,{requestId,chars:answer.length});
        return {success:true,requestId,inputWritten,handledLocally:true,providerConfirmed:null};
      });
    } catch(error) {
      log('control-unconfirmed',tabId,{requestId,action,inputWritten,error:error.message});
      refresh(tabId);
      return {success:false,requestId,inputWritten,submitted:submitWritten,deliveryUnknown:submitWritten,
        error:error.message || 'question_control_failed'};
    } finally {if(pendingActions.get(tabId)===requestId)pendingActions.delete(tabId);}
  }
  return {observeRecord,observeFrame:(tabId,frame)=>refresh(tabId,frame),
    get:tabId=>refresh(tabId),list:()=>[...states].map(([tabId])=>refresh(tabId)).filter(Boolean),
    control,clear};
}

module.exports={createCodexNativeQuestionMirror,inspectCodexNativeQuestions};
