import React, { type ReactNode, useCallback } from 'react';
import { useWorkspaceStore, type CommandType } from '../../store/useWorkspaceStore';
import { resolveTabTerminalPrimary, useUIStore } from '../../store/useUIStore';
import HistoryPanel from './HistoryPanel';
import TabTaskPlanPanel from './TabTaskPlanPanel';

interface SplitPaneSurfaceProps {
  projectId: string;
  tabId: string;
  focused: boolean;
  children: ReactNode;
}

/**
 * Per-pane center surface. The xterm subtree is never removed: History is an
 * overlay and the terminal is only visibility-hidden while the focused pane
 * owns the single live HistoryPanel instance.
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
  const codexSessionId = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.codexSessionId || '');
  const cwd = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.cwd || '');
  const projectPath = useWorkspaceStore((state) => state.openProjects.get(projectId)?.projectPath || cwd);
  const terminalIsPrimary = useUIStore((state) => resolveTabTerminalPrimary(state, tabId));
  const setTabTerminalIsPrimary = useUIStore((state) => state.setTabTerminalIsPrimary);
  const historyPanelWidth = useUIStore((state) => state.historyPanelWidth);
  const notesPanelWidth = useUIStore((state) => state.notesPanelWidth);

  const isCodex = commandType === 'codex'
    || (commandType !== 'claude' && !!codexSessionId && !claudeSessionId);
  const isAgentTab = tabType !== 'claude-sdk'
    && tabType !== 'browser'
    && tabType !== 'file'
    && (commandType === 'claude' || commandType === 'codex' || !!claudeSessionId || !!codexSessionId);
  const historySelected = isAgentTab && !terminalIsPrimary;
  const ownsLiveHistory = historySelected && focused;

  const showOtherSurface = useCallback(() => {
    setTabTerminalIsPrimary(tabId, !resolveTabTerminalPrimary(useUIStore.getState(), tabId));
  }, [setTabTerminalIsPrimary, tabId]);

  return (
    <div
      data-split-pane-surface={tabId}
      data-split-pane-surface-mode={historySelected ? 'history' : 'terminal'}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      <div
        data-split-pane-terminal-layer
        aria-hidden={ownsLiveHistory ? true : undefined}
        style={{
          position: 'absolute',
          inset: 0,
          visibility: ownsLiveHistory ? 'hidden' : 'visible',
          opacity: historySelected && !focused ? 0.42 : 1,
          pointerEvents: historySelected && !focused ? 'none' : undefined,
        }}
      >
        {children}
      </div>

      {ownsLiveHistory && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }}>
          <HistoryPanel
            tabId={tabId}
            sessionId={isCodex ? codexSessionId : claudeSessionId}
            cwd={cwd || projectPath}
            width={historyPanelWidth}
            notesPanelWidth={notesPanelWidth}
            isOpen
            toolType={isCodex ? 'codex' : 'claude'}
            enableClaudePtyControls
            embedded
            embeddedFill
            mainSurface
            projectId={projectId}
            onSwapPrimarySurface={showOtherSurface}
            terminalIsPrimary={false}
          />
        </div>
      )}

      {historySelected && !focused && (
        <div
          data-split-pane-history-focus-notice
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            pointerEvents: 'auto',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              maxWidth: '100%',
              padding: '7px 10px',
              borderRadius: 7,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(24,24,24,0.92)',
              color: '#c8c8cc',
              fontSize: 11.5,
              lineHeight: 1.35,
              textAlign: 'center',
              pointerEvents: 'none',
            }}
          >
            Транскрипт в сплите — только для фокусной панели
          </span>
        </div>
      )}

      <TabTaskPlanPanel
        tabId={tabId}
        projectPath={projectPath}
        inputSurface={historySelected ? 'history' : tabType === 'claude-sdk' ? 'sdk' : 'terminal'}
        commandType={commandType as CommandType | null}
      />
    </div>
  );
}
