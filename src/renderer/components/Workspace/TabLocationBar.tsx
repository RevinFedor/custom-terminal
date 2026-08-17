// WHERE the active tab is — its working directory, said out loud.
//
// The directory belongs to the TAB, not to the project: every tab carries its
// own cwd (a `cd` in the terminal moves it, a tab can sit in a worktree while
// its project points at the main checkout). The project only supplies the
// DEFAULT for new tabs. Nothing on screen said this, so "which folder am I in"
// was answerable only by reading the shell prompt — and the Git button, which
// used the PROJECT path, quietly answered about a different folder than the one
// the user was working in.
//
// One row, about the ACTIVE tab, under the toolbar (VS Code puts the same
// information in the same place). Panes do not each get a copy: three long
// paths would cost more room than they explain, and a pane's own path is a
// tooltip away on its header chip.

import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { TAB_LOCATION_BAR_H } from '../../constants/layout';

// Same access path the tab list and the help modal use for "reveal in Finder".
const { shell } = window.require('electron');

const HOME = (typeof process !== 'undefined' && process.env.HOME) || '';

/** `/Users/fedor/x` → `~/x`. The home prefix is noise on every single path. */
export function shortenHome(fullPath: string, home = HOME): string {
  const value = String(fullPath || '');
  if (!home || !value.startsWith(home)) return value;
  const rest = value.slice(home.length);
  if (rest === '') return '~';
  if (rest.startsWith('/')) return '~' + rest;
  return value;
}

export function TabLocationBar() {
  // Fingerprint selector: a string, never the tab object. The bar re-renders on
  // an actual change of the path, not on every store write.
  const cwd = useWorkspaceStore((s) => {
    const projectId = s.activeProjectId;
    if (!projectId) return '';
    const workspace = s.openProjects.get(projectId);
    if (!workspace) return '';
    const tabId = s.getEffectiveTabId();
    const tab = tabId ? workspace.tabs.get(tabId) : null;
    return tab?.cwd || '';
  });

  const display = shortenHome(cwd);

  return (
    <div
      data-tab-location-bar
      title={cwd ? `${cwd}\nКлик — открыть в Finder` : ''}
      style={{
        height: TAB_LOCATION_BAR_H,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 10px',
        fontSize: 10.5,
        lineHeight: 1,
        color: '#7c7c82',
        // Same panel surface as the toolbar above it, with a hairline seam —
        // this is a continuation of the top strip, not a new region.
        background: 'var(--color-panel, #1d1d1f)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        userSelect: 'none',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {display ? (
        <span
          onClick={() => { if (cwd) shell.openPath(cwd); }}
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#c8c8cd'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'inherit'; }}
        >
          {/* RTL direction clips the START of a long path (…/src/renderer) —
              the tail is what identifies a folder; the prefix is the same for
              every project. The bidi isolate keeps the slashes in order. */}
          &#x2066;{display}&#x2069;
        </span>
      ) : (
        <span style={{ opacity: 0.6 }}>Нет активной вкладки</span>
      )}
    </div>
  );
}
