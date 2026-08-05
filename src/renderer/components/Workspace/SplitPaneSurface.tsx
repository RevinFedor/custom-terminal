import React, { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useWorkspaceStore, type CommandType } from '../../store/useWorkspaceStore';
import { resolveTabTerminalPrimary, useUIStore } from '../../store/useUIStore';
import HistoryPanel from './HistoryPanel';
import TabTaskPlanPanel from './TabTaskPlanPanel';
import Timeline from './Timeline';
import ClaudeControlBar from './ClaudeControlBar';
import FloatingTerminalFrame from './FloatingTerminalFrame';

const { ipcRenderer } = window.require('electron');

// Per-pane portal hosts. The Run after strip and the docked composer belong to
// the PANE, not to the terminal layer — hiding or dimming the terminal must
// never take them along.
export const splitPaneQueueHostId = (tabId: string) => `split-pane-queue-host-${tabId}`;
export const splitPaneComposerHostId = (tabId: string) => `split-pane-composer-host-${tabId}`;

interface SplitPaneSurfaceProps {
  projectId: string;
  tabId: string;
  focused: boolean;
  children: ReactNode;
}

/**
 * A split pane is a FULL mini-workspace, not a viewport: every pane owns its
 * terminal+input, or an AI transcript with its composer, plus its own Run
 * after strip, Timeline column, task panel and control bar. Focus decides only
 * two things — the white frame and which pane owns GLOBAL hotkeys (Escape
 * interrupt, Cmd+F). Both panes stay fully interactive.
 *
 * The xterm subtree is never removed: in transcript mode the terminal lives in
 * the pane's own side frame (docked to THIS pane's right edge), hidden
 * off-edge while closed.
 */
export default function SplitPaneSurface({
  projectId,
  tabId,
  focused,
  children,
}: SplitPaneSurfaceProps) {
  const tabType = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.tabType);
  const commandType = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.commandType || null);
  const claudeSessionId = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.claudeSessionId || '');
  const geminiSessionId = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.geminiSessionId || '');
  const codexSessionId = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.codexSessionId || '');
  const tabName = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.name || 'Terminal');
  const cwd = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.cwd || '');
  const aiBusy = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.aiBusy === true);
  const projectPath = useWorkspaceStore((state) => state.openProjects.get(projectId)?.projectPath || cwd);
  const workspaceVisible = useWorkspaceStore((state) => state.view === 'workspace');
  const terminalIsPrimary = useUIStore((state) => resolveTabTerminalPrimary(state, tabId));
  const setTabTerminalIsPrimary = useUIStore((state) => state.setTabTerminalIsPrimary);
  const historyPanelWidth = useUIStore((state) => state.historyPanelWidth);
  const notesPanelWidth = useUIStore((state) => state.notesPanelWidth);
  const timelinePinned = useUIStore((state) => state.timelinePinned);
  const sideTerminalOpen = useUIStore((state) => state.sideTerminalOpenTabs[tabId] ?? false);
  const setSideTerminalOpen = useUIStore((state) => state.setSideTerminalOpen);
  const sideHistoryOpen = useUIStore((state) => state.historyPanelOpenTabs[tabId] ?? false);
  const setHistoryPanelOpen = useUIStore((state) => state.setHistoryPanelOpen);

  const isCodex = commandType === 'codex'
    || (commandType !== 'claude' && !!codexSessionId && !claudeSessionId);
  const isAgentTab = tabType !== 'claude-sdk'
    && tabType !== 'browser'
    && tabType !== 'file'
    && (commandType === 'claude' || commandType === 'codex' || !!claudeSessionId || !!codexSessionId);
  const historySelected = isAgentTab && !terminalIsPrimary;
  const agentSessionId = isCodex ? codexSessionId : claudeSessionId;
  const agentToolType: 'claude' | 'codex' = isCodex ? 'codex' : 'claude';

  // Timeline follows any session the tab has (agent PTY, SDK, gemini).
  const timelineToolType: 'claude' | 'gemini' | 'codex' = isCodex
    ? 'codex'
    : (commandType === 'gemini' || (!claudeSessionId && !!geminiSessionId)) ? 'gemini' : 'claude';
  const timelineSessionId = timelineToolType === 'codex'
    ? codexSessionId
    : timelineToolType === 'gemini' ? geminiSessionId : claudeSessionId;
  const showTimeline = !!timelineSessionId;

  // Shell/agent command state for this pane's tab — same IPC signals the
  // single-mode Workspace consumes, scoped to one tabId.
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  useEffect(() => {
    let disposed = false;
    const onStarted = (_: unknown, data: { tabId?: string }) => {
      if (data?.tabId === tabId) setIsCommandRunning(true);
    };
    const onFinished = (_: unknown, data: { tabId?: string }) => {
      if (data?.tabId === tabId) setIsCommandRunning(false);
    };
    ipcRenderer.on('terminal:command-started', onStarted);
    ipcRenderer.on('terminal:command-finished', onFinished);
    ipcRenderer.invoke('terminal:getCommandState', {
      tabId,
      caller: 'SplitPaneSurface',
      expectedProcess: 'codex',
      allowProcessTreeLookup: isCodex,
    }).then((state: any) => {
      if (!disposed) setIsCommandRunning(!!state?.isRunning);
    }).catch(() => {});
    return () => {
      disposed = true;
      ipcRenderer.removeListener('terminal:command-started', onStarted);
      ipcRenderer.removeListener('terminal:command-finished', onFinished);
    };
  }, [tabId, isCodex]);

  const showOtherSurface = useCallback(() => {
    setTabTerminalIsPrimary(tabId, !resolveTabTerminalPrimary(useUIStore.getState(), tabId));
  }, [setTabTerminalIsPrimary, tabId]);

  const toggleSideTerminal = useCallback(() => {
    setSideTerminalOpen(tabId, !(useUIStore.getState().sideTerminalOpenTabs[tabId] ?? false));
  }, [setSideTerminalOpen, tabId]);

  const closeSideTerminal = useCallback(() => {
    setSideTerminalOpen(tabId, false);
  }, [setSideTerminalOpen, tabId]);

  const toggleSideHistory = useCallback(() => {
    setHistoryPanelOpen(tabId, !(useUIStore.getState().historyPanelOpenTabs[tabId] ?? false));
  }, [setHistoryPanelOpen, tabId]);

  const composerHostId = splitPaneComposerHostId(tabId);
  const showControlBar = tabType !== 'browser' && tabType !== 'file';

  // Height of the transcript's docked controls (composer) — the pane's side
  // terminal stops above them, exactly like the single-mode side terminal.
  const [historyControlsHeight, setHistoryControlsHeight] = useState(0);
  const handleControlsHeight = useCallback((height: number) => {
    setHistoryControlsHeight((current) => (current === height ? current : height));
  }, []);

  return (
    <div
      data-split-pane-surface={tabId}
      data-split-pane-surface-mode={historySelected ? 'history' : 'terminal'}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        display: 'flex',
      }}
    >
      {/* ── Left column: surfaces + composer host + control bar ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* overflow hidden clips the side frames' translateX slide, exactly
            like the single-mode terminal content column. */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          {/* Transcript as the pane's MAIN surface. Mounted in EVERY pane that
              selected it — focus only gates global hotkeys, never content. */}
          {historySelected && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }}>
              <HistoryPanel
                tabId={tabId}
                sessionId={agentSessionId}
                cwd={cwd || projectPath}
                width={historyPanelWidth}
                notesPanelWidth={notesPanelWidth}
                isOpen
                toolType={agentToolType}
                enableClaudePtyControls
                embedded
                embeddedFill
                mainSurface
                projectId={projectId}
                onSwapPrimarySurface={showOtherSurface}
                terminalIsPrimary={false}
                terminalOpen={sideTerminalOpen}
                onToggleTerminal={toggleSideTerminal}
                onControlsHeightChange={handleControlsHeight}
                suppressGlobalHotkeys={!focused}
              />
            </div>
          )}

          {/* The pane's terminal. Terminal mode → fills the pane inline.
              Transcript mode → the SAME xterm docks as a side panel at THIS
              pane's right edge (kept mounted off-edge while closed). */}
          <FloatingTerminalFrame
            tabId={tabId}
            tabName={tabName}
            floating={historySelected}
            open={!historySelected || sideTerminalOpen}
            bottomInset={historySelected ? historyControlsHeight : 0}
            onClose={closeSideTerminal}
          >
            {children}
          </FloatingTerminalFrame>

          {/* Terminal mode: side transcript slice at the pane's right edge.
              Stays mounted while closed — it owns the docked composer below. */}
          {isAgentTab && !historySelected && (
            <div
              data-split-pane-side-history
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                width: historyPanelWidth,
                maxWidth: '100%',
                zIndex: 130,
                pointerEvents: sideHistoryOpen ? 'auto' : 'none',
              }}
            >
              <HistoryPanel
                tabId={tabId}
                sessionId={agentSessionId}
                cwd={cwd || projectPath}
                width={historyPanelWidth}
                notesPanelWidth={notesPanelWidth}
                isOpen={sideHistoryOpen}
                toolType={agentToolType}
                enableClaudePtyControls
                agentSidePanel
                composerPortalHostId={composerHostId}
                projectId={projectId}
                onSwapPrimarySurface={showOtherSurface}
                terminalIsPrimary
                terminalOpen={sideHistoryOpen}
                onToggleTerminal={toggleSideHistory}
                suppressGlobalHotkeys={!focused}
              />
            </div>
          )}

          {/* Run after strip host — the pane's service layer. Above both
              surfaces (z 120), below the pane's side panels (z 130), never
              dimmed and never hidden by the mode toggle. */}
          <div
            id={splitPaneQueueHostId(tabId)}
            data-split-pane-queue-host
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 120,
              pointerEvents: 'none',
            }}
          />

          <TabTaskPlanPanel
            tabId={tabId}
            projectPath={projectPath}
            inputSurface={isAgentTab && (historySelected || sideHistoryOpen)
              ? 'history'
              : tabType === 'claude-sdk' ? 'sdk' : 'terminal'}
            commandType={commandType as CommandType | null}
          />
        </div>

        {/* Terminal mode: the ONE composer docks below the terminal (History
            renders it here through the portal), so the pane types and watches
            in the same glance — exactly like single mode. */}
        {isAgentTab && !historySelected && (
          <div
            id={composerHostId}
            data-split-pane-composer-host
            className="shrink-0"
            style={{ pointerEvents: 'auto' }}
          />
        )}

        {showControlBar && (
          <div style={{ pointerEvents: 'auto', flexShrink: 0, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}>
            <ClaudeControlBar
              tabId={tabId}
              projectId={projectId}
              historyIsPrimary={isAgentTab && (historySelected || sideHistoryOpen)}
              claudeSessionId={claudeSessionId || null}
              geminiSessionId={geminiSessionId || null}
              codexSessionId={codexSessionId || null}
              commandType={commandType}
              isCommandRunning={isCommandRunning}
              projectPath={projectPath}
            />
          </div>
        )}
      </div>

      {/* ── The pane's own Timeline column at its right edge ── */}
      {showTimeline && (
        <div style={{ pointerEvents: 'auto', height: '100%', flexShrink: 0, display: 'flex' }}>
          <Timeline
            tabId={tabId}
            sessionId={timelineSessionId}
            cwd={cwd || projectPath}
            isActive={isCommandRunning}
            isTurnBusy={aiBusy}
            isVisible={workspaceVisible}
            isOpen
            toolType={timelineToolType}
            pinned={timelinePinned}
            historySurfaceVisible={historySelected}
          />
        </div>
      )}
    </div>
  );
}
