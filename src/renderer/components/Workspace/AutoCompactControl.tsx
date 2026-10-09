import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, FoldVertical, MoreHorizontal, Slash, X } from 'lucide-react';
import { useAutoCompactStore } from '../../store/useAutoCompactStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { automationWorkflowForProject, autoCompactIncludesTarget } from '../../utils/autoCompactPolicy.mjs';
import { cancelPendingAutoCompact } from '../../hooks/usePromptQueueRunner';
import CenteredUpwardPopover from '../UI/CenteredUpwardPopover';
import { markQueueChildDismiss, notifyQueueClickChildClosed } from '../../utils/hoverReturnGate.mjs';

export function AutoCompactControl({ tabId, settings = false, global = false, compact = false, hoverOwner }: {
  tabId: string; settings?: boolean; global?: boolean; compact?: boolean; hoverOwner?: string;
}) {
  const policy = useAutoCompactStore((s) => s.policy);
  const hydrated = useAutoCompactStore((s) => s.hydrated);
  const activity = useAutoCompactStore((s) => s.activities[tabId]);
  const workflowId = useWorkspaceStore((s) => {
    for (const [id, ws] of s.openProjects) if (ws.tabs.has(tabId)) return automationWorkflowForProject(s.spaces, id);
    return '';
  });
  const excluded = policy.excludedTabIds.includes(tabId);
  const applies = policy.enabled && autoCompactIncludesTarget(policy, { tabId, provider: 'codex', workflowId });
  const [open, setOpen] = useState(false);
  const wasClickOpenRef = useRef(false);
  const dismissRef = useRef<{ reason: string; point: { clientX: number; clientY: number } | null } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const visible = settings || applies || excluded || !!activity;
  useLayoutEffect(() => {
    const held = open && visible && !!hoverOwner;
    if (wasClickOpenRef.current && !held) {
      notifyQueueClickChildClosed(hoverOwner, dismissRef.current?.reason || 'selection', dismissRef.current?.point || null);
    }
    wasClickOpenRef.current = held;
    if (held) dismissRef.current = null;
  }, [open, visible, hoverOwner]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) {
        dismissRef.current = { reason: 'outside', point: { clientX: e.clientX, clientY: e.clientY } };
        markQueueChildDismiss(e, hoverOwner);
        setOpen(false);
      }
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') {
      e.stopImmediatePropagation(); dismissRef.current = { reason: 'escape', point: null }; setOpen(false);
    } };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  if (!visible) return null;
  const label = excluded ? 'Автокомпакт отключён для этой вкладки'
    : applies ? `Автокомпакт после ответа при контексте ≥ ${policy.percent}%`
      : 'Глобальный автокомпакт не применяется';
  return <>
    <button ref={trigger} type="button" className="pq-edge-action"
      data-auto-compact-control={tabId} data-auto-compact-excluded={excluded || undefined}
      aria-label={settings ? 'Настройки Run After' : label} aria-expanded={open}
      title={activity?.message || label} disabled={!hydrated}
      onClick={() => setOpen(!open)}
      style={{ position: 'relative', width: compact ? 20 : 22, height: compact ? 20 : 22, padding: 0, display: 'inline-grid', placeItems: 'center',
        border: '1px solid rgba(255,255,255,.10)', borderRadius: 6, background: open ? '#333' : '#171717',
        color: excluded || activity?.phase === 'error' ? '#da9865' : '#a1a1a7', cursor: 'pointer', flexShrink: 0 }}>
      {settings ? <MoreHorizontal size={13} /> : <FoldVertical size={13} />}
      {!settings && excluded && <Slash size={17} style={{ position: 'absolute' }} />}
    </button>
    {open && createPortal(<CenteredUpwardPopover ref={menu} getAnchorRect={() => trigger.current?.getBoundingClientRect() || null}
      zIndex={global ? 15300 : 10000} data-run-after-satellite="true"
      data-run-after-hover-owner={hoverOwner}
      data-run-after-click-open={hoverOwner ? 'true' : undefined}
      data-run-after-auto-compact-menu={tabId}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
      style={{ width: 265, padding: 10, background: '#181818', border: '1px solid #444', borderRadius: 8, color: '#ccc', fontSize: 12 }}>
      <div style={{ marginBottom: 8 }}>Автокомпакт · эта вкладка</div>
      <button type="button" aria-pressed={!excluded}
        onClick={() => useAutoCompactStore.getState().setExcluded(tabId, !excluded)}
        style={{ height: 25, padding: '0 7px', display: 'inline-flex', alignItems: 'center', gap: 5,
          border: `1px solid ${excluded ? '#3a3a3a' : '#806044'}`, borderRadius: 6,
          background: excluded ? '#1e1e1e' : 'rgba(147,88,42,0.18)',
          color: excluded ? '#999' : '#e7d8c5', cursor: 'pointer', font: 'inherit' }}>
        <span aria-hidden style={{ width: 11, height: 11, display: 'grid', placeItems: 'center' }}>
          {!excluded && <Check size={10} strokeWidth={2.5} />}
        </span>
        Использовать общее правило
      </button>
      <div style={{ color: '#888', fontSize: 11, marginTop: 8 }}>{label}. Порог: ≥ {policy.percent}%.</div>
      {activity && <div style={{ marginTop: 8, color: '#d9ae7c' }}>{activity.message}
        {activity.phase !== 'compacting' && activity.phase !== 'resuming' && <button type="button"
          aria-label="Отменить ожидающий автокомпакт" onClick={() => {
            cancelPendingAutoCompact(tabId);
            useAutoCompactStore.getState().setActivity(tabId, null);
          }} style={{ marginLeft: 6, border: 0, color: '#aaa', background: 'transparent', cursor: 'pointer' }}><X size={12} /></button>}
      </div>}
    </CenteredUpwardPopover>, document.body)}
  </>;
}
