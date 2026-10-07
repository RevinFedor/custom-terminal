import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import SideFlyout from '../UI/SideFlyout';
import { CONTEXT_MENU_ICON_SLOT_STYLE, CONTEXT_MENU_PANEL_STYLE, CONTEXT_MENU_ROW_STYLE } from '../UI/contextMenuMetrics.mjs';
import { submenuArrow } from '../../utils/submenuSide.mjs';
import {useWorkspaceOverlayTarget} from '../../hooks/useWorkspaceOverlayTarget';

/** A regular tab-menu row; choices open beside it without resizing the menu. */
export default function TabMenuChoices({label, icon, action, side, choices, onChoose}: {
  label: string; icon: React.ReactNode; action: string; side: 'left' | 'right';
  choices: {id: string; name: string; selected?: boolean}[];
  onChoose: (id: string) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null), flyout = useRef<HTMLDivElement>(null);
  const overlayTarget = useWorkspaceOverlayTarget();
  const [open,setOpen] = useState(false);
  const getAnchorRect = useCallback(() => anchor.current?.getBoundingClientRect() || null,[]);
  const leave = (event: React.MouseEvent) => {
    const target = event.relatedTarget;
    if (target instanceof Node && (anchor.current?.contains(target) || flyout.current?.contains(target))) return;
    setOpen(false);
  };
  return <div onMouseLeave={leave} onKeyDown={event => {if(event.key === 'Escape') {event.stopPropagation();setOpen(false);anchor.current?.focus();}}}>
    <button ref={anchor} type="button" role="menuitem" data-context-menu-row="ordinary" data-tab-context-action={action}
      aria-haspopup="menu" aria-expanded={open} style={CONTEXT_MENU_ROW_STYLE}
      className="w-full text-left text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-between"
      onMouseEnter={() => setOpen(true)} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}>
      <span className="flex items-center gap-2 min-w-0"><span style={CONTEXT_MENU_ICON_SLOT_STYLE}>{icon}</span>
        <span className="truncate">{label}</span></span><span className="text-[#666]">{submenuArrow(side)}</span>
    </button>
    {open && createPortal(<SideFlyout ref={flyout} getAnchorRect={getAnchorRect} side={side} gap={4} zIndex={100060}
      data-tab-context-menu data-tab-menu-choices={action} onMouseLeave={leave}
      onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <div role="menu" aria-label={label} style={{...CONTEXT_MENU_PANEL_STYLE, width:'max-content',maxWidth:280,
        maxHeight:'calc(100vh - 24px)',overflowY:'auto',background:'#2a2a2a',border:'1px solid #444',color:'#ccc'}}>
        {choices.map(choice => <button key={choice.id} type="button" role="menuitemradio" aria-checked={!!choice.selected}
          data-tab-menu-choice={choice.id} style={CONTEXT_MENU_ROW_STYLE}
          className="w-full text-left text-[13px] hover:bg-white/10 cursor-pointer flex items-center gap-2"
          onClick={() => {setOpen(false);onChoose(choice.id);}}>
          <span style={CONTEXT_MENU_ICON_SLOT_STYLE}>{choice.selected && <Check size={12}/>}</span>
          <span className="truncate min-w-0">{choice.name}</span>
        </button>)}
      </div>
    </SideFlyout>,overlayTarget)}
  </div>;
}
