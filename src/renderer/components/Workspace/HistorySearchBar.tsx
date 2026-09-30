import React,{useLayoutEffect,useRef} from 'react';
import {ArrowDown, ArrowUp, Search, X} from 'lucide-react';
import {HISTORY_SEARCH_PAGE_SIZE} from '../../../shared/history-search.mjs';

export default function HistorySearchBar({inputRef,query,type,onQuery,onType,onPrevious,onNext,onClose,onSelect,result,current,loading,error}:any) {
  const listRef=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const list=listRef.current, selected=list?.querySelector<HTMLElement>('[aria-current="true"]');
    if(!list||!selected)return;
    const viewport=list.getBoundingClientRect(),row=selected.getBoundingClientRect();
    if(row.top<viewport.top)list.scrollTop+=row.top-viewport.top;
    else if(row.bottom>viewport.bottom)list.scrollTop+=row.bottom-viewport.bottom;
  },[current,result]);
  const button:React.CSSProperties={display:'flex',alignItems:'center',justifyContent:'center',width:26,height:26,border:0,borderRadius:4,background:'transparent',color:'#aaa',cursor:'pointer',flexShrink:0};
  const count=Number(result?.total||0);
  return <div data-history-search-panel onKeyDown={event=>{
    if(event.nativeEvent.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}
    if(event.altKey||event.metaKey||event.ctrlKey)return;
    const target=event.target as HTMLElement;
    if(target.tagName==='SELECT'||(target.closest('button')&&event.key==='Enter')||(event.shiftKey&&event.key!=='Enter'))return;
    const previous=event.key==='ArrowLeft'||event.key==='ArrowUp'||(event.key==='Enter'&&event.shiftKey);
    const next=event.key==='ArrowRight'||event.key==='ArrowDown'||(event.key==='Enter'&&!event.shiftKey);
    if(previous||next){event.preventDefault();event.stopPropagation();previous?onPrevious():onNext();}
  }} style={{width:'100%',minWidth:0,flexBasis:'100%',order:2,color:'#ddd'}}>
    <div style={{display:'flex',gap:4,alignItems:'center'}}>
      <Search size={14} aria-hidden/>
      <input ref={inputRef} aria-label="Поиск по чату" placeholder="Найти в чате…" value={query} onChange={event=>onQuery(event.target.value)}
        style={{flex:1,minWidth:0,height:27,padding:'0 6px',background:'#18181b',border:'1px solid #444',borderRadius:4,color:'#eee',outline:'none',fontSize:12}}/>
      <span data-history-search-count aria-live="polite" style={{fontSize:11,whiteSpace:'nowrap'}}>{loading?'…':`${count?current+1:0}/${count}`}</span>
      <button aria-label="Предыдущее совпадение" title="Предыдущее · ← / ↑" disabled={!count} onClick={onPrevious} style={{...button,opacity:count?1:.35}}><ArrowUp size={14}/></button>
      <button aria-label="Следующее совпадение" title="Следующее · → / ↓" disabled={!count} onClick={onNext} style={{...button,opacity:count?1:.35}}><ArrowDown size={14}/></button>
      <button aria-label="Закрыть поиск по чату" title="Закрыть · Esc" onClick={onClose} style={button}><X size={14}/></button>
    </div>
    <div style={{display:'flex',alignItems:'center',gap:8,marginTop:6}}>
      <select aria-label="Тип сообщений" value={type} onChange={event=>onType(event.target.value)} style={{background:'#242427',color:'#ccc',border:'1px solid #444',borderRadius:4,fontSize:11,padding:'3px 4px',minWidth:0}}>
        <option value="all">Все сообщения</option><option value="user">Промпты</option><option value="assistant">Ответы</option><option value="user-images">Промпты с изображениями</option>
      </select>
      <span data-history-search-entry-count style={{fontSize:11,color:'#999'}}>{result?`Сообщений: ${result.entryTotal}`:''}</span>
    </div>
    {error&&<div role="status" style={{fontSize:11,color:'#fca5a5',paddingTop:6}}>Не удалось выполнить поиск. {error}</div>}
    {!loading&&!error&&(query||type!=='all')&&!count&&<div style={{fontSize:11,color:'#999',paddingTop:6}}>Ничего не найдено</div>}
    {count>0&&<div ref={listRef} data-history-search-results style={{maxHeight:180,overflowY:'auto',marginTop:6,borderTop:'1px solid #333'}}>
      {(result?.matches||[]).map((match:any)=><button key={match.matchIndex} data-history-search-result={match.matchIndex} aria-current={match.matchIndex===current?'true':undefined}
        onClick={()=>onSelect(match.matchIndex)} style={{display:'block',textAlign:'left',width:'100%',padding:'6px 7px',border:0,borderRadius:3,color:'#ddd',cursor:'pointer',fontSize:11,
        background:match.matchIndex===current?'rgba(234,179,8,.15)':'transparent'}}>
        <span style={{color:'#999',fontSize:10}}>{match.role==='user'?'Промпт':match.role==='assistant'?'Ответ':'Сообщение'} · {match.matchIndex+1}</span>
        <span style={{display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden',whiteSpace:'pre-wrap'}}>{query
          ? <>{match.snippet.slice(0,match.offset-match.snippetStart)}<mark style={{background:'rgba(234,179,8,.35)',color:'inherit'}}>{match.snippet.slice(match.offset-match.snippetStart,match.offset-match.snippetStart+query.length)}</mark>{match.snippet.slice(match.offset-match.snippetStart+query.length)}</>
          : match.snippet||(match.hasImages?'Изображение':'Сообщение без текста')}</span>
      </button>)}
    </div>}
    {count>0&&(result.offset>0||result.truncated)&&<div style={{display:'flex',justifyContent:'space-between',gap:8,paddingTop:5}}>
      <button disabled={!result.offset} onClick={()=>onSelect(Math.max(0,result.offset-HISTORY_SEARCH_PAGE_SIZE))}
        style={{...button,width:'auto',height:'auto',minWidth:0,flex:'1 1 0',padding:'3px 2px',fontSize:11,opacity:result.offset?1:.35}}>Предыдущие результаты</button>
      <button disabled={!result.truncated} onClick={()=>onSelect(result.offset+result.matches.length)}
        style={{...button,width:'auto',height:'auto',minWidth:0,flex:'1 1 0',padding:'3px 2px',fontSize:11,opacity:result.truncated?1:.35}}>Следующие результаты</button>
    </div>}
  </div>;
}
