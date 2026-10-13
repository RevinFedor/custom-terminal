import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import WorkflowChip from './WorkflowChip';
import { markQueueChildDismiss, notifyQueueClickChildClosed } from '../../utils/hoverReturnGate.mjs';

export function AutomationWorkflowSelect({ groups, selectedIds, all, disabled, owner, name, onChange, trailing }: {
  groups: { id: string; name: string; icon: string | null }[]; selectedIds: string[]; all: boolean;
  disabled?: boolean; owner: string; name: string; onChange: (ids: string[], all: boolean) => void;
  trailing?: (id: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 320 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), wasOpen = useRef(false);
  const dismissal = useRef({ reason: 'selection', point: null as { clientX: number; clientY: number } | null });
  const selected = all ? groups.map(group => group.id) : selectedIds;
  const allSelected = all || (groups.length > 0 && groups.every(group => selected.includes(group.id)));
  const close = (reason: string, point: { clientX: number; clientY: number } | null = null) => { dismissal.current = { reason, point }; setOpen(false); };
  useLayoutEffect(() => {
    if (wasOpen.current && !open) notifyQueueClickChildClosed(owner, dismissal.current.reason, dismissal.current.point);
    wasOpen.current = open;
    if (!open) return;
    const measure = () => {
      const r = trigger.current?.getBoundingClientRect(), popup = menu.current;
      if (!r || !popup) return;
      const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
      const maxHeight = Math.min(320, Math.max(below, above));
      const height = Math.min(popup.scrollHeight, maxHeight);
      setPosition({ left: Math.max(8, Math.min(r.left, window.innerWidth - popup.offsetWidth - 8)),
        top: below >= height ? r.bottom + 4 : Math.max(8, r.top - height - 4), maxHeight });
    };
    measure(); window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open, owner]);
  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => {
      if (trigger.current?.contains(event.target as Node) || menu.current?.contains(event.target as Node)) return;
      markQueueChildDismiss(event, owner); close('outside', { clientX: event.clientX, clientY: event.clientY });
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') {
      event.stopImmediatePropagation(); close('escape');
    } };
    window.addEventListener('mousedown', down, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); };
  }, [open, owner]);
  const summary = all ? 'All workflows' : selected.length === 1
    ? groups.find(group => group.id === selected[0])?.name || '1 workflow' : `Workflows · ${selected.length}`;
  return <>
    <button ref={trigger} type="button" aria-label={`${name}: workflows`} aria-haspopup="menu" aria-expanded={open}
      disabled={disabled} onClick={() => open ? close('toggle') : setOpen(true)}
      style={{ height: 26, maxWidth: 200, padding: '0 7px', display: 'inline-flex', alignItems: 'center', gap: 6,
        border: '1px solid #414141', borderRadius: 5, background: open ? '#303030' : '#212121',
        color: selected.length ? '#c4b5fd' : '#aaa', font: 'inherit', cursor: 'pointer' }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span><ChevronDown size={12} />
    </button>
    {open && createPortal(<div ref={menu} data-automation-workflow-menu={name} role="menu"
      data-run-after-hover-owner={owner} data-run-after-click-open="true"
      onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      style={{ position: 'fixed', zIndex: 15350, ...position, width: 246, maxWidth: 'calc(100vw - 16px)',
        overflowY: 'auto', padding: 4, background: '#202022', border: '1px solid #444', borderRadius: 6,
        boxShadow: '0 8px 24px #0008', color: '#ccc', fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 4, paddingBottom: 4, borderBottom: '1px solid #343434', marginBottom: 4 }}>
        <button type="button"
          onClick={() => onChange(allSelected ? [] : groups.map(group => group.id), !allSelected)}
          style={{ padding: '3px 6px', background: '#29292b', border: '1px solid #3e3e42', borderRadius: 4,
            color: '#bbb', font: 'inherit', cursor: 'pointer' }}>{allSelected ? 'Clear all' : 'Select all'}</button>
      </div>
      {groups.map(group => {
        const checked = selected.includes(group.id);
        return <button key={group.id} type="button" role="menuitemcheckbox" aria-checked={checked}
          data-automation-workflow-option={group.id}
          onClick={() => onChange(checked ? selected.filter(id => id !== group.id) : [...selected, group.id], false)}
          style={{ width: '100%', padding: '2px 3px', border: 0, background: 'transparent', display: 'flex',
            alignItems: 'center', gap: 6, cursor: 'pointer', color: '#c4b5fd', textAlign: 'left' }}>
          <span style={{ flex: '0 0 14px', width: 14, height: 14, display: 'grid', placeItems: 'center',
            border: `1px solid ${checked ? '#9782c6' : '#57575b'}`, borderRadius: 3, background: checked ? '#392e50' : 'transparent' }}>
            {checked && <Check size={11} />}
          </span>
          <WorkflowChip as="span" workflowId={group.id} label={group.name} icon={group.icon} selected={checked}
            unplaced={group.id === '__unplaced__'} style={{ flex: 1, minWidth: 0, maxWidth: '100%' }}>
            {trailing?.(group.id)}
          </WorkflowChip>
        </button>;
      })}
    </div>, document.body)}
  </>;
}
