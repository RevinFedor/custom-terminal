import React, { forwardRef, useMemo, useRef, useState } from 'react';
import { FileText, Folder, Plus } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { resolveTabCardBackground, resolveTabCardMetrics, TAB_STRIP_ROW_GAP, TAB_CARD_LINE_HEIGHT } from '../../utils/tabCardVisual.mjs';
import { getTabChromeColorConfig, flattenRgbaOnTabbarPanel, adjustRgbaAlpha } from './tabChrome';
import { resolveTabSessionDescriptor, useSessionAvailability } from '../../utils/sessionAvailabilityTracker';
import { sessionAvailabilityBackgroundImage, sessionAvailabilityRailShadow, sessionDerivedSignalsStale } from '../../utils/sessionAvailabilityVisual.mjs';
import { resolveCodexFastModeState } from '../../utils/codexFastMode.mjs';
import { isEmptyTab } from '../../utils/emptyTab.mjs';
import { isErrorToast } from '../../utils/toastPlacement.mjs';
import { useTabWorkContext } from '../../utils/tabWorkContext';
import {
  TabProcessBar, TabStatusMarker, TabStatusMarkerButton, TabTopLeftSignals,
  TabContextUpdateBadge, TabCompletionNotificationBadge, TabCompletionNotificationAlert,
  TabSessionAvailabilityMarker, useTabActivitySignals, useTabContextUsage,
  TAB_CONTEXT_UPDATE_INSET_PX,
  TAB_PROCESS_BAR_W_PX,
  tabFastBadgeOutsidePx,
  type SharedTabActivityMaps,
} from './TabSignals';
import TabPendingOperation, { resolveTabPendingOperationLabel } from './TabPendingOperation';
import TabLinkedFiles, { useTabLinkedFiles, type LinkedFile } from './TabLinkedFiles';
import { isLinkedFilePreview } from '../../utils/tabLinkedFiles.mjs';
import { useLinkedTitleLayout } from '../../utils/tabCardTitleMetrics';
import { useCodexNativeQuestion } from '../../utils/codexNativeQuestions';

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
  /** Legacy caller compatibility; workflow membership is shown by its container. */
  showProjectIcon?: boolean;
  showTaskMarkers?: boolean;
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
  /** Pane group outline is below these two overhanging signals. */
  cornerSignalZIndex?: number;
  onTaskClick?: (taskId: string, event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Opt-in only for placed pane cards; other consumers keep their own lanes. */
  onLinkedFileOpen?: (file: LinkedFile) => void;
  linkedFilesMode?: 'menu' | 'navigate';
}

/** The visual card and its live signals; each surface owns navigation/drag/selection. */
const LiveTabCard = forwardRef<HTMLElement, TabCardProps>(function LiveTabCard({
  projectId, tabId, as = 'span', shown = false, active = false, selected = false,
  pressed = false, fullWidth = false, truncate = true, showShownStripe = false,
  showProjectIcon: _showProjectIcon = false, showTaskMarkers: _showTaskMarkers, reserveSignalSpace = false, interactiveStatus = false, chooser = false,
  label, children, trailingActions, sharedActivity = null, activityOverride,
  geometry, fontSize, cornerSignalZIndex = 8, onTaskClick: _onTaskClick, onLinkedFileOpen, linkedFilesMode = 'menu', style, onMouseEnter, onMouseLeave, ...elementProps
}, ref) {
  const [hovered, setHovered] = useState(false);
  const nativeQuestion = useCodexNativeQuestion(tabId);
  const [attachmentHovered, setAttachmentHovered] = useState(false);
  const cardHovered = hovered && !attachmentHovered;
  const linkedFiles = useTabLinkedFiles(tabId, !!onLinkedFileOpen);
  const hasLinkedFiles = linkedFiles.length > 0;
  const fileSelected = useUIStore(s => !!onLinkedFileOpen && isLinkedFilePreview(s.filePreview, tabId));
  // Primitive subscriptions also observe in-place rename/status updates.
  const tabName = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.name || '');
  const nameSetManually = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.nameSetManually === true);
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
  const statusId = useWorkspaceStore(s => {
    const own = s.openProjects.get(projectId)?.tabs.get(tabId)?.sessionStatus;
    const id = s.globalGroups?.tabGroups?.[tabId];
    return own || (id && s.globalGroups.groups.find((group:any) => group.id === id)?.sessionStatus) || undefined;
  });
  const armed = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.completionNotificationArmed === true);
  const fired = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.completionNotificationFired === true);
  const persistent = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.completionNotificationPersistent === true);
  const serviceTier = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexLiveServiceTier);
  const tierSessionId = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexLiveServiceTierSessionId);
  const settingsSessionId = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexLiveSettingsSessionId);
  const empty = useWorkspaceStore(s => {
    const tab = s.openProjects.get(projectId)?.tabs.get(tabId);
    return !!tab && isEmptyTab(tab);
  });
  const hiddenErrors = useUIStore(s => shown ? 0 : s.toasts.reduce((n, toast) => n + (toast.tabId === tabId && isErrorToast(toast) ? 1 : 0), 0));
  const status = useUIStore(s => s.sessionStatuses.find(x => x.id === statusId));
  const configuredGeometry = useUIStore(s => s.tabGeometry);
  const configuredFontSize = useUIStore(s => s.tabsFontSize);
  const processBarPosition = useUIStore(s => s.processBar.position);
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
  const contextPct = useTabContextUsage(tabId);
  const contextUpdate = useTabWorkContext(tabId).pendingCount > 0;
  const fastActive = resolveCodexFastModeState({ currentSessionId: settingsSessionId || tierSessionId || codexSessionId,
    serviceTierSessionId: tierSessionId, serviceTier }).active;
  const groupColor = useWorkspaceStore(state => {
    const id = state.globalGroups?.tabGroups?.[tabId];
    return id ? state.globalGroups.groups.find((group:any) => group.id === id)?.color : undefined;
  });
  const effectiveColor = tabColor || groupColor;
  const chrome = getTabChromeColorConfig({ color: effectiveColor, tabType });
  const metrics = resolveTabCardMetrics({ ...geo,
    paddingLeft: Math.max(geo.paddingLeft, contextUpdate ? TAB_CONTEXT_UPDATE_INSET_PX : 0),
  }, { fontSize: fontSize ?? configuredFontSize, hasStatusMarker: !!status || contextUpdate,
    // Reserve the rail even while idle so starting a process cannot rewrap the
    // strip. The bell overlays the corner without changing the configured
    // spacing; a separate paddingRight would overwrite this single writer.
    minPaddingLeft: processBarPosition === 'left' ? TAB_PROCESS_BAR_W_PX : 0,
    minPaddingRight: processBarPosition === 'right' ? TAB_PROCESS_BAR_W_PX : 0,
  });
  const pending = resolveTabPendingOperationLabel({ aiClosing, pendingOperation, nameSetManually, name: tabName });
  const linkedFileHeight = Math.max(15, Math.ceil(metrics.fontSize * .72) + 4);
  const titleLineRef=useRef<HTMLSpanElement>(null);
  const titleLayout=useLinkedTitleLayout(titleLineRef,true,{text:pending||(typeof label==='string'?label:tabName),fontSize:metrics.fontSize,
    paddingY:parseFloat(metrics.padding),gap:TAB_STRIP_ROW_GAP,chipHeight:linkedFileHeight,
    fontWeight:style?.fontWeight,fontFamily:style?.fontFamily});
  const shadows = [showShownStripe && (shown || pressed) ? 'inset 0 2px 0 0 rgba(255,255,255,0.75)' : null,
    sessionAvailabilityRailShadow(availability), fileSelected ? 'inset 0 0 0 1px #b6a1e8' : null].filter(Boolean).join(', ') || undefined;
  const frameStyle: React.CSSProperties = {
    position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4,
    flexShrink: fullWidth ? 1 : 0, minWidth: 0, width: fullWidth ? '100%' : undefined,
    whiteSpace: 'nowrap', boxSizing: 'border-box', textAlign: 'left',
    fontSize: metrics.fontSize, lineHeight: TAB_CARD_LINE_HEIGHT,
    color: active || selected || shown || pressed || cardHovered ? '#e8e8e8' : '#9b9ba1',
    cursor: 'pointer', background: flattenRgbaOnTabbarPanel(resolveTabCardBackground({
      bgColor: chrome.bgColor, hasColor: !!effectiveColor && effectiveColor !== 'default', active: active || pressed, selected, hovered: cardHovered,
    }, adjustRgbaAlpha)), backgroundImage: sessionAvailabilityBackgroundImage(availability), boxShadow: shadows,
    border: hiddenErrors > 0 ? '1px solid #f87171'
      : `1px solid ${/^#[\da-f]{6}$/i.test(chrome.borderColor) ? chrome.borderColor + '55' : '#6666'}`,
    borderRadius: metrics.borderRadius,
    padding: metrics.padding,
    // All cards share the measured font profile, with or without attachments.
    // The file itself stays absolute; count/hover never change the row pitch.
    ...(hasLinkedFiles ? { '--tab-linked-file-height': `${linkedFileHeight}px`,
      '--tab-linked-file-overhang': `${Math.max(3, Math.round(linkedFileHeight / 3))}px`,
    } as React.CSSProperties : {}),
    ...(titleLayout?{height:titleLayout.height,'--tab-linked-file-top':`${titleLayout.chipTop}px`,
      ...(hasLinkedFiles?{'--tab-title-center':`${titleLayout.titleCenter}px`}:{})} as React.CSSProperties:{}),
    marginTop: reserveSignalSpace ? Math.max(0, tabFastBadgeOutsidePx(geo.gap ?? 4) - 1) : undefined,
    marginBottom: reserveSignalSpace && contextUpdate ? Math.max(0, tabFastBadgeOutsidePx(geo.gap ?? 4) - 1) : undefined,
    transition: 'none', ...style,
  };
  const titleContents = <>
    {chooser ? <Plus size={12} /> : tabType === 'file' ? <FileText size={14} style={{ color: '#a78bfa', flexShrink: 0 }} />
      : empty ? <Folder size={10} style={{ color: '#8a8a92', flexShrink: 0 }} /> : null}
    {children || (pending ? <TabPendingOperation label={pending} tabName={tabName} /> : <span data-tab-card-label style={{
      minWidth: 0, flex: fullWidth ? 1 : undefined, whiteSpace: 'nowrap',
      overflow: truncate ? 'hidden' : undefined, textOverflow: truncate ? 'ellipsis' : undefined,
    }}>{label ?? (chooser ? 'Новая вкладка' : tabName)}</span>)}
    <TabSessionAvailabilityMarker availability={availability} size={10} />
    {trailingActions}
  </>;
  const contents = <>
    {nativeQuestion && <span data-tab-codex-question-ring aria-hidden
      className="tab-codex-question-ring noted-infinite-animation" style={{ zIndex: 3 }} />}
    {!chooser && <TabProcessBar {...activity} radius={metrics.borderRadius} zIndex={4} />}
    <TabTopLeftSignals fastActive={fastActive} contextPct={contextPct} minContextPct={50} zIndex={cornerSignalZIndex} muted={muted} />
    <TabContextUpdateBadge active={contextUpdate} zIndex={cornerSignalZIndex} />
    <TabCompletionNotificationAlert fired={fired} />
    <TabCompletionNotificationBadge armed={armed} persistent={persistent} fired={fired} />
    {interactiveStatus ? <TabStatusMarkerButton projectId={projectId} tabId={tabId} color={status?.color} title={status?.label} topOffsetPx={hasLinkedFiles&&titleLayout?0:undefined} />
      : <TabStatusMarker color={status?.color} title={status?.label} topOffsetPx={hasLinkedFiles&&titleLayout?0:undefined} />}
    <span ref={titleLineRef} data-tab-card-title-line style={{display:'inline-flex',alignItems:'center',gap:4,
      minWidth:0,flex:fullWidth?'1 1 auto':undefined,transform:hasLinkedFiles&&titleLayout?`translateY(${titleLayout.titleOffset}px)`:undefined}}>
      {titleContents}</span>
    {onLinkedFileOpen && hasLinkedFiles && <TabLinkedFiles ownerTabId={tabId} files={linkedFiles} onOpen={onLinkedFileOpen}
      mode={linkedFilesMode}
      fontSize={metrics.fontSize} geometry={geo} onHoverChange={setAttachmentHovered}
      insetLeft={contextUpdate ? TAB_CONTEXT_UPDATE_INSET_PX : 6} />}
  </>;
  return React.createElement(as, { ...elementProps, ref, ...(as === 'button' ? { type: 'button' } : {}),
    'data-tab-card': tabId, 'data-linked-file-owner-selected': fileSelected ? '1' : undefined,
    'data-tab-operation': aiClosing ? 'close'
      : pendingOperation === 'Создание форка…' ? 'fork' : pendingOperation ? 'other' : undefined,
    'data-tab-session-availability': availability.state === 'none' ? undefined : availability.state,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => { setHovered(true); onMouseEnter?.(event); },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => { setHovered(false); onMouseLeave?.(event); },
    style: frameStyle }, contents);
});

// A chooser has no durable tab/session. It shares the card profile without
// creating activity/context subscriptions for a placeholder slot ID.
const ChooserTabCard = forwardRef<HTMLElement, TabCardProps>(function ChooserTabCard({
  projectId, tabId, as = 'span', shown, active, selected, pressed, fullWidth, truncate = true,
  showShownStripe, showProjectIcon: _showProjectIcon, showTaskMarkers: _showTaskMarkers, reserveSignalSpace: _reserveSignalSpace, interactiveStatus: _interactiveStatus, chooser: _chooser,
  label, children, trailingActions, sharedActivity: _sharedActivity, activityOverride: _activity,
  geometry, fontSize, cornerSignalZIndex: _cornerSignalZIndex, onTaskClick: _onTaskClick, onLinkedFileOpen: _onLinkedFileOpen, linkedFilesMode: _linkedFilesMode, style, onMouseEnter, onMouseLeave, ...props
}, ref) {
  const configuredGeometry = useUIStore(s => s.tabGeometry);
  const configuredFont = useUIStore(s => s.tabsFontSize);
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
    <>
      <Plus size={12} /><span data-tab-card-label style={{ minWidth: 0, overflow: truncate ? 'hidden' : undefined,
        textOverflow: truncate ? 'ellipsis' : undefined }}>{children || label || 'Новая вкладка'}</span>{trailingActions}</>);
});

export default forwardRef<HTMLElement, TabCardProps>(function TabCard(props, ref) {
  return props.chooser ? <ChooserTabCard {...props} ref={ref} /> : <LiveTabCard {...props} ref={ref} />;
});
