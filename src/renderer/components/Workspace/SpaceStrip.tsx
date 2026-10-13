// Полоса рабочих пространств — первая строка рабочей области.
//
// Пространство это ВИД на раскладку окон: свои окна, свои полосы вкладок, свои
// перегородки. Вкладки ему не принадлежат — они живут в списке слева, поэтому
// удалить пространство дёшево: исчезает раскладка, вкладки и процессы целы. Из
// этого же следует, что подтверждения при удалении нет.
//
// Стоит НАД окнами и внутри рабочей области, а не над боковым списком: полоса
// про то, что справа от него. Высота та же, что у полосы проектов наверху, —
// две строки-«переключателя» одной меры читаются как один язык.
//
// Жесты повторяют вкладки, и это не совпадение, а условие: двойной клик по
// пустому месту создаёт, правый клик открывает меню действий, колёсико удаляет.
// Переименование начинается из меню и выделяет имя целиком.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import {Copy, Square, Pencil, Settings, Trash2} from 'lucide-react';
import { useAgentSendPendingTabs } from '../../hooks/useAgentSendActivity';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { resolveStripOverflow, scrollOffsetForChip } from '../../utils/paneStripLayout.mjs';
import { SPACE_STRIP_H } from '../../constants/layout';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { resolveWorkflowActivityCounts } from '../../utils/workflowActivityCounts.mjs';
import { useCodexNativeQuestionCounts } from '../../utils/codexNativeQuestions';
import { allPaneTabIds } from '../../utils/splitPanesModel.mjs';
import { tabSpaceIndexMap } from '../../utils/workspaceSpacesModel.mjs';
import { spacesWithLiveLayout } from '../../utils/workspaceSpaceRecovery.mjs';
import WorkflowActivityBadges from './WorkflowActivityBadges';
import WorkflowChip from './WorkflowChip';
import { HORIZONTAL_ROW_DRAG_START, HORIZONTAL_ROW_DRAG_END, useConstrainedHorizontalReorder } from '../../hooks/useConstrainedHorizontalReorder';
import { PANE_TAB_DND_TYPE } from '../../utils/paneTabDragBridge';
import {
  clearTabDragNavigationTarget,
  setTabDragNavigationTarget,
  useTabDragNavigationSnapshot,
} from '../../utils/tabDragNavigationBridge';
import {
  CONTEXT_MENU_METRICS,
  CONTEXT_MENU_METRICS_HOOK,
  CONTEXT_MENU_PANEL_STYLE,
  CONTEXT_MENU_ROW_STYLE,
  contextMenuEstimatedHeight,
} from '../UI/contextMenuMetrics.mjs';
import { resolveWorkflowIcon } from '../../utils/workflowVisuals.mjs';
import {
  selectWorkspaceWindowSwapTarget,
  useWorkspaceWindowSwapPickerSnapshot,
} from '../../utils/workspaceWindowSwapPicker.mjs';
import { requestFocusedWorkspacePrimaryInput } from '../../utils/tabPrimaryInputFocus';
import { useInlineRenameInputRef } from '../../hooks/useInlineRenameInput';

/** «×N» — пространства, полностью ушедшие за край. Тот же ответ, что в шапке окна. */
function SpaceOverflowCount({ side, count, onClick }: {
  side: 'left' | 'right';
  count: number;
  onClick: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      data-space-overflow={side}
      title={`${side === 'left' ? 'Слева' : 'Справа'} ещё ${count} — клик прокрутит`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        flexShrink: 0,
        minWidth: 15,
        height: 13,
        lineHeight: '13px',
        padding: '0 3px',
        fontSize: 9.5,
        fontWeight: 700,
        color: '#c2c2c8',
        background: 'rgba(255,255,255,0.10)',
        border: 'none',
        borderRadius: 3,
        cursor: 'pointer',
      }}
    >
      {'×' + count}
    </button>
  );
}

type SpaceActivityProps = {
  processStatus: ReadonlyMap<string, boolean>;
  busyTabs: ReadonlyMap<string, boolean>;
  pasteBusyTabs: ReadonlyMap<string, boolean>;
  inheritedBusyTabIds: ReadonlySet<string>;
  awaitingTabs: ReadonlyMap<string, boolean>;
};

function SpaceChip({
  id,
  index,
  active,
  onRename,
  processStatus,
  busyTabs,
  pasteBusyTabs,
  inheritedBusyTabIds,
  awaitingTabs,
}: {
  id: string;
  index: number;
  active: boolean;
  onRename: (id: string, name: string) => void;
} & SpaceActivityProps) {
  const chipRef = useRef<HTMLSpanElement | null>(null);
  const workspaceVisible = useWorkspaceStore((state) => state.view === 'workspace');
  const sendPendingTabs = useAgentSendPendingTabs();
  const codexQuestionCounts = useCodexNativeQuestionCounts();
  // Metadata подписана по одному workflow. Родитель держит только fingerprint
  // списка id, поэтому выбор большой data-URL иконки не заставляет всю полосу
  // подписываться на массив `spaces` целиком.
  const name = useWorkspaceStore((s) => s.spaces.find((space) => space.id === id)?.name || 'Workflow');
  const configuredIcon = useWorkspaceStore((s) => s.spaces.find((space) => space.id === id)?.icon);
  const projectIdsKey = useWorkspaceStore((s) => (
    s.spaces.find((space) => space.id === id)?.projectIds?.join('\u0000') || ''
  ));
  const defaultProjectId = projectIdsKey ? projectIdsKey.split('\u0000')[0] : '';
  const fallbackProjectIcon = useProjectsStore((s) => (
    defaultProjectId ? (s.projects[defaultProjectId]?.icon || null) : null
  ));
  // undefined = legacy workflow, которому ещё не успели скопировать старую
  // цветную иконку. null = пользователь явно очистил иконку.
  const icon = resolveWorkflowIcon(
    { icon: configuredIcon, projectIds: defaultProjectId ? [defaultProjectId] : [] },
    () => fallbackProjectIcon,
  );
  // Кегль и мера карточки — те же, что у карточек проектов наверху. Полоса
  // пространств и полоса проектов это две строки одного языка: свой мелкий
  // размер делал бы её похожей на служебную подпись, а не на переключатель.
  // Activity принадлежит МЕСТУ, где вкладка реально разложена, а не project-
  // папке на sidebar. Project и workflow — разные оси: вкладку из iOS project
  // можно положить в окно main, и её loader обязан светиться на main. Старый
  // обход `space.projectIds` делал ровно обратное: main-ios-app показывал
  // чужую работу, а фактический main молчал.
  //
  // Одна вкладка может сохраниться в нескольких workflow. Используем тот же
  // canonical owner, что Cmd+P/карта размещения: активное место выигрывает,
  // среди dormant — первое сохранённое. Неразмещённая вкладка остаётся видна
  // busy в sidebar, но не приписывается workflow только из-за общей папки.
  //
  // SDK alive хранится в самой вкладке и участвует в fingerprint: terminal
  // process/busy карты приходят из App пропсами, а SDK-переход при неизменном
  // layout иначе не перерисовал бы chip.
  const activityKey = useWorkspaceStore((s) => {
    const spaces = spacesWithLiveLayout(s.spaces, s.activeSpaceId, s);
    const ownerSpaceIndex = spaces.findIndex((space) => space.id === id);
    if (ownerSpaceIndex < 0) return '';
    const ownerByTab = tabSpaceIndexMap(spaces, allPaneTabIds, s.activeSpaceId);
    const entries: string[] = [];
    s.openProjects.forEach((workspace) => {
      workspace.tabs.forEach((tab, tabId) => {
        if (ownerByTab.get(tabId) !== ownerSpaceIndex) return;
        entries.push([
          tabId,
          tab.sdkProcessAlive ? '1' : '0',
          tab.completionNotificationFired ? '1' : '0',
        ].join('\u001f'));
      });
    });
    return entries.join('\u001e');
  });
  const activity = React.useMemo(() => {
    const entries = activityKey
      ? activityKey.split('\u001e').map((part) => {
        const [tabId, sdkAlive, completionNotificationFired] = part.split('\u001f');
        return {
          tabId,
          sdkAlive: sdkAlive === '1',
          completionNotificationFired: completionNotificationFired === '1',
        };
      })
      : [];
    return resolveWorkflowActivityCounts(entries.map(({ tabId, sdkAlive, completionNotificationFired }) => ({
      tabId,
      sdkAlive,
      processAlive: processStatus.get(tabId) === true,
      busy: busyTabs.get(tabId) === true,
      pasteBusy: pasteBusyTabs.get(tabId) === true,
      sendPending: sendPendingTabs.has(tabId),
      inheritedBusy: inheritedBusyTabIds.has(tabId),
      awaiting: awaitingTabs.get(tabId) === true,
      nonblockingQuestion: (codexQuestionCounts.get(tabId) || 0) > 0,
      completionNotificationFired,
    })));
  }, [activityKey, processStatus, busyTabs, pasteBusyTabs, inheritedBusyTabIds, awaitingTabs, sendPendingTabs, codexQuestionCounts]);
  const [renaming, setRenaming] = useState(false);
  // Наведение подсвечивает чип: до этого единственным ответом на «я сейчас
  // попаду сюда» была форма курсора, и полоса читалась как неживая. Юзер:
  // *«при наведении должен как-то бэкграунд меняться… а не чисто
  // курсор-пойнтер»*.
  const [hovered, setHovered] = useState(false);
  // Pointerdown acknowledges the gesture immediately. The switch itself is
  // never delayed for an animation frame: active state, pane frame and input
  // focus are one logical commit.
  const [pending, setPending] = useState(false);
  const [pointerHeld, setPointerHeld] = useState(false);
  const switchQueuedRef = useRef(false);
  React.useEffect(() => {
    // Переключение состоялось (или не состоялось) — обещание чипа снимается.
    setPending(false);
    setPointerHeld(false);
    switchQueuedRef.current = false;
  }, [active]);
  const [draft, setDraft] = useState('');
  const renameInput = useInlineRenameInputRef(renaming);
  const canDelete = useWorkspaceStore((s) => s.spaces.length > 1 && s.spaces.find(space => space.id === id)?.kind !== 'inbox');
  const defaultCwd = useWorkspaceStore(s=>{const cwd=s.spaces.find(space=>space.id===id)?.defaultCwd;return typeof cwd==='string'?cwd:'';});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [stoppingSessions, setStoppingSessions] = useState(false);
  const stopSessionsInFlight = useRef(false);
  const navigationTarget = useTabDragNavigationSnapshot().target;
  const paneTabNavigationTarget = navigationTarget?.kind === 'workflow'
    && navigationTarget.id === id && !navigationTarget.blocked;
  const windowSwapPicker = useWorkspaceWindowSwapPickerSnapshot();
  const windowSwapTarget = windowSwapPicker.active && windowSwapPicker.targetSpaceId === id;

  useEffect(() => {
    const element = chipRef.current;
    if (!element || renaming) return undefined;
    const onRowDragStart = () => {
      setPending(false);
      setPointerHeld(false);
      switchQueuedRef.current = false;
    };
    element.addEventListener(HORIZONTAL_ROW_DRAG_START, onRowDragStart);
    const cleanup = dropTargetForElements({
        element,
        getData: () => ({ type: 'WORKSPACE_SPACE_CHIP', id, index }),
        canDrop: ({ source }) => source.data.type === PANE_TAB_DND_TYPE,
        onDragEnter: ({ source, location }) => {
          if (source.data.type === PANE_TAB_DND_TYPE) {
            setTabDragNavigationTarget('pane', {
              kind: 'workflow',
              id,
              clientX: location.current.input.clientX,
              clientY: location.current.input.clientY,
              blocked: active,
            });
            return;
          }
        },
        onDrag: ({ source, location }) => {
          if (source.data.type === PANE_TAB_DND_TYPE) {
            setTabDragNavigationTarget('pane', {
              kind: 'workflow',
              id,
              clientX: location.current.input.clientX,
              clientY: location.current.input.clientY,
              blocked: active,
            });
            return;
          }
        },
        onDragLeave: () => {
          clearTabDragNavigationTarget('pane');
        },
        onDrop: ({ source }) => {
          if (source.data.type === PANE_TAB_DND_TYPE) {
            clearTabDragNavigationTarget('pane');
          }
        },
      });
    return () => {
      cleanup();
      element.removeEventListener(HORIZONTAL_ROW_DRAG_START, onRowDragStart);
    };
  }, [active, id, index, renaming]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  const commit = () => {
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== name) onRename(id, next);
  };

  const stopSessions = async (mode: 'idle' | 'all') => {
    if (stopSessionsInFlight.current) return;
    stopSessionsInFlight.current = true;
    setStoppingSessions(true);
    setContextMenu(null);
    const actionId = globalThis.crypto.randomUUID();
    const startedAt = performance.now();
    // Local preparation can precede Main Send admission. These IDs only
    // EXCLUDE idle targets; they never grant Stop or identify an execution.
    const busyTabIds = [...new Set([...sendPendingTabs, ...inheritedBusyTabIds,
      ...[...busyTabs].filter(([, busy]) => busy).map(([tabId]) => tabId),
      ...[...pasteBusyTabs].filter(([, busy]) => busy).map(([tabId]) => tabId)])];
    console.log('[WorkflowStop] click action=' + actionId + ' workflow=' + id + ' mode=' + mode);
    try {
      const result = await window.require('electron').ipcRenderer.invoke('workflow:stop-sessions', {
        actionId, workflowId: id, mode, ...(mode === 'idle' ? { busyTabIds } : {}),
      });
      console.log('[WorkflowStop] settled action=' + (result?.actionId || actionId) + ' workflow=' + id
        + ' mode=' + mode + ' durMs=' + Math.round(performance.now() - startedAt));
      if (!Array.isArray(result?.results) || result?.error) throw new Error(result?.error || 'stop_not_confirmed');
      for (const target of result.results) if (target.kind === 'sdk' && target.success === true) {
        window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId: target.tabId } }));
      }
      useUIStore.getState().showToast(
        `Остановлено: ${result.stoppedCount || 0}${result.skippedCount ? ` · Пропущено: ${result.skippedCount}` : ''}${result.failedCount ? ` · Ошибок: ${result.failedCount}` : ''}`,
        result.failedCount ? 'error' : result.stoppedCount ? 'success' : 'info',
      );
    } catch (error: any) {
      console.warn('[WorkflowStop] failed action=' + actionId + ' workflow=' + id + ' mode=' + mode + ' error=' + String(error?.message || error));
      useUIStore.getState().showToast(`Остановка не подтверждена: ${error?.message || error}`, 'error');
    } finally {
      stopSessionsInFlight.current = false;
      setStoppingSessions(false);
    }
  };

  return (
    <WorkflowChip
      ref={chipRef}
      as="span"
      workflowId={id}
      label={name}
      icon={icon}
      selected={active}
      pending={pending}
      hovered={hovered}
      pointerHeld={pointerHeld}
      swapTarget={windowSwapTarget}
      navigationTarget={paneTabNavigationTarget}
      showIdentity={!renaming}
      data-space-chip={id}
      data-space-active={active ? '1' : '0'}
      data-space-pending={pending ? '1' : '0'}
      data-horizontal-reorder-disabled={renaming || windowSwapPicker.active ? 'true' : undefined}
      data-workspace-swap-target={windowSwapTarget ? '1' : undefined}
      data-tab-drag-navigation-target={paneTabNavigationTarget ? 'workflow' : undefined}
      title={windowSwapPicker.active
        ? `Показать окна «${name}» для обмена`
        : (active ? `${name} — это пространство` : `Перейти в «${name}»`)}
      onPointerDown={(e) => {
        if (windowSwapPicker.active) {
          e.stopPropagation();
          setPointerHeld(true);
          return;
        }
        if (e.button !== 0 || renaming || (active && workspaceVisible) || switchQueuedRef.current) return;
        // Pointerdown is the first trustworthy acknowledgement of the user's
        // intent. It normally precedes click by many frames, so the active-like
        // background is already painted by mouseup instead of waiting behind
        // the workspace reconciliation triggered from click.
        setPointerHeld(true);
        setPending(true);
      }}
      onPointerUp={() => setPointerHeld(false)}
      onPointerCancel={() => {
        setPointerHeld(false);
        if (!switchQueuedRef.current && !active) setPending(false);
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (windowSwapPicker.active) {
          e.preventDefault();
          setPointerHeld(false);
          setPending(false);
          switchQueuedRef.current = false;
          selectWorkspaceWindowSwapTarget(id);
          return;
        }
        if (renaming || (active && workspaceVisible) || switchQueuedRef.current) return;
        switchQueuedRef.current = true;
        if (!pending) setPending(true);
        const commitSwitch = () => {
          useWorkspaceStore.getState().switchWorkspaceSpace(id);
          if (useWorkspaceStore.getState().activeSpaceId === id
            && useWorkspaceStore.getState().view === 'workspace') {
            switchQueuedRef.current = false;
            setPending(false);
          }
          useUIStore.getState().setActiveArea('workspace');
          requestFocusedWorkspacePrimaryInput('workflow-strip-click');
          // Fail-safe only: a successful switch clears this through `active`.
          window.setTimeout(() => {
            if (useWorkspaceStore.getState().activeSpaceId === id) return;
            switchQueuedRef.current = false;
            setPending(false);
          }, 600);
        };
        commitSwitch();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const point = clampMenuToViewport({
          x: e.clientX,
          y: e.clientY,
          width: 190,
          height: contextMenuEstimatedHeight({ rows: 5, dividers: 2 }),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
        setContextMenu(point);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPointerHeld(false);
        if (!switchQueuedRef.current && !active) setPending(false);
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        if (windowSwapPicker.active) return;
        useWorkspaceStore.getState().removeWorkspaceSpace(id);
      }}
    >
      {renaming && (
        <input
          ref={renameInput.ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setRenaming(false);
          }}
          style={{
            width: Math.max(60, draft.length * 6.5 + 12),
            minWidth: 60,
            padding: '0 4px',
            border: 'none',
            outline: 'none',
            background: '#333',
            borderRadius: 3,
            // Рамка тенью, а не border'ом: тень не занимает места, и чип не
            // раздувается на время правки, сдвигая соседей.
            boxShadow: 'inset 0 0 0 1px var(--color-accent)',
            color: '#fff',
            font: 'inherit',
          }}
        />
      )}
      <WorkflowActivityBadges
        activeCount={activity.activeCount}
        busyCount={activity.busyCount}
        inheritedBusyCount={activity.inheritedBusyCount}
        awaitingCount={activity.awaitingCount}
        nonblockingQuestionCount={activity.nonblockingQuestionCount}
        completionNotificationCount={activity.completionNotificationCount}
        active={active}
      />
      {contextMenu && ReactDOM.createPortal(
        <div
          data-workflow-context-menu={id}
          data-context-menu-metrics={CONTEXT_MENU_METRICS_HOOK}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
          style={{
            ...CONTEXT_MENU_PANEL_STYLE,
            minWidth: 190,
            width: 190,
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 10020,
            border: '1px solid #3a3a3a',
            background: '#252526',
            boxShadow: '0 10px 26px rgba(0,0,0,0.45)',
            overflow: 'hidden',
          }}
        >
          <button
            type="button"
            data-context-menu-row="ordinary"
            data-workflow-context-action="rename"
            className="hover:bg-white/10"
            onClick={() => {
              setContextMenu(null);
              setDraft(name);
              setRenaming(true);
            }}
            style={{ ...CONTEXT_MENU_ROW_STYLE, ...workflowMenuItemStyle }}
          >
            <Pencil size={14}/>Rename
          </button>
          <button
            type="button"
            data-context-menu-row="ordinary"
            data-workflow-context-action="settings"
            className="hover:bg-white/10"
            onClick={() => {
              setContextMenu(null);
              window.dispatchEvent(new CustomEvent('workflow-settings:open', { detail: { workflowId:id } }));
            }}
            style={{ ...CONTEXT_MENU_ROW_STYLE, ...workflowMenuItemStyle }}
          >
            <Settings size={14}/>Settings
          </button>
          <button type="button" data-context-menu-row="ordinary" data-workflow-context-action="copy-path"
            disabled={!defaultCwd} title={defaultCwd || 'Choose a directory in Settings'}
            className={defaultCwd?'hover:bg-white/10':''} style={{...CONTEXT_MENU_ROW_STYLE,...workflowMenuItemStyle,
              display:'flex',alignItems:'center',gap:6,opacity:defaultCwd?1:.45,cursor:defaultCwd?'pointer':'default'}}
            onClick={()=>{if(!defaultCwd)return;window.require('electron').clipboard.writeText(defaultCwd);setContextMenu(null);useUIStore.getState().showToast('Path copied','success');}}>
            <Copy size={14}/><span style={{minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>Path: {defaultCwd.replace(/\/+$/,'').split('/').pop() || (defaultCwd?'/' :'—')}</span>
          </button>
          <div data-workflow-stop-controls data-context-menu-row="ordinary"
            style={{ display: 'flex', borderTop: '1px solid #3a3a3a', borderBottom: '1px solid #3a3a3a' }}>
            {([{ mode: 'idle', label: 'Stop idle', color: '#4ade80', title: 'Stop idle sessions; keep active work and MCP waits' },
              { mode: 'all', label: 'Stop all', color: '#f59e0b', title: 'Stop all workflow sessions, including active work' }] as const).map(action => (
              <button key={action.mode} type="button" data-workflow-context-action={`stop-${action.mode}`}
                title={action.title} aria-label={action.title} disabled={stoppingSessions}
                className="hover:bg-white/10" onClick={() => { void stopSessions(action.mode); }}
                style={{ ...CONTEXT_MENU_ROW_STYLE, ...workflowMenuItemStyle, width: 'auto', flex: '1',
                  display: 'inline-flex', alignItems: 'center', gap: 5, color: action.color,
                  borderRight: action.mode === 'idle' ? '1px solid #3a3a3a' : undefined,
                  opacity: stoppingSessions ? .5 : 1, cursor: stoppingSessions ? 'default' : 'pointer' }}>
                <Square size={12} style={{ flexShrink: 0 }}/>{action.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            data-context-menu-row="ordinary"
            data-workflow-context-action="delete"
            className={canDelete ? 'hover:bg-red-500/10' : ''}
            disabled={!canDelete}
            onClick={() => {
              if (!canDelete) return;
              setContextMenu(null);
              useWorkspaceStore.getState().removeWorkspaceSpace(id);
            }}
            style={{
              ...CONTEXT_MENU_ROW_STYLE,
              ...workflowMenuItemStyle,
              color: canDelete ? '#f87171' : '#626262',
              cursor: canDelete ? 'pointer' : 'not-allowed',
            }}
          >
            <Trash2 size={14}/>Delete
          </button>
        </div>,
        document.body,
      )}
    </WorkflowChip>
  );
}

const workflowMenuItemStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  border: 'none',
  background: 'transparent',
  color: '#d6d6d6',
  fontSize: 11,
  textAlign: 'left',
  cursor: 'pointer',
};

export default function SpaceStrip({
  processStatus,
  busyTabs,
  pasteBusyTabs,
  inheritedBusyTabIds,
  awaitingTabs,
}: SpaceActivityProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ left: 0, right: 0 });
  const chipMetricsRef = useRef<Array<{ id: string; left: number; width: number }>>([]);
  const viewportWidthRef = useRef(0);
  const scrollLeftRef = useRef(0);
  // Строковый отпечаток, не массив: селектор, отдающий объекты, — новая ссылка
  // на каждую запись в стор (правило Fingerprint).
  const spacesKey = useWorkspaceStore((s) => s.spaces.map((space) => space.id).join('\u0000'));
  const activeSpaceId = useWorkspaceStore((s) => s.activeSpaceId);
  const spaceIds = React.useMemo(() => spacesKey.split('\u0000').filter(Boolean), [spacesKey]);
  const commitSpaceOrder = useCallback((nextIds: string[]) => {
    useWorkspaceStore.getState().reorderWorkspaceSpaces(nextIds);
  }, []);
  const horizontalReorder = useConstrainedHorizontalReorder({
    ownerKey: 'workflow-strip',
    baseIds: spaceIds,
    containerRef: scrollerRef,
    itemSelector: '[data-space-chip]',
    idAttribute: 'data-space-chip',
    onCommit: commitSpaceOrder,
  });
  const displayedSpaceIds = spaceIds;
  const displayedSpacesKey = displayedSpaceIds.join('\u0000');
  const renameSpace = useCallback((id: string, name: string) => {
    useWorkspaceStore.getState().renameWorkspaceSpace(id, name);
  }, []);

  const applyCachedOverflow = useCallback((scrollLeft?: number) => {
    const el = scrollerRef.current;
    if (!el || horizontalReorder.activeRef.current) return;
    const next = resolveStripOverflow({
      chips: chipMetricsRef.current,
      scrollLeft: scrollLeft ?? scrollLeftRef.current,
      viewportWidth: viewportWidthRef.current || el.clientWidth,
    });
    setOverflow((prev) => (
      prev.left === next.hiddenLeft && prev.right === next.hiddenRight
        ? prev
        : { left: next.hiddenLeft, right: next.hiddenRight }
    ));
  }, []);

  // DOM geometry is read only when chips/container actually resize. Active
  // space changes do not alter chip widths, so consulting offsetLeft in their
  // layout-effect merely forced a full workspace layout (48ms self-time in the
  // switch CPU profile).
  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || horizontalReorder.activeRef.current) return;
    chipMetricsRef.current = Array.from(el.querySelectorAll<HTMLElement>('[data-space-chip]'))
      .map((node) => ({
        id: node.dataset.spaceChip || '',
        left: node.offsetLeft,
        width: node.offsetWidth,
      }));
    viewportWidthRef.current = el.clientWidth;
    scrollLeftRef.current = el.scrollLeft;
    applyCachedOverflow();
  }, [applyCachedOverflow]);

  const revealActiveFromCache = useCallback((spaceId: string) => {
    const el = scrollerRef.current;
    if (!el || horizontalReorder.activeRef.current) return;
    const chip = chipMetricsRef.current.find((candidate) => candidate.id === spaceId);
    if (!chip) return;
    const next = scrollOffsetForChip({
      chip,
      scrollLeft: scrollLeftRef.current,
      viewportWidth: viewportWidthRef.current || el.clientWidth,
    });
    if (next !== scrollLeftRef.current) {
      scrollLeftRef.current = next;
      el.scrollLeft = next;
    }
    applyCachedOverflow(next);
  }, [applyCachedOverflow]);

  // Текущее пространство должно быть ВИДНО: полоса говорит, где ты находишься,
  // и уехавший за край активный чип отвечает на этот вопрос молчанием.
  useLayoutEffect(() => {
    measure();
  }, [displayedSpacesKey, measure]);

  useLayoutEffect(() => {
    revealActiveFromCache(activeSpaceId);
  }, [activeSpaceId, revealActiveFromCache]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.querySelectorAll<HTMLElement>('[data-space-chip]').forEach((chip) => observer.observe(chip));
    return () => observer.disconnect();
  }, [displayedSpacesKey, measure]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onRelease = () => measure();
    el.addEventListener(HORIZONTAL_ROW_DRAG_END, onRelease);
    return () => el.removeEventListener(HORIZONTAL_ROW_DRAG_END, onRelease);
  }, [measure]);

  const scrollBy = (direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = scrollLeftRef.current + direction * Math.max(80, viewportWidthRef.current * 0.6);
    scrollLeftRef.current = next;
    el.scrollLeft = next;
    applyCachedOverflow(next);
  };

  return (
    <div
      data-space-strip
      // Двойной клик по ПУСТОМУ месту — новое пространство. Тот же жест, что
      // создаёт вкладку в шапке окна, и по той же причине: пустое место полосы
      // принадлежит полосе.
      onDoubleClick={(e) => {
        e.stopPropagation();
        useWorkspaceStore.getState().addWorkspaceSpace();
      }}
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: SPACE_STRIP_H,
        padding: '0 8px',
        boxSizing: 'border-box',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        userSelect: 'none',
      }}
    >
      <SpaceOverflowCount side="left" count={overflow.left} onClick={() => scrollBy(-1)} />
      <div
        ref={scrollerRef}
        data-space-strip-scroller
        onScroll={(event) => {
          scrollLeftRef.current = event.currentTarget.scrollLeft;
          applyCachedOverflow(scrollLeftRef.current);
        }}
        onWheel={(e) => {
          const el = scrollerRef.current;
          if (!el || el.scrollWidth <= el.clientWidth) return;
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (!delta) return;
          e.preventDefault();
          const next = scrollLeftRef.current + delta;
          scrollLeftRef.current = next;
          el.scrollLeft = next;
          applyCachedOverflow(next);
        }}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          minWidth: 0,
          flex: 1,
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none',
          height: '100%',
          boxSizing: 'border-box',
          paddingTop: 2,
        }}
      >
        {displayedSpaceIds.map((spaceId, index) => (
          <SpaceChip
            key={spaceId}
            id={spaceId}
            index={index}
            active={spaceId === activeSpaceId}
            onRename={renameSpace}
            processStatus={processStatus}
            busyTabs={busyTabs}
            pasteBusyTabs={pasteBusyTabs}
            inheritedBusyTabIds={inheritedBusyTabIds}
            awaitingTabs={awaitingTabs}
          />
        ))}
      </div>
      <SpaceOverflowCount side="right" count={overflow.right} onClick={() => scrollBy(1)} />
    </div>
  );
}
