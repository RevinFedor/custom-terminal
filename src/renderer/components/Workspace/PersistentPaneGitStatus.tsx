import React, { useLayoutEffect, useRef, useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { PANE_LAYER_PRESENTATION_EVENT } from '../../utils/paneLayerPresentation.mjs';
import GitStatusButton from './GitStatusButton';

type PersistentPaneGitStatusProps = {
  tabId: string;
  initialPresented: boolean;
  initialFocused: boolean;
  projectId?: string | null;
  projectName?: string;
  projectPath?: string;
  tabCwd?: string;
};

/**
 * Tiny reactive boundary for Git background ownership.
 *
 * Pane chrome is structurally cached across workflow switches, so its original
 * React props cannot prove that it is still visible. The outer presentation
 * event is the exact current answer. Updating this wrapper reconciles only the
 * Git subtree; History, Timeline, xterm and the tab strip stay untouched.
 */
function PersistentPaneGitStatus({
  tabId,
  initialPresented,
  initialFocused,
  ...gitProps
}: PersistentPaneGitStatusProps) {
  const activeArea = useUIStore((state) => state.activeArea);
  const [presentation, setPresentation] = useState({
    presented: initialPresented,
    focused: initialFocused,
  });
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;

  useLayoutEffect(() => {
    const onPresentation = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        presented?: boolean;
        focused?: boolean;
      }>).detail;
      if (detail?.tabId !== tabId || typeof detail.presented !== 'boolean') return;
      const next = {
        presented: detail.presented,
        focused: detail.focused === true,
      };
      const previous = presentationRef.current;
      if (previous.presented === next.presented && previous.focused === next.focused) return;
      presentationRef.current = next;
      setPresentation(next);
    };
    window.addEventListener(PANE_LAYER_PRESENTATION_EVENT, onPresentation);
    return () => window.removeEventListener(PANE_LAYER_PRESENTATION_EVENT, onPresentation);
  }, [tabId]);

  return (
    <GitStatusButton
      {...gitProps}
      foreground={presentation.presented && presentation.focused && activeArea !== 'sidebar'}
    />
  );
}

export default React.memo(PersistentPaneGitStatus);
