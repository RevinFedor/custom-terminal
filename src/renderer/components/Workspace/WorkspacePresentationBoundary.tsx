import React, { useLayoutEffect, useRef } from 'react';
import { createPaneFocusIsolationManager } from '../../utils/paneFocusIsolation';

const MANAGED_PANE_BOUNDARIES = [
  '[data-terminal-pane-wrapper][data-pane-focus-isolated]',
  '[data-terminal-pane-chrome-host][data-pane-focus-isolated]',
  '[data-single-center-focus-boundary][data-pane-focus-isolated]',
].join(',');

/** Home hides the retained workspace without Chromium's whole-tree inert walk. */
export default function WorkspacePresentationBoundary({
  view,
  children,
}: {
  view: string;
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const isolationRef = useRef<ReturnType<typeof createPaneFocusIsolationManager> | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const isolation = createPaneFocusIsolationManager(root, {
      boundarySelector: '[data-workspace-presentation]',
      excludeBoundarySelector: MANAGED_PANE_BOUNDARIES,
    });
    isolationRef.current = isolation;
    isolation.sync();
    return () => {
      isolation.dispose();
      isolationRef.current = null;
    };
  }, []);

  useLayoutEffect(() => { isolationRef.current?.sync(); }, [view]);

  const presented = view === 'workspace';
  return (
    <div
      ref={rootRef}
      data-workspace-presentation={view}
      data-pane-focus-isolated={presented ? '0' : '1'}
      aria-hidden={!presented}
      className="flex-1 flex flex-col min-h-0"
      style={{
        visibility: presented ? 'visible' : 'hidden',
        opacity: presented ? 1 : 0,
        position: presented ? 'relative' : 'absolute',
        // Child panes/portals can explicitly opt into pointer-events:auto and
        // visibility:visible. Keep the entire hidden stacking context below
        // Dashboard, so none can intercept a Home click through opacity:0.
        ...(!presented ? { inset: 0, zIndex: -1, pointerEvents: 'none' as const } : {}),
      }}
    >
      {children}
    </div>
  );
}
