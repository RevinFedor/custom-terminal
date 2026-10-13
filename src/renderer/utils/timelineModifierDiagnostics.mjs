import { currentUIActionId, uiPerformancePhaseForAction } from './uiPerformanceDiagnostics.mjs';

export function createTimelineModifierDiagnostics({emit=console.warn,postTask,currentId=currentUIActionId,
  annotate=uiPerformancePhaseForAction,now=()=>performance.now(),max=32}={}) {
  const entries=new WeakMap(),pending=[];
  let scheduled=false,channel=null,dropped=0,disposed=false;
  max=Math.max(1,Math.min(32,Number.isSafeInteger(max)?max:32));
  const flush=()=>{
    scheduled=false;
    for(const record of pending.splice(0))try{
      record.closed=true;
      const {closed,...fields}=record;
      fields.callbackMs=Math.round(fields.callbackMs*10)/10;
      annotate(fields.actionId,'timeline-modifier-owners',fields);
      emit('[Perf:ModifierOwners] '+JSON.stringify({...fields,dropped}));
    }catch{dropped=Math.min(0xffffffff,dropped+1);}
  };
  return {
    record(event,{presented,relevant,before,after,reasonMask,started}){
      try {
        if(disposed || event?.key!=='Meta')return;
        const actionId=currentId();if(!actionId)return;
        let record=entries.get(event);
        if(!record || record.closed || record.actionId!==actionId){
          if(pending.length>=max){dropped=Math.min(0xffffffff,dropped+1);return;}
          record={actionId,owners:0,presentedRelevant:0,truePublications:0,falsePublications:0,hiddenClears:0,reasonMask:0,callbackMs:0,closed:false};
          entries.set(event,record);pending.push(record);
        }
        record.owners++;record.presentedRelevant+=Number(presented&&relevant);
        record.truePublications+=Number(before!==after&&after===true);
        record.falsePublications+=Number(before!==after&&after===false);
        record.hiddenClears+=Number(!presented&&before===true&&after===false);
        record.reasonMask|=reasonMask&255;record.callbackMs+=Math.max(0,now()-started);
        if(scheduled)return;scheduled=true;
        if(postTask)postTask(flush);
        else {channel ||= new MessageChannel();channel.port1.onmessage=flush;channel.port2.postMessage(0);}
      }catch{scheduled=false;pending.length=0;dropped=Math.min(0xffffffff,dropped+1);}
    },
    dispose(){disposed=true;pending.length=0;channel?.port1.close();channel?.port2.close();},
  };
}

const modifierDiagnostics=createTimelineModifierDiagnostics();
globalThis.window?.addEventListener?.('beforeunload',()=>modifierDiagnostics.dispose(),{once:true});
export const recordTimelineModifierOwner=(event,record)=>modifierDiagnostics.record(event,record);
