import React, { forwardRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { PROJECT_CARD_MAX_H } from '../../constants/layout';
import { Inbox } from 'lucide-react';
import { INBOX_WORKFLOW_ID } from '../../utils/workflowMembership.mjs';

type Props = Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  as?: 'button' | 'span';
  workflowId: string;
  label: string;
  icon: string | null;
  selected: boolean;
  pending?: boolean;
  hovered?: boolean;
  pointerHeld?: boolean;
  swapTarget?: boolean;
  navigationTarget?: boolean;
  disabled?: boolean;
  unplaced?: boolean;
  showIdentity?: boolean;
  children?: ReactNode;
};

// Visual owner only. Navigation, scope selection, counts and DnD stay with
// callers; a chooser must never inherit SpaceStrip's switch/delete handlers.
export default forwardRef<HTMLElement, Props>(function WorkflowChip({
  as = 'button', workflowId, label, icon, selected, pending = false, hovered,
  pointerHeld = false, swapTarget = false, navigationTarget = false, disabled = false,
  unplaced = false, showIdentity = true, children, style, onMouseEnter, onMouseLeave, ...props
}, ref) {
  const [localHover, setLocalHover] = useState(false);
  const fontSize = useUIStore(s => s.projectTabsFontSize);
  const hover = !disabled && (hovered ?? localHover);
  const active = selected || pending;
  const inbox = workflowId === INBOX_WORKFLOW_ID;
  const Element = as;
  return <Element {...props} ref={ref as React.Ref<HTMLButtonElement & HTMLSpanElement>}
    {...(as === 'button' ? { type: 'button' as const, disabled, 'aria-pressed': selected } : {})}
    data-workflow-chip={workflowId}
    data-workflow-inbox={inbox ? '1' : undefined}
    onMouseEnter={event => { setLocalHover(true); onMouseEnter?.(event); }}
    onMouseLeave={event => { setLocalHover(false); onMouseLeave?.(event); }}
    style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 5,
      flexShrink: 0, maxWidth: 220, minWidth: 0, height: PROJECT_CARD_MAX_H,
      padding: '0 8px', borderRadius: 4, fontSize, lineHeight: `${PROJECT_CARD_MAX_H}px`,
      whiteSpace: 'nowrap', cursor: disabled ? 'default' : 'pointer', userSelect: 'none',
      boxSizing: 'border-box', fontFamily: 'inherit', appearance: 'none',
      color: active || swapTarget ? '#e8e8ea' : (hover ? '#cfcfd4' : '#9b9ba1'),
      background: swapTarget ? 'rgba(139,92,246,0.18)' : active ? 'rgba(255,255,255,0.10)'
        : navigationTarget ? 'rgba(139,92,246,0.14)' : hover ? 'rgba(255,255,255,0.055)' : 'transparent',
      border: '1px solid ' + (swapTarget ? 'rgba(167,139,250,0.95)' : active ? 'rgba(255,255,255,0.22)'
        : navigationTarget ? 'rgba(167,139,250,0.9)' : hover ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)'),
      ...(inbox && !swapTarget && !navigationTarget ? {
        color:active ? '#ffd9a7' : '#dfb078',
        background:active ? 'rgba(240,144,24,0.2)' : hover ? 'rgba(240,144,24,0.14)' : 'rgba(240,144,24,0.06)',
        borderColor:active ? 'rgba(240,144,24,0.65)' : 'rgba(240,144,24,0.28)',
      }:{}),
      transform: pointerHeld ? 'scale(0.985)' : undefined, opacity: disabled ? 0.52 : 1, transition: 'none', ...style }}>
    {showIdentity && <>
      {inbox ? <Inbox data-workflow-inbox-icon aria-hidden size={16} style={{flexShrink:0,color:'#f0a34a'}}/> : icon ? <img data-workflow-icon={workflowId} src={icon} alt="" draggable={false}
        style={{ width: 16, height: 16, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
        : <span data-workflow-fallback-icon={workflowId} aria-hidden style={{ width: 16, height: 16, borderRadius: 4,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          border: unplaced ? '1px dashed rgba(148,163,184,0.72)' : '1px solid rgba(255,255,255,0.16)',
          background: 'rgba(255,255,255,0.06)', color: '#9b9ba1', fontSize: 9, fontWeight: 700 }}>
          {unplaced ? '' : label.trim().slice(0, 1).toUpperCase() || 'W'}
        </span>}
      <span data-workflow-chip-label style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </>}
    {children}
  </Element>;
});
