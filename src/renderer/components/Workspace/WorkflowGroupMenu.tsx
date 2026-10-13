import React, { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, Folder, FolderInput, Pencil, Trash2, X } from 'lucide-react';
import { TAB_COLORS } from './tabChrome';
import {useWorkspaceOverlayTarget} from '../../hooks/useWorkspaceOverlayTarget';
import {reportWorkflowActionError} from '../../utils/workflowActionError';
import { CONTEXT_MENU_METRICS, CONTEXT_MENU_METRICS_HOOK, CONTEXT_MENU_PANEL_STYLE,
  CONTEXT_MENU_ROW_STYLE, CONTEXT_MENU_ICON_SLOT_STYLE, CONTEXT_MENU_BOTTOM_DIVIDER_STYLE } from '../UI/contextMenuMetrics.mjs';

export type WorkflowGlobalGroup = { id: string; name: string; revision: number; color?: string | null;
  collapsed?: boolean; sessionStatus?: string | null; [field: string]: unknown };
export type WorkflowGroupMember = { tabId: string; namespace?: string; projectId?: string; archived?: boolean; [field: string]: unknown };
export type WorkflowGroupMutation = { version: 1; mutationId: string; expectedRevision: number;
  groupId: string; expectedGroupRevision: number; [field: string]: unknown };
export type WorkflowGroupMemberIntent = { version: 1; mutationId: string; expectedRevision: number; expectedGroupRevision: number };
type Outcome = boolean | { success: boolean; error?: string };
export type WorkflowGroupMenuProps = {
  workflowId?: string;
  workflowName?: string;
  group: WorkflowGlobalGroup;
  revision: number;
  members: WorkflowGroupMember[];
  workflows: { id: string; name: string }[];
  statuses?: { id: string; label?: string; name?: string; color?: string }[];
  position: { x: number; y: number };
  onMutate: (kind: 'rename' | 'color' | 'status' | 'collapse' | 'delete', request: WorkflowGroupMutation) => Promise<Outcome> | Outcome;
  // These are explicit organization/close callbacks owned by Parent. No
  // project transfer, default placeTab, file unlink or terminal IPC here.
  onMoveMembers: (workflowId: string, members: WorkflowGroupMember[], group: WorkflowGlobalGroup, intent: WorkflowGroupMemberIntent) => Promise<Outcome> | Outcome;
  onCloseMembers: (members: WorkflowGroupMember[], group: WorkflowGlobalGroup, intent: WorkflowGroupMemberIntent) => Promise<Outcome> | Outcome;
  onDismiss: () => void;
  onRenameInline?: () => void;
};
const ok = (result: Outcome) => result === true || (typeof result === 'object' && result?.success === true);
const rowStyle = CONTEXT_MENU_ROW_STYLE as CSSProperties;
const iconStyle = CONTEXT_MENU_ICON_SLOT_STYLE as CSSProperties;

export default function WorkflowGroupMenu(props: WorkflowGroupMenuProps) {
  const { group, revision, members, workflows, statuses = [], onDismiss } = props;
  const overlayTarget = useWorkspaceOverlayTarget();
  const root = useRef<HTMLDivElement>(null), lock = useRef(false);
  const [screen, setScreen] = useState<'main' | 'rename' | 'color' | 'status' | 'move' | 'close'>('main');
  const [name, setName] = useState(group.name), [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<null | (() => Promise<void>)>(null);
  const [position, setPosition] = useState(props.position);
  const [closing, setClosing] = useState<null | { members: WorkflowGroupMember[]; group: WorkflowGlobalGroup; intent: WorkflowGroupMemberIntent }>(null);
  const activeMembers = members.filter(member => member.archived !== true);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const clamp = () => {
      const { width, height } = node.getBoundingClientRect(), inset = CONTEXT_MENU_METRICS.viewportInset;
      const next = { x: Math.max(inset, Math.min(props.position.x, window.innerWidth - width - inset)),
        y: Math.max(inset, Math.min(props.position.y, window.innerHeight - height - inset)) };
      setPosition(old => old.x === next.x && old.y === next.y ? old : next);
    };
    clamp(); const observer = new ResizeObserver(clamp); observer.observe(node);
    window.addEventListener('resize', clamp);
    return () => { observer.disconnect(); window.removeEventListener('resize', clamp); };
  }, [props.position.x, props.position.y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!lock.current && !root.current?.contains(event.target as Node)) onDismiss(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || lock.current) return;
      event.preventDefault(); event.stopPropagation();
      if (screen !== 'main' && !retry) { setScreen('main'); setName(group.name); } else onDismiss();
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [onDismiss, screen, retry, group.name]);

  const execute = async (action: () => Promise<Outcome> | Outcome, operation:Record<string,unknown>={}) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setRetry(null);
    const context={workflowId:props.workflowId,workflowName:props.workflowName,action:'Group '+String(operation.kind || screen),
      groupId:group.id,groupName:group.name,expectedRevision:revision,expectedGroupRevision:group.revision,...operation};
    try {
      const result = await action();
      if (ok(result)) onDismiss();
      else reportWorkflowActionError(typeof result === 'object' && result.error ? result.error : 'Изменение не принято. Обновите данные группы.',context);
    } catch (caught) {
      reportWorkflowActionError(caught,context);
      // Reuse the exact frozen action/request. A lost reply is not permission
      // to create another mutation ID or close a different member set.
      if((caught as any)?.disposition!=='not-applied')setRetry(() => () => execute(action,context));
    } finally { lock.current = false; setBusy(false); }
  };
  const mutate = (kind: Parameters<WorkflowGroupMenuProps['onMutate']>[0], patch: Record<string, unknown>) => {
    const request: WorkflowGroupMutation = { ...patch, version: 1, mutationId: crypto.randomUUID(),
      expectedRevision: revision, groupId: group.id, expectedGroupRevision: group.revision };
    const callback = props.onMutate;
    void execute(() => callback(kind, request),{kind,...request});
  };
  const disabled = busy || !!retry;
  const row = (label: string, action: () => void, icon: React.ReactNode, danger = false, selected = false, identity = label) => (
    <button key={identity} type="button" role="menuitem" disabled={disabled} data-group-action={label} data-group-action-id={identity}
      className="workflow-group-action w-full text-left text-[13px] flex items-center"
      style={{ ...rowStyle, color: danger ? '#f87171' : '#ccc', background: 'transparent', border: 0 }} onClick={action}>
      <span style={iconStyle}>{icon}</span><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {selected && <Check size={12} style={{ marginLeft: 'auto', flexShrink: 0 }} />}
    </button>
  );
  const back = () => { setScreen('main'); };
  return createPortal(<div ref={root} role="menu" aria-label={'Группа ' + group.name} data-workflow-group-menu
    data-context-menu-metrics={CONTEXT_MENU_METRICS_HOOK} aria-busy={busy}
    style={{ ...CONTEXT_MENU_PANEL_STYLE as CSSProperties, position: 'fixed', left: position.x, top: position.y,
      zIndex: 100030, background: '#2a2a2a', border: '1px solid #444', color: '#ccc',
      boxShadow: '0 16px 36px #0008', maxHeight: 'calc(100vh - 16px)', overflowY: 'auto',
      width: 'max-content', fontFamily: 'inherit' }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <style>{`.workflow-group-action:not(:disabled):hover,.workflow-group-action:not(:disabled):focus-visible{box-shadow:inset 0 0 0 999px #ffffff19;outline:none}
      .workflow-group-action:disabled{opacity:.45;cursor:default}.workflow-group-action{cursor:pointer}
      [data-workflow-group-menu] input:focus-visible{outline:1px solid #8b5cf6}`}</style>
    <div style={{ ...rowStyle, ...CONTEXT_MENU_BOTTOM_DIVIDER_STYLE, display: 'flex', alignItems: 'center', fontSize: 11, color: '#999' }}>
      <span style={iconStyle}><Folder size={12} color="#a78bfa" /></span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 190 }}>{group.name}</span>
      <span style={{ marginLeft: 'auto' }}>{activeMembers.length}</span>
    </div>
    {screen === 'main' && <>
      {row('Переименовать', () => {
        if(props.onRenameInline) {props.onRenameInline();onDismiss();}
        else {setName(group.name);setScreen('rename');}
      }, <Pencil size={12} />)}
      {row('Цвет', () => setScreen('color'), <span style={{ width: 11, height: 11, borderRadius: 3, background: TAB_COLORS.find(c => c.color === group.color)?.borderColor || '#666' }} />)}
      {row('Статус', () => setScreen('status'), <span style={{ width: 8, height: 8, borderRadius: '50%', background: statuses.find(s => s.id === group.sessionStatus)?.color || '#888' }} />)}
      {row(group.collapsed ? 'Развернуть' : 'Свернуть', () => mutate('collapse', { collapsed: !group.collapsed }), <Folder size={12} />)}
      {row('Перенести в workflow', () => setScreen('move'), <FolderInput size={12} />)}
      {row('Закрыть вкладки группы', () => {
        setClosing({ members: structuredClone(activeMembers), group: structuredClone(group), intent: { version: 1,
          mutationId: crypto.randomUUID(), expectedRevision: revision, expectedGroupRevision: group.revision } });
        setScreen('close');
      }, <X size={12} />, true)}
      {row('Удалить группу', () => mutate('delete', {}), <Trash2 size={12} />)}
    </>}
    {screen === 'rename' && <form style={{ padding: 8 }} onSubmit={event => { event.preventDefault(); if (!disabled && name.trim()) mutate('rename', { name: name.trim() }); }}>
      <input autoFocus aria-label="Название группы" value={name} disabled={disabled} onChange={event => setName(event.target.value)}
        style={{ boxSizing: 'border-box', width: 220, maxWidth: 'calc(100vw - 34px)', background: '#1e1e1e', color: '#ddd', border: '1px solid #555', borderRadius: 4, padding: 6, fontSize: 13 }} />
      <button type="submit" disabled={disabled || !name.trim()} className="workflow-group-action" style={{ ...rowStyle, width: '100%', color: '#ccc', border: 0, background: 'transparent', textAlign: 'left' }}>Сохранить</button>
    </form>}
    {screen === 'color' && TAB_COLORS.map(color => row(color.label.replace(/^[^\wА-Яа-я]+\s*/, ''), () => mutate('color', { color: color.color }),
      <span style={{ width: 11, height: 11, borderRadius: 3, border: '1px solid ' + color.borderColor, background: color.bgColor }} />, (false), (group.color || 'default') === color.color))}
    {screen === 'status' && <>{row('Без статуса', () => mutate('status', { status: null }), null, false, !group.sessionStatus)}
      {statuses.map(status => row(status.label || status.name || '', () => mutate('status', { status: status.id }), <span style={{ width: 8, height: 8, borderRadius: '50%', background: status.color || '#888' }} />, false, status.id === group.sessionStatus, 'status:' + status.id))}</>}
    {screen === 'move' && <>{workflows.map(workflow => row(workflow.name, () => {
      const exact = structuredClone(activeMembers), current = structuredClone(group), callback = props.onMoveMembers;
      const intent: WorkflowGroupMemberIntent = { version: 1, mutationId: crypto.randomUUID(), expectedRevision: revision, expectedGroupRevision: group.revision };
      void execute(() => callback(workflow.id, exact, current, intent),{kind:'move',...intent,targetWorkflowId:workflow.id,
        members:exact.map(({tabId,namespace,projectId})=>({tabId,namespace,projectId}))});
    }, <FolderInput size={12} />, false, false, 'workflow:' + workflow.id))}
      {workflows.length === 0 && <div style={{ padding: 8, fontSize: 12 }}>Нет workflow</div>}</>}
    {screen === 'close' && <>
      <div style={{ padding: 8, maxWidth: 250, fontSize: 12, lineHeight: 1.5 }}>Закрыть {closing?.members.length || 0} вкладок группы? Файлы на диске сохранятся.</div>
      {row('Подтвердить закрытие', () => {
        if (!closing) return;
        const { members: exact, group: current, intent } = closing, callback = props.onCloseMembers;
        void execute(() => callback(exact, current, intent),{kind:'close',...intent,
          members:exact.map(({tabId,namespace,projectId})=>({tabId,namespace,projectId}))});
      }, <X size={12} />, true)}
    </>}
    {screen !== 'main' && row('Назад', back, null)}
    {retry && <button className="workflow-group-action" style={{ ...rowStyle, width: '100%', border: 0, color: '#ccc', background: 'transparent' }} disabled={busy} onClick={() => void retry()}>Повторить запрос</button>}
  </div>, overlayTarget);
}
