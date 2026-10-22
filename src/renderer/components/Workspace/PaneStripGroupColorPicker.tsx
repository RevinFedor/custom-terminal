import React,{useEffect,useRef,useState} from 'react';
import {HsvColorPicker} from 'react-colorful';
import {stripHexToHsv,stripHsvToHex} from '../../utils/paneStripColor.mjs';
import './PaneStripGroupColorPicker.css';

/** Existing2.8KB picker owns the SV square; a native vertical range owns hue.
 * Draft changes stay in this mounted picker. Persistence commits once on release
 * or keyboard completion, never on every move. */
export default function PaneStripGroupColorPicker({color,onCommit,disabled=false}: {
  color:string;onCommit:(color:string)=>void;disabled?:boolean;
}) {
  const [hsv,setHsv]=useState(()=>stripHexToHsv(color));
  const draft=useRef(hsv),dirty=useRef(false),release=useRef<null|(()=>void)>(null);
  const latest=useRef({disabled,onCommit,color});latest.current={disabled,onCommit,color};
  const commit=()=>{const changed=dirty.current;dirty.current=false;
    if(!latest.current.disabled&&changed)latest.current.onCommit(stripHsvToHex(draft.current));};
  const update=(next:{h:number;s:number;v:number})=>{if(disabled)return;draft.current=next;dirty.current=true;setHsv(next);};
  useEffect(()=>{release.current?.();const next=stripHexToHsv(color);draft.current=next;dirty.current=false;setHsv(next);},[color]);
  useEffect(()=>()=>{dirty.current=false;release.current?.();},[]);
  const begin=()=>{
    if(disabled||release.current)return;
    const end=()=>{cleanup();commit();},cancel=()=>{cleanup();dirty.current=false;
      const next=stripHexToHsv(latest.current.color);draft.current=next;setHsv(next);};
    const cleanup=()=>{window.removeEventListener('pointerup',end,true);window.removeEventListener('pointercancel',cancel,true);release.current=null;};
    release.current=cleanup;
    window.addEventListener('pointerup',end,true);window.addEventListener('pointercancel',cancel,true);
  };
  return <div className="pane-strip-color-picker" data-pane-strip-color-picker aria-disabled={disabled}
    onPointerDownCapture={begin} onPointerDown={event=>event.stopPropagation()}
    onMouseDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}
    onKeyUp={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Enter',' '].includes(event.key))commit();}}
    style={{pointerEvents:disabled?'none':undefined}}>
    <HsvColorPicker className="pane-strip-color-square" color={hsv} onChange={update}/>
    <div className="pane-strip-color-hue">
      <input className="pane-strip-color-hue-input" type="range" min="0" max="359" step="1" value={Math.round(hsv.h)}
        disabled={disabled} aria-label="Оттенок группы" aria-orientation="vertical"
        style={{accentColor:`hsl(${hsv.h} 100% 50%)`}}
        onChange={event=>update({...draft.current,h:Number(event.currentTarget.value)})}/>
    </div>
  </div>;
}
