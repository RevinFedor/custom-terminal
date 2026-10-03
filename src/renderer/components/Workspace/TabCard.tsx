import React, { forwardRef, useMemo, useState } from 'react';
import { FileText, Folder, Plus } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { resolveTabCardBackground, resolveTabCardMetrics, TAB_CARD_LINE_HEIGHT } from '../../utils/tabCardVisual.mjs';
import { getTabChromeColorConfig, flattenRgbaOnTabbarPanel, adjustRgbaAlpha } from './tabChrome';
import { resolveTabSessionDescriptor, useSessionAvailability } from '../../utils/sessionAvailabilityTracker';
import { sessionAvailabilityBackgroundImage, sessionAvailabilityRailShadow, sessionDerivedSignalsStale } from '../../utils/sessionAvailabilityVisual.mjs';
import { resolveCodexFastModeState } from '../../utils/codexFastMode.mjs';
import { isEmptyTab } from '../../utils/emptyTab.mjs';
import { isErrorToast } from '../../utils/toastPlacement.mjs';
import { useTabWorkContext } from '../../utils/tabWorkContext';
import {
  TabProcessBar, TabStatusMarker, TabStatusMarkerButton, TabTopLeftSignals,
  TabContextUpdateBadge, TabCompletionNotificationAlert, TabCompletionNotificationBadge,
  TabSessionAvailabilityMarker, TabTaskMarker, useTabActivitySignals, useTabContextUsage,
  useTabCompletionNotificationDismissing, resolveTabCompletionNotificationShadow,
  TAB_CONTEXT_UPDATE_INSET_PX, TAB_COMPLETION_NOTIFICATION_INSET_PX,
  TASK_MARKER_GAP_PX, TASK_MARKER_LANE_HEIGHT_PX, TASK_MARKER_DEFAULT_COLOR,
  tabFastBadgeOutsidePx,
  type SharedTabActivityMaps,
} from './TabSignals';
import TabPendingOperation, { resolveTabPendingOperationLabel } from './TabPendingOperation';

type Activity = { hasProcess: boolean; busy: boolean; inheritedBusy: boolean };
export interface TabCardProps extends React.HTMLAttributes<HTMLElement> {
  projectId: string;
  tabId: string;
  as?: 'span' | 'button';
  shown?: boolean;
  active?: boolean;
  selected?: boolean;
  pressed?: boolean;
  fullWidth?: boolean;
  truncate?: boolean;
  showShownStripe?: boolean;
  showProjectIcon?: boolean;
  /** Popover scroll boxes need the signal overhang included in card layout. */
  reserveSignalSpace?: boolean;
  interactiveStatus?: boolean;
  chooser?: boolean;
  label?: React.ReactNode;
  trailingActions?: React.ReactNode;
  sharedActivity?: SharedTabActivityMaps | null;
  activityOverride?: Activity;
  geometry?: { paddingY: number; paddingX: number; paddingLeft: number; borderRadius: number; gap?: number };
  fontSize?: number;
  onTaskClick?: (taskId: string, event: React.MouseEvent<HTMLButtonElement>) => void;
}

/** The visual card and its live signals; each surface owns navigation/drag/selection. */
const LiveTabCard = forwardRef<HTMLElement, TabCardProps>(function LiveTabCard({
  projectId, tabId, as = 'span', shown = false, active = false, selected = false,
  pressed = false, fullWidth = false, truncate = true, showShownStripe = false,
  showProjectIcon = false, reserveSignalSpace = false, interactiveStatus = false, chooser = false,
  label, children, trailingActions, sharedActivity = null, activityOverride,
  geometry, fontSize, onTaskClick, style, onMouseEnter, onMouseLeave, ...elementProps
}, ref) {
  const [hovered, setHovered] = useState(false);
  // Primitive subscriptions also observe in-place rename/status updates.
  const tabName = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.name || '');
  const tabColor = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.color);
  const tabType = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.tabType);
  const commandType = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.commandType);
  const cwd = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.cwd || '');
  const claudeSessionId = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.claudeSessionId || '');
  const codexSessionId = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexSessionId || '');
  const geminiSessionId = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.geminiSessionId || '');
  const sdkAlive = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.sdkProcessAlive === true);
  const aiClosing = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.aiClosing === true);
  const pendingOperation = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.pendingOperation);
  const statusId = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.sessionStatus);
  const armed = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.completionNotificationArmed === true);
  const fired = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.completionNotificationFired === true);
  const persistent = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.completionNotificationPersistent === true);
  const serviceTier = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexLiveServiceTier);
  const tierSessionId = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexLiveServiceTierSessionId);
  const settingsSessionId = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexLiveSettingsSessionId);
  const taskPlan = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.taskPlan);
  const empty = useWorkspaceStore(s => {
    const tab = s.openProjects.get(projectId)?.tabs.get(tabId);
    return !!tab && isEmptyTab(tab);
  });
  const hiddenErrors = useUIStore(s => shown ? 0 : s.toasts.reduce((n, toast) => n + (toast.tabId === tabId && isErrorToast(toast) ? 1 : 0), 0));
  const status = useUIStore(s => s.sessionStatuses.find(x => x.id === statusId));
  const taskStatuses = useUIStore(s => s.taskStatuses);
  const taskShape = useUIStore(s => s.taskStatusMarker.shape);
  const configuredGeometry = useUIStore(s => s.tabGeometry);
  const configuredFontSize = useUIStore(s => s.tabsFontSize);
  const projectIcon = useProjectsStore(s => s.projects[projectId]?.icon || '');
  const projectName = useProjectsStore(s => s.projects[projectId]?.name || '');
  const taskItems = taskPlan?.items || [];
  const geo = geometry || configuredGeometry;
  // Run After already has an authoritative activity snapshot. Reuse it rather
  // than starting an extra process lookup for every row in its picker.
  const signalSnapshot = useMemo(() => activityOverride || chooser ? {
    processStatus: new Map([[tabId, activityOverride?.hasProcess ?? false]]),
    busyTabs: new Map([[tabId, activityOverride?.busy ?? false]]),
  } : sharedActivity, [tabId, activityOverride?.hasProcess, activityOverride?.busy, !!activityOverride, chooser, sharedActivity]);
  const liveActivity = useTabActivitySignals(tabId, signalSnapshot);
  const activity = activityOverride || liveActivity;
  const availability = useSessionAvailability(resolveTabSessionDescriptor({ id: tabId, cwd, commandType, tabType,
    claudeSessionId, codexSessionId, geminiSessionId }));
  const muted = sessionDerivedSignalsStale(availability, sdkAlive || (activity.hasProcess
    && (commandType === 'claude' || commandType === 'codex' || commandType === 'gemini')));
  const dismissing = useTabCompletionNotificationDismissing(fired);
  const contextPct = useTabContextUsage(tabId);
  const contextUpdate = useTabWorkContext(tabId).pendingCount > 0;
  const fastActive = resolveCodexFastModeState({ currentSessionId: settingsSessionId || tierSessionId || codexSessionId,
    serviceTierSessionId: tierSessionId, serviceTier }).active;
  const chrome = getTabChromeColorConfig({ color: tabColor, tabType });
  const metrics = resolveTabCardMetrics({ ...geo,
    paddingLeft: Math.max(geo.paddingLeft, contextUpdate ? TAB_CONTEXT_UPDATE_INSET_PX : 0),
  }, { fontSize: fontSize ?? configuredFontSize, showTaskLane: taskItems.length > 0, hasStatusMarker: !!status || contextUpdate });
  const pending = resolveTabPendingOperationLabel({ aiClosing, pendingOperation });
  const shadows = [resolveTabCompletionNotificationShadow({ armed: armed && !fired, fired }),
    showShownStripe && (shown || pressed) ? 'inset 0 2px 0 0 rgba(255,255,255,0.75)' : null,
    sessionAvailabilityRailShadow(availability)].filter(Boolean).join(', ') || undefined;
  const frameStyle: React.CSSProperties = {
    position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4,
    flexShrink: fullWidth ? 1 : 0, minWidth: 0, width: fullWidth ? '100%' : undefined,
    whiteSpace: 'nowrap', boxSizing: 'border-box', textAlign: 'left',
    fontSize: metrics.fontSize, lineHeight: TAB_CARD_LINE_HEIGHT,
    color: active || selected || shown || pressed || hovered ? '#e8e8e8' : '#9b9ba1',
    cursor: 'pointer', background: flattenRgbaOnTabbarPanel(resolveTabCardBackground({
      bgColor: chrome.bgColor, hasColor: !!tabColor && tabColor !== 'default', active: active || pressed, selected, hovered,
    }, adjustRgbaAlpha)), backgroundImage: sessionAvailabilityBackgroundImage(availability), boxShadow: shadows,
    border: hiddenErrors > 0 ? '1px solid #f87171'
      : `1px solid ${/^#[\da-f]{6}$/i.test(chrome.borderColor) ? chrome.borderColor + '55' : '#6666'}`,
    borderRadius: metrics.borderRadius, padding: metrics.padding,
    marginTop: reserveSignalSpace ? Math.max(0, tabFastBadgeOutsidePx(geo.gap ?? 4) - 1) : undefined,
    marginBottom: reserveSignalSpace ? Math.max(0, -metrics.laneBottomPx,
      contextUpdate ? tabFastBadgeOutsidePx(geo.gap ?? 4) - 1 : 0) : undefined,
    paddingRight: armed || persistent || fired ? Math.max(geo.paddingX, TAB_COMPLETION_NOTIFICATION_INSET_PX) : undefined,
    transition: 'none', ...style,
  };
  const contents = <>
    <TabCompletionNotificationAlert fired={fired} dismissing={dismissing} borderRadius={metrics.borderRadius} />
    {!chooser && <TabProcessBar {...activity} radius={metrics.borderRadius} zIndex={4} />}
    <TabTopLeftSignals fastActive={fastActive} contextPct={contextPct} minContextPct={50} zIndex={8} muted={muted} />
    <TabContextUpdateBadge active={contextUpdate} />
    <TabCompletionNotificationBadge armed={armed} persistent={persistent} fired={fired} />
    {interactiveStatus ? <TabStatusMarkerButton projectId={projectId} tabId={tabId} color={status?.color} title={status?.label} />
      : <TabStatusMarker color={status?.color} title={status?.label} />}
    {showProjectIcon && projectIcon && <img data-tab-card-project-icon={projectId} src={projectIcon} title={projectName}
      alt="" draggable={false} style={{ width: 12, height: 12, flexShrink: 0, borderRadius: 2, objectFit: 'cover' }} />}
    {chooser ? <Plus size={12} /> : tabType === 'file' ? <FileText size={10} style={{ color: '#a78bfa', flexShrink: 0 }} />
      : empty ? <Folder size={10} style={{ color: '#8a8a92', flexShrink: 0 }} /> : null}
    {pending ? <TabPendingOperation label={pending} tabName={tabName} /> : children || <span data-tab-card-label style={{
      minWidth: 0, flex: fullWidth ? 1 : undefined, whiteSpace: 'nowrap',
      overflow: truncate ? 'hidden' : undefined, textOverflow: truncate ? 'ellipsis' : undefined,
    }}>{label ?? (chooser ? 'Новая вкладка' : tabName)}</span>}
    <TabSessionAvailabilityMarker availability={availability} size={10} />
    {trailingActions}
    {taskItems.length > 0 && <span data-task-plan-tab-markers style={{ position: 'absolute',
      left: contextUpdate ? TAB_CONTEXT_UPDATE_INSET_PX : 6, right: 6, bottom: metrics.laneBottomPx,
      height: TASK_MARKER_LANE_HEIGHT_PX, display: 'flex', alignItems: 'flex-end', gap: TASK_MARKER_GAP_PX,
      overflow: 'hidden', pointerEvents: 'none', zIndex: 7 }}>
      {taskItems.map(task => <TabTaskMarker key={task.id} color={taskStatuses.find(s => s.id === task.statusId)?.color || TASK_MARKER_DEFAULT_COLOR}
        shape={taskShape} title={task.title} onClick={onTaskClick ? event => onTaskClick(task.id, event) : undefined} />)}
    </span>}
  </>;
  return React.createElement(as, { ...elementProps, ref, ...(as === 'button' ? { type: 'button' } : {}),
    'data-tab-card': tabId, 'data-tab-session-availability': availability.state === 'none' ? undefined : availability.state,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => { setHovered(true); onMouseEnter?.(event); },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => { setHovered(false); onMouseLeave?.(event); },
    style: frameStyle }, contents);
});

// A chooser has no durable tab/session. It shares the card profile without
// creating activity/context subscriptions for a placeholder slot ID.
const ChooserTabCard = forwardRef<HTMLElement, TabCardProps>(function ChooserTabCard({
  projectId, tabId, as = 'span', shown, active, selected, pressed, fullWidth, truncate = true,
  showShownStripe, showProjectIcon, reserveSignalSpace: _reserveSignalSpace, interactiveStatus: _interactiveStatus, chooser: _chooser,
  label, children, trailingActions, sharedActivity: _sharedActivity, activityOverride: _activity,
  geometry, fontSize, onTaskClick: _onTaskClick, style, onMouseEnter, onMouseLeave, ...props
}, ref) {
  const configuredGeometry = useUIStore(s => s.tabGeometry);
  const configuredFont = useUIStore(s => s.tabsFontSize);
  const icon = useProjectsStore(s => s.projects[projectId]?.icon || '');
  const [hovered, setHovered] = useState(false);
  const metrics = resolveTabCardMetrics(geometry || configuredGeometry, { fontSize: fontSize ?? configuredFont });
  return React.createElement(as, { ...props, ref, ...(as === 'button' ? { type: 'button' } : {}),
    'data-tab-card': tabId,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => { setHovered(true); onMouseEnter?.(event); },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => { setHovered(false); onMouseLeave?.(event); },
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0,
      width: fullWidth ? '100%' : undefined, boxSizing: 'border-box', whiteSpace: 'nowrap', cursor: 'pointer',
      fontSize: metrics.fontSize, lineHeight: TAB_CARD_LINE_HEIGHT, padding: metrics.padding,
      border: '1px solid #6666', borderRadius: metrics.borderRadius, color: '#b8b8c2',
      boxShadow: showShownStripe && shown ? 'inset 0 2px 0 0 rgba(255,255,255,0.75)' : undefined,
      background: flattenRgbaOnTabbarPanel(resolveTabCardBackground({ bgColor: 'transparent', hasColor: false,
        active: active || pressed, selected, hovered }, adjustRgbaAlpha)), transition: 'none', ...style } },
    <>{showProjectIcon && icon && <img src={icon} alt="" draggable={false} style={{ width: 12, height: 12, flexShrink: 0 }} />}
      <Plus size={12} /><span data-tab-card-label style={{ minWidth: 0, overflow: truncate ? 'hidden' : undefined,
        textOverflow: truncate ? 'ellipsis' : undefined }}>{children || label || 'Новая вкладка'}</span>{trailingActions}</>);
});

export default forwardRef<HTMLElement, TabCardProps>(function TabCard(props, ref) {
  return props.chooser ? <ChooserTabCard {...props} ref={ref} /> : <LiveTabCard {...props} ref={ref} />;
});
